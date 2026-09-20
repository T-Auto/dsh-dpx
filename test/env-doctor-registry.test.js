import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * `dpx env doctor` without a selector answers a different question than the
 * per-environment form: "is this registry still coherent?" Its contract is
 * *report*, never *repair* — it must not create anything it finds missing, and
 * an unreadable registry is a finding rather than an exception.
 */

const cli = join(import.meta.dirname, '..', 'bin', 'dpx.js');
const node = process.execPath;

function run(args, env) {
  return spawnSync(node, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

/** One CLI-only environment (no launcher copy) registered in a scratch registry. */
async function registryFixture() {
  const work = await mkdtemp(join(tmpdir(), 'dpx-doctor-'));
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
  return { work, registry, root: join(storage, 'dsh-environments', 'test') };
}

test('the registry-level doctor reports an empty registry and exits zero', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-doctor-'));
  const registry = join(work, 'registry');
  const result = run(['env', 'doctor'], { DPX_HOME: registry, DPX_DISABLE_DISCOVERY: '1' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'registry');
  assert.equal(report.json, true);
  assert.equal(report.environments, 0);
  assert.deepEqual(report.entries, []);
  assert.equal(report.ok, true);
  // The registry-level shape must not pretend to be an environment report.
  assert.equal(report.envRoot, undefined);
  assert.equal(report.instanceId, undefined);
});

test('a registered environment whose root is gone is reported, never recreated', async () => {
  const fixture = await registryFixture();
  await rm(fixture.root, { recursive: true, force: true });
  assert.equal(existsSync(fixture.root), false);

  const result = run(['env', 'doctor'], { DPX_HOME: fixture.registry, DPX_DISABLE_DISCOVERY: '1' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'registry');
  assert.equal(report.ok, false);
  assert.equal(report.entries.length, 1);
  const [entry] = report.entries;
  assert.equal(entry.name, 'test');
  const root = entry.checks.find(row => row.id === 'root');
  assert.equal(root.status, 'error');
  assert.match(root.detail, /环境根缺失/);
  assert.match(root.fix, /dpx env remove --test/);

  // Read-only by contract: a doctor that heals its own findings cannot be used
  // to prove the finding was real.
  assert.equal(existsSync(fixture.root), false, 'the doctor must not create the missing root');
});

test('an unreadable registry is reported instead of thrown', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-doctor-'));
  const registry = join(work, 'registry');
  await writeFile(join(work, 'keep'), '');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, 'registry.json'), '{ this is not json');

  const result = run(['env', 'doctor'], { DPX_HOME: registry, DPX_DISABLE_DISCOVERY: '1' });
  assert.equal(result.status, 1);
  // The point is that this is a JSON report, not a stack trace on stderr.
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'registry');
  assert.equal(report.ok, false);
  const readable = report.checks.find(row => row.id === 'registry-readable');
  assert.equal(readable.status, 'error');
  assert.match(readable.detail, /registry 不可用/);
  assert.ok(readable.fix.includes('registry.json'));
});
