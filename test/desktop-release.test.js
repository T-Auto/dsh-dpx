import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { createEnvironment, pathsFor } from '../src/index.js';
import {
  DEFAULT_DESKTOP_SOURCE,
  checkDesktopUpdate,
  compareVersions,
  desktopGithubApi,
  desktopLauncherPath,
  desktopStampPath,
  desktopStatus,
  fetchDesktopRelease,
  installBundledDesktopLauncher,
  normalizeManifest,
  parseDesktopSource,
  resolveLatestPrereleaseTag,
  updateDesktopLauncher,
} from '../src/desktop-release.js';
import { httpGet, httpGetJson } from '../src/http.js';

const cli = join(import.meta.dirname, '..', 'bin', 'dpx.js');
const node = process.execPath;

function run(args, env) {
  return spawnSync(node, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

/**
 * The same, without blocking the event loop: a blocking spawn would starve the
 * in-process release server these tests talk to.
 */
function runAsync(args, env) {
  return new Promise(resolve => {
    const child = spawn(node, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function manifest(version, { assetUrl, bytes, tag } = {}) {
  return {
    schemaVersion: 1,
    kind: 'DPXDesktopRelease',
    channel: 'desktop',
    version,
    tag: tag ?? `desktop-v${version}`,
    platform: 'win32-x64',
    assetName: `DSH-DeepSeek-Harness-Desktop-${version}-x64.exe`,
    assetUrl,
    sha256: sha256(bytes),
    size: bytes.length,
    publishedAt: '2026-01-01T00:00:00Z',
  };
}

/** A local release host plus an optional CONNECT proxy in front of it. */
async function withReleaseServer(run) {
  const asset = Buffer.from(`fake-desktop-launcher-${'x'.repeat(64)}`);
  const routes = new Map();
  const server = createServer((request, response) => {
    const route = routes.get(request.url.split('?')[0]);
    if (!route) {
      response.writeHead(404).end('not found');
      return;
    }
    // Retry behaviour is only observable by counting requests per route.
    route.hits = (route.hits ?? 0) + 1;
    if (route.statusSequence?.length || route.status !== undefined) {
      const status = route.statusSequence?.length ? route.statusSequence.shift() : route.status;
      const body = route.body ?? `status ${status}`;
      response.writeHead(status, { 'content-type': route.type ?? 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (route.redirect) {
      response.writeHead(302, { location: route.redirect }).end();
      return;
    }
    if (route.chunked) {
      response.writeHead(200, { 'content-type': 'application/json' });
      const body = Buffer.from(route.body);
      for (let offset = 0; offset < body.length; offset += 7) response.write(body.subarray(offset, offset + 7));
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': route.type ?? 'application/json', 'content-length': Buffer.byteLength(route.body) });
    response.end(route.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // A tiny CONNECT proxy, so the tunnel code path is exercised without a network.
  const proxySockets = new Set();
  const proxy = createServer((request, response) => response.writeHead(405).end());
  proxy.on('connect', (request, clientSocket, head) => {
    const [host, targetPort] = request.url.split(':');
    const upstream = connect(Number(targetPort), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    proxySockets.add(upstream);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  try {
    await run({ base, port, asset, routes, proxyUrl });
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    for (const socket of proxySockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('release sources cover github, explicit tags, urls, and local manifests', () => {
  assert.deepEqual(parseDesktopSource(undefined), { kind: 'github', source: DEFAULT_DESKTOP_SOURCE, repository: 'T-Auto/dsh-dpx', tag: undefined });
  assert.equal(parseDesktopSource('github:acme/shell').repository, 'acme/shell');
  assert.equal(parseDesktopSource('github:acme/shell@desktop-v1.2.3').tag, 'desktop-v1.2.3');
  assert.equal(parseDesktopSource('https://example.com/desktop-latest.json').kind, 'url');
  assert.equal(parseDesktopSource('D:\\releases\\desktop-latest.json').kind, 'file');
  assert.equal(parseDesktopSource('file:///D:/releases/desktop-latest.json').kind, 'file');
  assert.throws(() => parseDesktopSource('github:not-a-repo'), /Invalid GitHub repository/);
});

test('versions compare like semver, including pre-releases', () => {
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1);
});

test('manifests are validated and relative assets resolve against the manifest', () => {
  const raw = manifest('0.2.1', { bytes: Buffer.from('abc') });
  const normalized = normalizeManifest(raw, { manifestUrl: 'https://example.com/releases/desktop-latest.json' });
  assert.equal(normalized.version, '0.2.1');
  assert.equal(normalized.assetUrl, 'https://example.com/releases/DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe');
  assert.throws(() => normalizeManifest({ version: '1.0.0' }), /sha256/);
  assert.throws(() => normalizeManifest({ kind: 'SomethingElse', version: '1.0.0', sha256: 'a'.repeat(64) }), /kind/);
});

test('the http client follows redirects and tolerates chunked responses', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    routes.set('/chunked', { chunked: true, body: JSON.stringify({ ok: true, asset: asset.toString('utf8') }) });
    routes.set('/redirect', { redirect: `${base}/chunked` });
    const direct = await httpGetJson(`${base}/chunked`);
    assert.equal(direct.ok, true);
    const followed = await httpGetJson(`${base}/redirect`);
    assert.equal(followed.ok, true);
    const missing = await httpGet(`${base}/nope`);
    assert.equal(missing.status, 404);
  });
});

test('the http client can reach a host through an HTTP CONNECT proxy', async () => {
  await withReleaseServer(async ({ base, routes, proxyUrl }) => {
    routes.set('/via-proxy', { body: JSON.stringify({ proxied: true }) });
    const direct = await httpGetJson(`${base}/via-proxy`);
    assert.equal(direct.proxied, true);
    const proxied = await httpGetJson(`${base}/via-proxy`, { proxy: proxyUrl });
    assert.equal(proxied.proxied, true);
  });
});

test('checking and installing a release verifies the digest and records a stamp', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
    const envRoot = record.root;

    routes.set('/desktop-latest.json', { body: JSON.stringify(manifest('0.2.1', { bytes: asset, assetUrl: 'DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe' })) });
    routes.set('/DSH-DeepSeek-Harness-Desktop-0.2.1-x64.exe', { type: 'application/octet-stream', body: asset });

    const before = await desktopStatus(envRoot);
    assert.equal(before.present, false);

    const check = await checkDesktopUpdate({ envRoot, source: `${base}/desktop-latest.json` });
    assert.equal(check.available, true);
    assert.equal(check.reason, 'not-installed');
    assert.equal(check.latest.version, '0.2.1');

    const result = await updateDesktopLauncher({ envRoot, source: `${base}/desktop-latest.json` });
    assert.equal(result.updated, true);
    assert.deepEqual(await readFile(desktopLauncherPath(envRoot)), asset);

    const stamp = JSON.parse(await readFile(desktopStampPath(envRoot), 'utf8'));
    assert.equal(stamp.version, '0.2.1');
    assert.equal(stamp.sha256, sha256(asset));

    const after = await desktopStatus(envRoot);
    assert.equal(after.version, '0.2.1');
    assert.equal(after.digest, sha256(asset));

    const upToDate = await updateDesktopLauncher({ envRoot, source: `${base}/desktop-latest.json` });
    assert.equal(upToDate.updated, false);
    assert.equal(upToDate.reason, 'up-to-date');

    const dryRun = await updateDesktopLauncher({ envRoot, source: `${base}/desktop-latest.json`, force: true, dryRun: true });
    assert.equal(dryRun.reason, 'dry-run');
    assert.deepEqual(await readFile(desktopLauncherPath(envRoot)), asset);
  });
});

test('a tampered asset is rejected and never installed', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
    routes.set('/desktop-latest.json', { body: JSON.stringify(manifest('0.2.1', { bytes: asset, assetUrl: 'asset.exe' })) });
    routes.set('/asset.exe', { type: 'application/octet-stream', body: Buffer.from('!'.repeat(asset.length)) });
    await assert.rejects(updateDesktopLauncher({ envRoot: record.root, source: `${base}/desktop-latest.json` }), /摘要不符|digest mismatch/);
    assert.equal(existsSync(desktopLauncherPath(record.root)), false);
  });
});

test('a channel without a published release reports that instead of failing', async () => {
  await withReleaseServer(async ({ base }) => {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
    const result = await checkDesktopUpdate({ envRoot: record.root, source: `${base}/desktop-latest.json` });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'no-release');
    await assert.rejects(fetchDesktopRelease(`${base}/desktop-latest.json`), error => error.status === 404);
  });
});

test('a local manifest directory drives the same update path offline', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-release-'));
  const asset = Buffer.from('local-desktop-build');
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'asset.exe'), asset);
  await writeFile(join(work, 'desktop-latest.json'), JSON.stringify(manifest('0.3.0', { bytes: asset, assetUrl: 'asset.exe' })));
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
  const result = await updateDesktopLauncher({ envRoot: record.root, source: join(work, 'desktop-latest.json') });
  assert.equal(result.updated, true);
  assert.equal(result.release.version, '0.3.0');
  assert.deepEqual(await readFile(desktopLauncherPath(record.root)), asset);
});

test('the bundled launcher is installed with a digest stamp', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-artifact-'));
  const artifact = join(work, 'fake.exe');
  const bytes = Buffer.from('bundled-launcher');
  await writeFile(artifact, bytes);
  const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
  const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
  const record = await createEnvironment({
    name: 'test',
    storageRoot: storage,
    home,
    publishDiscovery: false,
    desktop: false,
    platform: 'win32',
  });
  const installed = await installBundledDesktopLauncher({ envRoot: record.root, artifactPath: artifact });
  assert.equal(installed.sha256, sha256(bytes));
  const stamp = JSON.parse(await readFile(desktopStampPath(record.root), 'utf8'));
  assert.equal(stamp.source, 'bundled');
  assert.equal(stamp.sha256, sha256(bytes));
  assert.deepEqual(await readFile(pathsFor(record.root).desktop), bytes);
});

test('dpx desktop status/check/update drive the release channel from the cli', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
    const storage = join(work, 'storage');
    const registry = join(work, 'registry');
    await createEnvironment({ name: 'test', storageRoot: storage, home: registry, publishDiscovery: false, desktop: false, platform: 'win32' });
    const envRoot = join(storage, 'dsh-environments', 'test');
    routes.set('/desktop-latest.json', { body: JSON.stringify(manifest('0.2.1', { bytes: asset, assetUrl: 'asset.exe' })) });
    routes.set('/asset.exe', { type: 'application/octet-stream', body: asset });
    const common = { DPX_HOME: registry, DPX_DISABLE_DISCOVERY: '1' };

    const status = await runAsync(['desktop', 'status', '--test'], common);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).present, false);

    const check = await runAsync(['desktop', 'check', '--test', '--source', `${base}/desktop-latest.json`], common);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).available, true);

    const update = await runAsync(['desktop', 'update', '--test', '--source', `${base}/desktop-latest.json`], common);
    assert.equal(update.status, 0, update.stderr);
    const updated = JSON.parse(update.stdout);
    assert.equal(updated.updated, true);
    assert.equal(updated.installed.version, '0.2.1');
    assert.deepEqual(await readFile(desktopLauncherPath(envRoot)), asset);

    const again = await runAsync(['desktop', 'update', '--test', '--source', `${base}/desktop-latest.json`], common);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).reason, 'up-to-date');

    const dryRun = await runAsync(['desktop', 'update', '--test', '--source', `${base}/desktop-latest.json`, '--force', '--dry-run'], common);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).reason, 'dry-run');

    // Errors must fail loudly and never touch an environment they cannot identify.
    const unknown = run(['desktop', 'check', '--nope'], common);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /not registered/);
    const badVerb = run(['desktop', 'frobnicate', '--test'], common);
    assert.notEqual(badVerb.status, 0);
    assert.match(badVerb.stderr, /desktop status\|check\|update\|install/);
    const badSource = run(['desktop', 'check', '--test', '--source', 'github:broken'], common);
    assert.notEqual(badSource.status, 0);
    assert.match(badSource.stderr, /Invalid GitHub repository/);
  });
});

test('a newly created Windows environment carries a stamped desktop launcher', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dpx-artifact-'));
  const artifact = join(work, 'packaged.exe');
  const bytes = Buffer.from('packaged-launcher');
  await writeFile(artifact, bytes);
  const previous = process.env.DPX_DESKTOP_ARTIFACT;
  process.env.DPX_DESKTOP_ARTIFACT = artifact;
  try {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'stamped', storageRoot: storage, home, publishDiscovery: false, platform: 'win32' });
    assert.deepEqual(await readFile(pathsFor(record.root).desktop), bytes);
    const stamp = JSON.parse(await readFile(desktopStampPath(record.root), 'utf8'));
    assert.equal(stamp.sha256, sha256(bytes));
    assert.equal(stamp.source, 'bundled');
    assert.equal((await desktopStatus(record.root)).present, true);
    assert.equal(record.desktop.launcher, './desktop/DSH DeepSeek Harness Desktop.exe');
  } finally {
    if (previous === undefined) delete process.env.DPX_DESKTOP_ARTIFACT;
    else process.env.DPX_DESKTOP_ARTIFACT = previous;
    await rm(work, { recursive: true, force: true });
  }
});

test('a transient release-host failure is retried until it succeeds', async () => {
  await withReleaseServer(async ({ base, routes }) => {
    routes.set('/flaky.json', { statusSequence: [500, 502], body: JSON.stringify({ ok: true }) });
    const payload = await httpGetJson(`${base}/flaky.json`, { retries: 3, retryDelayMs: 0 });
    assert.equal(payload.ok, true);
    // Two rejected attempts plus the one that succeeded.
    assert.equal(routes.get('/flaky.json').hits, 3);
  });
});

test('client errors are not retried, and the retry budget is bounded', async () => {
  await withReleaseServer(async ({ base, routes }) => {
    // 404 is a client error: it fails once, immediately.
    routes.set('/missing.json', { status: 404, body: 'nope' });
    await assert.rejects(httpGetJson(`${base}/missing.json`, { retries: 4, retryDelayMs: 0 }), error => error.status === 404);
    assert.equal(routes.get('/missing.json').hits, 1);

    // 503 is retryable, but only `retries` extra attempts are made.
    routes.set('/down.json', { status: 503, body: 'down' });
    await assert.rejects(httpGetJson(`${base}/down.json`, { retries: 2, retryDelayMs: 0 }), error => error.status === 503);
    assert.equal(routes.get('/down.json').hits, 3);
  });
});

test('an asset whose byte count disagrees with the manifest is rejected', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
    // The digest is correct; only the declared length is wrong.
    const declared = manifest('0.2.1', { bytes: asset, assetUrl: 'asset.exe' });
    declared.size = asset.length + 1;
    routes.set('/desktop-latest.json', { body: JSON.stringify(declared) });
    routes.set('/asset.exe', { type: 'application/octet-stream', body: asset });

    await assert.rejects(
      updateDesktopLauncher({ envRoot: record.root, source: `${base}/desktop-latest.json` }),
      /size mismatch/,
    );
    assert.equal(existsSync(desktopLauncherPath(record.root)), false);
  });
});

test('an older release is never available and never replaces a newer launcher', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
    const newerBytes = Buffer.from(`newer-launcher-${'n'.repeat(64)}`);
    routes.set('/new.json', { body: JSON.stringify(manifest('0.3.0', { bytes: newerBytes, assetUrl: 'new.exe' })) });
    routes.set('/new.exe', { type: 'application/octet-stream', body: newerBytes });
    assert.equal((await updateDesktopLauncher({ envRoot: record.root, source: `${base}/new.json` })).updated, true);

    // The channel is replaced by an older build with different bytes. Only-upgrade
    // means this must neither be advertised nor installed.
    routes.set('/old.json', { body: JSON.stringify(manifest('0.2.1', { bytes: asset, assetUrl: 'old.exe' })) });
    routes.set('/old.exe', { type: 'application/octet-stream', body: asset });

    const check = await checkDesktopUpdate({ envRoot: record.root, source: `${base}/old.json` });
    assert.equal(check.available, false);
    assert.equal(check.reason, 'different-build');
    assert.equal(check.installedNewer, true);

    const refused = await updateDesktopLauncher({ envRoot: record.root, source: `${base}/old.json` });
    assert.equal(refused.updated, false);
    assert.equal(refused.reason, 'newer-installed');
    assert.deepEqual(await readFile(desktopLauncherPath(record.root)), newerBytes);
  });
});

test('the newest prerelease tag is resolved through an injectable api base', async () => {
  await withReleaseServer(async ({ base, routes }) => {
    routes.set('/repos/T-Auto/dsh-dpx/releases', {
      body: JSON.stringify([
        { tag_name: 'desktop-v0.2.7' },
        { tag_name: 'desktop-v0.3.0-rc.1' },
        { tag_name: 'desktop-v0.3.0-rc.2' },
        // Drafts are not published, and unrelated tags are not desktop releases.
        { tag_name: 'desktop-v0.9.0', draft: true },
        { tag_name: 'release-notes' },
      ]),
    });
    assert.equal(await resolveLatestPrereleaseTag('T-Auto/dsh-dpx', { apiBase: base }), 'desktop-v0.3.0-rc.2');
    // The query string is not part of the route key, so this counts API hits.
    assert.equal(routes.get('/repos/T-Auto/dsh-dpx/releases').hits, 1);
  });
});

test('the github api base is selectable by argument or environment', () => {
  assert.equal(desktopGithubApi(undefined, {}), 'https://api.github.com');
  assert.equal(desktopGithubApi(undefined, { DPX_GITHUB_API: 'http://127.0.0.1:9/api/' }), 'http://127.0.0.1:9/api');
  assert.equal(desktopGithubApi('http://example.test/', { DPX_GITHUB_API: 'http://ignored.test' }), 'http://example.test');
});

test('an empty prerelease channel is reported as no-release, not as a failure', async () => {
  await withReleaseServer(async ({ base, routes }) => {
    const storage = await mkdtemp(join(tmpdir(), 'dpx-storage-'));
    const home = await mkdtemp(join(tmpdir(), 'dpx-registry-'));
    const record = await createEnvironment({ name: 'test', storageRoot: storage, home, publishDiscovery: false, desktop: false, platform: 'win32' });
    // Only a draft and an unrelated tag: there is no prerelease to install.
    routes.set('/repos/T-Auto/dsh-dpx/releases', {
      body: JSON.stringify([{ tag_name: 'desktop-v0.9.0', draft: true }, { tag_name: 'release-notes' }]),
    });
    const check = await checkDesktopUpdate({ envRoot: record.root, source: 'github:T-Auto/dsh-dpx', prerelease: true, apiBase: base });
    assert.equal(check.available, false);
    assert.equal(check.reason, 'no-release');
    // The same situation fails loudly when the caller asks for the manifest
    // itself, because there is no manifest to resolve.
    await assert.rejects(
      fetchDesktopRelease('github:T-Auto/dsh-dpx', { prerelease: true, apiBase: base }),
      error => error.status === 404,
    );
  });
});

test('dpx desktop install is the explicit door, while update refuses a downgrade', async () => {
  await withReleaseServer(async ({ base, routes, asset }) => {
    const work = await mkdtemp(join(tmpdir(), 'dpx-cli-'));
    const storage = join(work, 'storage');
    const registry = join(work, 'registry');
    await createEnvironment({ name: 'test', storageRoot: storage, home: registry, publishDiscovery: false, desktop: false, platform: 'win32' });
    const envRoot = join(storage, 'dsh-environments', 'test');
    const older = Buffer.from(`older-launcher-${'o'.repeat(64)}`);
    routes.set('/new.json', { body: JSON.stringify(manifest('0.2.5', { bytes: asset, assetUrl: 'new.exe' })) });
    routes.set('/new.exe', { type: 'application/octet-stream', body: asset });
    routes.set('/old.json', { body: JSON.stringify(manifest('0.2.1', { bytes: older, assetUrl: 'old.exe' })) });
    routes.set('/old.exe', { type: 'application/octet-stream', body: older });
    const common = { DPX_HOME: registry, DPX_DISABLE_DISCOVERY: '1' };

    const installed = await runAsync(['desktop', 'install', '--test', '--source', `${base}/new.json`], common);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).updated, true);

    // `install` implies force, so it reinstalls even when nothing changed.
    const again = await runAsync(['desktop', 'install', '--test', '--source', `${base}/new.json`], common);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).updated, true);

    const refused = await runAsync(['desktop', 'update', '--test', '--source', `${base}/old.json`], common);
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).reason, 'newer-installed');
    assert.deepEqual(await readFile(desktopLauncherPath(envRoot)), asset);

    const forced = await runAsync(['desktop', 'install', '--test', '--source', `${base}/old.json`], common);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(forced.stdout).updated, true);
    assert.deepEqual(await readFile(desktopLauncherPath(envRoot)), older);
  });
});
