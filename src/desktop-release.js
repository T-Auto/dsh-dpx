// Desktop launcher release channel (GitHub Releases).
//
// `dpx` and the desktop shell both consume this contract; the machine-readable
// shape is specified in `docs/desktop-release.md`. The desktop shell implements
// the same rules in Rust (`desktop-shell/src-tauri/src/update.rs`).
//
// A published desktop release has the tag `desktop-v<version>` and carries:
//   - `desktop-latest.json`                     the manifest below
//   - `DSH-DeepSeek-Harness-Desktop-<version>-x64.exe`   the launcher
//
// Manifest (`DPXDesktopRelease`, schemaVersion 1):
//   { schemaVersion, kind, channel, version, tag, platform, assetName,
//     assetUrl, sha256, size, publishedAt, notes }

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HttpError, defaultProxy, httpGet, httpGetBuffer, httpGetJson } from './http.js';

export const DESKTOP_RELEASE_KIND = 'DPXDesktopRelease';
export const DESKTOP_RELEASE_SCHEMA_VERSION = 1;
export const DESKTOP_RELEASE_CHANNEL = 'desktop';
export const DESKTOP_MANIFEST_ASSET = 'desktop-latest.json';
export const DESKTOP_ASSET_PREFIX = 'DSH-DeepSeek-Harness-Desktop-';
export const DESKTOP_LAUNCHER_DIR = 'desktop';
export const DESKTOP_LAUNCHER_NAME = 'DSH DeepSeek Harness Desktop.exe';
export const DESKTOP_STAMP_NAME = '.dpx-desktop.json';
export const DESKTOP_TAG_PREFIX = 'desktop-v';
export const DESKTOP_PLATFORM = 'win32-x64';
export const DEFAULT_DESKTOP_REPOSITORY = 'T-Auto/dsh-dpx';
export const DEFAULT_DESKTOP_SOURCE = `github:${DEFAULT_DESKTOP_REPOSITORY}`;
export const DESKTOP_USER_AGENT = 'dsh-dpx-desktop-updater';

export function desktopDir(envRoot) {
  return join(resolve(envRoot), DESKTOP_LAUNCHER_DIR);
}

export function desktopLauncherPath(envRoot) {
  return join(desktopDir(envRoot), DESKTOP_LAUNCHER_NAME);
}

export function desktopStampPath(envRoot) {
  return join(desktopDir(envRoot), DESKTOP_STAMP_NAME);
}

export function desktopAssetName(version) {
  return `${DESKTOP_ASSET_PREFIX}${version}-x64.exe`;
}

export function desktopTag(version) {
  return `${DESKTOP_TAG_PREFIX}${version}`;
}

/**
 * Parse a release source.
 *
 * - `github`                → the latest published release of the default repo
 * - `github:owner/repo`     → the latest published release of that repo
 * - `github:owner/repo@tag` → one exact release tag
 * - `https://…` / `http://…` → a manifest URL (self-hosted or a local test server)
 * - `file:/…` or a path      → a manifest file on disk (offline testing)
 */
export function parseDesktopSource(source = DEFAULT_DESKTOP_SOURCE) {
  const value = String(source ?? '').trim() || DEFAULT_DESKTOP_SOURCE;
  if (/^https?:\/\//i.test(value)) return { kind: 'url', source: value, manifestUrl: value };
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    return { kind: 'file', source: value, manifestPath: fileURLToPath(url) };
  }
  if (!value.startsWith('github:')) {
    if (isAbsolute(value) || value.startsWith('.') || value.includes('\\') || value.includes('/')) {
      return { kind: 'file', source: value, manifestPath: resolve(value) };
    }
    throw new Error(`Unsupported desktop release source ${JSON.stringify(value)}. Use github[:owner/repo][@tag], an https manifest URL, or a local manifest path.`);
  }
  const spec = value.slice('github:'.length).trim() || DEFAULT_DESKTOP_REPOSITORY;
  const at = spec.lastIndexOf('@');
  const repository = (at > 0 ? spec.slice(0, at) : spec).trim();
  const tag = at > 0 ? spec.slice(at + 1).trim() : undefined;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository in desktop release source: ${JSON.stringify(repository)}.`);
  }
  return { kind: 'github', source: value, repository, tag: tag || undefined };
}

export function desktopManifestUrl(parsed, { tag } = {}) {
  if (parsed.kind === 'url') return parsed.manifestUrl;
  const effectiveTag = tag ?? parsed.tag;
  const suffix = effectiveTag
    ? `releases/download/${encodeURIComponent(effectiveTag)}`
    : 'releases/latest/download';
  return `https://github.com/${parsed.repository}/${suffix}/${DESKTOP_MANIFEST_ASSET}`;
}

/** Compare two dotted versions (`1.2.3-alpha.1`); returns -1, 0, or 1. */
export function compareVersions(left, right) {
  const parse = value => String(value ?? '').trim().replace(/^v/i, '').split('+')[0];
  const split = value => {
    const [core, ...rest] = parse(value).split('-');
    return { parts: core.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)), pre: rest.join('-') };
  };
  const a = split(left);
  const b = split(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.parts[index];
    const y = b.parts[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    const xs = String(x);
    const ys = String(y);
    if (xs === ys) continue;
    return xs < ys ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function normalizeManifest(raw, { source, manifestUrl } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Desktop release manifest is not a JSON object.');
  if (raw.kind && raw.kind !== DESKTOP_RELEASE_KIND) {
    throw new Error(`Unexpected desktop release manifest kind ${JSON.stringify(raw.kind)}; expected ${DESKTOP_RELEASE_KIND}.`);
  }
  const version = String(raw.version ?? '').trim().replace(/^v/i, '');
  if (!version) throw new Error('Desktop release manifest has no version.');
  const sha256 = normalizeSha256(raw.sha256);
  if (!sha256) throw new Error(`Desktop release manifest for ${version} has no sha256 digest.`);
  const assetName = String(raw.assetName ?? desktopAssetName(version)).trim();
  let assetUrl = raw.assetUrl ? String(raw.assetUrl).trim() : undefined;
  if (assetUrl && manifestUrl) assetUrl = new URL(assetUrl, manifestUrl).href;
  if (assetUrl && /^file:/i.test(assetUrl)) {
    // Keep file: URLs intact; the downloader resolves them locally.
  } else if (!assetUrl && manifestUrl && /^https?:/i.test(manifestUrl)) {
    assetUrl = new URL(encodeURIComponent(assetName), manifestUrl.replace(/[^/]*$/, '')).href;
  }
  return {
    schemaVersion: Number(raw.schemaVersion ?? DESKTOP_RELEASE_SCHEMA_VERSION),
    kind: DESKTOP_RELEASE_KIND,
    channel: String(raw.channel ?? DESKTOP_RELEASE_CHANNEL),
    version,
    tag: raw.tag ? String(raw.tag) : undefined,
    platform: String(raw.platform ?? DESKTOP_PLATFORM),
    assetName,
    assetUrl,
    sha256,
    size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : undefined,
    publishedAt: raw.publishedAt ? String(raw.publishedAt) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    source: source ?? DEFAULT_DESKTOP_SOURCE,
    manifestUrl,
  };
}

export function normalizeSha256(value) {
  if (!value) return undefined;
  const hex = String(value).trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/**
 * Parse a manifest document. Tolerates a UTF-8 BOM, because PowerShell's
 * `Set-Content -Encoding utf8` (and several editors) add one and it would
 * otherwise be an unhelpful "Unexpected token" failure.
 */
export function parseManifestText(text, { source, manifestUrl } = {}) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`桌面发布清单不是有效 JSON（${manifestUrl ?? source ?? '未知来源'}）：${error.message}`);
  }
  return normalizeManifest(raw, { source, manifestUrl });
}

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The manifest describing the desktop launcher bundled in this dpx package. */
export function bundledDesktopManifestPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'windows', 'desktop-manifest.json');
}

export async function readBundledDesktopManifest() {
  const path = bundledDesktopManifestPath();
  if (!existsSync(path)) return undefined;
  try {
    return parseManifestText(await readFile(path, 'utf8'), { source: 'bundled', manifestUrl: path });
  } catch {
    return undefined;
  }
}

const GITHUB_API = 'https://api.github.com';

function githubHeaders(env) {
  const token = env?.DPX_GITHUB_TOKEN?.trim() || env?.GITHUB_TOKEN?.trim() || env?.GH_TOKEN?.trim();
  return {
    'User-Agent': DESKTOP_USER_AGENT,
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Find the newest prerelease desktop tag through the GitHub API. Only used when
 * the caller explicitly opts into prereleases, because `/releases/latest`
 * deliberately ignores them.
 */
export async function resolveLatestPrereleaseTag(repository, { proxy, env = process.env, timeout } = {}) {
  const releases = await httpGetJson(`${GITHUB_API}/repos/${repository}/releases?per_page=30`, {
    proxy: proxy ?? defaultProxy(env),
    headers: githubHeaders(env),
    timeout,
  });
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter(release => release && !release.draft && String(release.tag_name ?? '').startsWith(DESKTOP_TAG_PREFIX))
    .map(release => ({ tag: String(release.tag_name), version: String(release.tag_name).slice(DESKTOP_TAG_PREFIX.length) }))
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0]?.tag;
}

/**
 * Fetch the newest desktop release manifest for a source.
 * Throws `HttpError` with status 404 when the channel has no published release.
 */
export async function fetchDesktopRelease(source, { proxy, prerelease = false, tag, env = process.env, timeout } = {}) {
  const parsed = parseDesktopSource(source);
  const effectiveProxy = proxy ?? defaultProxy(env);
  if (parsed.kind === 'file') {
    if (!existsSync(parsed.manifestPath)) {
      throw new Error(`Desktop release manifest not found: ${parsed.manifestPath}`);
    }
    return parseManifestText(await readFile(parsed.manifestPath, 'utf8'), {
      source: parsed.source,
      manifestUrl: pathToFileURL(parsed.manifestPath).href,
    });
  }
  let effectiveTag = tag ?? parsed.tag;
  if (!effectiveTag && prerelease && parsed.kind === 'github') {
    effectiveTag = await resolveLatestPrereleaseTag(parsed.repository, { proxy: effectiveProxy, env, timeout });
    if (!effectiveTag) throw new Error(`No pre-release ${DESKTOP_TAG_PREFIX}* release found in ${parsed.repository}.`);
  }
  const manifestUrl = desktopManifestUrl(parsed, { tag: effectiveTag });
  const text = await httpGet(manifestUrl, {
    proxy: effectiveProxy,
    headers: { 'User-Agent': DESKTOP_USER_AGENT },
    timeout,
  });
  if (text.status < 200 || text.status >= 300) {
    throw new HttpError(`GET ${manifestUrl} failed with status ${text.status}.`, { status: text.status, url: manifestUrl });
  }
  return parseManifestText(text.body.toString('utf8'), { source: parsed.source, manifestUrl });
}

/** Download one release asset, verifying size and digest before returning it. */
export async function downloadDesktopAsset(manifest, { proxy, env = process.env, timeout } = {}) {
  if (!manifest.assetUrl) throw new Error(`Desktop release ${manifest.version} does not declare a downloadable asset.`);
  let buffer;
  if (/^file:/i.test(manifest.assetUrl)) {
    const path = fileURLToPath(manifest.assetUrl);
    if (!existsSync(path)) throw new Error(`Desktop release asset not found: ${path}`);
    buffer = await readFile(path);
  } else if (/^[A-Za-z]:[\\/]/.test(manifest.assetUrl) || manifest.assetUrl.startsWith('\\\\')) {
    buffer = await readFile(manifest.assetUrl);
  } else {
    const response = await httpGetBuffer(manifest.assetUrl, {
      proxy: proxy ?? defaultProxy(env),
      headers: { 'User-Agent': DESKTOP_USER_AGENT, Accept: 'application/octet-stream' },
      timeout,
    });
    buffer = response.body;
  }
  if (manifest.size !== undefined && buffer.length !== manifest.size) {
    throw new Error(`Desktop release ${manifest.version} asset size mismatch: expected ${manifest.size} bytes, received ${buffer.length}.`);
  }
  const digest = sha256Of(buffer);
  if (digest !== manifest.sha256) {
    throw new Error(`Desktop release ${manifest.version} digest mismatch: expected ${manifest.sha256}, received ${digest}.`);
  }
  return { buffer, sha256: digest };
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

export async function readDesktopStamp(envRoot) {
  const path = desktopStampPath(envRoot);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    return {
      schemaVersion: Number(raw.schemaVersion ?? 1),
      platform: String(raw.platform ?? DESKTOP_PLATFORM),
      version: raw.version ? String(raw.version) : undefined,
      sha256: normalizeSha256(raw.sha256),
      source: raw.source ? String(raw.source) : 'bundled',
      tag: raw.tag ? String(raw.tag) : undefined,
      installedAt: raw.installedAt ? String(raw.installedAt) : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function writeDesktopStamp(envRoot, stamp) {
  await atomicWrite(desktopStampPath(envRoot), `${JSON.stringify({
    schemaVersion: 1,
    platform: stamp.platform ?? DESKTOP_PLATFORM,
    ...stamp,
    installedAt: stamp.installedAt ?? new Date().toISOString(),
  }, null, 2)}\n`);
}

/** Hash the launcher that is installed in an environment, if any. */
export async function installedDesktopDigest(envRoot) {
  const path = desktopLauncherPath(envRoot);
  if (!existsSync(path)) return undefined;
  return sha256Of(await readFile(path));
}

export async function installedDesktopSize(envRoot) {
  const path = desktopLauncherPath(envRoot);
  if (!existsSync(path)) return undefined;
  return (await stat(path)).size;
}

/** The desktop launcher state of one environment, without network access. */
export async function desktopStatus(envRoot) {
  const launcher = desktopLauncherPath(envRoot);
  const present = existsSync(launcher);
  const stamp = await readDesktopStamp(envRoot);
  return {
    envRoot: resolve(envRoot),
    launcher,
    present,
    version: stamp?.version,
    sha256: stamp?.sha256,
    digest: present ? await installedDesktopDigest(envRoot) : undefined,
    source: stamp?.source ?? (present ? 'bundled' : undefined),
    installedAt: stamp?.installedAt,
  };
}

/**
 * Compare the installed launcher with the newest published release.
 * Never writes anything.
 */
export async function checkDesktopUpdate({ envRoot, source = DEFAULT_DESKTOP_SOURCE, proxy, prerelease = false, tag, env = process.env, timeout } = {}) {
  const current = await desktopStatus(envRoot);
  let release;
  try {
    release = await fetchDesktopRelease(source, { proxy, prerelease, tag, env, timeout });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { ...current, source, available: false, reason: 'no-release', message: `发布源 ${source} 还没有 desktop 发行版。` };
    }
    throw error;
  }
  if (!current.present) {
    return { ...current, source, latest: release, available: true, reason: 'not-installed' };
  }
  const newer = compareVersions(release.version, current.version ?? '0.0.0') > 0;
  const identical = release.sha256 && current.digest === release.sha256;
  return {
    ...current,
    source,
    latest: release,
    available: newer || (!identical && compareVersions(release.version, current.version ?? '0.0.0') >= 0),
    reason: newer ? 'newer-version' : identical ? 'up-to-date' : 'different-build',
    versionMatch: current.version === release.version,
  };
}

/**
 * Download and install the desktop launcher for one environment.
 *
 * `dryRun` resolves the release and verifies everything without touching the
 * environment. The launcher file itself is replaced atomically; a running
 * launcher cannot be replaced on Windows, which is reported as a clear error
 * instead of a half-written file.
 */
export async function updateDesktopLauncher({
  envRoot,
  source = DEFAULT_DESKTOP_SOURCE,
  proxy,
  prerelease = false,
  tag,
  force = false,
  dryRun = false,
  env = process.env,
  timeout,
} = {}) {
  const root = resolve(envRoot);
  const current = await desktopStatus(root);
  const release = await fetchDesktopRelease(source, { proxy, prerelease, tag, env, timeout });
  const newer = compareVersions(release.version, current.version ?? '0.0.0') > 0;
  const sameDigest = current.present && current.digest === release.sha256;
  if (!force && !newer && sameDigest) {
    return { updated: false, reason: 'up-to-date', current, release, target: desktopLauncherPath(root) };
  }
  if (!force && !newer && !sameDigest && current.version && compareVersions(release.version, current.version) < 0) {
    return { updated: false, reason: 'newer-installed', current, release, target: desktopLauncherPath(root) };
  }
  if (dryRun) {
    return { updated: false, reason: 'dry-run', current, release, target: desktopLauncherPath(root) };
  }
  const { buffer, sha256 } = await downloadDesktopAsset(release, { proxy, env, timeout });
  const target = desktopLauncherPath(root);
  const staged = `${target}.${process.pid}.new`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(staged, buffer);
    await rm(target, { force: true });
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true });
    if (error?.code === 'EPERM' || error?.code === 'EBUSY') {
      throw new Error(`无法替换正在运行的桌面启动器：${target}。请先关闭该桌面程序后重试。`);
    }
    throw error;
  }
  const stamp = {
    version: release.version,
    sha256,
    source: release.source ?? source,
    tag: release.tag,
    installedAt: new Date().toISOString(),
  };
  await writeDesktopStamp(root, stamp);
  return { updated: true, reason: 'updated', current, release, target, sha256, stamp };
}

/** Install the launcher bundled with this dpx package into an environment. */
export async function installBundledDesktopLauncher({ envRoot, artifactPath, artifactBuffer }) {
  const root = resolve(envRoot);
  const buffer = artifactBuffer ?? await readFile(artifactPath);
  const target = desktopLauncherPath(root);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  const manifest = await readBundledDesktopManifest();
  const sha256 = sha256Of(buffer);
  await writeDesktopStamp(root, {
    version: manifest?.version,
    sha256,
    source: 'bundled',
    tag: manifest?.tag,
  });
  return { target, sha256, version: manifest?.version };
}
