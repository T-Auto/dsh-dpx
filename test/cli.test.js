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
