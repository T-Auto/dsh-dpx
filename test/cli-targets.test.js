import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * Coverage for the CLI verbs that had none: `run`, `descriptor`, `env show`,
 * `env remove`. The fixture installs *entry files* (not just package manifests),
 * because `dpx run` starts the target entry directly and refuses when the
 * isolated package is missing — two behaviours that only show up with a real
 * entry on disk.
 */

const cli = join(import.meta.dirname, '..', 'bin', 'dpx.js');
const node = process.execPath;

function run(args, env) {
  return spawnSync(node, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

/**
 * A fake `npm` that materializes the launch targets inside the selected prefix,
 * including their entry files. `withTargets: false` installs nothing, which is
 * how the "isolated package is missing" path is reached.
 */
async function environmentFixture({ withTargets = true } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
  const storage = join(work, 'storage');
  const registry = join(work, 'registry');
  const fakeNpm = join(work, 'fake-npm.js');
  const root = join(storage, 'dsh-environments', 'test');

  const targets = [
    ['@deepseek-ai/dsh', ['lib', 'bin.js'], 'fake-dsh'],
    ['@deepseek-harness-tui/dsh-tui', ['bin', 'dsh-tui.js'], 'fake-tui'],
  ];
  const lines = withTargets
    ? targets.map(([name, entry, label]) => {
      const body = `process.stdout.write(${JSON.stringify(`${label} `)} + process.argv.slice(2).join(','))`;
      return `{ const dir = join(prefix, 'node_modules', ...${JSON.stringify(name)}.split('/'));`
        + ` await mkdir(join(dir, ...${JSON.stringify(entry)}.slice(0, -1)), { recursive: true });`
        + ` await writeFile(join(dir, 'package.json'), JSON.stringify({ name: ${JSON.stringify(name)}, version: '1.2.3' }));`
        + ` await writeFile(join(dir, ...${JSON.stringify(entry)}), ${JSON.stringify(body)}); }`;
    })
    : [];
  await writeFile(fakeNpm, `import { mkdir, writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n`
    + `const args = process.argv.slice(2);\nconst prefix = args[args.indexOf('--prefix') + 1];\n${lines.join('\n')}\n`);

  const installed = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test', `--${storage}`], {
    DPX_HOME: registry,
    DPX_NPM_CLI: fakeNpm,
    DPX_DISABLE_DISCOVERY: '1',
  });
  assert.equal(installed.status, 0, installed.stderr);
  return { work, storage, registry, root };
}

test('dpx run starts the isolated entry directly and forwards target arguments', async () => {
  const fixture = await environmentFixture();

  const explicit = run(['run', '--test', 'dsh', '--version'], { DPX_HOME: fixture.registry });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, 'fake-dsh --version');

  // The target defaults to dsh, and its own flags are not swallowed by dpx.
  const bare = run(['run', '--test'], { DPX_HOME: fixture.registry });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout, 'fake-dsh ');

  const tui = run(['run', '--test', 'dsh-tui', 'web', '--no-open'], { DPX_HOME: fixture.registry });
  assert.equal(tui.status, 0, tui.stderr);
  assert.equal(tui.stdout, 'fake-tui web,--no-open');
});

test('dpx run refuses a target whose isolated package is missing', async () => {
  const fixture = await environmentFixture({ withTargets: false });
  const result = run(['run', '--test', 'dsh', '--version'], { DPX_HOME: fixture.registry });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated @deepseek-ai\/dsh package is missing/);
  assert.match(result.stderr, /dpx npm install -g @deepseek-ai\/dsh/);
});

test('dpx descriptor reports the descriptor path and instance, and rejects extra arguments', async () => {
  const fixture = await environmentFixture();
  const result = run(['descriptor', '--test'], { DPX_HOME: fixture.registry });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.descriptor, join(fixture.root, 'dsh-distribution.json'));
  assert.equal(existsSync(report.descriptor), true);
  assert.equal(report.instance.kind, 'EnvironmentInstance');
  assert.equal(report.instance.distribution.version, '0.1.0');

  const extra = run(['descriptor', '--test', 'nonsense'], { DPX_HOME: fixture.registry });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /descriptor accepts only an environment selector/);
});

test('dpx env show reports the environment layout, and rejects extra arguments', async () => {
  const fixture = await environmentFixture();
  const result = run(['env', 'show', '--test'], { DPX_HOME: fixture.registry });
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.name, 'test');
  assert.equal(shown.root, fixture.root);
  assert.equal(shown.npmPrefix, join(fixture.root, 'npm-prefix'));
  assert.equal(shown.npmCache, join(fixture.root, 'npm-cache'));
  assert.equal(shown.dshHome, join(fixture.root, 'dsh-home'));
  assert.equal(shown.agentsHome, join(fixture.root, 'agents-home'));
  // The Windows launcher is copied on first creation and then reported. Note the
  // field is named `desktop` but holds the launcher *file*, not its directory.
  if (process.platform === 'win32') {
    assert.equal(shown.desktop, join(fixture.root, 'desktop', 'DSH DeepSeek Harness Desktop.exe'));
    assert.equal(existsSync(shown.desktop), true);
  }

  const extra = run(['env', 'show', '--test', 'nonsense'], { DPX_HOME: fixture.registry });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /env show accepts only an environment selector/);
});

test('dpx env remove unregisters the environment and keeps its root unless purged', async () => {
  const fixture = await environmentFixture();

  // Argument validation happens before anything is touched.
  const extra = run(['env', 'remove', '--test', '--nonsense'], { DPX_HOME: fixture.registry });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /env remove accepts only an environment selector/);

  const removed = run(['env', 'remove', '--test'], { DPX_HOME: fixture.registry });
  assert.equal(removed.status, 0, removed.stderr);
  const outcome = JSON.parse(removed.stdout);
  assert.equal(outcome.removed, 'test');
  assert.equal(outcome.root, fixture.root);
  assert.equal(outcome.purged, false);
  // Without --purge the environment root is left on disk for inspection.
  assert.equal(existsSync(fixture.root), true);

  const listed = run(['env', 'list'], { DPX_HOME: fixture.registry });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).environments, []);

  const again = run(['env', 'remove', '--test'], { DPX_HOME: fixture.registry });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /is not registered/);
});

test('dpx env remove --purge deletes the managed root', async () => {
  const fixture = await environmentFixture();
  const removed = run(['env', 'remove', '--test', '--purge'], { DPX_HOME: fixture.registry });
  assert.equal(removed.status, 0, removed.stderr);
  const outcome = JSON.parse(removed.stdout);
  assert.equal(outcome.purged, true);
  assert.equal(existsSync(fixture.root), false);
});
