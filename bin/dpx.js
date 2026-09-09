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
