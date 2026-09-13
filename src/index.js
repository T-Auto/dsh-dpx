import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { DESKTOP_LAUNCHER_DIR, DESKTOP_LAUNCHER_NAME, installBundledDesktopLauncher } from './desktop-release.js';
import { GUIDE_FORMAT, ensureEnvironmentGuide, environmentGuidePath } from './environment-guide.js';

export const FORMAT = 1;
export const DPX_API_VERSION = 'dpx.dsh.dev/v1alpha1';
export const DISTRIBUTION = Object.freeze({
  id: 'urn:dsh:distribution:t-auto:dsh-dpx',
  version: '0.1.0',
});

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
 * Where DPX keeps `registry.json`.
 *
 * `DPX_HOME` always wins: an operator (or a parent dpx) can point a process at
 * one exact registry. Otherwise the platform default is used — with one
 * documented exception. A dpx environment isolates `LOCALAPPDATA`, so the
 * child's "platform default" is a *private, empty* registry inside
 * `<env-root>\localappdata`; a `dpx` started inside an environment would then
 * report no environments at all, which is the opposite of what a multi
 * environment manager is for. When the process can prove it lives in a managed
 * environment (`DSH_DPX_ENV_ROOT`) and the private default holds no registry,
 * the machine-level discovery pointer is preferred.
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
  if (env[DPX_ENV_ROOT_VARIABLE]?.trim()) {
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
    descriptor: join(absolute, 'dsh-distribution.json'),
    manifest: join(absolute, '.dpx-environment.json'),
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
    if (!isAbsolute(row.root) || row.instance.apiVersion !== 'discovery.distribution.dsh.dev/v1alpha1' || row.instance.kind !== 'EnvironmentInstance' || row.instance.distribution?.id !== DISTRIBUTION.id || row.instance.distribution?.version !== DISTRIBUTION.version) {
      throw new Error('Registry environment binding is invalid.');
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

export async function removeEnvironment({ name, home = defaultRegistryHome(), purge = false }) {
  name = assertEnvironmentName(name);
  return withRegistryLock(home, async () => {
    const registry = await loadRegistry(home);
    const index = registry.environments.findIndex(row => row.name === name);
    if (index < 0) throw new Error(`Environment --${name} is not registered.`);
    const [record] = registry.environments.splice(index, 1);
    const expected = environmentRoot(dirname(dirname(record.root)), name);
    if (resolve(record.root) !== expected) throw new Error(`Refusing to remove environment with an unsafe root: ${record.root}`);
    if (purge && existsSync(record.root)) await rm(record.root, { recursive: true, force: false });
    registry.revision += 1;
    await atomicJson(registryPath(home), registry);
    return { record, purged: purge && !existsSync(record.root) };
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

/** Read the version a package manifest declares, without failing on damage. */
export function packageVersionAt(directory) {
  try {
    const raw = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return typeof raw?.version === 'string' ? raw.version : undefined;
  } catch {
    return undefined;
  }
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
  try {
    const raw = JSON.parse(readFileSync(join(envRoot, DESKTOP_LAUNCHER_DIR, '.dpx-desktop.json'), 'utf8'));
    return typeof raw?.version === 'string' ? raw.version : undefined;
  } catch {
    return undefined;
  }
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
  const globalPackage = locatePackage(paths, entry.package);
  if (globalPackage) {
    copies.push({ location: 'npm-prefix', path: globalPackage, version: packageVersionAt(globalPackage) });
  }
  for (const profile of listProfiles(paths)) {
    const directory = join(paths.dshHome, 'profiles', profile, 'node_modules', ...entry.package.split('/'));
    if (!existsSync(directory)) continue;
    copies.push({ location: `profile:${profile}`, path: directory, version: packageVersionAt(directory) });
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
      current ? undefined : `dpx env show --${name} 会就地刷新它（标记块之外的内容不动）`);
  }

  const identity = env[DPX_ENV_ROOT_VARIABLE]?.trim();
  const inside = identity ? pathContains(paths.root, identity) : false;
  push('process-identity', 'ok',
    identity
      ? (inside
        ? `当前进程就在这个环境里（${DPX_ENV_ROOT_VARIABLE}=${identity}）`
        : `当前进程在另一个环境里（${DPX_ENV_ROOT_VARIABLE}=${identity}），这是对 --${name} 的只读检查`)
      : `当前进程不在任何 dpx 环境里（${DPX_ENV_ROOT_VARIABLE} 未设置），这是对 --${name} 的只读检查`);

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

  const expectedStore = expectedPnpmStore(paths);
  const profiles = listProfiles(paths);
  for (const profile of profiles) {
    const directory = profileDirectory(paths, profile);
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
  const directory = profileDirectory(paths, profile);
  let dependencies;
  try {
    const raw = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    dependencies = Object.keys(raw?.dependencies ?? {});
  } catch {
    return [];
  }
  return dependencies.map(packageName => {
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
}

export function commandUsage() {
  return `dpx — isolated DeepSeek Harness environments\n\n` +
    `Create and install:\n  dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --test --D:\\DevEnvs\\Projects\n  dpx npm install -g @deepseek-ai/dsh --test --D:\\DevEnvs\\Projects --no-desktop\n\n` +
    `Reuse an environment:\n  dpx npm install -g @deepseek-harness-tui/dsh-tui --test\n  dpx run --test dsh-tui\n  dpx run --test dsh -- web --no-open\n  dpx exec --test -- npm ls -g --depth=0\n\n` +
    `Ask which copy you are about to use (never guesses, never runs it):\n  dpx which --test\n  dpx which --test dsh-tui\n  dpx env doctor --test\n\n` +
    `Enter an environment in the current shell:\n  dpx env use --test --format powershell | Invoke-Expression\n  dpx env use --test --format cmd\n\n` +
    `Manage a profile's plugins with an explicit store:\n  dpx plugin add --test <package>[@version|tarball] --profile dsh-tui\n\n` +
    `Desktop launcher (Windows):\n  dpx desktop status --test\n  dpx desktop check  --test\n  dpx desktop update --test\n  dpx desktop install --test --source github:T-Auto/dsh-dpx\n\n` +
    `Inspect:\n  dpx env list\n  dpx env show --test\n  dpx env remove --test --purge\n  dpx descriptor --test\n\n` +
    `The --name selector and optional --absolute-storage-root may appear anywhere in dpx npm arguments. New Windows environments receive a desktop EXE unless --no-desktop is supplied.\n` +
    `dpx desktop updates only the desktop launcher, from GitHub Releases by default; --source also accepts an https manifest URL or a local manifest path.`;
}
