import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createEnvironment,
  environmentDescriptor,
  isGlobalInstall,
  loadRegistry,
  npmInstallArguments,
  parseEnvironmentArguments,
  pathsFor,
  removeEnvironment,
  resolveEnvironment,
  runtimeEnvironment,
} from '../src/index.js';
import { environmentGuidePath } from '../src/environment-guide.js';

test('parses the requested npm syntax with name and absolute storage root', () => {
  const parsed = parseEnvironmentArguments([
    '-g', '@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui', '--test', '--D:\\DevEnvs\\Projects',
  ]);
  assert.deepEqual(parsed, {
    name: 'test',
    root: process.platform === 'win32' ? 'D:\\DevEnvs\\Projects' : process.cwd() + '/D:\\DevEnvs\\Projects',
    passthrough: ['-g', '@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui'],
    desktop: true,
  });
});

test('forwards target flags rather than mistaking them for environment selectors', () => {
  const parsed = parseEnvironmentArguments(['--test', '--version', '--no-open', '--resume']);
  assert.equal(parsed.name, 'test');
  assert.equal(parsed.desktop, true);
  assert.deepEqual(parsed.passthrough, ['--version', '--no-open', '--resume']);
});

test('recognizes --no-desktop as a DPX-only creation option', () => {
  const parsed = parseEnvironmentArguments(['-g', '@deepseek-ai/dsh', '--test', '--no-desktop']);
  assert.equal(parsed.name, 'test');
  assert.equal(parsed.desktop, false);
  assert.deepEqual(parsed.passthrough, ['-g', '@deepseek-ai/dsh']);
});

test('can preserve --no-desktop for a target command', () => {
  const parsed = parseEnvironmentArguments(['--test', 'dsh', '--no-desktop'], { parseDesktop: false });
  assert.equal(parsed.desktop, true);
  assert.deepEqual(parsed.passthrough, ['dsh', '--no-desktop']);
});

test('requires a named selector and rejects malformed names', () => {
  assert.throws(() => parseEnvironmentArguments(['-g', '@deepseek-ai/dsh']), /environment name is required/i);
  assert.throws(() => parseEnvironmentArguments(['--bad_name']), /environment name is required/i);
});

test('creates a private isolated environment and a discoverable record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'test', storageRoot: root, home, publishDiscovery: false, platform: 'win32' });
  const paths = pathsFor(record.root);
  assert.equal(record.name, 'test');
  assert.match(record.instance.instanceId, /^urn:uuid:/);
  assert.equal(record.discoverableEntry.status, 'published');
  assert.ok(record.discoverableEntry.contentDigest.startsWith('sha256:'));
  for (const location of [paths.npmPrefix, paths.npmCache, paths.dshHome, paths.agentsHome, paths.workspace, paths.desktopHome, paths.desktop, paths.descriptor, paths.manifest]) {
    assert.ok(existsSync(location), `missing ${location}`);
  }
  assert.deepEqual(JSON.parse(await readFile(paths.descriptor, 'utf8')), environmentDescriptor({ desktop: true }));
  assert.deepEqual(record.desktop, { platform: 'win32', launcher: './desktop/DSH DeepSeek Harness Desktop.exe' });
  assert.deepEqual(await resolveEnvironment('test', home), record);
  const registry = await loadRegistry(home);
  assert.equal(registry.revision, 1);
  assert.equal(registry.environments.length, 1);
  const second = await createEnvironment({ name: 'test', storageRoot: root, home, publishDiscovery: false, platform: 'win32' });
  assert.deepEqual(second, record);
});

test('repairs the isolated Windows Desktop when reusing an older environment', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'repair', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
  const paths = pathsFor(record.root);
  await rm(paths.desktopHome, { recursive: true, force: true });
  assert.equal(existsSync(paths.desktopHome), false);
  await createEnvironment({ name: 'repair', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
  assert.equal(existsSync(paths.desktopHome), true);
});

test('can create a CLI-only environment without copying a desktop launcher', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'cli', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
  assert.equal(existsSync(pathsFor(record.root).desktop), false);
  assert.equal(record.desktop, undefined);
});

test('does not require or copy the Windows launcher outside Windows', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'linux', storageRoot: storage, home, publishDiscovery: false, platform: 'linux' });
  assert.equal(existsSync(pathsFor(record.root).desktop), false);
  assert.equal(record.desktop, undefined);
});

test('rejects changing the storage root for an existing environment', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const other = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false });
  await assert.rejects(createEnvironment({ name: 'test', storageRoot: other, home, publishDiscovery: false, desktop: false }), /already registered/);
});

test('removes a registered environment and optionally purges only its managed root', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'remove', storageRoot: storage, home, publishDiscovery: false, desktop: false });
  const removed = await removeEnvironment({ name: 'remove', home, purge: true });
  assert.equal(removed.record.root, record.root);
  assert.equal(removed.purged, true);
  assert.equal(existsSync(record.root), false);
  assert.equal((await loadRegistry(home)).environments.length, 0);
});

test('builds npm and DSH environments rooted wholly in the selected environment', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'qa', storageRoot: storage, home, publishDiscovery: false });
  const paths = pathsFor(record.root);
  assert.equal(isGlobalInstall(['install', '-g', 'x']), true);
  assert.deepEqual(
    npmInstallArguments(['-g', 'x'], paths.npmPrefix, paths.npmCache),
    ['-g', 'x', '--prefix', paths.npmPrefix, '--cache', paths.npmCache, '--no-audit', '--no-fund', '--proxy=null', '--https-proxy=null'],
  );
  assert.deepEqual(
    npmInstallArguments(['-g', 'x', '--proxy=http://127.0.0.1:7897', '--https-proxy=http://127.0.0.1:7897'], paths.npmPrefix, paths.npmCache),
    ['-g', 'x', '--proxy=http://127.0.0.1:7897', '--https-proxy=http://127.0.0.1:7897', '--prefix', paths.npmPrefix, '--cache', paths.npmCache, '--no-audit', '--no-fund'],
  );
  assert.throws(() => npmInstallArguments(['x'], paths.npmPrefix, paths.npmCache), /global installs/);
  assert.throws(() => npmInstallArguments(['-g', 'x', '--cache=C:\\other'], paths.npmPrefix, paths.npmCache), /owns npm --cache/);
  const env = runtimeEnvironment(paths, { PATH: 'host-path', NODE_OPTIONS: '--evil', NODE_PATH: 'bad', HTTPS_PROXY: 'http://127.0.0.1:7897', npm_config_proxy: 'http://127.0.0.1:7897', NPM_CONFIG_PREFIX: 'C:\\host-prefix' });
  assert.equal(env.DSH_HOME, paths.dshHome);
  assert.equal(env.DSH_AGENTS_HOME, paths.agentsHome);
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.npm_config_proxy, undefined);
});

test('never hijacks npm defaults for a dsh/tui child process', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'native', storageRoot: storage, home, publishDiscovery: false, desktop: false });
  const paths = pathsFor(record.root);
  const env = runtimeEnvironment(paths, {});
  for (const key of ['NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'npm_config_prefix', 'npm_config_cache']) {
    assert.equal(env[key], undefined, `runtime env must not set ${key}`);
  }
  assert.equal(env.PATH.split(process.platform === 'win32' ? ';' : ':')[0], paths.npmPrefix);
});

test('writes and refreshes the environment-level AGENTS.md that every launcher reads', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'guide', storageRoot: storage, home, publishDiscovery: false, desktop: false });
  const paths = pathsFor(record.root);
  assert.equal(existsSync(paths.desktop), false);
  const guide = join(paths.dshHome, 'AGENTS.md');
  assert.equal(existsSync(guide), true);
  assert.equal(environmentGuidePath(paths), guide);
  const text = await readFile(guide, 'utf8');
  assert.match(text, /dsh-dpx/);
  assert.match(text, /--prefix/);
  assert.match(text, /--cache/);
  assert.ok(text.includes(paths.npmPrefix));
  assert.ok(text.includes(paths.npmCache));
  assert.ok(text.includes(paths.root));
  assert.ok(text.includes('guide'));
  // Reusing the environment refreshes the managed block instead of appending it twice.
  await resolveEnvironment('guide', home);
  const refreshed = await readFile(guide, 'utf8');
  assert.equal(refreshed, text);
  assert.equal(refreshed.split('<!-- dpx:environment-guide:begin').length - 1, 1);
});

test('keeps instructions a user wrote outside the managed AGENTS.md block', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'custom', storageRoot: storage, home, publishDiscovery: false, desktop: false });
  const paths = pathsFor(record.root);
  const guide = join(paths.dshHome, 'AGENTS.md');
  await writeFile(guide, '# 我自己的全局规则\n\n总是用中文回答。\n');
  const second = await createEnvironment({ name: 'custom', storageRoot: storage, home, publishDiscovery: false, desktop: false });
  assert.equal(second.name, 'custom');
  const text = await readFile(guide, 'utf8');
  assert.match(text, /总是用中文回答。/);
  assert.equal(text.split('<!-- dpx:environment-guide:begin').length - 1, 1);
  assert.ok(text.indexOf('总是用中文回答。') < text.indexOf('<!-- dpx:environment-guide:begin'));
});
