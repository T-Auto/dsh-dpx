// `dpx env repair` — the recovery path, and the failure paths around it.
//
// Every other verb in this repository had a test before this file existed; the
// repair verb did not, which is why three of these cases shipped broken:
//
//   * an environment with no profiles yet crashed on a directory it created
//     itself and then failed to read, and the leftover directory made every
//     later run fail the same way;
//   * `--profile <unknown>` was silently filtered out of the target list, so it
//     did nothing and reported success;
//   * a `PROFILE_TEMPLATES` shape upstream had shipped for months was read as
//     "upstream has no template", because only the newer shape was recognized.
//
// The fixture is a real, importable `dsh-app-boot` rather than a manifest stub,
// because `probeAppBoot` does an actual `import()`. That is also what lets the
// legacy shape be exercised at all.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { pathsFor } from '../src/index.js';

const cli = join(import.meta.dirname, '..', 'bin', 'dpx.js');
const node = process.execPath;

function run(args, env) {
  return spawnSync(node, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const HEADLESS_BUNDLES = ['@deepseek-ai/dsh-base'];

/**
 * A real `dsh-app-boot` inside the environment's npm prefix, at the path
 * `probeAppBoot` resolves.
 *
 * `shape` reproduces the two value shapes upstream has shipped: through
 * `0.1.1-rc.2` a template is a bare array of bundles, and from `0.1.2-alpha.2`
 * it is an object carrying `bundles` and `patchReload`.
 */
async function fakeAppBoot(npmPrefix, { shape = 'modern' } = {}) {
  const dsh = join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh');
  const appBoot = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-app-boot');
  await mkdir(join(appBoot, 'lib'), { recursive: true });
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }));
  await writeFile(join(appBoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '1.2.3', type: 'module' }));
  const templates = shape === 'legacy'
    ? `{ web: ${JSON.stringify(WEB_BUNDLES)}, headless: ${JSON.stringify(HEADLESS_BUNDLES)} }`
    : `{ web: { bundles: ${JSON.stringify(WEB_BUNDLES)}, patchReload: 'live' },`
      + ` headless: { bundles: ${JSON.stringify(HEADLESS_BUNDLES)}, patchReload: 'startup' } }`;
  // Mirrors upstream's `initProfile`: it never touches a file that already
  // exists, which is what makes it safe to point at a directory someone else
  // created.
  await writeFile(join(appBoot, 'lib', 'index.js'), `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

export const PROFILE_TEMPLATES = ${templates};
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';

export function initProfile(dir, bundles, patchReload = 'live') {
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({
      name: 'dsh-profile-' + basename(dir),
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles], patchReload } },
    }, undefined, 2) + '\\n');
  }
  const patch = join(dir, PROFILE_PATCH_FILENAME);
  if (!existsSync(patch)) writeFileSync(patch, '[]\\n');
  const workspace = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(workspace)) writeFileSync(workspace, 'packages:\\n  - .\\n');
}

// The two reads dpx derives a third-party profile's bundle list with. Both mirror
// upstream's own exports: probe the resolution paths from one anchor (the
// installation first, then the profile directory) for a directory holding the
// package manifest.
export function readProfileManifest(binName, dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

export function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
      const candidate = join(searchPath, packageName);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
  }
  throw new Error(binName + ': cannot resolve profile bundle ' + JSON.stringify(packageName));
}
`);
}

/** One CLI-only environment, registered in a scratch registry, with app-boot in place. */
async function environmentFixture({ shape = 'modern' } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'dpx-repair-'));
  const storage = join(work, 'storage');
  const registry = join(work, 'registry');
  const fakeNpm = join(work, 'fake-npm.js');
  await writeFile(fakeNpm, '');
  const created = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test', `--${storage}`, '--no-desktop'], {
    DPX_HOME: registry,
    DPX_NPM_CLI: fakeNpm,
    DPX_DISABLE_DISCOVERY: '1',
  });
  assert.equal(created.status, 0, created.stderr);
  const root = join(storage, 'dsh-environments', 'test');
  const paths = pathsFor(root);
  await fakeAppBoot(paths.npmPrefix, { shape });
  return { work, storage, registry, root, paths };
}

function repair(fixture, args = []) {
  return run(['env', 'repair', '--test', ...args], {
    DPX_HOME: fixture.registry,
    DPX_DISABLE_DISCOVERY: '1',
  });
}

/** A profile directory shaped the way a real one is, ready to be broken. */
async function writeProfile(paths, profile, { bundles, dependencies = {}, patch = '[]\n' } = {}) {
  const directory = join(paths.dshHome, 'profiles', profile);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles, patchReload: 'live' } },
  }, null, 2)}\n`);
  if (patch !== null) await writeFile(join(directory, 'cordis.patch.yml'), patch);
  await writeFile(join(directory, 'cordis.yml'), 'x: 1\n');
  await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  return directory;
}

/**
 * A package installed into a profile's own `node_modules`, the way `dsh plugin`
 * leaves one: resolvable from the profile directory, and declaring whether it is a
 * bundle.
 */
async function installPlugin(paths, profile, name, { bundle = true } = {}) {
  const directory = join(paths.dshHome, 'profiles', profile, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  }, null, 2)}\n`);
  return directory;
}

test('an environment with no profiles has nothing to repair and creates nothing', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.profiles, []);
  assert.deepEqual(report.created, []);
  // The old implementation created a directory for every upstream template name
  // here, then crashed reading the manifest it had not written.
  assert.equal(existsSync(join(fixture.paths.dshHome, 'profiles')), false);
});

test('--dry-run on an environment with no profiles writes nothing', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.profiles, []);
  assert.equal(existsSync(join(fixture.paths.dshHome, 'profiles')), false);
  // The registry stamp is the one metadata write, and dry-run must not do it.
  assert.equal(report.registryStamped, undefined);
});

test('naming a profile that does not exist creates it from the upstream template', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture, ['--profile', 'web']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.created, ['web']);
  const directory = join(fixture.paths.dshHome, 'profiles', 'web');
  // A created profile is a real one: manifest, patch layer and pnpm workspace.
  // The old implementation made an empty directory and then failed on it.
  for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    assert.ok(existsSync(join(directory, file)), `created profile is missing ${file}`);
  }
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, WEB_BUNDLES);
});

test('naming a profile upstream has no template for is refused, not invented', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture, ['--profile', 'nope']);
  // It used to be filtered out of the target list, so the command did nothing
  // and exited 0 — success reported for a request that was silently dropped.
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.profiles[0].reason, 'no-upstream-template');
  assert.equal(existsSync(join(fixture.paths.dshHome, 'profiles', 'nope')), false);
});

test('--dry-run on a named profile that does not exist reports it without creating it', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture, ['--profile', 'web', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.created, ['web']);
  assert.equal(existsSync(join(fixture.paths.dshHome, 'profiles', 'web')), false);
});

test('a broken profile keeps its patch byte-for-byte and its dependencies', async () => {
  const fixture = await environmentFixture();
  const brokenPatch = 'this: [is: not, valid: yaml\n  - broken\n\t!!tabs\n';
  const directory = await writeProfile(fixture.paths, 'web', {
    bundles: ['@deepseek-ai/dsh-base', '@evil/third-party-bundle', ...WEB_BUNDLES.slice(1)],
    dependencies: { '@evil/third-party-bundle': '^1.0.0' },
    patch: brokenPatch,
  });
  const untouched = await readFile(join(directory, 'cordis.yml'), 'utf8');

  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).profiles[0];
  assert.equal(row.profile, 'web');
  assert.equal(row.changed, true);
  assert.equal(row.patchExists, true);

  // The whole point of the command: the patch is what broke the profile, so it
  // must be moved aside without ever being parsed. Invalid YAML surviving
  // byte-for-byte is the proof.
  assert.equal(await readFile(row.backupPath, 'utf8'), brokenPatch);
  assert.equal(existsSync(join(directory, 'cordis.patch.yml')), false);

  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, WEB_BUNDLES);
  // Not narrowed the "easy" way: dependencies survive, so nothing reinstalls.
  assert.deepEqual(manifest.dependencies, { '@evil/third-party-bundle': '^1.0.0' });
  assert.equal(await readFile(join(directory, 'cordis.yml'), 'utf8'), untouched);
});

test('an empty patch layer is never backed up, and a clean profile stays untouched', async () => {
  const fixture = await environmentFixture();
  const directory = await writeProfile(fixture.paths, 'web', { bundles: ['@evil/third-party-bundle'] });
  const first = repair(fixture);
  assert.equal(first.status, 0, first.stderr);
  const firstRow = JSON.parse(first.stdout).profiles[0];
  assert.equal(firstRow.kind, 'repaired');
  // The patch file holds the shipped empty layer (`[]`), so there is nothing in it
  // to preserve. The old code renamed it anyway, which left one `.bak-` file per
  // profile per run and, for a profile whose only repairable part is the patch
  // layer, made the whole run a no-op that still littered.
  assert.equal(firstRow.patchExists, true);
  assert.equal(firstRow.patchEmpty, true);
  assert.equal(firstRow.backupPath, undefined);
  assert.equal(existsSync(join(directory, 'cordis.patch.yml')), true);
  assert.deepEqual((await readdir(directory)).filter(name => name.includes('.bak-')), []);

  const second = repair(fixture);
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout);
  assert.equal(report.profiles[0].kind, 'unchanged');
  assert.equal(report.profiles[0].changed, false);
  assert.match(report.message, /没有 patch 文件需要备份/);
});

test('a manifest that carries a BOM is repaired rather than reported as damaged', async () => {
  const fixture = await environmentFixture();
  const directory = await writeProfile(fixture.paths, 'web', { bundles: ['@evil/third-party-bundle'] });
  const manifestPath = join(directory, 'package.json');
  await writeFile(manifestPath, `\uFEFF${await readFile(manifestPath, 'utf8')}`);

  const result = repair(fixture);
  // `dpx env repair` exists to survive a BOM'd manifest, so it cannot classify one
  // as damaged: the reader strips the BOM (for parsing only) and the write path
  // produces a manifest without it.
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).profiles[0];
  assert.equal(row.kind, 'repaired');
  assert.equal(row.manifestRewritten, true);
  const text = await readFile(manifestPath, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(JSON.parse(text).dsh.profile.bundles, WEB_BUNDLES);
});

test('a custom profile with no upstream template gets the patch half and keeps its bundles', async () => {
  const fixture = await environmentFixture();
  const broken = 'this: [is: not, valid: yaml\n  - broken\n\t!!tabs\n';
  const directory = await writeProfile(fixture.paths, 'custom', {
    bundles: ['@deepseek-ai/dsh-base', '@evil/third-party-bundle'],
    dependencies: { '@evil/third-party-bundle': '^1.0.0' },
    patch: broken,
  });

  const result = repair(fixture);
  // A third-party profile is not a failure. A batch scan reports the half it could
  // not do and exits zero, so a repair run in a script or a CI job never goes red
  // merely because the environment contains a profile upstream ships no template
  // for.
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const row = report.profiles.find(candidate => candidate.profile === 'custom');
  assert.equal(row.kind, 'repaired');
  assert.equal(row.bundlesSource, 'untouched');
  assert.equal(row.changed, false);
  // The one action that needs no bundle list: the broken patch layer is preserved
  // byte-for-byte and stops being loaded.
  assert.equal(row.patchExists, true);
  assert.equal(await readFile(row.backupPath, 'utf8'), broken);
  assert.equal(existsSync(join(directory, 'cordis.patch.yml')), false);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@evil/third-party-bundle']);
  assert.deepEqual(manifest.dependencies, { '@evil/third-party-bundle': '^1.0.0' });
  // The half that was not done is stated, on stderr, without failing the command.
  assert.deepEqual(report.warnings.length, 1);
  assert.match(report.warnings[0], /无出厂模板：custom/);
  assert.match(result.stderr, /\[WARN\] 无出厂模板：custom/);
});

test('naming a custom profile explicitly repairs it as well', async () => {
  const fixture = await environmentFixture();
  await writeProfile(fixture.paths, 'custom', { bundles: ['@deepseek-ai/dsh-base'], patch: 'broken: [\n' });
  const result = repair(fixture, ['--profile', 'custom']);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).profiles[0];
  assert.equal(row.kind, 'repaired');
  // An explicit name is a request, not a permission: the same two halves run. With
  // no dependencies to read, the derived list is the in-box layer the profile
  // already had, so the patch half is the whole change.
  assert.equal(row.bundlesSource, 'derived-from-install');
  assert.equal(row.changed, false);
  assert.equal(row.patchEmpty, false);
});

test('naming a custom profile that does not exist is the one no-template failure', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture, ['--profile', 'custom']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.profiles[0].kind, 'failed');
  assert.equal(report.profiles[0].reason, 'no-upstream-template');
  assert.equal(existsSync(join(fixture.paths.dshHome, 'profiles', 'custom')), false);
});

test('a run whose rows are all unchanged still exits zero, and says so', async () => {
  const fixture = await environmentFixture();
  await writeProfile(fixture.paths, 'web', { bundles: WEB_BUNDLES, patch: null });
  await writeProfile(fixture.paths, 'custom', { bundles: ['@deepseek-ai/dsh-base'], patch: null });
  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  const kinds = new Map(report.profiles.map(row => [row.profile, row.kind]));
  assert.equal(kinds.get('web'), 'unchanged');
  assert.equal(kinds.get('custom'), 'unchanged');
  // `repaired` is the compatibility view of the same rows: not a failure.
  assert.deepEqual(report.profiles.map(row => row.repaired), [true, true]);
  assert.match(report.message, /本就无需处理 2 个/);
});

test('the legacy bare-array template shape is read, not misreported as missing', async () => {
  const fixture = await environmentFixture({ shape: 'legacy' });
  await writeProfile(fixture.paths, 'web', { bundles: ['@evil/third-party-bundle'] });
  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).profiles[0];
  assert.equal(row.repaired, true, row.message);
  assert.deepEqual(row.bundles, WEB_BUNDLES);
});

test('a directory without a manifest is ignored rather than allowed to block repair', async () => {
  const fixture = await environmentFixture();
  // What a crashed older dpx left behind. It used to be picked up as a profile
  // and throw on every subsequent run, so the environment could never recover.
  await mkdir(join(fixture.paths.dshHome, 'profiles', 'web'), { recursive: true });
  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.profiles, []);
  assert.equal(report.ignored.length, 1);
  assert.equal(report.ignored[0].profile, 'web');
  assert.equal(report.ignored[0].reason, 'not-a-profile');
});

test('one unreadable profile does not stop the others from being repaired', async () => {
  const fixture = await environmentFixture();
  const good = await writeProfile(fixture.paths, 'headless', { bundles: ['@evil/third-party-bundle'] });
  const damaged = join(fixture.paths.dshHome, 'profiles', 'web');
  await mkdir(damaged, { recursive: true });
  await writeFile(join(damaged, 'package.json'), '{ this is not json');

  const result = repair(fixture);
  const report = JSON.parse(result.stdout);
  const rows = new Map(report.profiles.map(row => [row.profile, row]));
  assert.equal(rows.get('web').repaired, false);
  assert.equal(rows.get('web').reason, 'unrepairable');
  assert.equal(rows.get('headless').repaired, true);
  // The good one really was repaired, and the bad one still fails the command.
  const manifest = JSON.parse(await readFile(join(good, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, HEADLESS_BUNDLES);
  assert.equal(result.status, 1);
});

test('the summary reports skips and claims no work it did not do', async () => {
  const fixture = await environmentFixture();
  const result = repair(fixture, ['--profile', 'nope']);
  const report = JSON.parse(result.stdout);
  assert.match(report.message, /没有修复任何 profile/);
  assert.match(report.message, /no-upstream-template/);
  assert.doesNotMatch(report.message, /已备份/);
});

test('the summary names the directories it ignored', async () => {
  const fixture = await environmentFixture();
  await mkdir(join(fixture.paths.dshHome, 'profiles', 'leftover'), { recursive: true });
  // No --profile on purpose: naming one forces `ignored` empty, which is how the
  // ignore wording went unasserted while looking covered.
  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).message, /忽略 1 个非 profile 目录：leftover/);
});

test('the summary does not claim a narrowing that did not happen', async () => {
  const fixture = await environmentFixture();
  // Already on the template and with no patch file: repair has nothing to do.
  await writeProfile(fixture.paths, 'web', { bundles: WEB_BUNDLES, patch: null });
  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.profiles[0].changed, false);
  assert.match(report.message, /bundles 本就与上游内建集合一致/);
  assert.doesNotMatch(report.message, /收窄/);
});

test('a directory with a patch but no manifest is completed, not declared healthy', async () => {
  const fixture = await environmentFixture();
  const directory = join(fixture.paths.dshHome, 'profiles', 'web');
  await mkdir(directory, { recursive: true });
  const brokenPatch = 'still: [broken\n\t!!x\n';
  await writeFile(join(directory, 'cordis.patch.yml'), brokenPatch);

  const result = repair(fixture, ['--profile', 'web']);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).profiles[0];
  assert.equal(row.created, true);
  // `initProfile` fills the manifest in, but the patch that was already sitting
  // there is still the most likely reason the profile would not boot. Declaring
  // the profile healthy without moving it would report success over a live
  // breakage.
  assert.equal(row.patchExists, true);
  assert.equal(await readFile(row.backupPath, 'utf8'), brokenPatch);
  assert.equal(existsSync(join(directory, 'cordis.patch.yml')), false);
});

test('an empty --profile is refused instead of repairing every profile', async () => {
  const fixture = await environmentFixture();
  await writeProfile(fixture.paths, 'web', { bundles: ['@evil/third-party-bundle'] });
  for (const args of [['--profile='], ['--profile', '']]) {
    const result = repair(fixture, args);
    assert.equal(result.status, 1, `expected a refusal for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /需要一个非空的 profile 名/);
  }
  // The whole-environment rewrite the empty value used to fall back to did not run.
  const manifest = JSON.parse(await readFile(join(fixture.paths.dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@evil/third-party-bundle']);
});

test('a creation that fails is a row, not an aborted command', async () => {
  const fixture = await environmentFixture();
  // The profile path is a plain file, so upstream's `mkdirSync` throws.
  await mkdir(join(fixture.paths.dshHome, 'profiles'), { recursive: true });
  await writeFile(join(fixture.paths.dshHome, 'profiles', 'web'), 'not a directory');

  const result = repair(fixture, ['--profile', 'web']);
  // Previously stdout was empty and the caller's JSON.parse threw with it.
  const report = JSON.parse(result.stdout);
  assert.equal(report.profiles[0].repaired, false);
  assert.equal(report.profiles[0].reason, 'cannot-create');
  assert.equal(result.status, 1);
});

test('a third-party bundle list is derived from the installed state', async () => {
  const fixture = await environmentFixture();
  const directory = await writeProfile(fixture.paths, 'custom', {
    // Drifted: the plugin is installed, but it is missing from the layer list.
    bundles: ['@deepseek-ai/dsh-base'],
    dependencies: { '@evil/third-party-bundle': '^1.0.0' },
    patch: null,
  });
  await installPlugin(fixture.paths, 'custom', '@evil/third-party-bundle');

  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const row = report.profiles[0];
  assert.equal(row.kind, 'repaired');
  assert.equal(row.bundlesSource, 'derived-from-install');
  assert.deepEqual(row.bundles, ['@deepseek-ai/dsh-base', '@evil/third-party-bundle']);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@evil/third-party-bundle']);
  // The in-box layer is kept, the installed plugin joins the stack, and the run
  // says which list it wrote rather than implying an upstream template.
  assert.match(report.warnings[0], /按安装事实推导/);
});

test('a dependency that declares no dsh.bundle is not turned into a layer', async () => {
  const fixture = await environmentFixture();
  await writeProfile(fixture.paths, 'custom', {
    bundles: ['@deepseek-ai/dsh-base'],
    dependencies: { '@evil/plain-library': '^1.0.0' },
    patch: null,
  });
  await installPlugin(fixture.paths, 'custom', '@evil/plain-library', { bundle: false });

  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).profiles[0];
  assert.equal(row.kind, 'unchanged');
  assert.equal(row.bundlesSource, 'derived-from-install');
  assert.deepEqual(row.bundles, ['@deepseek-ai/dsh-base']);
});

test('a listed bundle that cannot be verified refuses the derived list', async () => {
  const fixture = await environmentFixture();
  const broken = 'still: [broken\n\t!!x\n';
  const directory = await writeProfile(fixture.paths, 'custom', {
    // The `dsh-tui` shape: a third-party layer is listed and its package is not
    // installed where dpx can read it. Narrowing to a list computed without it
    // would drop the user's layer on the strength of a package nobody can read, so
    // the derivation refuses and the patch half runs instead.
    bundles: ['@deepseek-ai/dsh-base', '@evil/third-party-bundle'],
    dependencies: { '@evil/third-party-bundle': '^1.0.0' },
    patch: broken,
  });

  const result = repair(fixture);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const row = report.profiles[0];
  assert.equal(row.bundlesSource, 'untouched');
  assert.equal(row.changed, false);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@evil/third-party-bundle']);
  assert.equal(await readFile(row.backupPath, 'utf8'), broken);
  assert.match(report.warnings[0], /无法核实/);
});
