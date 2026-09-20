import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { DESKTOP_LAUNCHER_DIR, DESKTOP_LAUNCHER_NAME, DESKTOP_STAMP_NAME, DESKTOP_STAMP_SCHEMA_VERSIONS, installBundledDesktopLauncher } from './desktop-release.js';
import { ENVIRONMENT_MANIFEST_NAME, GUIDE_FORMAT, ensureEnvironmentGuide, environmentGuidePath } from './environment-guide.js';

export const FORMAT = 1;
export const DPX_API_VERSION = 'dpx.dsh.dev/v1alpha1';
export const DISTRIBUTION = Object.freeze({
  id: 'urn:dsh:distribution:t-auto:dsh-dpx',
  version: '0.1.0',
});

/**
 * Every distribution identity this build can still *read*, newest first.
 *
 * The registry stores the distribution identity it was written with, and every
 * command reads the registry, so a naive equality test against `DISTRIBUTION`
 * turns "bump the version" into "every existing environment becomes
 * unreadable". The separation that prevents that:
 *
 * - **declared read compatibility** (`DISTRIBUTION_READ_COMPATIBLE_*`) — an
 *   explicit list; a record inside it is readable, a record outside it still
 *   fails loudly;
 * - **write always stamps current** — every record this build writes uses
 *   `DISTRIBUTION` verbatim, so the list grows only by a deliberate declaration
 *   and never by drift.
 *
 * Add the outgoing identity to these lists *in the same change* that bumps
 * `DISTRIBUTION`; `REGISTRY_BINDING` below is what enforces it.
 */
export const DISTRIBUTION_READ_COMPATIBLE_VERSIONS = Object.freeze(['0.1.0']);
export const DISTRIBUTION_READ_COMPATIBLE_IDS = Object.freeze([DISTRIBUTION.id]);

/** Aliases: the name upstream uses for the same policy (`compatibleVersions`). */
export const COMPATIBLE_DISTRIBUTION_VERSIONS = DISTRIBUTION_READ_COMPATIBLE_VERSIONS;
export const COMPATIBLE_DISTRIBUTION_IDS = DISTRIBUTION_READ_COMPATIBLE_IDS;

/**
 * The one place that decides whether a stored distribution identity is readable.
 *
 * `id` may change only with the version (`id 变化等价于换代`): a record whose id
 * this build never wrote cannot be assumed to mean the same thing, so it is
 * rejected even if its version is listed.
 */
export const REGISTRY_BINDING = Object.freeze({
  readableVersions: DISTRIBUTION_READ_COMPATIBLE_VERSIONS,
  readableIds: DISTRIBUTION_READ_COMPATIBLE_IDS,
  readCompatible(distribution) {
    const version = distribution?.version;
    const id = distribution?.id;
    return DISTRIBUTION_READ_COMPATIBLE_IDS.includes(id) && DISTRIBUTION_READ_COMPATIBLE_VERSIONS.includes(version);
  },
  /** `true` when a readable record is *behind* the current identity (`换代`). */
  isStale(distribution) {
    return this.readCompatible(distribution)
      && (distribution.version !== DISTRIBUTION.version || distribution.id !== DISTRIBUTION.id);
  },
});

/**
 * Damage grading: how a damaged file is handled, by domain.
 *
 * The judgement is "can this data be rebuilt from something else?" — not "is it
 * important?".
 *
 * - `authoritative` — the file *is* the fact (the registry, an environment's own
 *   identity record, a distribution descriptor). Damage must stop the command:
 *   guessing here would let dpx act on a fiction.
 * - `derived` — the file is a reading of something else (a package manifest's
 *   version, a profile's dependency list, a desktop update log). Damage is
 *   reported with its file path and skipped, because a doctor that refuses to
 *   run on the very damage it exists to find is useless.
 *
 * Every reader below returns the same shape, so a caller never has to guess
 * which of the two it is holding: `{ ok, value, problem, path }`, where
 * `problem.code` is `'missing'` (nothing there), `'unreadable'` (there, but not
 * readable) or `'damaged'` (readable bytes, unusable content).
 */
export const DAMAGE_DOMAINS = Object.freeze({
  authoritative: Object.freeze(['registry.json', ENVIRONMENT_MANIFEST_NAME, 'dsh-distribution.json']),
  derived: Object.freeze([
    'package.json (version)', 'profile package.json', 'desktop-state/updates.jsonl', 'desktop/.dpx-desktop.json',
  ]),
  policy: 'authoritative domains fail loud; derived domains report-and-skip',
});

/** Read and parse one JSON document, classifying every failure reason. */
export function readJsonDocument(path, { domain = 'derived' } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, problem: { code: 'missing', path, message: '文件不存在' }, domain, path };
    return { ok: false, problem: { code: 'unreadable', path, message: error.message }, domain, path };
  }
  try {
    return { ok: true, value: JSON.parse(text), path, domain };
  } catch (error) {
    return { ok: false, problem: { code: 'damaged', path, message: error.message }, domain, path };
  }
}

const DAMAGE_CODE_LABELS = Object.freeze({ missing: '缺失', unreadable: '不可读', damaged: '损坏' });

/** A one-line, user-facing rendering of a `problem` (`缺失` / `不可读` / `损坏`). */
export function describeDamage(problem) {
  if (!problem) return '未知问题';
  return `${DAMAGE_CODE_LABELS[problem.code] ?? problem.code}：${problem.path}${problem.message ? `（${problem.message}）` : ''}`;
}

/** The version a package manifest declares, keeping the reason it is unknown. */
export function packageVersionReport(directory) {
  const path = join(directory, 'package.json');
  const read = readJsonDocument(path, { domain: 'derived' });
  if (!read.ok) return read;
  if (typeof read.value?.version !== 'string') {
    return { ok: false, value: undefined, path, domain: 'derived', problem: { code: 'damaged', path, message: 'package.json 没有字符串 version 字段' } };
  }
  return { ok: true, value: read.value.version, path, domain: 'derived' };
}

/**
 * The plugin compatibility anchor.
 *
 * This is the machine-readable half of `docs/plugin-compat.md` (the prose lives
 * in its own file, because a schema that exists only in a document is not a
 * contract). It answers one question for a plugin author and for `dpx env
 * doctor`: **which `@deepseek-ai/dsh` releases is this dpx build's plugin
 * contract valid against?**
 *
 * Two deliberate choices, both of them corrections of a tempting mistake:
 *
 * - the anchor is the **`@deepseek-ai/dsh` version range plus a protocol
 *   number**, never the desktop launcher's version. dpx's whole point is that a
 *   launcher serves many dsh versions
 *   (`docs/desktop-release.md`: "Upgrading DSH never needs a new launcher"), so
 *   anchoring on the launcher would re-create the exact co-qualification that
 *   mechanism exists to avoid;
 * - it is **not** written into `dsh-distribution.json`. That descriptor's schema
 *   is `additionalProperties: false`
 *   (`spec/dsh-distribution/packages/core/schema/descriptor.schema.json`), so an
 *   extra key there is a protocol violation, not an extension. The anchor is
 *   surfaced by `dpx descriptor` (which already owns that output) instead.
 */
export const PLUGIN_COMPAT = Object.freeze({
  /** The coordination point: which package's versions this anchor constrains. */
  anchorPackage: '@deepseek-ai/dsh',
  /** Declared readable dsh range (npm semver range syntax). */
  dshRange: '>=0.1.0',
  /** Lowest dsh version the range admits, for the human-readable verdict. */
  minimum: '0.1.0',
  /** dpx's own plugin-contract protocol number. Bump only with a breaking change. */
  protocolVersion: 1,
  /** One line explaining what must *not* be used as the anchor. */
  forbiddenAnchor: '桌面启动器版本号（dpx 的核心语义是一个启动器服务多个 dsh 版本；用它做锚点等于把两者重新绑死）',
  /** The npm target a plugin author resolves against. */
  target: 'dsh',
});

/** `true` when `version` satisfies `PLUGIN_COMPAT.dshRange`. */
export function pluginCompatible(version) {
  const parsed = parseComparableVersion(version);
  if (!parsed) return false;
  for (const alternative of String(PLUGIN_COMPAT.dshRange).split('||')) {
    const clauses = alternative.trim().split(/\s+/).filter(Boolean);
    if (clauses.every(clause => versionSatisfiesClause(parsed, clause))) return true;
  }
  return false;
}

/**
 * A comparable version, or undefined when the text is not one.
 *
 * Only three numeric components plus an optional pre-release are needed: dpx
 * compares *dsh* release versions, which follow that shape. Anything else is
 * "unknown", and an unknown version is never guessed into a range.
 */
export function parseComparableVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
  if (!match) return undefined;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

function compareParsedVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function versionSatisfiesClause(version, clause) {
  const operator = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(clause);
  if (!operator) return false;
  const bound = parseComparableVersion(operator[2]);
  if (!bound) return false;
  const comparison = compareParsedVersions(version, bound);
  switch (operator[1]) {
    case '>=': return comparison >= 0;
    case '<=': return comparison <= 0;
    case '>': return comparison > 0;
    case '<': return comparison < 0;
    case '^': return comparison >= 0 && version.parts[0] === bound.parts[0];
    case '~': return comparison >= 0 && version.parts[0] === bound.parts[0] && version.parts[1] === bound.parts[1];
    default: return comparison === 0;
  }
}

/**
 * Environment identity handed to every child dpx launches.
 *
 * `DSH_HOME` already tells DSH which state it uses, but it is DSH's own
 * variable: it says nothing about *which managed environment* a process lives
 * in, and nothing outside DSH reads it. These two variables make the
 * environment discoverable by any tool — including a `dpx` that an agent
 * starts *inside* the environment, whose default registry location is otherwise
 * swallowed by the isolated `LOCALAPPDATA`.
 */
export const DPX_ENV_VARIABLE = 'DSH_DPX_ENV';
export const DPX_ENV_ROOT_VARIABLE = 'DSH_DPX_ENV_ROOT';
/** DPX's own registry location; propagated so nested dpx calls share one registry. */
export const DPX_HOME_VARIABLE = 'DPX_HOME';
export const WINDOWS_DISCOVERY_KEY = 'HKCU\\Software\\DSH\\DPX';

const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
// These belong to the selected DSH/TUI target, not to DPX. A future
// schema-backed target parser can replace this small compatibility list.
const TARGET_OPTIONS = new Set([
  '--help', '-h', '--version', '--profile', '--dump-config', '--dump-default-config',
  '--config', '--no-open', '--open', '--host', '--port', '--verbose', '--debug',
]);
const NO_DESKTOP_OPTION = '--no-desktop';

/**
 * Read the machine-level DPX discovery pointer (`HKCU\Software\DSH\DPX`).
 *
 * dpx publishes this key next to its registry (see `publishWindowsRegistry`),
 * so a tool that cannot see the manager's state directory can still find the
 * one registry that owns every environment on this machine. It is read-only
 * here, and only ever used as a documented fallback.
 */
export function windowsDiscoveryRegistryPath(platform = process.platform) {
  if (platform !== 'win32') return undefined;
  try {
    const result = spawnSync('reg.exe', ['query', WINDOWS_DISCOVERY_KEY, '/v', 'RegistryPath'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const match = /RegistryPath\s+REG_SZ\s+(.+?)\s*$/m.exec(result.stdout);
    const value = match?.[1]?.trim();
    return value && isAbsolute(value) ? resolve(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which managed environment this process is running inside, derived from
 * evidence rather than from a single variable.
 *
 * `DSH_DPX_ENV_ROOT` is the direct answer, but it is not always visible: DSH's
 * shell/terminal layer rebuilds the `DSH_*` namespace for the processes it hands
 * to an agent, and anything not declared there — including dpx's own identity
 * variables — is dropped before the agent's commands ever see it. Measured, not
 * assumed: inside a dpx-hosted desktop environment the agent's shell sees
 * `DSH_HOME` but neither `DSH_DPX_ENV_ROOT` nor even `DSH_AGENTS_HOME`.
 *
 * So the fallback is evidence a stripped environment cannot fake: `DSH_HOME` (or
 * the isolated `LOCALAPPDATA`) sitting next to a `.dpx-environment.json` that
 * declares `kind: DPXEnvironment`. A host shell has neither, and a directory
 * that merely happens to be called `dsh-home` is not enough.
 *
 * @returns `{ root, source, name }`, or undefined when this is not a dpx
 *   environment at all.
 */
export function environmentRootFromProcess(env = process.env, platform = process.platform) {
  const declared = env[DPX_ENV_ROOT_VARIABLE]?.trim();
  if (declared) {
    const manifest = environmentManifest(declared);
    if (manifest) return { root: resolve(declared), source: 'identity-variable', name: manifest.name };
  }
  const probes = [];
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    const root = dirname(resolve(dshHome));
    probes.push({ root, home: resolve(dshHome), source: 'dsh-home' });
  }
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const root = dirname(resolve(localAppData));
    probes.push({ root, home: join(root, 'dsh-home'), source: 'isolated-localappdata' });
  }
  for (const probe of probes) {
    if (basename(probe.home).toLowerCase() !== 'dsh-home') continue;
    const manifest = environmentManifest(probe.root);
    if (manifest) return { root: probe.root, source: probe.source, name: manifest.name };
  }
  return undefined;
}

/** The `DPXEnvironment` record stored in an environment root, if it is one. */
function environmentManifest(root) {
  return environmentManifestReport(root).manifest;
}

/**
 * The same read, with the reason a non-dpx root was not recognized.
 *
 * `environmentRootFromProcess` only ever wants the value (and deliberately
 * treats "not a dpx root" and "damaged record" as the same non-answer, because
 * it is asking who *this* process is, not auditing a directory). The registry
 * doctor wants the difference, and gets it from `problem`.
 */
export function environmentManifestReport(root) {
  const absolute = resolve(root);
  const path = join(absolute, ENVIRONMENT_MANIFEST_NAME);
  const read = readJsonDocument(path, { domain: 'authoritative' });
  if (!read.ok) return { manifest: undefined, path, read };
  if (read.value?.kind !== 'DPXEnvironment' || typeof read.value.root !== 'string') {
    return {
      manifest: undefined,
      path,
      read: { ...read, ok: false, problem: { code: 'damaged', path, message: `不是 DPXEnvironment 记录（kind=${JSON.stringify(read.value?.kind)}）` } },
    };
  }
  return { manifest: read.value, path, read };
}

/**
 * Where DPX keeps `registry.json`.
 *
 * `DPX_HOME` always wins: an operator (or a parent dpx) can point a process at
 * one exact registry. Otherwise the platform default is used — with one
 * documented exception. A dpx environment isolates `LOCALAPPDATA`, so the
 * child's "platform default" is a *private, empty* registry inside
 * `<env-root>\localappdata`; a `dpx` started inside an environment would then
 * report no environments at all, which is the opposite of what a multi
 * environment manager is for. When the process can prove it lives in a managed
 * environment (see `environmentRootFromProcess`) and the private default holds
 * no registry, the machine-level discovery pointer is preferred.
 */
export function defaultRegistryHome(env = process.env, platform = process.platform) {
  if (env.DPX_HOME?.trim()) return resolve(env.DPX_HOME);
  let candidate;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error('LOCALAPPDATA is unavailable; set DPX_HOME to an absolute private directory.');
    candidate = resolve(localAppData, 'DSH', 'DPX');
  } else {
    const stateHome = env.XDG_STATE_HOME?.trim() || (env.HOME ? join(env.HOME, '.local', 'state') : undefined);
    if (!stateHome) throw new Error('Cannot determine a state directory; set DPX_HOME.');
    candidate = resolve(stateHome, 'dsh-dpx');
  }
  if (existsSync(join(candidate, 'registry.json'))) return candidate;
  if (environmentRootFromProcess(env, platform)) {
    const pointer = windowsDiscoveryRegistryPath(platform);
    if (pointer && dirname(pointer) !== candidate) return dirname(pointer);
  }
  return candidate;
}

export function registryPath(home = defaultRegistryHome()) {
  return join(home, 'registry.json');
}

export function assertEnvironmentName(name) {
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new Error(`Invalid environment name ${JSON.stringify(name)}. Use 1–64 ASCII letters, digits, or hyphens, starting with a letter.`);
  }
  return name.toLowerCase();
}

export function parseEnvironmentArguments(args, { parseDesktop = true } = {}) {
  let name;
  let root;
  let desktop = true;
  const passthrough = [];
  for (const arg of args) {
    if (parseDesktop && arg === NO_DESKTOP_OPTION) {
      desktop = false;
      continue;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const candidate = arg.slice(2);
      if (WINDOWS_DRIVE_PATH.test(candidate) || isAbsolute(candidate)) {
        if (root) throw new Error('Specify at most one environment storage root.');
        root = resolve(candidate);
        continue;
      }
      if (!name && ENVIRONMENT_NAME.test(candidate) && !TARGET_OPTIONS.has(arg)) {
        name = assertEnvironmentName(candidate);
        continue;
      }
    }
    passthrough.push(arg);
  }
  if (!name) throw new Error('An environment name is required, for example --test.');
  return { name, root, passthrough, desktop };
}

export function environmentRoot(storageRoot, name) {
  if (!storageRoot || !isAbsolute(storageRoot)) throw new Error('Environment storage root must be an absolute path.');
  return join(resolve(storageRoot), 'dsh-environments', assertEnvironmentName(name));
}

export function pathsFor(root) {
  const absolute = resolve(root);
  const home = join(absolute, 'home');
  return {
    root: absolute,
    npmPrefix: join(absolute, 'npm-prefix'),
    npmCache: join(absolute, 'npm-cache'),
    dshHome: join(absolute, 'dsh-home'),
    agentsHome: join(absolute, 'agents-home'),
    home,
    // Windows applications commonly derive the first workspace location from
    // USERPROFILE\\Desktop. Keep that location inside the isolated profile and
    // create it during environment initialization (including upgrades of an
    // environment created by an older dpx version).
    desktopHome: join(home, 'Desktop'),
    appData: join(absolute, 'appdata'),
    localAppData: join(absolute, 'localappdata'),
    tmp: join(absolute, 'tmp'),
    xdgConfig: join(absolute, 'xdg-config'),
    xdgCache: join(absolute, 'xdg-cache'),
    xdgData: join(absolute, 'xdg-data'),
    workspace: join(absolute, 'workspace'),
    // Desktop shell state (logs, WebView profile) lives inside the environment
    // root so `dpx env remove --purge` cannot leave it behind on the host.
    desktopState: join(absolute, 'desktop-state'),
    // The desktop shell owns this append-only update journal; dpx only reads it.
    updates: join(absolute, 'desktop-state', 'updates.jsonl'),
    descriptor: join(absolute, 'dsh-distribution.json'),
    manifest: join(absolute, ENVIRONMENT_MANIFEST_NAME),
    desktopDir: join(absolute, DESKTOP_LAUNCHER_DIR),
    desktop: join(absolute, DESKTOP_LAUNCHER_DIR, DESKTOP_LAUNCHER_NAME),
  };
}

export function desktopLauncherRelative() {
  return `./${DESKTOP_LAUNCHER_DIR}/${DESKTOP_LAUNCHER_NAME}`;
}

function environmentDirectories(paths, platform) {
  const directories = [
    paths.npmPrefix, paths.npmCache, paths.dshHome, paths.agentsHome, paths.home,
    paths.appData, paths.localAppData, paths.tmp, paths.xdgConfig, paths.xdgCache,
    paths.xdgData, paths.workspace,
  ];
  // Node and many Windows file pickers resolve the user's Desktop from
  // USERPROFILE. Without this directory, the first workspace setup shows the
  // native "location unavailable" dialog before the user can choose anything.
  if (platform === 'win32') directories.push(paths.desktopHome);
  return directories;
}

async function ensureEnvironmentDirectories(paths, platform) {
  for (const directory of environmentDirectories(paths, platform)) {
    await mkdir(directory, { recursive: true });
  }
}

/**
 * Write the environment-level DSH instruction file (`dsh-home/AGENTS.md`).
 *
 * Every launch path points `DSH_HOME` at that directory, so this single file
 * reaches an agent started through `dpx run` (Web or TUI), through the desktop
 * launcher, and through any future launcher that honors `DSH_HOME`. It states
 * which environment is running, how the layout is arranged, and that npm keeps
 * its native meaning — installing into the environment requires an explicit
 * `--prefix` and `--cache` (or `dpx npm install`).
 */
async function writeEnvironmentGuide(paths, { name, instanceId }) {
  return ensureEnvironmentGuide(paths, { name, instanceId, version: DISTRIBUTION.version });
}

/** Repair/refresh the parts of an existing environment that are generated. */
async function ensureEnvironmentScaffold(paths, record, platform) {
  await ensureEnvironmentDirectories(paths, platform);
  await writeEnvironmentGuide(paths, { name: record.name, instanceId: record.instance?.instanceId });
}

export function environmentDescriptor({ desktop = false } = {}) {
  const resources = [
    resource('npm-prefix', 'extensions', './npm-prefix', 'nonportable'),
    resource('dsh-home', 'config', './dsh-home', 'conditional'),
    resource('agents-home', 'config', './agents-home', 'conditional'),
    resource('npm-cache', 'cache', './npm-cache', 'nonportable'),
    resource('workspace', 'data', './workspace', 'conditional'),
  ];
  // The layout protocol deliberately excludes whitespace in relative path
  // segments, so it owns the launcher directory rather than its display-named EXE.
  if (desktop) resources.push(resource('desktop-launcher', 'dsh-dpx:desktop-launcher', './desktop', 'nonportable'));
  return {
    apiVersion: 'distribution.dsh.dev/v1alpha1',
    kind: 'DistributionDescriptor',
    distribution: DISTRIBUTION,
    displayName: 'dsh-dpx isolated DeepSeek Harness environment',
    protocols: [
      {
        apiVersion: 'layout.distribution.dsh.dev/v1alpha1',
        kind: 'ManagedLayout',
        required: true,
        spec: { resources },
      },
      {
        apiVersion: 'discovery.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentDiscovery',
        required: false,
        spec: { references: ['urn:dsh:dpx:descriptor:0.1.0'] },
      },
    ],
  };
}

function resource(id, role, value, portability) {
  return {
    id,
    role,
    location: { type: 'relative-path', value },
    ownership: 'exclusive',
    portability,
    sensitivity: 'private',
  };
}

export function newRegistry() {
  return { format: FORMAT, revision: 0, environments: [] };
}

export async function loadRegistry(home) {
  const path = registryPath(home);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    validateRegistry(parsed);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return newRegistry();
    throw new Error(`Cannot read DPX registry ${path}: ${error.message}`);
  }
}

/**
 * The same read, without throwing, for read-only callers.
 *
 * `dpx env doctor` must be able to *report* a damaged registry, so it needs a
 * path that returns the damage instead of raising it. Authoritative-domain
 * fail-loud is preserved where it belongs: every mutating command still calls
 * `loadRegistry`, which refuses to overwrite a registry it cannot validate.
 *
 * @returns `{ registry, problems }`; `registry` is `newRegistry()` when the file
 *   is absent, and `undefined` when it exists but cannot be trusted.
 */
export async function readRegistryReport(home) {
  const path = registryPath(home);
  const read = readJsonDocument(path, { domain: 'authoritative' });
  if (!read.ok) {
    if (read.problem.code === 'missing') return { registry: newRegistry(), problems: [] };
    return { registry: undefined, problems: [read.problem] };
  }
  try {
    validateRegistry(read.value);
  } catch (error) {
    return { registry: undefined, problems: [{ code: 'damaged', path, message: error.message }] };
  }
  return { registry: read.value, problems: [] };
}

function validateRegistry(registry) {
  if (!registry || registry.format !== FORMAT || !Number.isSafeInteger(registry.revision) || registry.revision < 0 || !Array.isArray(registry.environments)) {
    throw new Error('Registry format is invalid; refusing to overwrite it.');
  }
  const names = new Set();
  const ids = new Set();
  for (const row of registry.environments) {
    if (!row || row.apiVersion !== DPX_API_VERSION || row.kind !== 'DPXEnvironment') throw new Error('Registry has an invalid environment record.');
    const name = assertEnvironmentName(row.name);
    if (name !== row.name || names.has(name) || ids.has(row.instance.instanceId)) throw new Error('Registry has duplicate or invalid environment identities.');
    if (!isAbsolute(row.root) || row.instance.apiVersion !== 'discovery.distribution.dsh.dev/v1alpha1' || row.instance.kind !== 'EnvironmentInstance') {
      throw new Error('Registry environment binding is invalid.');
    }
    // Read compatibility, not equality: an environment written by an older dpx
    // is still readable (see REGISTRY_BINDING). An identity this build never
    // wrote is not, and says so with the two lists a reader needs to act.
    if (!REGISTRY_BINDING.readCompatible(row.instance.distribution)) {
      throw new Error(
        `Registry environment --${row.name} binds distribution `
        + `${row.instance.distribution?.id}@${row.instance.distribution?.version ?? '(no version)'}, `
        + `which this dpx cannot read. Readable ids: ${DISTRIBUTION_READ_COMPATIBLE_IDS.join(', ')}; `
        + `readable versions: ${DISTRIBUTION_READ_COMPATIBLE_VERSIONS.join(', ')}. `
        + 'If that distribution is a newer dpx, upgrade dpx; do not edit the registry by hand.',
      );
    }
    if (row.desktop !== undefined && (!row.desktop || row.desktop.platform !== 'win32' || row.desktop.launcher !== desktopLauncherRelative())) {
      throw new Error('Registry desktop launcher binding is invalid.');
    }
    names.add(name);
    ids.add(row.instance.instanceId);
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export async function withRegistryLock(home, operation) {
  await mkdir(home, { recursive: true });
  const lock = join(home, 'registry.lock');
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw new Error(`DPX registry is busy: ${lock}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function createEnvironment({ name, storageRoot, home = defaultRegistryHome(), publishDiscovery = true, desktop = true, platform = process.platform }) {
  name = assertEnvironmentName(name);
  const root = environmentRoot(storageRoot, name);
  const installDesktop = desktop && platform === 'win32';
  return withRegistryLock(home, async () => {
    const registry = await loadRegistry(home);
    const existing = registry.environments.find(row => row.name === name);
    if (existing) {
      if (resolve(existing.root) !== root) throw new Error(`Environment --${name} is already registered at ${existing.root}.`);
      // Also repair environments created before the isolated Windows profile
      // folders were initialized. This makes the fix effective without asking
      // users to remove and recreate an existing environment.
      await ensureEnvironmentScaffold(pathsFor(existing.root), existing, platform);
      return existing;
    }
    if (existsSync(root)) {
      const contents = await import('node:fs/promises').then(fs => fs.readdir(root));
      if (contents.length > 0) throw new Error(`Refusing to adopt non-empty environment directory: ${root}`);
    }
    const paths = pathsFor(root);
    await ensureEnvironmentDirectories(paths, platform);
    const instanceId = `urn:uuid:${randomUUID()}`;
    const instance = {
      apiVersion: 'discovery.distribution.dsh.dev/v1alpha1',
      kind: 'EnvironmentInstance',
      instanceId,
      distribution: DISTRIBUTION,
      descriptorRef: 'urn:dsh:dpx:descriptor:0.1.0',
      revision: 0,
    };
    const record = {
      apiVersion: DPX_API_VERSION,
      kind: 'DPXEnvironment',
      name,
      root,
      instance,
      discoverableEntry: discoverableEntry(instance, name),
      createdAt: new Date().toISOString(),
      desktop: installDesktop ? {
        platform: 'win32',
        launcher: desktopLauncherRelative(),
      } : undefined,
    };
    await atomicJson(paths.descriptor, environmentDescriptor({ desktop: installDesktop }));
    if (installDesktop) await installPackagedDesktopLauncher(root);
    await writeEnvironmentGuide(paths, { name, instanceId });
    await atomicJson(paths.manifest, record);
    registry.environments.push(record);
    registry.revision += 1;
    await atomicJson(registryPath(home), registry);
    if (publishDiscovery && process.env.DPX_DISABLE_DISCOVERY !== '1') publishWindowsRegistry(home);
    return record;
  });
}

function discoverableEntry(instance, displayName) {
  const source = JSON.stringify(instance);
  return {
    apiVersion: 'discovery.distribution.dsh.dev/v1alpha1',
    kind: 'DiscoverableEntry',
    instanceId: instance.instanceId,
    distribution: instance.distribution,
    descriptorRef: instance.descriptorRef,
    revision: instance.revision,
    contentDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
    status: 'published',
    displayName,
    publisher: 'dsh-dpx',
  };
}

export async function resolveEnvironment(name, home = defaultRegistryHome()) {
  name = assertEnvironmentName(name);
  const registry = await loadRegistry(home);
  const record = registry.environments.find(row => row.name === name);
  if (!record) throw new Error(`Environment --${name} is not registered. Create it with: dpx npm install -g @deepseek-ai/dsh --${name} --<absolute-storage-root>`);
  if (!existsSync(record.root)) throw new Error(`Environment --${name} is registered but its root is missing: ${record.root}`);
  // Repair what an environment created by an older dpx version is missing —
  // profile directories and the generated instruction file — before a caller
  // launches npm, dsh, the TUI, or the desktop shell.
  await ensureEnvironmentScaffold(pathsFor(record.root), record, process.platform);
  return record;
}

/**
 * What `dpx env remove` would change, computed without touching anything.
 *
 * This is the *same* code path the real removal runs (`removeEnvironment` calls
 * it inside the registry lock and then applies it), so a `--dry-run` cannot
 * drift from what the real command does. It deliberately does not call
 * `resolveEnvironment`: that would run `ensureEnvironmentScaffold`, and a
 * preview that writes files is not a preview.
 */
export async function environmentRemovalPlan({ name, home = defaultRegistryHome(), purge = false, platform = process.platform } = {}) {
  name = assertEnvironmentName(name);
  const registry = await loadRegistry(home);
  const index = registry.environments.findIndex(row => row.name === name);
  if (index < 0) throw new Error(`Environment --${name} is not registered.`);
  const record = registry.environments[index];
  const expected = environmentRoot(dirname(dirname(record.root)), name);
  if (resolve(record.root) !== expected) throw new Error(`Refusing to remove environment with an unsafe root: ${record.root}`);
  const paths = pathsFor(record.root);
  const rootExists = existsSync(record.root);
  const desktopStateExists = existsSync(paths.desktopState);
  const remaining = registry.environments.length - 1;
  return {
    name,
    home,
    purge,
    record,
    registry: {
      path: registryPath(home),
      // The record is dropped either way; the revision always moves.
      revision: { from: registry.revision, to: registry.revision + 1 },
      removesRecordFor: name,
      remainingRecords: remaining,
    },
    root: {
      path: record.root,
      exists: rootExists,
      action: purge ? (rootExists ? 'delete' : 'already-missing') : 'keep',
      // Everything below lives inside the root, which is why purging the root
      // is the whole of the environment's removal.
      includes: [
        { path: paths.npmPrefix, label: '环境内 npm 全局目录' },
        { path: paths.dshHome, label: 'DSH_HOME（profiles / sessions / 本环境指南）' },
        { path: paths.agentsHome, label: 'agents / skills' },
        { path: paths.descriptor, label: 'distribution descriptor' },
        { path: paths.manifest, label: '环境身份记录' },
      ],
    },
    desktop: {
      dir: paths.desktopDir,
      launcher: paths.desktop,
      exists: existsSync(paths.desktop),
      action: purge ? (rootExists ? 'delete-with-root' : 'already-missing') : 'keep',
      state: { path: paths.desktopState, exists: desktopStateExists, action: purge ? 'delete-with-root' : 'keep' },
    },
    discovery: {
      key: WINDOWS_DISCOVERY_KEY,
      // dpx owns this pointer and only ever removes it when no environment is
      // left; a per-environment removal leaves it in place.
      action: remaining === 0 ? (platform === 'win32' ? 'evaluate-and-remove-own-key' : 'not-applicable') : 'keep',
      pointer: platform === 'win32' ? windowsDiscoveryRegistryPath(platform) : undefined,
    },
    platform,
  };
}

export async function removeEnvironment({ name, home = defaultRegistryHome(), purge = false, dryRun = false, platform = process.platform }) {
  name = assertEnvironmentName(name);
  if (dryRun) {
    // Still wrapped in the lock: the plan must be read against a stable
    // registry, and holding the lock changes nothing on disk.
    return withRegistryLock(home, async () => ({ plan: await environmentRemovalPlan({ name, home, purge, platform }), purged: false, dryRun: true }));
  }
  return withRegistryLock(home, async () => {
    const registry = await loadRegistry(home);
    const index = registry.environments.findIndex(row => row.name === name);
    if (index < 0) throw new Error(`Environment --${name} is not registered.`);
    const [record] = registry.environments.splice(index, 1);
    const expected = environmentRoot(dirname(dirname(record.root)), name);
    if (resolve(record.root) !== expected) throw new Error(`Refusing to remove environment with an unsafe root: ${record.root}`);
    // Purging is the one operation that must survive a real Windows directory
    // tree. On Windows an indexer, an antivirus scanner or a DSH child that has
    // just been asked to exit can hold a handle for a moment and fail the delete
    // with EBUSY/EPERM; Node's `rm` only retries when `maxRetries` says so, and
    // its default of 0 means the first transient failure would otherwise leave a
    // half-deleted environment behind.
    if (purge && existsSync(record.root)) await rm(record.root, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
    registry.revision += 1;
    await atomicJson(registryPath(home), registry);
    return { record, purged: purge && !existsSync(record.root), dryRun: false };
  });
}

export function npmCliPath(node = process.execPath) {
  const candidate = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(candidate)) throw new Error(`Cannot locate npm-cli.js next to Node: ${candidate}. Set DPX_NPM_CLI to a trusted absolute npm-cli.js path.`);
  return candidate;
}

/**
 * Environment for an npm child process that dpx itself starts.
 *
 * npm's target is expressed with **explicit command-line flags** (`--prefix`,
 * `--cache`, see `npmInstallArguments`) instead of `NPM_CONFIG_*`. dsh-dpx does
 * not silently redefine what `npm` means: an isolated environment must not make
 * a plain `npm install -g` elsewhere behave differently. Inherited npm config
 * that would retarget the install is dropped for the same reason.
 */
export function npmEnvironment(inherited = process.env) {
  const env = { ...inherited };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  // Default installs are direct. Remove inherited proxy state so an environment
  // never silently depends on a host-local proxy. An operator can explicitly
  // pass npm's --proxy / --https-proxy flags for a single install command.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy']) delete env[key];
  for (const key of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'NPM_CONFIG_CACHE', 'npm_config_cache', 'NPM_CONFIG_UPDATE_NOTIFIER', 'npm_config_update_notifier']) delete env[key];
  return env;
}

/**
 * The isolated environment variables every child DSH/TUI process receives.
 *
 * Note what is deliberately *absent*: no `NPM_CONFIG_PREFIX` and no
 * `NPM_CONFIG_CACHE`. npm keeps its native defaults inside the environment, and
 * the generated `dsh-home/AGENTS.md` tells an agent to use an explicit
 * `--prefix` / `--cache` (or `dpx npm install`) when it really means this
 * environment.
 *
 * What is deliberately *present*: the environment's own identity. `DSH_HOME`
 * only tells DSH where its state is; nothing outside DSH reads it, and a tool
 * cannot tell "inside environment A" from "the host" by looking at it alone.
 * `DSH_DPX_ENV` / `DSH_DPX_ENV_ROOT` are the environment's name and root, so
 * any process — including another `dpx` started inside this one — can answer
 * "which environment am I in?" without guessing from paths. `DPX_HOME` is
 * propagated for the same reason: every environment on this machine is owned by
 * one registry, and a nested dpx must find that registry, not a private empty
 * one produced by the isolated `LOCALAPPDATA`.
 */
export function runtimeEnvironment(paths, inherited = process.env, { name, registryHome } = {}) {
  const env = npmEnvironment(inherited);
  env.DSH_HOME = paths.dshHome;
  env.DSH_AGENTS_HOME = paths.agentsHome;
  env.DSH_TELEMETRY_DISABLED = '1';
  env[DPX_ENV_ROOT_VARIABLE] = paths.root;
  env[DPX_ENV_VARIABLE] = name ?? basename(paths.root);
  if (registryHome) env[DPX_HOME_VARIABLE] = registryHome;
  env.HOME = paths.home;
  env.USERPROFILE = paths.home;
  env.APPDATA = paths.appData;
  env.LOCALAPPDATA = paths.localAppData;
  env.TEMP = paths.tmp;
  env.TMP = paths.tmp;
  env.XDG_CONFIG_HOME = paths.xdgConfig;
  env.XDG_CACHE_HOME = paths.xdgCache;
  env.XDG_DATA_HOME = paths.xdgData;
  env.PATH = [paths.npmPrefix, inherited.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
  return env;
}

/**
 * The launch targets dpx recognizes.
 *
 * This is dpx's own compatibility list, not a protocol: a target names the npm
 * package plus the entry file dpx starts *directly*, so a launch never depends
 * on PATH lookup, on a `.cmd` shim, or on any shell. `dpx which` reports the
 * same list, which is why it is exported rather than inlined.
 */
export const LAUNCH_TARGETS = Object.freeze([
  Object.freeze({ target: 'dsh', package: '@deepseek-ai/dsh', entry: ['lib', 'bin.js'] }),
  Object.freeze({ target: 'dsh-tui', package: '@deepseek-harness-tui/dsh-tui', entry: ['bin', 'dsh-tui.js'] }),
]);

export function launchTarget(name) {
  return LAUNCH_TARGETS.find(entry => entry.target === name);
}

export function launchTargets() {
  return LAUNCH_TARGETS.map(entry => entry.target);
}

function globalPackageRoots(paths) {
  return process.platform === 'win32'
    ? [join(paths.npmPrefix, 'node_modules')]
    : [join(paths.npmPrefix, 'lib', 'node_modules'), join(paths.npmPrefix, 'node_modules')];
}

export function locatePackage(paths, packageName) {
  for (const root of globalPackageRoots(paths)) {
    const candidate = join(root, ...packageName.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Read the version a package manifest declares, without failing on damage.
 *
 * The returning API shape is unchanged (an unknown version is `undefined`); the
 * *reason* it is unknown is available from `packageVersionReport`, which is what
 * lets `dpx env doctor` say "文件损坏" instead of "未知版本".
 */
export function packageVersionAt(directory) {
  const report = packageVersionReport(directory);
  const version = report.ok ? report.value : undefined;
  return typeof version === 'string' ? version : undefined;
}

/** What `packageVersionAt` reads, plus the part of the environment it came from. */
export function describePackageVersion(directory) {
  return packageVersionReport(directory);
}

export function launchSpec(paths, target) {
  const entry = launchTarget(target);
  if (!entry) {
    throw new Error(`Unsupported launch target ${JSON.stringify(target)}. Supported targets: ${launchTargets().join(', ')}.`);
  }
  const pkg = locatePackage(paths, entry.package);
  if (!pkg) {
    throw new Error(`The isolated ${entry.package} package is missing. Install it with dpx npm install -g ${entry.package} --<environment>.`);
  }
  return { file: process.execPath, args: [join(pkg, ...entry.entry)] };
}

export function runChild(file, args, options) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveChild({ code: code ?? 1, signal }));
  });
}

export function publishWindowsRegistry(home, platform = process.platform) {
  if (platform !== 'win32') return;
  const command = "$ErrorActionPreference='Stop'; New-Item -Path 'HKCU:\\Software\\DSH\\DPX' -Force | Out-Null; New-ItemProperty -Path 'HKCU:\\Software\\DSH\\DPX' -Name 'RegistryPath' -PropertyType String -Value $env:DPX_REGISTRY_PATH -Force | Out-Null; New-ItemProperty -Path 'HKCU:\\Software\\DSH\\DPX' -Name 'Profile' -PropertyType String -Value 'dpx.dsh.dev/v1alpha1' -Force | Out-Null";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, DPX_REGISTRY_PATH: registryPath(home) },
    stdio: 'ignore',
  });
  if (result.error || result.status !== 0) throw new Error('Could not publish the DPX Windows discovery pointer.');
}

export function desktopArtifactPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'windows', 'DSH DeepSeek Harness Desktop.exe');
}

export function resolvedDesktopArtifact(env = process.env) {
  const artifact = env.DPX_DESKTOP_ARTIFACT?.trim() || desktopArtifactPath();
  if (!isAbsolute(artifact)) throw new Error('DPX_DESKTOP_ARTIFACT must be an absolute path.');
  return artifact;
}

export function assertDesktopArtifact(env = process.env) {
  const artifact = resolvedDesktopArtifact(env);
  if (!existsSync(artifact)) {
    throw new Error(`Desktop launcher artifact is missing: ${artifact}. Reinstall dsh-dpx, or create this environment with --no-desktop.`);
  }
  return artifact;
}

export async function installDesktopLauncher(destination, env = process.env) {
  const artifact = assertDesktopArtifact(env);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(artifact, destination);
}

/**
 * Copy the desktop launcher shipped inside this dpx package into an environment
 * and record the version/digest stamp the update commands compare against.
 */
export async function installPackagedDesktopLauncher(envRoot, env = process.env) {
  const artifact = assertDesktopArtifact(env);
  const installed = await installBundledDesktopLauncher({ envRoot, artifactPath: artifact });
  return { ...installed, artifact };
}

/** Version of the desktop launcher recorded for an environment, if any. */
export function desktopVersion(envRoot) {
  return desktopVersionReport(envRoot).value;
}

/**
 * The same read, keeping the reason a stamp is unreadable, and honouring the
 * stamp schema whitelist that `readDesktopStamp` enforces.
 *
 * Without that check `dpx env show` would happily print a version read out of a
 * stamp that `dpx desktop status` reports as damaged — the same file described
 * two different ways by two commands. A stamp outside
 * `DESKTOP_STAMP_SCHEMA_VERSIONS` is therefore "unknown version" here too.
 */
export function desktopVersionReport(envRoot) {
  const path = join(envRoot, DESKTOP_LAUNCHER_DIR, DESKTOP_STAMP_NAME);
  const read = readJsonDocument(path, { domain: 'derived' });
  if (!read.ok) return read;
  const schemaVersion = Number(read.value?.schemaVersion);
  if (!Number.isInteger(schemaVersion) || !DESKTOP_STAMP_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return {
      ok: false,
      value: undefined,
      path,
      domain: 'derived',
      problem: {
        code: 'damaged',
        path,
        message: `桌面启动器标记的 schemaVersion ${JSON.stringify(read.value?.schemaVersion)} 不在支持的版本里`
          + `（${DESKTOP_STAMP_SCHEMA_VERSIONS.join(', ')}）——与 dpx desktop status 的判定保持一致`,
      },
    };
  }
  const version = typeof read.value?.version === 'string' ? read.value.version : undefined;
  return { ok: true, value: version, path, domain: 'derived' };
}

export function displayEnvironment(record) {
  return {
    name: record.name,
    instanceId: record.instance.instanceId,
    root: record.root,
    descriptor: join(record.root, 'dsh-distribution.json'),
    npmPrefix: pathsFor(record.root).npmPrefix,
    npmCache: pathsFor(record.root).npmCache,
    dshHome: pathsFor(record.root).dshHome,
    agentsHome: pathsFor(record.root).agentsHome,
    ...(existsSync(pathsFor(record.root).desktop) ? { desktop: pathsFor(record.root).desktop, desktopVersion: desktopVersion(record.root) } : {}),
  };
}

export function isGlobalInstall(args) {
  return args.includes('-g') || args.includes('--global');
}

/**
 * Complete an npm global install's target with explicit flags.
 *
 * `--prefix` and `--cache` are passed on the command line rather than through
 * `NPM_CONFIG_*`, so dpx never changes what `npm` means for anything else that
 * runs in the same environment.
 */
export function npmInstallArguments(args, prefix, cache) {
  if (!isGlobalInstall(args)) throw new Error('dpx only accepts npm global installs. Include -g or --global.');
  if (args.some(arg => arg === '--prefix' || arg.startsWith('--prefix='))) throw new Error('dpx owns npm --prefix; do not override it.');
  if (cache !== undefined && args.some(arg => arg === '--cache' || arg.startsWith('--cache='))) throw new Error('dpx owns npm --cache; do not override it.');
  const hasProxy = args.some(arg => arg === '--proxy' || arg.startsWith('--proxy='));
  const hasHttpsProxy = args.some(arg => arg === '--https-proxy' || arg.startsWith('--https-proxy='));
  return [
    ...args,
    '--prefix', prefix,
    ...(cache === undefined ? [] : ['--cache', cache]),
    '--no-audit', '--no-fund',
    ...(hasProxy ? [] : ['--proxy=null']),
    ...(hasHttpsProxy ? [] : ['--https-proxy=null']),
  ];
}

// ---------------------------------------------------------------------------
// Runtime identity: "which copy would actually run?"
//
// dpx knows the npm-prefix ↔ DSH_HOME ↔ profile relation, but that knowledge
// used to live only inside a `dpx` process. Everything below turns it into a
// queryable fact, so neither a human nor an agent has to guess which DSH a
// bare command name resolves to.
// ---------------------------------------------------------------------------

/** Compare two paths the way the platform's filesystem does. */
export function samePath(left, right, platform = process.platform) {
  const a = resolve(left);
  const b = resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Is `candidate` inside `parent` (or equal to it)? */
export function pathContains(parent, candidate, platform = process.platform) {
  const a = resolve(parent);
  const b = resolve(candidate);
  const relative = platform === 'win32'
    ? (b.toLowerCase().startsWith(a.toLowerCase()) ? b.slice(a.length) : undefined)
    : (b.startsWith(a) ? b.slice(a.length) : undefined);
  if (relative === undefined) return false;
  return relative === '' || relative.startsWith('\\') || relative.startsWith('/');
}

export function pathEntries(env = process.env, platform = process.platform) {
  const raw = env.PATH ?? env.Path ?? '';
  return String(raw).split(platform === 'win32' ? ';' : ':').map(entry => entry.trim()).filter(Boolean);
}

const WINDOWS_SHIM_SUFFIXES = ['.cmd', '.exe', '.bat', '.ps1'];

/**
 * Every file a shell would consider when asked for `target`, in PATH order.
 *
 * This is intentionally a *prediction*, not an execution: it never runs the
 * candidate, so reporting on an environment can never have side effects. The
 * first entry is what a bare `target` resolves to in this process's ambient
 * PATH — which is exactly the question that produced the original confusion.
 */
export function commandCandidates(target, { env = process.env, platform = process.platform } = {}) {
  const suffixes = platform === 'win32' ? WINDOWS_SHIM_SUFFIXES : [''];
  const found = [];
  const seen = new Set();
  for (const directory of pathEntries(env, platform)) {
    for (const suffix of suffixes) {
      const file = resolve(directory, `${target}${suffix}`);
      const key = platform === 'win32' ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      let stats;
      try {
        stats = statSync(file);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      seen.add(key);
      found.push({ file, directory: resolve(directory) });
      break;
    }
  }
  return found;
}

/** Resolve a command name through an environment's own PATH (used by `dpx exec`). */
export function resolveCommandInPath(command, env = process.env, platform = process.platform) {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;
  return commandCandidates(command, { env, platform })[0]?.file ?? command;
}

/**
 * Which managed environment (if any) owns a path, and which `DSH_HOME` a copy
 * found there would use.
 *
 * A copy found outside every registered environment belongs to the host, and
 * the interesting fact about it is that it will *silently use the host's own
 * DSH state*: that is why "I installed it but the UI did not change" happens.
 */
export function classifyCommandPath(file, { paths, name, registry, env = process.env, platform = process.platform } = {}) {
  const rows = [];
  if (paths) rows.push({ name, root: paths.root });
  for (const row of registry?.environments ?? []) {
    if (!rows.some(candidate => samePath(candidate.root, row.root, platform))) rows.push({ name: row.name, root: row.root });
  }
  for (const row of rows) {
    const prefix = pathsFor(row.root).npmPrefix;
    if (!pathContains(prefix, file, platform)) continue;
    return {
      file,
      inEnvironment: true,
      environment: row.name,
      envRoot: row.root,
      dshHome: pathsFor(row.root).dshHome,
      source: 'npm-prefix',
    };
  }
  const hostHome = env.DSH_HOME?.trim()
    || (env.USERPROFILE?.trim() || env.HOME?.trim()
      ? join(env.USERPROFILE?.trim() || env.HOME.trim(), '.dsh')
      : undefined);
  return { file, inEnvironment: false, environment: undefined, envRoot: undefined, dshHome: hostHome, source: 'host' };
}

/** Every copy of one launch target inside an environment: global + each profile. */
export function targetCopies(paths, target) {
  const entry = launchTarget(target);
  if (!entry) return { target, package: undefined, copies: [] };
  const copies = [];
  // `versionReport` rides along so a caller can tell "this copy is not
  // installed" from "this copy's manifest is damaged" without reading it again.
  const copyOf = (location, directory) => {
    const versionReport = packageVersionReport(directory);
    return {
      location,
      path: directory,
      version: versionReport.ok ? versionReport.value : undefined,
      versionReport,
    };
  };
  const globalPackage = locatePackage(paths, entry.package);
  if (globalPackage) copies.push(copyOf('npm-prefix', globalPackage));
  for (const profile of listProfiles(paths)) {
    const directory = join(paths.dshHome, 'profiles', profile, 'node_modules', ...entry.package.split('/'));
    if (!existsSync(directory)) continue;
    copies.push(copyOf(`profile:${profile}`, directory));
  }
  return { target, package: entry.package, entry: join(...entry.entry), copies };
}

export function listProfiles(paths) {
  try {
    return readdirSync(join(paths.dshHome, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Parse pnpm's `node_modules/.modules.yaml`.
 *
 * Despite the extension, pnpm writes this file as **JSON** in current versions
 * and wrote it as YAML in older ones, so both shapes are accepted. Reading it is
 * how dpx learns which store a profile's `node_modules` is already linked from,
 * which is the difference between a working `plugin add` and
 * `ERR_PNPM_UNEXPECTED_STORE`.
 */
function parseModulesManifest(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const raw = JSON.parse(trimmed);
      if (raw && typeof raw === 'object') {
        const stringValue = value => (typeof value === 'string' && value ? value : undefined);
        return {
          storeDir: stringValue(raw.storeDir),
          virtualStoreDir: stringValue(raw.virtualStoreDir),
          layoutVersion: raw.layoutVersion === undefined ? undefined : String(raw.layoutVersion),
        };
      }
    } catch {
      // Fall through to the line scan below.
    }
  }
  const pick = key => {
    const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(text);
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
  };
  return { storeDir: pick('storeDir'), virtualStoreDir: pick('virtualStoreDir'), layoutVersion: pick('layoutVersion') };
}

function directoryHasEntries(directory) {
  try {
    return readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

/** How a profile's `node_modules` was installed, and from which store. */
export function readProfileInstaller(profileDir) {
  const modules = join(profileDir, 'node_modules');
  const modulesManifest = join(modules, '.modules.yaml');
  if (existsSync(modulesManifest)) {
    try {
      return { manager: 'pnpm', manifest: modulesManifest, ...parseModulesManifest(readFileSync(modulesManifest, 'utf8')) };
    } catch {
      return { manager: 'pnpm', manifest: modulesManifest };
    }
  }
  if (existsSync(join(profileDir, 'package-lock.json'))) {
    return { manager: 'npm', manifest: join(profileDir, 'package-lock.json') };
  }
  // An existing but empty `node_modules` is not an install: DSH creates the
  // directory as part of profile scaffolding, and reporting it would be a false
  // alarm on every fresh profile.
  if (existsSync(modules) && directoryHasEntries(modules)) return { manager: 'unknown' };
  return undefined;
}

/** The pnpm store dpx expects a child of this environment to use. */
export function expectedPnpmStore(paths) {
  return join(paths.xdgData, 'pnpm', 'store');
}

// ---------------------------------------------------------------------------
// `dpx env repair`: a recovery entry point that does not depend on the failures
// it recovers from
// ---------------------------------------------------------------------------
//
// Aligned with the upstream native recovery action (see
// `apps/desktop/README.zh.md`, "恢复操作…": it disables third-party bundles and
// renames the profile's `cordis.patch.yml` to `cordis.patch.yml.bak-<timestamp>`,
// **without parsing it**, and keeps installed packages and every other manifest
// field). Two properties matter and are easy to lose:
//
//   * the patch file is never parsed — parsing is what fails when a patch is the
//     thing that broke the profile;
//   * only `dsh.profile.bundles` is narrowed. `dependencies`, `overrides`, and
//     `node_modules` are untouched, so no package has to be reinstalled.
//
// The bundle list is *not* a second authority in this repository. It comes from
// the installed `@deepseek-ai/dsh-app-boot` (`PROFILE_TEMPLATES`) when that
// export exists, and `dpx` refuses to write bundles it cannot source rather than
// freezing a copy of upstream's list. `sanitizeProfile` itself is only exported
// by dsh >= 0.1.6-alpha.2 source, so it is *probed*: used when present, and
// replaced by a local equivalent (same policy, no parsing) when absent.

/** Probe for the exported helpers of the installed `@deepseek-ai/dsh-app-boot`. */
export async function probeAppBoot(paths) {
  const dshPackage = locatePackage(paths, 'dsh') ?? locatePackage(paths, '@deepseek-ai/dsh');
  if (!dshPackage) {
    return { available: false, reason: `环境内没有安装 ${PLUGIN_COMPAT.anchorPackage}`, templates: undefined };
  }
  const appBoot = join(dshPackage, 'node_modules', '@deepseek-ai', 'dsh-app-boot');
  if (!existsSync(appBoot)) {
    return { available: false, reason: `没有找到 ${appBoot}（npm 会把 dsh 的依赖树嵌在 dsh 之下）`, templates: undefined };
  }
  try {
    const module = await import(pathToFileURL(join(appBoot, 'lib', 'index.js')).href);
    return {
      available: true,
      module,
      path: appBoot,
      templates: module.PROFILE_TEMPLATES,
      patchFileName: module.PROFILE_PATCH_FILENAME,
      hasSanitizeProfile: typeof module.sanitizeProfile === 'function',
      hasWriteProfileBundles: typeof module.writeProfileBundles === 'function',
    };
  } catch (error) {
    return { available: false, reason: `import() 失败：${error.message}`, path: appBoot, templates: undefined };
  }
}

/** Profile names upstream ships a template for, plus their ordered bundles. */
export function profileTemplateNames(templates) {
  return Object.keys(templates ?? {}).sort();
}

function bundlesForProfile(templates, profile) {
  const bundles = templates?.[profile]?.bundles;
  return Array.isArray(bundles) && bundles.length ? [...bundles] : undefined;
}

/**
 * Write one profile's `cordis.patch.yml` aside and narrow its bundles.
 *
 * Never parses the patch. Never re-serializes the whole manifest: the manifest
 * is re-read, only `dsh.profile.bundles` is replaced, and the result is written
 * as UTF-8 **without a BOM** — the workspace has a recorded accident where a
 * PowerShell `Set-Content -Encoding utf8` BOM made `JSON.parse` throw and the
 * app would not start. Two-space JSON plus a trailing newline is what upstream's
 * `writeProfileManifest` produces, so a repaired manifest is byte-comparable
 * with a freshly initialized one.
 */
export async function repairProfileDirectory(profileDir, { bundles, patchFileName = 'cordis.patch.yml', dryRun = false, timestamp = Date.now() } = {}) {
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error('repairProfileDirectory needs the bundle list to narrow to; refusing to guess one.');
  }
  const patchPath = join(profileDir, patchFileName);
  const manifestPath = join(profileDir, 'package.json');
  const manifestReport = readJsonDocument(manifestPath, { domain: 'authoritative' });
  if (!manifestReport.ok) {
    throw new Error(`Cannot repair profile ${profileDir}: manifest is unusable — ${describeDamage(manifestReport.problem)}`);
  }
  const record = { profileDir, patchPath, manifestPath, bundles };
  // The backup name is chosen even under `--dry-run`, from the same loop the
  // real run uses, so the preview names the exact file the real run creates.
  const backupBase = `${patchPath}.bak-${timestamp}`;
  let backupPath = backupBase;
  let ordinal = 0;
  while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`;
  const patchExists = existsSync(patchPath);
  record.backupPath = patchExists ? backupPath : undefined;
  record.patchExists = patchExists;
  const before = manifestReport.value?.dsh?.profile?.bundles;
  record.bundlesBefore = Array.isArray(before) ? [...before] : undefined;
  record.changed = JSON.stringify(record.bundlesBefore ?? null) !== JSON.stringify(bundles);
  if (dryRun) return record;
  if (patchExists) {
    // rename, not copy: the patch must stop being loaded in the same step it is
    // preserved, and dsh re-creates an empty one on the next boot.
    await rename(patchPath, backupPath);
  }
  const updated = {
    ...manifestReport.value,
    dsh: { ...manifestReport.value.dsh, profile: { ...manifestReport.value.dsh?.profile, bundles: [...bundles] } },
  };
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8' });
  record.bundlesAfter = [...bundles];
  return record;
}

/**
 * Repair every profile of one environment.
 *
 * `profiles` defaults to every existing profile. A named profile that does not
 * exist yet is created from the upstream template when upstream has one, and is
 * refused otherwise — dpx will not invent a bundle list.
 */
export async function repairEnvironment({
  name,
  home = defaultRegistryHome(),
  profiles,
  dryRun = false,
  platform = process.platform,
  timestamp = Date.now(),
  registryHome,
} = {}) {
  name = assertEnvironmentName(name);
  const registry = await loadRegistry(home);
  const record = registry.environments.find(row => row.name === name);
  if (!record) throw new Error(`Environment --${name} is not registered. Create it with: dpx npm install -g @deepseek-ai/dsh --${name} --<absolute-storage-root>`);
  const paths = pathsFor(record.root);
  if (!existsSync(paths.root)) throw new Error(`Environment --${name} is registered but its root is missing: ${paths.root}`);
  const probe = await probeAppBoot(paths);
  if (!probe.available || !probe.templates) {
    throw new Error(
      `无法确定 profile 的内建 bundle 集合：${probe.reason ?? '上游未导出 PROFILE_TEMPLATES'}。`
      + `dpx 不会硬编码第二份 bundle 清单。请先安装/修复环境内的 ${PLUGIN_COMPAT.anchorPackage}：dpx npm install -g ${PLUGIN_COMPAT.anchorPackage} --${name}`,
    );
  }
  const requested = profiles?.length ? profiles : undefined;
  const known = listProfiles(paths);
  const targets = requested?.filter(profile => known.includes(profile))
    ?? (known.length ? known : profileTemplateNames(probe.templates));
  const results = [];
  const created = [];
  for (const profile of targets) {
    const bundles = bundlesForProfile(probe.templates, profile);
    if (!bundles) {
      results.push({
        profile,
        repaired: false,
        reason: 'no-upstream-template',
        message: `上游 PROFILE_TEMPLATES 里没有 ${JSON.stringify(profile)} 的 bundle 集合；dpx 不猜。`
          + `可用的 profile：${profileTemplateNames(probe.templates).join(', ') || '(none)'}`,
      });
      continue;
    }
    const directory = profileDirectory(paths, profile);
    if (!existsSync(directory)) {
      if (requested) created.push(profile);
      if (!dryRun) await mkdir(directory, { recursive: true });
    }
    const repair = await repairProfileDirectory(directory, { bundles, patchFileName: probe.patchFileName ?? 'cordis.patch.yml', dryRun, timestamp });
    results.push({ profile, repaired: true, created: !existsSync(join(directory, 'package.json')), ...repair });
  }
  // Repair always stamps the current distribution identity: this is the one
  // place that legitimately rewrites a registry record, and "write always
  // stamps current" is what keeps older environments inside the read whitelist.
  const outcome = {
    environment: name,
    envRoot: paths.root,
    registry: registryHome ?? home,
    dryRun,
    bundlesSource: `${PLUGIN_COMPAT.anchorPackage} → ${probe.path ?? 'dsh-app-boot'} (PROFILE_TEMPLATES)`,
    // What the probe found, and therefore which implementation answered:
    // `sanitizeProfile` is only exported by dsh >= 0.1.6-alpha.2. The local
    // equivalent is preferred even when it exists, because it never parses the
    // profile manifest and writes a BOM-free manifest by construction — the two
    // failure modes this command exists to survive.
    capabilities: {
      sanitizeProfile: probe.hasSanitizeProfile ? 'available-upstream' : 'absent-upstream',
      writeProfileBundles: probe.hasWriteProfileBundles ? 'available-upstream' : 'absent-upstream',
      implementation: 'local-equivalent',
      reason: probe.hasSanitizeProfile
        ? '上游 sanitizeProfile 需要先解析 manifest（本命令的恢复前提恰恰是它可能不可解析），故使用不解析的本地等价实现'
        : '上游未导出 sanitizeProfile（它只在 dsh >= 0.1.6-alpha.2 源码里导出），使用本地等价实现',
    },
    created,
    profiles: results,
  };
  if (!dryRun) {
    // Everything that writes happens above; the registry stamp is the one
    // metadata change, and it is written through the same atomic path as
    // every other registry mutation.
    await withRegistryLock(home, async () => {
      const current = await loadRegistry(home);
      const row = current.environments.find(candidate => candidate.name === name);
      if (!row) return;
      row.instance = { ...row.instance, distribution: DISTRIBUTION };
      row.discoverableEntry = discoverableEntry(row.instance, row.name);
      current.revision += 1;
      await atomicJson(registryPath(home), current);
    });
    outcome.registryStamped = DISTRIBUTION.version;
  }
  return outcome;
}

export function profileDirectory(paths, profile) {
  return join(paths.dshHome, 'profiles', profile);
}

/** What `dpx run --<name> <target>` starts, versus what a bare `<target>` starts. */
export function whichReport({ paths, name, target, env = process.env, registry } = {}) {
  const entry = launchTarget(target);
  const isolatedPackage = entry ? locatePackage(paths, entry.package) : undefined;
  const isolated = entry ? {
    file: isolatedPackage ? join(isolatedPackage, ...entry.entry) : join(paths.npmPrefix, 'node_modules', ...entry.package.split('/'), ...entry.entry),
    present: Boolean(isolatedPackage),
    via: `dpx run --${name} ${target}`,
    package: entry.package,
    version: isolatedPackage ? packageVersionAt(isolatedPackage) : undefined,
  } : undefined;
  const ambientPath = commandCandidates(target, { env }).map((candidate, index) =>
    ({ ...classifyCommandPath(candidate.file, { paths, name, registry, env }), winner: index === 0 }));
  const winner = ambientPath.find(candidate => candidate.winner);
  const verdict = !isolated?.present ? 'not-installed' : winner && !winner.inEnvironment ? 'host-leak' : 'clean';
  return {
    environment: name,
    envRoot: paths.root,
    target,
    isolated,
    copies: targetCopies(paths, target).copies,
    ambientPath,
    verdict,
    advice: whichAdvice({ verdict, target, name, paths, winner }),
  };
}

function whichAdvice({ verdict, target, name, paths, winner }) {
  if (verdict === 'not-installed') {
    return `这个环境里没有 ${target}。先安装：dpx npm install -g <包名> --${name}`;
  }
  if (verdict === 'host-leak') {
    const home = winner?.dshHome ? `，并会使用 ${winner.dshHome}` : '';
    return `裸敲 \`${target}\` 命中的是环境外的副本 ${winner.file}${home}。请用 dpx run --${name} ${target}，`
      + `或 dpx exec --${name} -- ${target}，或绝对路径 ${join(paths.npmPrefix, `${target}.cmd`)}。`;
  }
  return `PATH 上首个 \`${target}\` 位于本环境内；仍建议用 dpx run --${name} ${target} 以保证 DSH_HOME 由 dpx 一起钉住。`;
}

function check(id, status, detail, fix) {
  return { id, status, detail, ...(fix ? { fix } : {}) };
}

/**
 * One pass over everything that can make an environment look "wrong": the
 * registry binding, the generated guide, PATH shadowing, the two copies of each
 * launch target, and the installer/store each profile was linked from.
 *
 * Every finding carries a `fix` that is a real command, because the point of
 * the check is to end a debugging session, not to start one.
 */
export function doctorReport({ paths, name, record, env = process.env, registry, registryHome } = {}) {
  const checks = [];
  const push = (...args) => { checks.push(check(...args)); };

  const rootExists = existsSync(paths.root);
  push('registry-binding', rootExists ? 'ok' : 'error',
    rootExists
      ? `registry、环境根与 DSH_HOME 对得上：${paths.root}`
      : `registry 里有 --${name}，但环境根不存在：${paths.root}`,
    rootExists ? undefined : `dpx env remove --${name} 注销记录，或重建该环境`);
  if (rootExists) {
    const expected = [
      ['npm-prefix', paths.npmPrefix], ['dsh-home', paths.dshHome], ['agents-home', paths.agentsHome],
      ['workspace', paths.workspace], ['descriptor', paths.descriptor], ['manifest', paths.manifest],
    ];
    const missing = expected.filter(([, value]) => !existsSync(value)).map(([label]) => label);
    push('layout', missing.length === 0 ? 'ok' : 'error',
      missing.length === 0 ? '受控布局的目录与文件都存在' : `缺少受控布局项：${missing.join('、')}`,
      missing.length === 0 ? undefined : `复用该环境即可自动补齐：dpx env show --${name}`);
  }

  const guide = environmentGuidePath(paths);
  if (!existsSync(guide)) {
    push('environment-guide', 'error', `环境级指令文件缺失：${guide}`,
      `dpx env show --${name} 会重新生成它`);
  } else {
    const text = readFileSync(guide, 'utf8');
    const current = text.includes(`dpx:environment-guide:begin v${GUIDE_FORMAT}`);
    push('environment-guide', current ? 'ok' : 'warn',
      current ? `环境级指令文件是最新格式（v${GUIDE_FORMAT}）：${guide}`
        : `环境级指令文件是旧格式，缺少本次新增的排查与通用规则：${guide}`,
      current ? undefined : `dpx env show --${name} 会就地刷新它（标记块之外的内容不动）；`
        + `若旧托管区与仓库中该格式的模板不逐字节一致，dpx 会拒绝改写并提示，请人工确认后再刷新`);
  }

  // The environment's own record is authoritative here: it is the last piece of
  // evidence that answers "which environment am I in?" when the identity
  // variables have been stripped. A damaged record is damage, not merely
  // "unknown" — that distinction is the whole point of the graded policy.
  const manifestReport = environmentManifestReport(paths.root);
  if (manifestReport.read.ok) {
    push('environment-record', 'ok', `环境身份记录可读：${manifestReport.path}`);
  } else if (manifestReport.read.problem.code === 'missing') {
    push('environment-record', 'warn', `环境身份记录不存在：${manifestReport.path}（进程身份反推会失效）`,
      `重建该记录：dpx env repair --${name}，或删除后重新创建该环境`);
  } else {
    push('environment-record', 'error', `环境身份记录不可用——${describeDamage(manifestReport.read.problem)}`,
      `修好或删除 ${manifestReport.path} 后重建：dpx env repair --${name}；这会让进程身份反推失效，直到修好为止`);
  }

  // Derived-domain damage is collected while walking and reported once, so a
  // damaged file never masquerades as "未知版本" without saying which file.
  const damagedDerived = [];
  const noteDerivedDamage = (report, label) => {
    if (!report || report.ok || report.problem?.code !== 'damaged') return;
    damagedDerived.push({ label, ...report.problem });
  };

  const identity = environmentRootFromProcess(env, process.platform);
  const declared = env[DPX_ENV_ROOT_VARIABLE]?.trim();
  let identityDetail;
  if (!identity) {
    identityDetail = `当前进程不在任何 dpx 环境里（${DPX_ENV_ROOT_VARIABLE} 未设置，DSH_HOME 与 LOCALAPPDATA 也没有指向带 ${ENVIRONMENT_MANIFEST_NAME} 的环境根），这是对 --${name} 的只读检查`;
  } else if (pathContains(paths.root, identity.root)) {
    identityDetail = `当前进程就在这个环境里（依据：${identity.source}）`;
    if (!declared) {
      identityDetail += `；${DPX_ENV_ROOT_VARIABLE} 在本进程的环境里不可见——DSH 的 shell/终端层会重建 DSH_* 命名空间并丢掉未声明的键，`
        + `所以 dpx 改用环境根里的 ${ENVIRONMENT_MANIFEST_NAME} 反推`;
    }
  } else {
    identityDetail = `当前进程在另一个环境里：${identity.root}${identity.name ? `（--${identity.name}）` : ''}（依据：${identity.source}），这是对 --${name} 的只读检查`;
  }
  push('process-identity', 'ok', identityDetail);

  const registered = (registry?.environments ?? []).some(row => samePath(row.root, paths.root));
  push('registry-membership', registered ? 'ok' : 'error',
    registered ? `registry 位于 ${registryHome}，其中登记了 --${name}`
      : `registry（${registryHome}）里没有指向 ${paths.root} 的记录`,
    registered ? undefined : `确认 DPX_HOME；在环境内看不到别的环境时用 dpx which --${name} 查看 registry 归属`);

  for (const target of launchTargets()) {
    const report = whichReport({ paths, name, target, env, registry });
    if (report.verdict === 'host-leak') {
      push(`path-shadowing:${target}`, 'error', report.advice, `dpx run --${name} ${target}`);
    } else if (report.verdict === 'not-installed') {
      push(`path-shadowing:${target}`, 'warn', `环境内没有安装 ${target}；裸敲它会命中环境外的副本（如果有）`,
        `dpx npm install -g <包名> --${name}`);
    } else {
      push(`path-shadowing:${target}`, 'ok',
        report.ambientPath[0]
          ? `PATH 上首个 ${target} 位于本环境内：${report.ambientPath[0].file}`
          : `PATH 上没有环境外的 ${target} 副本`);
    }
    const copies = report.copies;
    // "未知版本" and "文件损坏" are different findings with different fixes, so
    // the damaged case is named with its path instead of collapsing into
    // `copy.version === undefined`.
    for (const copy of copies) noteDerivedDamage(copy.versionReport, `${target} @ ${copy.location}`);
    const global = copies.find(copy => copy.location === 'npm-prefix');
    const profiles = copies.filter(copy => copy.location.startsWith('profile:'));
    if (global && profiles.length) {
      const mismatched = profiles.filter(copy => copy.version !== global.version);
      push(`target-copies:${target}`, mismatched.length ? 'error' : 'ok',
        mismatched.length
          ? `${target} 的全局副本是 ${global.version ?? '未知版本'}，而 ${mismatched.map(copy => `${copy.location}=${copy.version ?? '未知版本'}`).join('、')}`
          : `${target} 的全局副本与 ${profiles.length} 个 profile 副本版本一致（${global.version ?? '未知版本'}）`,
        mismatched.length ? `dpx plugin add --${name} <包名> --profile <profile> 或 dpx npm install -g <包名>@<版本> --${name} 对齐两侧` : undefined);
    } else if (profiles.length && !global) {
      push(`target-copies:${target}`, 'warn',
        `${target} 只存在于 profile：${profiles.map(copy => `${copy.location}=${copy.version ?? '未知版本'}`).join('、')}`,
        `dpx npm install -g <包名> --${name} 让 dpx run --${name} ${target} 也能启动`);
    }
  }

  // The plugin compatibility anchor: the environment's *dsh* version against the
  // range dpx declares, never against the desktop launcher's version.
  const dshPackage = locatePackage(paths, PLUGIN_COMPAT.anchorPackage);
  const dshVersion = dshPackage ? packageVersionAt(dshPackage) : undefined;
  if (!dshPackage) {
    push('plugin-compat', 'ok', `环境内没有安装 ${PLUGIN_COMPAT.anchorPackage}；锚点区间 ${PLUGIN_COMPAT.dshRange}（协议号 ${PLUGIN_COMPAT.protocolVersion}）暂不适用`,
      `dpx npm install -g ${PLUGIN_COMPAT.anchorPackage} --${name}`);
  } else if (dshVersion === undefined) {
    const report = packageVersionReport(dshPackage);
    push('plugin-compat', 'error',
      `${PLUGIN_COMPAT.anchorPackage} 的版本读不出来——${describeDamage(report.problem)}，无法核对插件兼容锚点`,
      `重装该包：dpx npm install -g ${PLUGIN_COMPAT.anchorPackage} --${name}`);
  } else if (pluginCompatible(dshVersion)) {
    push('plugin-compat', 'ok',
      `环境内 ${PLUGIN_COMPAT.anchorPackage}=${dshVersion} 落在锚点区间 ${PLUGIN_COMPAT.dshRange}（协议号 ${PLUGIN_COMPAT.protocolVersion}）`);
  } else {
    push('plugin-compat', 'error',
      `环境内 ${PLUGIN_COMPAT.anchorPackage}=${dshVersion} 不在锚点区间 ${PLUGIN_COMPAT.dshRange} 内；`
      + '插件兼容锚点只认 dsh 版本，不认桌面启动器版本',
      `dpx npm install -g ${PLUGIN_COMPAT.anchorPackage}@<区间内版本> --${name}`);
  }

  const expectedStore = expectedPnpmStore(paths);
  const profiles = listProfiles(paths);
  for (const profile of profiles) {
    const directory = profileDirectory(paths, profile);
    // A profile manifest that exists but cannot be parsed is damage, and it is
    // exactly the damage that silently empties `plugin add`'s read-back.
    noteDerivedDamage(readJsonDocument(join(directory, 'package.json'), { domain: 'derived' }), `profile:${profile} package.json`);
    const installer = readProfileInstaller(directory);
    if (!installer) continue;
    if (!installer.storeDir) {
      push(`profile-store:${profile}`, installer.manager === 'unknown' ? 'warn' : 'ok',
        installer.manager === 'unknown'
          ? `profile ${profile} 有 node_modules，但读不出安装器（缺 .modules.yaml / package-lock.json）`
          : `profile ${profile} 由 ${installer.manager} 安装（未声明 store 目录）`,
        installer.manager === 'unknown' ? `重建该 profile，或始终用 dpx plugin add --${name} … --profile ${profile} 安装` : undefined);
      continue;
    }
    const insideRoot = pathContains(paths.root, installer.storeDir);
    const expected = pathContains(expectedStore, installer.storeDir);
    if (!insideRoot) {
      push(`profile-store:${profile}`, 'error',
        `profile ${profile} 的 node_modules 链接自环境外的 store：${installer.storeDir}`
        + `（任何补充安装都会报 ERR_PNPM_UNEXPECTED_STORE）`,
        `dpx plugin add --${name} <包名> --profile ${profile} --store-dir "${installer.storeDir}" 保持既有链接，`
        + `或删除 ${join(directory, 'node_modules')} 后用 dpx plugin add --${name} <包名> --profile ${profile} 重建`);
    } else if (!expected) {
      push(`profile-store:${profile}`, 'warn',
        `profile ${profile} 的 store 在环境内但不是 dpx 期望的那个：${installer.storeDir}（期望 ${expectedStore}）`,
        `dpx plugin add --${name} <包名> --profile ${profile} --store-dir "${installer.storeDir}"`);
    } else {
      push(`profile-store:${profile}`, 'ok', `profile ${profile} 由 ${installer.manager} 安装，store 位于环境内：${installer.storeDir}`);
    }
  }

  // Desktop update journal (R6, read side) and the launcher stamp. This is a
  // *read-only* check: the journal belongs to the desktop shell, and a doctor
  // that created `desktop-state/` merely by looking would be lying about being
  // read-only.
  noteDerivedDamage(desktopVersionReport(paths.root), `desktop/${DESKTOP_STAMP_NAME}`);
  const journal = readDesktopUpdateJournal(paths.updates);
  if (journal.records.length === 0 && journal.problems.length === 0) {
    push('desktop-updates', 'ok', `没有桌面端更新记录（${paths.updates} 不存在或为空），无需处置`);
  } else {
    const last = journal.records.at(-1);
    const failed = journal.records.filter(row => row.result !== undefined && row.result !== 'success' && row.result !== 'ok');
    if (journal.problems.length) {
      push('desktop-updates', 'warn',
        `桌面端更新记录有 ${journal.problems.length} 行不可用，已跳过：${journal.problems.slice(0, 3).map(problem => problem.message).join('；')}`,
        `检查 ${paths.updates}，坏行与未知 schemaVersion 不会被猜测解析`);
    }
    push('desktop-updates:last', failed.length ? 'error' : 'ok',
      last
        ? `最近一条桌面端更新记录：${last.time ?? '(无时间)'} ${last.action ?? '(无动作)'} `
          + `${last.fromVersion ?? '?'} → ${last.toVersion ?? last.fromVersion ?? '?'} result=${last.result ?? '(无结果)'}`
        : '更新记录里没有可读条目',
      last ? undefined : `检查 ${paths.updates} 的内容`);
    if (failed.length) {
      push('desktop-updates:failures', 'error',
        `${failed.length} 条桌面端更新记录的结果不是成功：${failed.slice(-3).map(row => `${row.time ?? '?'}:${row.result}`).join('、')}`,
        `重跑一次并保留现场：dpx desktop update --${name}；更新记录在 ${paths.updates}`);
    }
  }

  for (const damage of damagedDerived) {
    push(`damaged-file:${damage.label}`, 'error',
      `派生域文件损坏（已跳过，不参与其它判定）——${describeDamage(damage)}`,
      `修复或删除该文件后重跑 dpx env doctor --${name}；派生域可以重建，权威域（registry 与环境身份记录）不会这样处理`);
  }

  const errors = checks.filter(row => row.status === 'error').length;
  const warnings = checks.filter(row => row.status === 'warn').length;
  return {
    environment: name,
    envRoot: paths.root,
    registry: registryHome,
    ok: errors === 0,
    summary: { errors, warnings, checks: checks.length },
    checks,
    ...(record?.instance ? { instanceId: record.instance.instanceId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Registry-level `dpx env doctor` (no `--<name>`)
// ---------------------------------------------------------------------------
//
// The single-environment report above answers "is THIS environment healthy?".
// This one answers "is the registry itself coherent, and which records are safe
// to unregister?" — a different question with a different output contract, so
// the two deliberately do not share a shape beyond `{ ok, summary, checks }`:
//
//   single (--name)   { environment, envRoot, registry, ok, summary, checks, instanceId? }
//   registry (no name){ scope: 'registry', registry, entries[], ok, summary, checks }
//
// No `envRoot`, no `environment`, no `instanceId` at the top level: a consumer
// that wants one environment must ask for one. Everything here is read-only —
// in particular it never calls `resolveEnvironment`, so a registry-level check
// cannot create a missing root, a guide file, or a `desktop-state/` directory.

function desktopCapability(record) {
  return record?.desktop?.platform === 'win32' && record.desktop.launcher ? 'declared' : 'none';
}

/**
 * One read-only pass over every registry record.
 *
 * @returns `{ scope, registry, revision, entries, ok, summary, checks }`; each
 *   entry carries the same per-record checks under `entry.checks`, plus a
 *   `safeToUnregister` verdict that names the exact command.
 */
export async function registryDoctorReport({ home = defaultRegistryHome(), env = process.env, platform = process.platform } = {}) {
  const path = registryPath(home);
  const { registry, problems } = await readRegistryReport(home);
  const checks = [];
  const push = (...args) => { checks.push(check(...args)); };

  // Authoritative domain: an unreadable registry is fail-loud everywhere else,
  // and here it is reported as the top-level verdict rather than thrown, so the
  // operator can see the registry doctor complain about its own input.
  if (problems.length) {
    for (const problem of problems) {
      push('registry-readable', 'error', `registry 不可用——${describeDamage(problem)}`,
        `先修好或移走 ${path}；dpx 不会覆盖一个无法校验的 registry（负载是权威域）`);
    }
    const errors = checks.filter(row => row.status === 'error').length;
    return {
      scope: 'registry',
      registry: home,
      registryPath: path,
      revision: undefined,
      entries: [],
      ok: false,
      summary: { errors, warnings: 0, checks: checks.length },
      checks,
    };
  }

  push('registry-readable', 'ok', `registry 格式与全部记录绑定可读：${path}（revision ${registry.revision}）`);
  push('registry-revision', 'ok', `registry revision=${registry.revision}，共 ${registry.environments.length} 条记录`);

  // The discovery pointer is a machine-level fact, not a per-record one.
  const pointer = platform === 'win32' ? windowsDiscoveryRegistryPath(platform) : undefined;
  if (platform !== 'win32') {
    push('discovery-pointer', 'ok', `非 Windows 平台不使用 ${WINDOWS_DISCOVERY_KEY}，跳过`);
  } else if (registry.environments.length === 0) {
    push('discovery-pointer', 'ok', 'registry 里没有环境，discovery pointer 无需指向任何地方');
  } else if (!pointer) {
    push('discovery-pointer', 'warn', `${WINDOWS_DISCOVERY_KEY} 不存在或不可读；环境内的 dpx 将回落到隔离的 LOCALAPPDATA`,
      '在宿主机上重跑一次 dpx env list（或 dpx env repair --<name>）以重新发布 discovery pointer');
  } else if (samePath(pointer, path, platform)) {
    push('discovery-pointer', 'ok', `${WINDOWS_DISCOVERY_KEY} 指向本 registry：${path}`);
  } else if (env.DPX_DISABLE_DISCOVERY === '1') {
    // Publishing was explicitly switched off, so a pointer aimed at another
    // registry is expected here, not a defect of this one. Reporting it as an
    // error would make `dpx env doctor` fail on every isolated/CI registry.
    push('discovery-pointer', 'warn',
      `${WINDOWS_DISCOVERY_KEY} 指向另一个 registry：${pointer}（本 registry 是 ${path}），`
      + '但 DPX_DISABLE_DISCOVERY=1 明确不发布 pointer，符合预期',
      '需要让环境内的 dpx 找到本 registry 时，去掉 DPX_DISABLE_DISCOVERY 再跑一次 dpx env list');
  } else {
    push('discovery-pointer', 'error', `${WINDOWS_DISCOVERY_KEY} 指向另一个 registry：${pointer}（本 registry 是 ${path}）`,
      `确认 DPX_HOME；需要改回时用 DPX_HOME=${home} 重跑一次环境操作以重新发布 pointer`);
  }

  const entries = [];
  for (const record of registry.environments) {
    const entryChecks = [];
    const entryPush = (...args) => { entryChecks.push(check(...args)); };
    const paths = pathsFor(record.root);
    const rootExists = existsSync(record.root);
    entryPush('root', rootExists ? 'ok' : 'error',
      rootExists ? `环境根存在：${record.root}` : `环境根缺失：${record.root}`,
      rootExists ? undefined : `dpx env remove --${record.name} 注销这条失效记录（不删任何文件）`);

    // descriptor / manifest presence, and — when both exist — instanceId
    // agreement. The manifest is the environment's own claim about itself, so a
    // disagreement is an identity problem, not a missing-file problem.
    const descriptorReport = readJsonDocument(paths.descriptor, { domain: 'authoritative' });
    entryPush('descriptor', descriptorReport.ok ? 'ok' : 'error',
      descriptorReport.ok ? `descriptor 存在且可解析：${paths.descriptor}` : `descriptor 不可用——${describeDamage(descriptorReport.problem)}`,
      descriptorReport.ok ? undefined : `重新生成：dpx env repair --${record.name}；仍不行则注销后重建该环境`);
    const manifestReport = environmentManifestReport(record.root);
    entryPush('manifest', manifestReport.read.ok ? 'ok' : 'error',
      manifestReport.read.ok ? `环境身份记录存在且可解析：${manifestReport.path}` : `环境身份记录不可用——${describeDamage(manifestReport.read.problem)}`,
      manifestReport.read.ok ? undefined : `重新生成：dpx env repair --${record.name}`);

    const manifestInstance = manifestReport.manifest?.instance?.instanceId;
    const registryInstance = record.instance?.instanceId;
    if (manifestInstance === undefined) {
      entryPush('instance-id', 'warn', '环境身份记录里没有 instanceId，无法与 registry 记录比对',
        `重建该记录：dpx env repair --${record.name}`);
    } else if (manifestInstance === registryInstance) {
      entryPush('instance-id', 'ok', `instanceId 与 registry 记录一致：${registryInstance}`);
    } else {
      entryPush('instance-id', 'error',
        `instanceId 不一致：registry=${registryInstance ?? '(none)'}，环境记录=${manifestInstance}`
        + '（同一个名字指向了两份不同的环境身份）',
        `确认哪一份是真的；要保留环境里的那份，就注销后按该 root 重新登记：dpx env remove --${record.name}`);
    }

    // Desktop capability vs what is actually on disk.
    const capability = desktopCapability(record);
    const launcherExists = existsSync(paths.desktop);
    if (capability === 'declared' && launcherExists) {
      entryPush('desktop-capability', 'ok', `记录声明 win32 桌面启动器，且文件存在：${paths.desktop}`
        + `${desktopVersion(record.root) ? `（版本 ${desktopVersion(record.root)}）` : ''}`);
    } else if (capability === 'declared' && !launcherExists) {
      entryPush('desktop-capability', 'warn', `记录声明 win32 桌面启动器，但文件不存在：${paths.desktop}`,
        rootExists ? `重新安装：dpx desktop install --${record.name}` : `环境根已缺失；注销该记录即可：dpx env remove --${record.name}`);
    } else if (capability === 'none' && launcherExists) {
      entryPush('desktop-capability', 'warn', `记录没有声明桌面能力，但环境里存在桌面启动器：${paths.desktop}`,
        `确认后重装桌面端：dpx desktop install --${record.name}，或删掉该文件`);
    } else {
      entryPush('desktop-capability', 'ok', '记录没有声明桌面能力，环境里也没有桌面启动器（CLI-only 环境）');
    }

    // Safe to unregister = the record can be dropped without losing anything
    // dpx still needs. A missing root is the textbook case; an identity
    // disagreement is not, because dropping the record would lose the only
    // pointer to the on-disk environment.
    const errors = entryChecks.filter(row => row.status === 'error');
    const safeToUnregister = !rootExists || errors.every(row => row.id === 'root' || row.id === 'descriptor' || row.id === 'manifest');
    entryPush('unregister', safeToUnregister ? (rootExists ? 'warn' : 'ok') : 'ok',
      safeToUnregister
        ? (rootExists
          ? `可以安全注销：dpx env remove --${record.name}（不加 --purge 时环境目录原样保留）`
          : `root 已缺失，注销是纯 registry 修复：dpx env remove --${record.name}`)
        : '不建议现在注销：先处理上面的身份/文件问题，注销会丢掉指向该环境根的唯一指针',
      safeToUnregister ? `dpx env remove --${record.name}${rootExists ? '' : ' --purge'}` : undefined);

    entries.push({
      name: record.name,
      instanceId: registryInstance,
      root: record.root,
      rootExists,
      distribution: record.instance?.distribution,
      readCompatible: REGISTRY_BINDING.readCompatible(record.instance?.distribution),
      staleIdentity: REGISTRY_BINDING.isStale(record.instance?.distribution),
      desktop: { capability, launcher: paths.desktop, launcherExists },
      safeToUnregister,
      checks: entryChecks,
    });
    for (const row of entryChecks) checks.push({ ...row, id: `${record.name}/${row.id}` });
  }

  const errors = checks.filter(row => row.status === 'error').length;
  const warnings = checks.filter(row => row.status === 'warn').length;
  return {
    scope: 'registry',
    registry: home,
    registryPath: path,
    revision: registry.revision,
    environments: entries.length,
    entries,
    ok: errors === 0,
    summary: { errors, warnings, checks: checks.length },
    checks,
  };
}

// ---------------------------------------------------------------------------
// `dpx env use`: the environment as a script a shell can evaluate
// ---------------------------------------------------------------------------

const SHELL_EXPORT_KEYS = [
  DPX_ENV_VARIABLE, DPX_ENV_ROOT_VARIABLE, DPX_HOME_VARIABLE,
  'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_TELEMETRY_DISABLED',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
];
const SHELL_UNSET_KEYS = ['NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE'];

export const SHELL_FORMATS = ['powershell', 'cmd', 'json'];

/**
 * A script that puts the *current* shell inside one environment.
 *
 * dpx cannot change its parent's environment, so it prints the assignments
 * instead; the caller decides whether to evaluate them. The script prepends the
 * environment's npm prefix to the PATH that exists at evaluation time, which
 * keeps the "prepend, never replace" contract that `runtimeEnvironment` uses.
 */
export function environmentShellScript(paths, { name, format = 'powershell', env = process.env, registryHome } = {}) {
  const target = runtimeEnvironment(paths, env, { name, registryHome });
  const assignments = SHELL_EXPORT_KEYS
    .filter(key => typeof target[key] === 'string' && target[key].length > 0)
    .map(key => [key, target[key]]);
  if (format === 'json') {
    return `${JSON.stringify({
      format: 'dpx-env-use',
      schemaVersion: 1,
      environment: name,
      envRoot: paths.root,
      unset: SHELL_UNSET_KEYS,
      pathPrepend: [paths.npmPrefix],
      set: Object.fromEntries(assignments),
    }, null, 2)}\n`;
  }
  if (format === 'cmd') {
    const lines = [`rem dpx env use --${name}`, 'rem 用法: for /f "delims=" %i in (\'dpx env use --' + name + ' --format cmd\') do @%i'];
    for (const key of SHELL_UNSET_KEYS) lines.push(`set "${key}="`);
    for (const [key, value] of assignments) lines.push(`set "${key}=${value}"`);
    lines.push(`set "PATH=${paths.npmPrefix};%PATH%"`);
    return `${lines.join('\r\n')}\r\n`;
  }
  if (format !== 'powershell') {
    throw new Error(`Unsupported shell format ${JSON.stringify(format)}. Supported formats: ${SHELL_FORMATS.join(', ')}.`);
  }
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const lines = [`# dpx env use --${name}`, '# 用法: dpx env use --' + name + ' --format powershell | Invoke-Expression'];
  for (const key of SHELL_UNSET_KEYS) lines.push(`Remove-Item Env:${key} -ErrorAction SilentlyContinue`);
  for (const [key, value] of assignments) lines.push(`$env:${key} = ${quote(value)}`);
  lines.push(`$env:PATH = ${quote(paths.npmPrefix)} + ';' + $env:PATH`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// `dpx plugin`: install into a profile without depending on ambient pnpm state
// ---------------------------------------------------------------------------

/**
 * Complete a `dsh plugin` invocation with the flags that keep a profile's
 * existing `node_modules` valid.
 *
 * `dsh plugin` is a thin pnpm forwarder that also reconciles the profile's
 * bundle list, so dpx drives it rather than calling pnpm directly. What dpx
 * adds is the one piece of context the forwarder cannot know: which store the
 * profile is already linked from. Passing it explicitly is what turns
 * `ERR_PNPM_UNEXPECTED_STORE` from a failure into a non-event.
 */
export function pluginArguments({ args, storeDir }) {
  if (args.length === 0) throw new Error('dpx plugin add needs at least one package spec, for example: dpx plugin add --<name> <package> --profile <profile>');
  const explicit = args.some(arg => arg === '--store-dir' || arg.startsWith('--store-dir='));
  return [...args, ...(storeDir && !explicit ? ['--store-dir', storeDir] : [])];
}

/**
 * What a profile declares, together with the version actually installed there
 * and the version of the same package in the environment's npm prefix.
 *
 * Reading the install back is the point: plenty of "I installed it and nothing
 * changed" reports are really "the launcher and the profile are two different
 * copies", and only a read-back can say which one moved.
 */
export function profileInstalledPackages(paths, profile) {
  return profileInstalledPackagesReport(paths, profile).packages;
}

/**
 * The same read-back, with the reason a profile's declarations are unavailable.
 *
 * The array-returning shape above is preserved because callers print it; this
 * one carries `manifest`, a graded damage report, so `dpx env doctor` can say
 * "profile manifest 损坏：<path>" instead of reporting an empty package list.
 */
export function profileInstalledPackagesReport(paths, profile) {
  const directory = profileDirectory(paths, profile);
  const manifest = readJsonDocument(join(directory, 'package.json'), { domain: 'derived' });
  if (!manifest.ok) return { profile, directory, packages: [], manifest };
  const dependencies = Object.keys(manifest.value?.dependencies ?? {});
  const packages = dependencies.map(packageName => {
    const installed = join(directory, 'node_modules', ...packageName.split('/'));
    const version = existsSync(installed) ? packageVersionAt(installed) : undefined;
    const globalPackage = locatePackage(paths, packageName);
    const globalVersion = globalPackage ? packageVersionAt(globalPackage) : undefined;
    return {
      package: packageName,
      ...(version === undefined ? {} : { version }),
      ...(globalVersion === undefined ? {} : { globalVersion }),
      ...(version === undefined || globalVersion === undefined ? {} : { match: version === globalVersion }),
    };
  });
  return { profile, directory, packages, manifest };
}

// ---------------------------------------------------------------------------
// Desktop update journal (`<env-root>/desktop-state/updates.jsonl`) — read side
// ---------------------------------------------------------------------------
//
// The desktop shell owns this file and appends one JSON object per line:
//
//   { schemaVersion, time, action, fromVersion, toVersion, sha256, result }
//
// dpx only ever *reads* it, and reads it tolerantly in exactly one direction:
// a bad line is skipped and reported; a line whose `schemaVersion` this build
// does not know is **rejected**, never guessed at — "格式不许静默演进" is what
// keeps an unknown future journal from being misread as this one.

/** Journal schema versions this build understands. A future one must be added deliberately. */
export const DESKTOP_UPDATE_JOURNAL_SCHEMA_VERSIONS = Object.freeze([1]);

/** The update outcomes that count as success; anything else is reported as a failure. */
const DESKTOP_UPDATE_SUCCESS_RESULTS = Object.freeze(['success', 'ok', 'updated', 'up-to-date']);

/**
 * Read `<env-root>/desktop-state/updates.jsonl`.
 *
 * Never throws and never creates anything: a missing file yields
 * `{ records: [], problems: [], present: false }`, which is a valid answer for
 * "this environment has never updated its launcher".
 *
 * @returns `{ path, present, schemaVersions, records, problems, last }` where
 *   `last` is the newest readable record.
 */
export function readDesktopUpdateJournal(path = undefined) {
  const resolved = path ?? pathsFor('.').updates;
  const report = { path: resolved, present: false, schemaVersions: [], records: [], problems: [], last: undefined };
  if (!existsSync(resolved)) return report;
  report.present = true;
  const read = readJsonDocument(resolved, { domain: 'derived' });
  if (!read.ok) {
    // A JSONL file is not one JSON document, so "cannot parse as JSON" is only
    // damage when the *lines* are unusable — handled below. Anything else
    // (unreadable, or not a regular file) is damage outright.
    if (read.problem.code !== 'damaged') {
      report.problems.push(read.problem);
      return report;
    }
  }
  let text = '';
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (error) {
    report.problems.push({ code: 'unreadable', path: resolved, message: error.message });
    return report;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch (error) {
      report.problems.push({ code: 'damaged', path: `${resolved}:${index + 1}`, message: `不是有效 JSON（${error.message}）` });
      return;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      report.problems.push({ code: 'damaged', path: `${resolved}:${index + 1}`, message: '不是 JSON 对象' });
      return;
    }
    const schemaVersion = Number(row.schemaVersion);
    if (!DESKTOP_UPDATE_JOURNAL_SCHEMA_VERSIONS.includes(schemaVersion)) {
      report.problems.push({
        code: 'damaged',
        path: `${resolved}:${index + 1}`,
        message: `未知 schemaVersion ${JSON.stringify(row.schemaVersion)}，本 dpx 只认 ${DESKTOP_UPDATE_JOURNAL_SCHEMA_VERSIONS.join(', ')}——拒绝按当前格式解读`,
      });
      return;
    }
    report.schemaVersions.push(schemaVersion);
    const record = {
      schemaVersion,
      time: typeof row.time === 'string' ? row.time : undefined,
      action: typeof row.action === 'string' ? row.action : undefined,
      fromVersion: typeof row.fromVersion === 'string' ? row.fromVersion : undefined,
      toVersion: typeof row.toVersion === 'string' ? row.toVersion : undefined,
      sha256: normalizeHash(row.sha256),
      result: typeof row.result === 'string' ? row.result : undefined,
    };
    report.records.push(record);
    report.last = record;
  });
  return report;
}

function normalizeHash(value) {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/**
 * The one-line summary `dpx desktop status` attaches.
 *
 * `status` is one of `none` (no journal), `ok`, or `failed`, so a caller can
 * gate on it without re-deriving the rules from `records`.
 */
export function desktopUpdateJournalSummary(journal) {
  if (!journal.present || (journal.records.length === 0 && journal.problems.length === 0)) {
    return { status: 'none', path: journal.path, records: 0, problems: journal.problems.length };
  }
  const last = journal.last;
  const failed = journal.records.filter(row => row.result !== undefined && !DESKTOP_UPDATE_SUCCESS_RESULTS.includes(row.result));
  const status = journal.records.length === 0 || failed.length || journal.problems.length ? (failed.length ? 'failed' : 'unknown') : 'ok';
  return {
    status,
    path: journal.path,
    records: journal.records.length,
    problems: journal.problems.length,
    ...(last ? { last: { time: last.time, action: last.action, fromVersion: last.fromVersion, toVersion: last.toVersion, result: last.result } } : {}),
  };
}

export function commandUsage() {
  return `dpx — isolated DeepSeek Harness environments\n\n` +
    `Create and install:\n  dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --test --D:\\DevEnvs\\Projects\n  dpx npm install -g @deepseek-ai/dsh --test --D:\\DevEnvs\\Projects --no-desktop\n\n` +
    `Reuse an environment:\n  dpx npm install -g @deepseek-harness-tui/dsh-tui --test\n  dpx run --test dsh-tui\n  dpx run --test dsh -- web --no-open\n  dpx exec --test -- npm ls -g --depth=0\n\n` +
    `Ask which copy you are about to use (never guesses, never runs it):\n  dpx which --test\n  dpx which --test dsh-tui\n  dpx env doctor --test\n\n` +
    `Check every environment at once, without one:\n  dpx env doctor\n  dpx env doctor --json\n\n` +
    `Enter an environment in the current shell:\n  dpx env use --test --format powershell | Invoke-Expression\n  dpx env use --test --format cmd\n\n` +
    `Manage a profile's plugins with an explicit store:\n  dpx plugin add --test <package>[@version|tarball] --profile dsh-tui\n\n` +
    `Recover a profile whose patch or bundles stopped it from booting (never parses the patch):\n  dpx env repair --test\n  dpx env repair --test --profile web --dry-run\n\n` +
    `Desktop launcher (Windows):\n  dpx desktop status --test\n  dpx desktop check  --test\n  dpx desktop update --test\n  dpx desktop install --test --source github:T-Auto/dsh-dpx\n\n` +
    `Inspect:\n  dpx env list\n  dpx env show --test\n  dpx env remove --test --purge\n  dpx env remove --test --purge --dry-run\n  dpx descriptor --test\n\n` +
    `The --name selector and optional --absolute-storage-root may appear anywhere in dpx npm arguments. New Windows environments receive a desktop EXE unless --no-desktop is supplied.\n` +
    `dpx desktop updates only the desktop launcher, from GitHub Releases by default; --source also accepts an https manifest URL or a local manifest path.\n` +
    `--dry-run prints what would change and writes nothing; it is supported by dpx env remove and dpx env repair.`;
}
