import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = join(import.meta.dirname, '..', 'bin', 'dpx.js');
const node = process.execPath;

function run(args, env) {
  return spawnSync(node, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('dpx cli installs into the selected isolated npm prefix without network', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
  const storage = join(work, 'storage');
  const registry = join(work, 'registry');
  const fakeNpm = join(work, 'fake-npm.js');
  const capture = join(work, 'npm-capture.json');
  await writeFile(fakeNpm, `import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path';\nconst args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1]; const cache=args[args.indexOf('--cache')+1]; await mkdir(join(prefix,'node_modules','@deepseek-ai','dsh'),{recursive:true}); await writeFile(join(prefix,'node_modules','@deepseek-ai','dsh','package.json'),'{}'); await writeFile(process.env.CAPTURE,JSON.stringify({args, env:{cache:process.env.NPM_CONFIG_CACHE,prefix:process.env.NPM_CONFIG_PREFIX,argCache:cache,nodeOptions:process.env.NODE_OPTIONS,httpsProxy:process.env.HTTPS_PROXY,npmProxy:process.env.npm_config_proxy}}));`);
  const result = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test', `--${storage}`], {
    DPX_HOME: registry,
    DPX_NPM_CLI: fakeNpm,
    CAPTURE: capture,
    NODE_OPTIONS: '--trace-warnings',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    npm_config_proxy: 'http://127.0.0.1:7897',
    DPX_DISABLE_DISCOVERY: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const root = join(storage, 'dsh-environments', 'test');
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  // npm is native: the target is expressed with flags, never with NPM_CONFIG_*.
  assert.equal(captured.env.prefix, undefined);
  assert.equal(captured.env.cache, undefined);
  assert.equal(captured.args[captured.args.indexOf('--prefix') + 1], join(root, 'npm-prefix'));
  assert.equal(captured.env.argCache, join(root, 'npm-cache'));
  assert.equal(captured.env.nodeOptions, undefined);
  assert.equal(captured.env.httpsProxy, undefined);
  assert.equal(captured.env.npmProxy, undefined);
  assert.ok(captured.args.includes('--no-audit'));
  assert.ok(captured.args.includes('--proxy=null'));
  assert.ok(captured.args.includes('--https-proxy=null'));
  assert.ok(captured.args.includes('--no-fund'));
  assert.ok(existsSync(join(root, 'npm-prefix', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  // The environment-level instruction file is written for every launch path.
  const guide = await readFile(join(root, 'dsh-home', 'AGENTS.md'), 'utf8');
  assert.ok(guide.includes(join(root, 'npm-prefix')));
  assert.ok(guide.includes(join(root, 'npm-cache')));
  const listed = run(['env', 'list'], { DPX_HOME: registry });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).environments[0].name, 'test');
});

test('dpx copies the packaged desktop launcher by default and omits it with --no-desktop', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
  const storage = join(work, 'storage');
  const registry = join(work, 'registry');
  const artifact = join(work, 'desktop.exe');
  const fakeNpm = join(work, 'fake-npm.js');
  await writeFile(artifact, 'launcher');
  await writeFile(fakeNpm, '');
  const common = { DPX_HOME: registry, DPX_NPM_CLI: fakeNpm, DPX_DESKTOP_ARTIFACT: artifact, DPX_DISABLE_DISCOVERY: '1' };
  const desktop = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--desktop', `--${storage}`], common);
  assert.equal(desktop.status, 0, desktop.stderr);
  const copied = join(storage, 'dsh-environments', 'desktop', 'desktop', 'DSH DeepSeek Harness Desktop.exe');
  if (process.platform === 'win32') assert.equal(await readFile(copied, 'utf8'), 'launcher');
  else assert.equal(existsSync(copied), false);
  const cliOnly = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--cli', `--${storage}`, '--no-desktop'], common);
  assert.equal(cliOnly.status, 0, cliOnly.stderr);
  assert.equal(existsSync(join(storage, 'dsh-environments', 'cli', 'desktop', 'DSH DeepSeek Harness Desktop.exe')), false);
});

test('dpx rejects reuse before a named environment is registered', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
  const result = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test'], { DPX_HOME: join(work, 'registry') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not registered/);
});

/**
 * One environment shaped like a real one: a "global" copy of each launch target
 * in `npm-prefix`, plus an ambient PATH that either keeps the environment first
 * or leaks a host shim ahead of it.
 */
async function environmentFixture() {
  const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
  const storage = join(work, 'storage');
  const registry = join(work, 'registry');
  const fakeNpm = join(work, 'fake-npm.js');
  const root = join(storage, 'dsh-environments', 'test');
  await writeFile(fakeNpm, `import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path';\nconst args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1]; for (const [name, version] of [['@deepseek-ai/dsh','1.2.3'],['@deepseek-harness-tui/dsh-tui','0.10.0']]) { const dir=join(prefix,'node_modules',...name.split('/')); await mkdir(dir,{recursive:true}); await writeFile(join(dir,'package.json'),JSON.stringify({name,version,bin:{}})); }`);
  const installed = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test', `--${storage}`], {
    DPX_HOME: registry,
    DPX_NPM_CLI: fakeNpm,
    DPX_DISABLE_DISCOVERY: '1',
  });
  assert.equal(installed.status, 0, installed.stderr);
  const hostShim = join(work, 'host-shims');
  await mkdir(hostShim, { recursive: true });
  await writeFile(join(hostShim, 'dsh.cmd'), '@echo off\r\n');
  await writeFile(join(hostShim, 'dsh-tui.cmd'), '@echo off\r\n');
  const nodeDir = dirname(process.execPath);
  const cleanPath = [join(root, 'npm-prefix'), nodeDir, 'C:\\Windows'].join(';');
  const leakedPath = [hostShim, nodeDir, join(root, 'npm-prefix'), 'C:\\Windows'].join(';');
  return { work, registry, root, hostShim, cleanPath, leakedPath };
}

test('dpx which answers "which copy would run" without running it', async () => {
  const fixture = await environmentFixture();
  const clean = run(['which', '--test'], { DPX_HOME: fixture.registry, PATH: fixture.cleanPath });
  assert.equal(clean.status, 0, clean.stderr);
  const report = JSON.parse(clean.stdout);
  assert.equal(report.environment, 'test');
  assert.equal(report.targets[0].verdict, 'clean');
  assert.equal(report.targets[0].isolated.present, true);
  assert.equal(report.targets[0].isolated.version, '1.2.3');
  assert.match(report.targets[0].isolated.via, /dpx run --test dsh/);

  const leaked = run(['which', '--test', 'dsh'], { DPX_HOME: fixture.registry, PATH: fixture.leakedPath });
  assert.equal(leaked.status, 0, leaked.stderr);
  const single = JSON.parse(leaked.stdout);
  assert.equal(single.target, 'dsh');
  assert.equal(single.verdict, 'host-leak');
  assert.equal(single.ambientPath[0].file, join(fixture.hostShim, 'dsh.cmd'));
  assert.ok(single.advice.includes(join(fixture.hostShim, 'dsh.cmd')));

  const unknown = run(['which', '--test', 'nope'], { DPX_HOME: fixture.registry, PATH: fixture.cleanPath });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unsupported launch target/);
});

test('dpx env doctor exits non-zero exactly when the environment is not self-consistent', async () => {
  const fixture = await environmentFixture();
  const clean = run(['env', 'doctor', '--test'], { DPX_HOME: fixture.registry, PATH: fixture.cleanPath });
  assert.equal(clean.status, 0, clean.stderr);
  const report = JSON.parse(clean.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.registry, fixture.registry);
  assert.equal(report.checks.find(row => row.id === 'registry-binding').status, 'ok');
  assert.equal(report.checks.find(row => row.id === 'environment-guide').status, 'ok');

  const leaked = run(['env', 'doctor', '--test'], { DPX_HOME: fixture.registry, PATH: fixture.leakedPath });
  assert.equal(leaked.status, 1);
  const broken = JSON.parse(leaked.stdout);
  assert.equal(broken.ok, false);
  const shadowed = broken.checks.find(row => row.id === 'path-shadowing:dsh');
  assert.equal(shadowed.status, 'error');
  assert.ok(shadowed.fix.includes('dpx run --test dsh'));
});

test('dpx env use prints a script for the current shell, and blocks nothing', async () => {
  const fixture = await environmentFixture();
  const powershell = run(['env', 'use', '--test', '--format', 'powershell'], { DPX_HOME: fixture.registry });
  assert.equal(powershell.status, 0, powershell.stderr);
  assert.ok(powershell.stdout.includes(`$env:DSH_HOME = '${join(fixture.root, 'dsh-home')}'`));
  assert.ok(powershell.stdout.includes(`$env:DSH_DPX_ENV_ROOT = '${fixture.root}'`));
  assert.ok(powershell.stdout.includes(`$env:DPX_HOME = '${fixture.registry}'`));
  assert.ok(powershell.stdout.includes(`$env:PATH = '${join(fixture.root, 'npm-prefix')}' + ';' + $env:PATH`));

  const json = run(['env', 'use', '--test', '--format', 'json'], { DPX_HOME: fixture.registry });
  assert.equal(JSON.parse(json.stdout).envRoot, fixture.root);

  const bad = run(['env', 'use', '--test', '--format', 'nushell'], { DPX_HOME: fixture.registry });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unsupported shell format/);
});

test('dpx exec runs an arbitrary command inside the environment', async () => {
  const fixture = await environmentFixture();
  const result = run(
    ['exec', '--test', '--', process.execPath, '-e', 'process.stdout.write([process.env.DSH_HOME, process.env.DSH_DPX_ENV_ROOT, process.env.DSH_DPX_ENV].join("|"))'],
    { DPX_HOME: fixture.registry, PATH: fixture.cleanPath },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [join(fixture.root, 'dsh-home'), fixture.root, 'test'].join('|'));

  // `--cwd` is honoured, and the default is the environment workspace.
  const cwd = run(['exec', '--test', '--cwd', fixture.work, '--', process.execPath, '-e', 'process.stdout.write(process.cwd())'], { DPX_HOME: fixture.registry, PATH: fixture.cleanPath });
  assert.equal(cwd.stdout, fixture.work);

  const noCommand = run(['exec', '--test', '--'], { DPX_HOME: fixture.registry, PATH: fixture.cleanPath });
  assert.notEqual(noCommand.status, 0);
  assert.match(noCommand.stderr, /dpx exec --<name>/);
});

test('dpx plugin add pins the store the profile is already linked from', async () => {
  const fixture = await environmentFixture();
  const profile = join(fixture.root, 'dsh-home', 'profiles', 'web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await writeFile(join(profile, 'node_modules', '.modules.yaml'), 'storeDir: C:\\host-store\\v11\nlayoutVersion: 5\n');

  const dryRun = run(['plugin', 'add', '--test', 'some-plugin', '--profile', 'web', '--dry-run'], { DPX_HOME: fixture.registry });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.profile, 'web');
  assert.equal(plan.store.path, 'C:\\host-store\\v11');
  assert.equal(plan.store.source, 'existing-node_modules');
  assert.ok(plan.command.includes('--store-dir C:\\host-store\\v11'));
  assert.equal(plan.dryRun, true);

  const missingSpec = run(['plugin', 'add', '--test', '--profile', 'web'], { DPX_HOME: fixture.registry });
  assert.notEqual(missingSpec.status, 0);
  assert.match(missingSpec.stderr, /at least one package spec/);
});
