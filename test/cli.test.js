import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await writeFile(fakeNpm, `import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path';\nconst args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1]; await mkdir(join(prefix,'node_modules','@deepseek-ai','dsh'),{recursive:true}); await writeFile(join(prefix,'node_modules','@deepseek-ai','dsh','package.json'),'{}'); await writeFile(process.env.CAPTURE,JSON.stringify({args, env:{cache:process.env.NPM_CONFIG_CACHE,prefix:process.env.NPM_CONFIG_PREFIX,nodeOptions:process.env.NODE_OPTIONS}}));`);
  const result = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test', `--${storage}`], {
    DPX_HOME: registry,
    DPX_NPM_CLI: fakeNpm,
    CAPTURE: capture,
    NODE_OPTIONS: '--trace-warnings',
    DPX_DISABLE_DISCOVERY: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const root = join(storage, 'dsh-environments', 'test');
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(captured.env.prefix, join(root, 'npm-prefix'));
  assert.equal(captured.env.cache, join(root, 'npm-cache'));
  assert.equal(captured.env.nodeOptions, undefined);
  assert.ok(captured.args.includes('--no-audit'));
  assert.ok(captured.args.includes('--no-fund'));
  assert.ok(existsSync(join(root, 'npm-prefix', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  const listed = run(['env', 'list'], { DPX_HOME: registry });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).environments[0].name, 'test');
});

test('dpx rejects reuse before a named environment is registered', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
  const result = run(['npm', 'install', '-g', '@deepseek-ai/dsh', '--test'], { DPX_HOME: join(work, 'registry') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not registered/);
});
