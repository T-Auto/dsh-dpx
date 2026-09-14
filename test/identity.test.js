import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  DPX_ENV_ROOT_VARIABLE,
  DPX_ENV_VARIABLE,
  DPX_HOME_VARIABLE,
  commandCandidates,
  createEnvironment,
  defaultRegistryHome,
  doctorReport,
  environmentShellScript,
  environmentRootFromProcess,
  expectedPnpmStore,
  isGlobalInstall,
  launchTargets,
  loadRegistry,
  pathContains,
  pathsFor,
  pluginArguments,
  profileInstalledPackages,
  readProfileInstaller,
  resolveCommandInPath,
  resolveEnvironment,
  runtimeEnvironment,
  samePath,
  whichReport,
} from '../src/index.js';
import { GUIDE_FORMAT, renderEnvironmentGuide } from '../src/environment-guide.js';

async function environment(name = 'identity') {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name, storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
  return { record, storage, home, paths: pathsFor(record.root) };
}

/** A package directory that looks installed, without running npm. */
async function fakePackage(prefix, packageName, version) {
  const directory = join(prefix, 'node_modules', ...packageName.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: packageName, version }));
  return directory;
}

test('runtimeEnvironment carries the environment identity, not just DSH_HOME', async () => {
  const { record, paths, home } = await environment('identity');
  const env = runtimeEnvironment(paths, { PATH: 'host', DPX_HOME: 'C:\\host-dpx' }, { name: record.name, registryHome: home });
  assert.equal(env[DPX_ENV_VARIABLE], 'identity');
  assert.equal(env[DPX_ENV_ROOT_VARIABLE], paths.root);
  assert.equal(env[DPX_HOME_VARIABLE], home);
  assert.equal(env.PATH.split(process.platform === 'win32' ? ';' : ':')[0], paths.npmPrefix);
  // The identity is additive: it must not reintroduce the npm redirect dpx removed.
  assert.equal(env.NPM_CONFIG_PREFIX, undefined);
  assert.equal(env.NPM_CONFIG_CACHE, undefined);
});

test('the identity variables default sensibly when no name is supplied', async () => {
  const { paths } = await environment('fallback');
  const env = runtimeEnvironment(paths, { PATH: 'host' });
  assert.equal(env[DPX_ENV_ROOT_VARIABLE], paths.root);
  assert.equal(env[DPX_ENV_VARIABLE], 'fallback');
  assert.equal(env[DPX_HOME_VARIABLE], undefined);
});

test('defaultRegistryHome keeps an explicit DPX_HOME and an existing registry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  assert.equal(defaultRegistryHome({ DPX_HOME: home, LOCALAPPDATA: join(home, 'la') }, 'win32'), home);

  const local = join(home, 'localappdata');
  await mkdir(join(local, 'DSH', 'DPX'), { recursive: true });
  await writeFile(join(local, 'DSH', 'DPX', 'registry.json'), '{}');
  assert.equal(
    defaultRegistryHome({ LOCALAPPDATA: local, [DPX_ENV_ROOT_VARIABLE]: join(home, 'env') }, 'win32'),
    join(local, 'DSH', 'DPX'),
  );
});

test('the environment a process lives in is derived from evidence, not one variable', async () => {
  const { record, paths } = await environment('evidence');

  // 1. The declared identity variable is the direct answer.
  assert.deepEqual(environmentRootFromProcess({ [DPX_ENV_ROOT_VARIABLE]: paths.root }), {
    root: paths.root,
    source: 'identity-variable',
    name: record.name,
  });

  // 2. DSH's shell layer rebuilds the DSH_* namespace, so the identity variable
  //    is gone by the time an agent's command runs. DSH_HOME still points at the
  //    environment, and the marker file next to it is what dpx trusts.
  assert.deepEqual(environmentRootFromProcess({ DSH_HOME: paths.dshHome }), {
    root: paths.root,
    source: 'dsh-home',
    name: record.name,
  });

  // 3. Same conclusion from the isolated LOCALAPPDATA.
  assert.deepEqual(environmentRootFromProcess({ LOCALAPPDATA: paths.localAppData }), {
    root: paths.root,
    source: 'isolated-localappdata',
    name: record.name,
  });

  // A host shell looks like none of those: `~/.dsh` is not `<root>\dsh-home`,
  // and a directory that merely has the right name has no dpx manifest.
  const impostor = await mkdtemp(join(tmpdir(), 'dpx-impostor-'));
  await mkdir(join(impostor, 'dsh-home'), { recursive: true });
  assert.equal(environmentRootFromProcess({ DSH_HOME: join(impostor, 'dsh-home') }), undefined);
  assert.equal(environmentRootFromProcess({ DSH_HOME: join(impostor, 'user', '.dsh'), LOCALAPPDATA: join(impostor, 'la') }), undefined);
  assert.equal(environmentRootFromProcess({}), undefined);
  // A stale pointer is not evidence either.
  assert.equal(environmentRootFromProcess({ [DPX_ENV_ROOT_VARIABLE]: join(impostor, 'gone') }), undefined);
});

test('the discovery-pointer fallback stays a Windows-only, in-environment behaviour', async () => {
  const { paths } = await environment('pointer');
  const host = await mkdtemp(join(tmpdir(), 'dpx-host-home-'));
  // Outside an environment the platform default is used verbatim ...
  assert.equal(
    defaultRegistryHome({ XDG_STATE_HOME: host }, 'linux'),
    join(host, 'dsh-dpx'),
  );
  // ... and inside one, on a platform with no discovery pointer, dpx still does
  // not invent a registry: the candidate remains the documented default.
  assert.equal(
    defaultRegistryHome({ XDG_STATE_HOME: host, DSH_HOME: paths.dshHome, HOME: host }, 'linux'),
    join(host, 'dsh-dpx'),
  );
});

test('path helpers compare the way the platform filesystem does', () => {
  assert.equal(pathContains('C:\\env', 'C:\\env\\npm-prefix\\dsh.cmd', 'win32'), true);
  assert.equal(pathContains('C:\\env', 'C:\\env2\\npm-prefix\\dsh.cmd', 'win32'), false);
  assert.equal(pathContains('C:\\env', 'C:\\env', 'win32'), true);
  assert.equal(samePath('C:\\ENV', 'c:\\env', 'win32'), true);
  // Case sensitivity is only relaxed on Windows.
  assert.equal(pathContains('/srv/env', '/srv/envil/x', 'linux'), false);
});

test('commandCandidates predicts PATH resolution without executing anything', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-path-'));
  const first = join(work, 'first');
  const second = join(work, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(second, 'probe.cmd'), '@echo off\r\n');
  await writeFile(join(first, 'probe.ps1'), 'exit 0\n');
  const env = { PATH: [first, second].join(process.platform === 'win32' ? ';' : ':') };
  const candidates = commandCandidates('probe', { env, platform: 'win32' });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].file, join(first, 'probe.ps1'));
  assert.equal(candidates[1].file, join(second, 'probe.cmd'));
  assert.equal(resolveCommandInPath('probe', env, 'win32'), join(first, 'probe.ps1'));
  assert.equal(resolveCommandInPath('C:\\tool.exe', env, 'win32'), 'C:\\tool.exe');
});

test('which reports host leakage with the DSH_HOME the leaked copy would use', async () => {
  const { record, paths, home } = await environment('leak');
  const registry = await loadRegistry(home);
  const work = await mkdtemp(join(tmpdir(), 'dpx-host-'));
  await fakePackage(paths.npmPrefix, '@deepseek-ai/dsh', '9.9.9');
  await writeFile(join(work, 'dsh.cmd'), '@echo off\r\n');

  const clean = whichReport({ paths, name: record.name, target: 'dsh', env: { PATH: paths.npmPrefix }, registry });
  assert.equal(clean.verdict, 'clean');
  assert.equal(clean.isolated.present, true);
  assert.equal(clean.isolated.version, '9.9.9');

  const leaked = whichReport({
    paths,
    name: record.name,
    target: 'dsh',
    env: { PATH: [work, paths.npmPrefix].join(process.platform === 'win32' ? ';' : ':'), USERPROFILE: join(work, 'user') },
    registry,
  });
  assert.equal(leaked.verdict, 'host-leak');
  assert.equal(leaked.ambientPath[0].winner, true);
  assert.equal(leaked.ambientPath[0].inEnvironment, false);
  assert.equal(leaked.ambientPath[0].dshHome, join(work, 'user', '.dsh'));
  assert.ok(leaked.advice.includes(join(work, 'dsh.cmd')));
  assert.ok(leaked.advice.includes(join(work, 'user', '.dsh')));
  // The env copy is present, so this is a shadowing verdict, not an install problem.
  assert.equal(leaked.isolated.present, true);
});

test('which reports a missing target instead of pretending PATH is fine', async () => {
  const { record, paths, home } = await environment('absent');
  const report = whichReport({ paths, name: record.name, target: 'dsh', env: { PATH: '' }, registry: await loadRegistry(home) });
  assert.equal(report.verdict, 'not-installed');
  assert.match(report.advice, /dpx npm install -g/);
  // Every target dpx can launch is answerable, so `dpx which` with no target never guesses.
  assert.deepEqual(launchTargets(), ['dsh', 'dsh-tui']);
});

test('which lists the global copy next to every profile copy', async () => {
  const { record, paths, home } = await environment('copies');
  await fakePackage(paths.npmPrefix, '@deepseek-ai/dsh', '1.0.0');
  await fakePackage(join(paths.dshHome, 'profiles', 'web'), '@deepseek-ai/dsh', '2.0.0');
  const report = whichReport({ paths, name: record.name, target: 'dsh', env: { PATH: '' }, registry: await loadRegistry(home) });
  assert.deepEqual(
    report.copies.map(copy => [copy.location, copy.version]),
    [['npm-prefix', '1.0.0'], ['profile:web', '2.0.0']],
  );
});

test('doctor fails on a two-copy version mismatch and names both versions', async () => {
  const { record, paths, home } = await environment('mismatch');
  await fakePackage(paths.npmPrefix, '@deepseek-ai/dsh', '1.0.0');
  await fakePackage(join(paths.dshHome, 'profiles', 'web'), '@deepseek-ai/dsh', '2.0.0');
  const report = doctorReport({
    paths,
    name: record.name,
    record,
    env: { PATH: '' },
    registry: await loadRegistry(home),
    registryHome: home,
  });
  assert.equal(report.ok, false);
  const check = report.checks.find(row => row.id === 'target-copies:dsh');
  assert.equal(check.status, 'error');
  assert.ok(check.detail.includes('1.0.0'));
  assert.ok(check.detail.includes('2.0.0'));
  assert.ok(check.fix.includes(`--${record.name}`));
});

test('doctor fails on PATH shadowing and reports the leaked path', async () => {
  const { record, paths, home } = await environment('shadow');
  await fakePackage(paths.npmPrefix, '@deepseek-ai/dsh', '1.0.0');
  const work = await mkdtemp(join(tmpdir(), 'dpx-shadow-'));
  await writeFile(join(work, 'dsh.cmd'), '@echo off\r\n');
  const report = doctorReport({
    paths,
    name: record.name,
    record,
    env: { PATH: [work, paths.npmPrefix].join(process.platform === 'win32' ? ';' : ':') },
    registry: await loadRegistry(home),
    registryHome: home,
  });
  assert.equal(report.ok, false);
  const check = report.checks.find(row => row.id === 'path-shadowing:dsh');
  assert.equal(check.status, 'error');
  assert.ok(check.detail.includes(join(work, 'dsh.cmd')));
});

test('doctor makes a torn profile store visible before pnpm fails with it', async () => {
  const { record, paths, home } = await environment('store');
  const profile = join(paths.dshHome, 'profiles', 'web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  // pnpm writes `.modules.yaml` as JSON in current versions; the YAML shape is
  // covered by the next case. Both must be readable.
  await writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({
    hoistPattern: ['*'],
    layoutVersion: 5,
    storeDir: 'C:\\host-store\\v11',
    virtualStoreDir: 'D:\\env\\profiles\\web\\node_modules\\.pnpm',
  }, null, 2));

  const installer = readProfileInstaller(profile);
  assert.equal(installer.manager, 'pnpm');
  assert.equal(installer.storeDir, 'C:\\host-store\\v11');
  assert.equal(installer.layoutVersion, '5');

  const report = doctorReport({
    paths,
    name: record.name,
    record,
    env: { PATH: '' },
    registry: await loadRegistry(home),
    registryHome: home,
  });
  assert.equal(report.ok, false);
  const check = report.checks.find(row => row.id === 'profile-store:web');
  assert.equal(check.status, 'error');
  assert.ok(check.detail.includes('C:\\host-store\\v11'));
  assert.ok(check.detail.includes('ERR_PNPM_UNEXPECTED_STORE'));
  assert.ok(check.fix.includes('--store-dir "C:\\host-store\\v11"'));
});

test('the legacy YAML shape of .modules.yaml is still understood', async () => {
  const { paths } = await environment('store-yaml');
  const profile = join(paths.dshHome, 'profiles', 'legacy');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await writeFile(join(profile, 'node_modules', '.modules.yaml'), [
    'hoistPattern:',
    '  - "*"',
    'layoutVersion: 5',
    'storeDir: "D:/env/xdg-data/pnpm/store/v10"',
    '',
  ].join('\n'));
  const installer = readProfileInstaller(profile);
  assert.equal(installer.storeDir, 'D:/env/xdg-data/pnpm/store/v10');
  assert.equal(installer.layoutVersion, '5');
});

test('an empty profile node_modules is scaffolding, not an install', async () => {
  const { record, paths, home } = await environment('empty-nm');
  await mkdir(join(paths.dshHome, 'profiles', 'web', 'node_modules'), { recursive: true });
  assert.equal(readProfileInstaller(join(paths.dshHome, 'profiles', 'web')), undefined);
  const report = doctorReport({
    paths,
    name: record.name,
    record,
    env: { PATH: '' },
    registry: await loadRegistry(home),
    registryHome: home,
  });
  assert.equal(report.checks.some(row => row.id === 'profile-store:web'), false);
  assert.equal(report.ok, true);
});

test('doctor accepts an in-environment profile store', async () => {
  const { record, paths, home } = await environment('store-ok');
  const profile = join(paths.dshHome, 'profiles', 'web');
  const store = join(expectedPnpmStore(paths), 'v11');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await writeFile(join(profile, 'node_modules', '.modules.yaml'), `storeDir: ${store}\nlayoutVersion: 5\n`);
  const report = doctorReport({
    paths,
    name: record.name,
    record,
    env: { PATH: '' },
    registry: await loadRegistry(home),
    registryHome: home,
  });
  const check = report.checks.find(row => row.id === 'profile-store:web');
  assert.equal(check.status, 'ok');
  assert.equal(report.ok, true);
});

test('doctor notices a stale generated guide and a stale registry binding', async () => {
  const { record, paths, home } = await environment('stale');
  const guide = join(paths.dshHome, 'AGENTS.md');
  const text = await readFile(guide, 'utf8');
  await writeFile(guide, text.replace(`dpx:environment-guide:begin v${GUIDE_FORMAT}`, 'dpx:environment-guide:begin v0'));
  const report = doctorReport({
    paths,
    name: record.name,
    record,
    env: { PATH: '' },
    registry: await loadRegistry(home),
    registryHome: home,
  });
  const check = report.checks.find(row => row.id === 'environment-guide');
  assert.equal(check.status, 'warn');
  assert.ok(check.fix.includes(`--${record.name}`));

  const unregistered = doctorReport({ paths, name: record.name, record, env: { PATH: '' }, registry: { environments: [] }, registryHome: home });
  assert.equal(unregistered.checks.find(row => row.id === 'registry-membership').status, 'error');
});

test('doctor reports where the running process thinks it lives', async () => {
  const { record, paths, home } = await environment('inside');
  const registry = await loadRegistry(home);
  const outside = doctorReport({ paths, name: record.name, record, env: { PATH: '' }, registry, registryHome: home });
  assert.match(outside.checks.find(row => row.id === 'process-identity').detail, /不在任何 dpx 环境里/);
  const inside = doctorReport({ paths, name: record.name, record, env: { PATH: '', [DPX_ENV_ROOT_VARIABLE]: paths.root }, registry, registryHome: home });
  assert.match(inside.checks.find(row => row.id === 'process-identity').detail, /就在这个环境里/);
});

test('env use renders a script for each shell and never leaks the parent state', async () => {
  const { record, paths, home } = await environment('shell');
  const powershell = environmentShellScript(paths, { name: record.name, format: 'powershell', env: { PATH: 'host', NODE_OPTIONS: '--evil' }, registryHome: home });
  assert.ok(powershell.includes(`$env:DSH_HOME = '${paths.dshHome.replace(/'/g, "''")}'`));
  assert.ok(powershell.includes(`$env:${DPX_ENV_ROOT_VARIABLE} = '${paths.root}'`));
  assert.ok(powershell.includes(`$env:${DPX_HOME_VARIABLE} = '${home}'`));
  assert.ok(powershell.includes('Remove-Item Env:NODE_OPTIONS'));
  assert.ok(powershell.includes(`$env:PATH = '${paths.npmPrefix}' + ';' + $env:PATH`));

  const cmd = environmentShellScript(paths, { name: record.name, format: 'cmd', env: { PATH: 'host' } });
  assert.ok(cmd.includes(`set "DSH_HOME=${paths.dshHome}"`));
  assert.ok(cmd.includes(`set "PATH=${paths.npmPrefix};%PATH%"`));

  const json = JSON.parse(environmentShellScript(paths, { name: record.name, format: 'json', env: { PATH: 'host' } }));
  assert.equal(json.environment, record.name);
  assert.deepEqual(json.pathPrepend, [paths.npmPrefix]);
  assert.equal(json.set.DSH_HOME, paths.dshHome);

  assert.throws(() => environmentShellScript(paths, { name: record.name, format: 'nushell' }), /Unsupported shell format/);
});

test('the powershell script actually puts a shell inside the environment', { skip: process.platform !== 'win32' }, async () => {
  const { record, paths } = await environment('eval');
  const script = join(paths.tmp, 'dpx-use.ps1');
  await mkdir(paths.tmp, { recursive: true });
  await writeFile(script, [
    environmentShellScript(paths, { name: record.name, format: 'powershell' }),
    'Write-Output $env:DSH_HOME',
    'Write-Output $env:DSH_DPX_ENV_ROOT',
    'Write-Output ($env:PATH -split ";" )[0]',
    'Write-Output ($env:PATH -split ";" )[-1]',
  ].join('\n'));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [dshHome, envRoot, first, last] = result.stdout.trim().split(/\r?\n/);
  assert.equal(dshHome, paths.dshHome);
  assert.equal(envRoot, paths.root);
  assert.equal(first, paths.npmPrefix);
  // "prepend, never replace": whatever the shell already had is still there.
  const inheritedTail = String(process.env.PATH).split(process.platform === 'win32' ? ';' : ':').filter(Boolean).at(-1);
  assert.equal(last, inheritedTail);
});

test('pluginArguments pins the store the profile is already linked from', () => {
  assert.deepEqual(
    pluginArguments({ args: ['add', 'pkg'], storeDir: 'C:\\store' }),
    ['add', 'pkg', '--store-dir', 'C:\\store'],
  );
  assert.deepEqual(
    pluginArguments({ args: ['add', 'pkg', '--store-dir', 'D:\\other'], storeDir: 'C:\\store' }),
    ['add', 'pkg', '--store-dir', 'D:\\other'],
  );
  assert.throws(() => pluginArguments({ args: [], storeDir: 'C:\\store' }), /at least one package spec/);
});

test('profileInstalledPackages reads back both sides of a profile install', async () => {
  const { paths } = await environment('readback');
  const profile = join(paths.dshHome, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '^1.0.0', 'plain-lib': '2.0.0' } }));
  await fakePackage(profile, '@deepseek-ai/dsh', '1.5.0');
  await fakePackage(profile, 'plain-lib', '2.0.0');
  await fakePackage(paths.npmPrefix, '@deepseek-ai/dsh', '1.5.0');
  const rows = profileInstalledPackages(paths, 'web');
  assert.deepEqual(rows, [
    { package: '@deepseek-ai/dsh', version: '1.5.0', globalVersion: '1.5.0', match: true },
    { package: 'plain-lib', version: '2.0.0' },
  ]);
  assert.deepEqual(profileInstalledPackages(paths, 'missing'), []);
});

test('the published guide carries rules, not this machine', async () => {
  // A synthetic root proves the invariant independently of where the tests run:
  // the published block may only contain paths it was handed at render time.
  const synthetic = pathsFor('Q:\\synthetic\\env');
  const guide = renderEnvironmentGuide(synthetic, { name: 'demo', version: '0.1.0' });
  assert.ok(guide.includes(`dpx:environment-guide:begin v${GUIDE_FORMAT}`));
  for (const match of guide.matchAll(/[A-Za-z]:\\[^\s`|)*]*/g)) {
    assert.ok(pathContains(synthetic.root, match[0]), `unexpected literal path: ${match[0]}`);
  }
  for (const leak of ['DevEnvs', 'Workplace_dsh', 'C:\\Users', 'AIPC']) {
    assert.equal(guide.includes(leak), false, `published guide must not mention ${leak}`);
  }
  // The rules it does carry are the ones that end a "which copy ran?" session.
  for (const needle of ['dpx which', 'dpx env doctor', 'dpx env use', 'dpx exec', 'dpx plugin add', DPX_ENV_ROOT_VARIABLE, 'ERR_PNPM_UNEXPECTED_STORE']) {
    assert.ok(guide.includes(needle), `guide should mention ${needle}`);
  }
  // The two hand-editing traps that a Windows host hits while operating an
  // environment, both carried into every generated guide:
  //   - PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM, and Node's
  //     `readFileSync(path, 'utf8')` does not strip it, so the next `JSON.parse`
  //     of a profile manifest throws and the app cannot start;
  //   - a build command reporting success is not proof the artifact is correct.
  for (const needle of ['Set-Content -Encoding utf8', 'UTF8Encoding($false)', '产物正确']) {
    assert.ok(guide.includes(needle), `guide should carry the hand-editing trap: ${needle}`);
  }
  // And the real environment still gets its own paths, not placeholders.
  const { record, paths } = await environment('published');
  const real = renderEnvironmentGuide(paths, { name: record.name, version: '0.1.0' });
  for (const value of [paths.root, paths.npmPrefix, paths.npmCache, paths.dshHome, paths.agentsHome, paths.workspace]) {
    assert.ok(real.includes(value), `rendered guide should contain ${value}`);
  }
});

test('refreshing an environment upgrades an older guide in place', async () => {
  const { record, paths, home } = await environment('upgrade');
  const guide = join(paths.dshHome, 'AGENTS.md');
  const legacy = `# 我自己的规则\n\n总是用中文回答。\n\n<!-- dpx:environment-guide:begin v1 dsh-dpx@0.1.0 -->\n旧内容\n<!-- dpx:environment-guide:end -->\n`;
  await writeFile(guide, legacy);
  await resolveEnvironment(record.name, home);
  const text = await readFile(guide, 'utf8');
  assert.ok(text.includes('总是用中文回答。'));
  assert.equal(text.includes('旧内容'), false);
  assert.ok(text.includes(`dpx:environment-guide:begin v${GUIDE_FORMAT}`));
  assert.equal(text.split('<!-- dpx:environment-guide:begin').length - 1, 1);
  assert.ok(text.indexOf('总是用中文回答。') < text.indexOf('<!-- dpx:environment-guide:begin'));
});

test('isGlobalInstall still gates the npm surface', () => {
  assert.equal(isGlobalInstall(['-g', 'x']), true);
  assert.equal(isGlobalInstall(['--global', 'x']), true);
  assert.equal(isGlobalInstall(['x']), false);
});

test('environment scaffold still exists after the identity changes', async () => {
  const { paths } = await environment('scaffold');
  for (const location of [paths.npmPrefix, paths.dshHome, paths.agentsHome, paths.workspace, paths.descriptor]) {
    assert.ok(existsSync(location), `missing ${location}`);
  }
  await rm(paths.root, { recursive: true, force: true });
});
