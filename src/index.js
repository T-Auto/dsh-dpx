import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { DESKTOP_LAUNCHER_DIR, DESKTOP_LAUNCHER_NAME, installBundledDesktopLauncher } from './desktop-release.js';

export const FORMAT = 1;
export const DPX_API_VERSION = 'dpx.dsh.dev/v1alpha1';
export const DISTRIBUTION = Object.freeze({
  id: 'urn:dsh:distribution:t-auto:dsh-dpx',
  version: '0.1.0',
});
const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
// These belong to the selected DSH/TUI target, not to DPX. A future
// schema-backed target parser can replace this small compatibility list.
const TARGET_OPTIONS = new Set([
  '--help', '-h', '--version', '--profile', '--dump-config', '--dump-default-config',
  '--config', '--no-open', '--open', '--host', '--port', '--verbose', '--debug',
]);
const NO_DESKTOP_OPTION = '--no-desktop';

export function defaultRegistryHome(env = process.env, platform = process.platform) {
  if (env.DPX_HOME?.trim()) return resolve(env.DPX_HOME);
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error('LOCALAPPDATA is unavailable; set DPX_HOME to an absolute private directory.');
    return resolve(localAppData, 'DSH', 'DPX');
  }
  const stateHome = env.XDG_STATE_HOME?.trim() || (env.HOME ? join(env.HOME, '.local', 'state') : undefined);
  if (!stateHome) throw new Error('Cannot determine a state directory; set DPX_HOME.');
  return resolve(stateHome, 'dsh-dpx');
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
      await ensureEnvironmentDirectories(pathsFor(existing.root), platform);
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
  // Repair profile directories for environments created by older dpx versions
  // before a caller launches npm, dsh, or the desktop shell.
  await ensureEnvironmentDirectories(pathsFor(record.root), process.platform);
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

export function npmEnvironment(paths, inherited = process.env) {
  const env = { ...inherited };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  // Default installs are direct. Remove inherited proxy state so an environment
  // never silently depends on a host-local proxy. An operator can explicitly
  // pass npm's --proxy / --https-proxy flags for a single install command.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy']) delete env[key];
  env.NPM_CONFIG_CACHE = paths.npmCache;
  env.npm_config_cache = paths.npmCache;
  env.NPM_CONFIG_PREFIX = paths.npmPrefix;
  env.npm_config_prefix = paths.npmPrefix;
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.npm_config_update_notifier = 'false';
  return env;
}

export function runtimeEnvironment(paths, inherited = process.env) {
  const env = npmEnvironment(paths, inherited);
  env.DSH_HOME = paths.dshHome;
  env.DSH_AGENTS_HOME = paths.agentsHome;
  env.DSH_TELEMETRY_DISABLED = '1';
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

export function launchSpec(paths, target) {
  if (target === 'dsh') {
    const pkg = locatePackage(paths, '@deepseek-ai/dsh');
    if (!pkg) throw new Error('The isolated @deepseek-ai/dsh package is missing. Install it with dpx npm install -g @deepseek-ai/dsh --<environment>.');
    return { file: process.execPath, args: [join(pkg, 'lib', 'bin.js')] };
  }
  if (target === 'dsh-tui') {
    const pkg = locatePackage(paths, '@deepseek-harness-tui/dsh-tui');
    if (!pkg) throw new Error('The isolated dsh-tui package is missing. Install it with dpx npm install -g @deepseek-harness-tui/dsh-tui --<environment>.');
    return { file: process.execPath, args: [join(pkg, 'bin', 'dsh-tui.js')] };
  }
  throw new Error(`Unsupported launch target ${JSON.stringify(target)}. Supported targets: dsh, dsh-tui.`);
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

export function npmInstallArguments(args, prefix) {
  if (!isGlobalInstall(args)) throw new Error('dpx only accepts npm global installs. Include -g or --global.');
  if (args.some(arg => arg === '--prefix' || arg.startsWith('--prefix='))) throw new Error('dpx owns npm --prefix; do not override it.');
  const hasProxy = args.some(arg => arg === '--proxy' || arg.startsWith('--proxy='));
  const hasHttpsProxy = args.some(arg => arg === '--https-proxy' || arg.startsWith('--https-proxy='));
  return [
    ...args,
    '--prefix', prefix, '--no-audit', '--no-fund',
    ...(hasProxy ? [] : ['--proxy=null']),
    ...(hasHttpsProxy ? [] : ['--https-proxy=null']),
  ];
}

export function commandUsage() {
  return `dpx — isolated DeepSeek Harness environments\n\n` +
    `Create and install:\n  dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --test --D:\\DevEnvs\\Projects\n  dpx npm install -g @deepseek-ai/dsh --test --D:\\DevEnvs\\Projects --no-desktop\n\n` +
    `Reuse an environment:\n  dpx npm install -g @deepseek-harness-tui/dsh-tui --test\n  dpx run --test dsh-tui\n  dpx run --test dsh -- web --no-open\n\n` +
    `Desktop launcher (Windows):\n  dpx desktop status --test\n  dpx desktop check  --test\n  dpx desktop update --test\n  dpx desktop install --test --source github:T-Auto/dsh-dpx\n\n` +
    `Inspect:\n  dpx env list\n  dpx env show --test\n  dpx env remove --test --purge\n  dpx descriptor --test\n\n` +
    `The --name selector and optional --absolute-storage-root may appear anywhere in dpx npm arguments. New Windows environments receive a desktop EXE unless --no-desktop is supplied.\n` +
    `dpx desktop updates only the desktop launcher, from GitHub Releases by default; --source also accepts an https manifest URL or a local manifest path.`;
}
