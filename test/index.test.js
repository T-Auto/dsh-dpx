import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  resolveEnvironment,
  runtimeEnvironment,
} from '../src/index.js';

test('parses the requested npm syntax with name and absolute storage root', () => {
  const parsed = parseEnvironmentArguments([
    '-g', '@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui', '--test', '--D:\\DevEnvs\\Projects',
  ]);
  assert.deepEqual(parsed, {
    name: 'test',
    root: process.platform === 'win32' ? 'D:\\DevEnvs\\Projects' : process.cwd() + '/D:\\DevEnvs\\Projects',
    passthrough: ['-g', '@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui'],
  });
});

test('forwards target flags rather than mistaking them for environment selectors', () => {
  const parsed = parseEnvironmentArguments(['--test', '--version', '--no-open', '--resume']);
  assert.equal(parsed.name, 'test');
  assert.deepEqual(parsed.passthrough, ['--version', '--no-open', '--resume']);
});

test('requires a named selector and rejects malformed names', () => {
  assert.throws(() => parseEnvironmentArguments(['-g', '@deepseek-ai/dsh']), /environment name is required/i);
  assert.throws(() => parseEnvironmentArguments(['--bad_name']), /environment name is required/i);
});

test('creates a private isolated environment and a discoverable record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'test', storageRoot: root, home, publishDiscovery: false });
  const paths = pathsFor(record.root);
  assert.equal(record.name, 'test');
  assert.match(record.instance.instanceId, /^urn:uuid:/);
  assert.equal(record.discoverableEntry.status, 'published');
  assert.ok(record.discoverableEntry.contentDigest.startsWith('sha256:'));
  for (const location of [paths.npmPrefix, paths.npmCache, paths.dshHome, paths.agentsHome, paths.workspace, paths.descriptor, paths.manifest]) {
    assert.ok(existsSync(location), `missing ${location}`);
  }
  assert.deepEqual(JSON.parse(await readFile(paths.descriptor, 'utf8')), environmentDescriptor());
  assert.deepEqual(await resolveEnvironment('test', home), record);
  const registry = await loadRegistry(home);
  assert.equal(registry.revision, 1);
  assert.equal(registry.environments.length, 1);
  const second = await createEnvironment({ name: 'test', storageRoot: root, home, publishDiscovery: false });
  assert.deepEqual(second, record);
});

test('rejects changing the storage root for an existing environment', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const other = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false });
  await assert.rejects(createEnvironment({ name: 'test', storageRoot: other, home, publishDiscovery: false }), /already registered/);
});

test('builds npm and DSH environments rooted wholly in the selected environment', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'qa', storageRoot: storage, home, publishDiscovery: false });
  const paths = pathsFor(record.root);
  assert.equal(isGlobalInstall(['install', '-g', 'x']), true);
  assert.deepEqual(npmInstallArguments(['-g', 'x'], paths.npmPrefix), ['-g', 'x', '--prefix', paths.npmPrefix, '--no-audit', '--no-fund']);
  assert.throws(() => npmInstallArguments(['x'], paths.npmPrefix), /global installs/);
  const env = runtimeEnvironment(paths, { PATH: 'host-path', NODE_OPTIONS: '--evil', NODE_PATH: 'bad' });
  assert.equal(env.DSH_HOME, paths.dshHome);
  assert.equal(env.DSH_AGENTS_HOME, paths.agentsHome);
  assert.equal(env.NPM_CONFIG_CACHE, paths.npmCache);
  assert.equal(env.NPM_CONFIG_PREFIX, paths.npmPrefix);
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
});
