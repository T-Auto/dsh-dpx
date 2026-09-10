#!/usr/bin/env node
import {
  commandUsage,
  createEnvironment,
  defaultRegistryHome,
  displayEnvironment,
  isGlobalInstall,
  launchSpec,
  loadRegistry,
  npmCliPath,
  npmEnvironment,
  npmInstallArguments,
  parseEnvironmentArguments,
  removeEnvironment,
  pathsFor,
  resolveEnvironment,
  runChild,
  runtimeEnvironment,
} from '../src/index.js';
import {
  DEFAULT_DESKTOP_SOURCE,
  checkDesktopUpdate,
  desktopStatus,
  parseDesktopSource,
  updateDesktopLauncher,
} from '../src/desktop-release.js';

async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(commandUsage());
    return 0;
  }
  const home = defaultRegistryHome(environment);
  if (command === 'npm') return npmCommand(rest, home, environment);
  if (command === 'run') return runCommand(rest, home, environment);
  if (command === 'env') return environmentCommand(rest, home);
  if (command === 'desktop') return desktopCommand(rest, home, environment);
  if (command === 'descriptor') return descriptorCommand(rest, home);
  throw new Error(`Unknown dpx command ${JSON.stringify(command)}.\n\n${commandUsage()}`);
}

async function npmCommand(args, home, environment) {
  const [verb, ...npmArgs] = args;
  if (verb !== 'install') throw new Error('Only `dpx npm install -g … --name [--storage-root]` is supported in v0.1.');
  if (!isGlobalInstall(npmArgs)) throw new Error('Use npm global install syntax: dpx npm install -g <packages> --name [--absolute-storage-root].');
  const parsed = parseEnvironmentArguments(npmArgs);
  let record;
  if (parsed.root) {
    record = await createEnvironment({ name: parsed.name, storageRoot: parsed.root, home, desktop: parsed.desktop });
  } else {
    record = await resolveEnvironment(parsed.name, home);
  }
  const paths = pathsFor(record.root);
  const argsForNpm = npmInstallArguments(parsed.passthrough, paths.npmPrefix);
  const npmCli = environment.DPX_NPM_CLI?.trim() || npmCliPath();
  const result = await runChild(process.execPath, [npmCli, 'install', ...argsForNpm], {
    cwd: paths.workspace,
    env: npmEnvironment(paths, environment),
  });
  return result.code;
}

async function runCommand(args, home, environment) {
  // --no-desktop only changes first-time environment creation. Preserve it when
  // running DSH so a future DSH flag with that spelling is not swallowed.
  const parsed = parseEnvironmentArguments(args, { parseDesktop: false });
  const [target = 'dsh', ...targetArgs] = parsed.passthrough;
  const record = await resolveEnvironment(parsed.name, home);
  const paths = pathsFor(record.root);
  const spec = launchSpec(paths, target);
  const result = await runChild(spec.file, [...spec.args, ...targetArgs], {
    cwd: paths.workspace,
    env: runtimeEnvironment(paths, environment),
  });
  return result.code;
}

const DESKTOP_VERBS = new Set(['status', 'check', 'update', 'install']);

/**
 * Options that belong to `dpx desktop …` only. They are parsed out of the
 * argument list so the environment selector parser keeps its single job.
 */
function parseDesktopOptions(args) {
  const options = { source: undefined, proxy: undefined, tag: undefined, prerelease: false, force: false, dryRun: false };
  const rest = [];
  let index = 0;
  const readValue = (name, inline) => {
    if (inline !== undefined) return inline;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 需要一个值。`);
    index += 1;
    return value;
  };
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--source' || arg.startsWith('--source=')) { options.source = readValue('--source', arg.startsWith('--source=') ? arg.slice(9) : undefined); continue; }
    if (arg === '--proxy' || arg.startsWith('--proxy=')) { options.proxy = readValue('--proxy', arg.startsWith('--proxy=') ? arg.slice(8) : undefined); continue; }
    if (arg === '--tag' || arg.startsWith('--tag=')) { options.tag = readValue('--tag', arg.startsWith('--tag=') ? arg.slice(6) : undefined); continue; }
    if (arg === '--prerelease') { options.prerelease = true; continue; }
    if (arg === '--force') { options.force = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    rest.push(arg);
  }
  return { options, rest };
}

async function desktopCommand(args, home, environment) {
  const [verb, ...rest] = args;
  if (!DESKTOP_VERBS.has(verb)) {
    throw new Error('Use `dpx desktop status|check|update|install --<name> [--source <github[:owner/repo][@tag]>|https://清单URL|本地清单路径] [--proxy <url>] [--tag <tag>] [--prerelease] [--force] [--dry-run]`.');
  }
  const { options, rest: selectors } = parseDesktopOptions(rest);
  const parsed = parseEnvironmentArguments(selectors, { parseDesktop: false });
  if (parsed.passthrough.length) {
    throw new Error(`dpx desktop ${verb} 不接受这些参数：${parsed.passthrough.join(' ')}`);
  }
  const record = await resolveEnvironment(parsed.name, home);
  const envRoot = record.root;
  if (verb === 'status') {
    console.log(JSON.stringify({ environment: record.name, ...(await desktopStatus(envRoot)) }, null, 2));
    return 0;
  }
  const source = options.source?.trim()
    || environment.DPX_DESKTOP_SOURCE?.trim()
    || DEFAULT_DESKTOP_SOURCE;
  parseDesktopSource(source);
  if (verb === 'check') {
    const result = await checkDesktopUpdate({ envRoot, source, proxy: options.proxy, prerelease: options.prerelease, tag: options.tag, env: environment });
    console.log(JSON.stringify({ environment: record.name, ...result }, null, 2));
    return 0;
  }
  const result = await updateDesktopLauncher({
    envRoot,
    source,
    proxy: options.proxy,
    prerelease: options.prerelease,
    tag: options.tag,
    force: options.force || verb === 'install',
    dryRun: options.dryRun,
    env: environment,
  });
  console.log(JSON.stringify({
    environment: record.name,
    command: verb,
    updated: result.updated,
    reason: result.reason,
    target: result.target,
    installed: result.stamp ? { version: result.stamp.version, sha256: result.sha256, source: result.stamp.source } : undefined,
    previous: result.current ? { version: result.current.version, digest: result.current.digest } : undefined,
    release: result.release ? { version: result.release.version, tag: result.release.tag, assetName: result.release.assetName, source: result.release.source } : undefined,
    message: result.updated
      ? `desktop 封装已更新到 ${result.release.version}：${result.target}`
      : result.reason === 'up-to-date'
        ? `已是最新版本（${result.release.version}），无需更新。`
        : result.reason === 'dry-run'
          ? `将更新到 ${result.release.version}（--dry-run 未写入任何文件）。`
          : `未更新：${result.reason}`,
  }, null, 2));
  return 0;
}

async function environmentCommand(args, home) {
  const [verb, ...rest] = args;
  if (verb === 'list') {
    const registry = await loadRegistry(home);
    console.log(JSON.stringify({ registry: home, revision: registry.revision, environments: registry.environments.map(displayEnvironment) }, null, 2));
    return 0;
  }
  if (verb === 'show') {
    const parsed = parseEnvironmentArguments(rest, { parseDesktop: false });
    if (parsed.passthrough.length) throw new Error('env show accepts only an environment selector.');
    console.log(JSON.stringify(displayEnvironment(await resolveEnvironment(parsed.name, home)), null, 2));
    return 0;
  }
  if (verb === 'remove') {
    const parsed = parseEnvironmentArguments(rest, { parseDesktop: false });
    const purge = parsed.passthrough.includes('--purge');
    const extras = parsed.passthrough.filter(arg => arg !== '--purge');
    if (extras.length) throw new Error('env remove accepts only an environment selector and optional --purge.');
    const removed = await removeEnvironment({ name: parsed.name, home, purge });
    console.log(JSON.stringify({ removed: removed.record.name, root: removed.record.root, purged: removed.purged }, null, 2));
    return 0;
  }
  throw new Error('Use `dpx env list`, `dpx env show --name`, or `dpx env remove --name [--purge]`.');
}

async function descriptorCommand(args, home) {
  const parsed = parseEnvironmentArguments(args, { parseDesktop: false });
  if (parsed.passthrough.length) throw new Error('descriptor accepts only an environment selector.');
  const record = await resolveEnvironment(parsed.name, home);
  console.log(JSON.stringify({ descriptor: pathsFor(record.root).descriptor, instance: record.instance, discoverableEntry: record.discoverableEntry }, null, 2));
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`dpx: ${error.message}`);
  process.exitCode = 1;
});

export { main };
