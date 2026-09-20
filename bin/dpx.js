#!/usr/bin/env node
import {
  PLUGIN_COMPAT,
  SHELL_FORMATS,
  commandUsage,
  createEnvironment,
  defaultRegistryHome,
  desktopUpdateJournalSummary,
  displayEnvironment,
  doctorReport,
  environmentRemovalPlan,
  environmentShellScript,
  expectedPnpmStore,
  isGlobalInstall,
  launchSpec,
  launchTarget,
  launchTargets,
  listProfiles,
  loadRegistry,
  npmCliPath,
  npmEnvironment,
  npmInstallArguments,
  parseEnvironmentArguments,
  pathsFor,
  pluginArguments,
  profileDirectory,
  profileInstalledPackages,
  readDesktopUpdateJournal,
  readProfileInstaller,
  registryDoctorReport,
  removeEnvironment,
  repairEnvironment,
  resolveCommandInPath,
  resolveEnvironment,
  runChild,
  runtimeEnvironment,
  whichReport,
} from '../src/index.js';
import {
  DEFAULT_DESKTOP_SOURCE,
  checkDesktopUpdate,
  desktopStatus,
  parseDesktopSource,
  updateDesktopLauncher,
} from '../src/desktop-release.js';
import { basename, resolve } from 'node:path';

async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(commandUsage());
    return 0;
  }
  const home = defaultRegistryHome(environment);
  if (command === 'npm') return npmCommand(rest, home, environment);
  if (command === 'run') return runCommand(rest, home, environment);
  if (command === 'exec') return execCommand(rest, home, environment);
  if (command === 'which') return whichCommand(rest, home, environment);
  if (command === 'plugin') return pluginCommand(rest, home, environment);
  if (command === 'env') return environmentCommand(rest, home, environment);
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
  const argsForNpm = npmInstallArguments(parsed.passthrough, paths.npmPrefix, paths.npmCache);
  const npmCli = environment.DPX_NPM_CLI?.trim() || npmCliPath();
  const result = await runChild(process.execPath, [npmCli, 'install', ...argsForNpm], {
    cwd: paths.workspace,
    env: npmEnvironment(environment),
  });
  return result.code;
}

/**
 * Start a launch target *inside* one environment.
 *
 * The entry is executed directly, so neither PATH nor an npm shim can decide
 * which copy runs — that decision belongs to `--<name>`, not to the ambient
 * shell.
 */
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
    env: runtimeEnvironment(paths, environment, { name: record.name, registryHome: home }),
  });
  return result.code;
}

/**
 * Run any command inside one environment.
 *
 * `dpx run` covers the launch targets dpx knows; this covers everything else —
 * npm, pnpm, node, git, another dpx — with exactly the environment a `dpx run`
 * child gets. It is the scriptable form of `dpx env use`, and it is what makes
 * "develop environment A from inside environment B" a single command.
 */
async function execCommand(args, home, environment) {
  const separator = args.indexOf('--');
  const selectors = separator >= 0 ? args.slice(0, separator) : args;
  const { options, rest } = parseExecOptions(selectors);
  const parsed = parseEnvironmentArguments(rest, { parseDesktop: false });
  const commandArgs = separator >= 0 ? args.slice(separator + 1) : parsed.passthrough;
  if (commandArgs.length === 0) {
    throw new Error('Use `dpx exec --<name> [--cwd <dir>] -- <command> [args...]`.');
  }
  const record = await resolveEnvironment(parsed.name, home);
  const paths = pathsFor(record.root);
  const env = runtimeEnvironment(paths, environment, { name: record.name, registryHome: home });
  const cwd = options.cwd ? resolve(options.cwd) : paths.workspace;
  const [verb, ...verbArgs] = commandArgs;
  const file = resolveCommandInPath(verb, env);
  // A Windows .cmd/.bat shim is not executable on its own; cmd.exe has to run it.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const result = await runChild(file, verbArgs, { cwd, env, shell });
  return result.code;
}

/**
 * Answer "which copy would actually run?" without running anything.
 *
 * This is the command that was missing when a bare `dsh-tui` silently resolved
 * to the host copy: the answer is computable offline, it just was not exposed.
 */
async function whichCommand(args, home, environment) {
  const parsed = parseEnvironmentArguments(args, { parseDesktop: false });
  const [target, ...extra] = parsed.passthrough;
  if (extra.length) throw new Error('dpx which accepts at most one launch target.');
  if (target && !launchTarget(target)) {
    throw new Error(`Unsupported launch target ${JSON.stringify(target)}. Supported targets: ${launchTargets().join(', ')}.`);
  }
  const record = await resolveEnvironment(parsed.name, home);
  const paths = pathsFor(record.root);
  const registry = await loadRegistry(home);
  const targets = target ? [target] : launchTargets();
  const reports = targets.map(name_ => whichReport({ paths, name: record.name, target: name_, env: environment, registry }));
  console.log(JSON.stringify(
    reports.length === 1
      ? reports[0]
      : { environment: record.name, envRoot: paths.root, registry: home, targets: reports },
    null,
    2,
  ));
  return 0;
}

const PLUGIN_VERBS = new Set(['add']);

/**
 * Install into a profile through `dsh plugin`, with the profile's own pnpm
 * store pinned.
 *
 * dsh forwards `plugin add` to pnpm and then reconciles the profile's bundle
 * list, so dpx must not bypass it — but the forwarder cannot know which store
 * the profile's existing `node_modules` came from. dpx knows, so it passes it.
 */
async function pluginCommand(args, home, environment) {
  const [verb, ...rest] = args;
  if (!PLUGIN_VERBS.has(verb)) {
    throw new Error('Use `dpx plugin add --<name> <package[@version|tarball]> [--profile <profile>] [--store-dir <path>] [--dry-run]`.');
  }
  const { options, rest: selectors } = parsePluginOptions(rest);
  const parsed = parseEnvironmentArguments(selectors, { parseDesktop: false });
  if (parsed.passthrough.length === 0) {
    throw new Error('dpx plugin add needs at least one package spec, for example: dpx plugin add --<name> <package> --profile dsh-tui');
  }
  const record = await resolveEnvironment(parsed.name, home);
  const paths = pathsFor(record.root);
  const profiles = listProfiles(paths);
  const profile = options.profile
    ?? (profiles.includes('web') ? 'web' : profiles.length === 1 ? profiles[0] : undefined);
  if (!profile) {
    throw new Error(`Specify the target profile with --profile. Available profiles: ${profiles.join(', ') || '(none yet)'}.`);
  }
  const directory = profileDirectory(paths, profile);
  const installer = readProfileInstaller(directory);
  const storeDir = options.storeDir ?? installer?.storeDir ?? expectedPnpmStore(paths);
  const dshArgs = ['plugin', '--profile', profile, ...pluginArguments({ args: ['add', ...parsed.passthrough], storeDir })];
  const spec = launchSpec(paths, 'dsh');
  const payload = {
    environment: record.name,
    profile,
    profileDir: directory,
    store: {
      path: storeDir,
      source: options.storeDir ? 'flag' : installer?.storeDir ? 'existing-node_modules' : 'environment-default',
      installer: installer?.manager,
      expected: expectedPnpmStore(paths),
    },
    command: [spec.file, ...spec.args, ...dshArgs].join(' '),
  };
  if (options.dryRun) {
    console.log(JSON.stringify({ ...payload, dryRun: true, exitCode: null, installed: [] }, null, 2));
    return 0;
  }
  const result = await runChild(spec.file, [...spec.args, ...dshArgs], {
    cwd: paths.workspace,
    env: runtimeEnvironment(paths, environment, { name: record.name, registryHome: home }),
  });
  const installed = profileInstalledPackages(paths, profile);
  console.log(JSON.stringify({
    ...payload,
    dryRun: false,
    exitCode: result.code,
    installed,
    guidance: result.code === 0
      ? undefined
      : `安装失败。先跑 dpx env doctor --${record.name} 看 profile 的 store 与两侧版本；`
        + `若报 store 不一致，用 dpx plugin add --${record.name} <包名> --profile ${profile} --store-dir "${installer?.storeDir ?? storeDir}" 保持既有链接。`,
  }, null, 2));
  return result.code;
}

const DESKTOP_VERBS = new Set(['status', 'check', 'update', 'install']);

/**
 * Options that belong to `dpx desktop …` only. They are parsed out of the
 * argument list so the environment selector parser keeps its single job.
 */
function parseDesktopOptions(args) {
  const options = { source: undefined, proxy: undefined, tag: undefined, apiBase: undefined, prerelease: false, force: false, dryRun: false };
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
    // GitHub REST base for the `--prerelease` lookup. Additive: `DPX_GITHUB_API`
    // reaches the same code path, and the default stays api.github.com.
    if (arg === '--api-base' || arg.startsWith('--api-base=')) { options.apiBase = readValue('--api-base', arg.startsWith('--api-base=') ? arg.slice('--api-base='.length) : undefined); continue; }
    if (arg === '--prerelease') { options.prerelease = true; continue; }
    if (arg === '--force') { options.force = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    rest.push(arg);
  }
  return { options, rest };
}

function parsePluginOptions(args) {
  const options = { profile: undefined, storeDir: undefined, dryRun: false };
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
    if (arg === '--profile' || arg.startsWith('--profile=')) { options.profile = readValue('--profile', arg.startsWith('--profile=') ? arg.slice(10) : undefined); continue; }
    if (arg === '--store-dir' || arg.startsWith('--store-dir=')) { options.storeDir = readValue('--store-dir', arg.startsWith('--store-dir=') ? arg.slice(12) : undefined); continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    rest.push(arg);
  }
  return { options, rest };
}

function parseExecOptions(args) {
  const options = { cwd: undefined };
  const rest = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--cwd' || arg.startsWith('--cwd=')) {
      const inline = arg.startsWith('--cwd=') ? arg.slice(6) : undefined;
      if (inline !== undefined) { options.cwd = inline; continue; }
      const value = args[index + 1];
      if (value === undefined) throw new Error('--cwd 需要一个值。');
      options.cwd = value;
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { options, rest };
}

function parseUseOptions(args) {
  const options = { format: 'powershell' };
  const rest = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--format' || arg.startsWith('--format=')) {
      const inline = arg.startsWith('--format=') ? arg.slice(9) : undefined;
      const value = inline ?? args[index + 1];
      if (value === undefined) throw new Error('--format 需要一个值。');
      if (inline === undefined) index += 1;
      if (!SHELL_FORMATS.includes(value)) {
        throw new Error(`Unsupported shell format ${JSON.stringify(value)}. Supported formats: ${SHELL_FORMATS.join(', ')}.`);
      }
      options.format = value;
      continue;
    }
    rest.push(arg);
  }
  return { options, rest };
}

async function desktopCommand(args, home, environment) {
  const [verb, ...rest] = args;
  if (!DESKTOP_VERBS.has(verb)) {
    throw new Error('Use `dpx desktop status|check|update|install --<name> [--source <github[:owner/repo][@tag]>|https://清单URL|本地清单路径] [--proxy <url>] [--tag <tag>] [--prerelease] [--api-base <github-api-base>] [--force] [--dry-run]`.');
  }
  const { options, rest: selectors } = parseDesktopOptions(rest);
  const parsed = parseEnvironmentArguments(selectors, { parseDesktop: false });
  if (parsed.passthrough.length) {
    throw new Error(`dpx desktop ${verb} 不接受这些参数：${parsed.passthrough.join(' ')}`);
  }
  const record = await resolveEnvironment(parsed.name, home);
  const envRoot = record.root;
  if (verb === 'status') {
    // The update journal is read-only evidence, so the status report can carry
    // it without changing the existing shape (`present` / `version` / … stay).
    const journal = desktopUpdateJournalSummary(readDesktopUpdateJournal(pathsFor(envRoot).updates));
    console.log(JSON.stringify({ environment: record.name, ...(await desktopStatus(envRoot)), updates: journal }, null, 2));
    return 0;
  }
  const source = options.source?.trim()
    || environment.DPX_DESKTOP_SOURCE?.trim()
    || DEFAULT_DESKTOP_SOURCE;
  parseDesktopSource(source);
  if (verb === 'check') {
    const result = await checkDesktopUpdate({ envRoot, source, proxy: options.proxy, prerelease: options.prerelease, tag: options.tag, apiBase: options.apiBase, env: environment });
    console.log(JSON.stringify({ environment: record.name, ...result }, null, 2));
    return 0;
  }
  const result = await updateDesktopLauncher({
    envRoot,
    source,
    proxy: options.proxy,
    prerelease: options.prerelease,
    tag: options.tag,
    apiBase: options.apiBase,
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
    message: desktopUpdateMessage(result),
  }, null, 2));
  return 0;
}

/**
 * One line explaining an update outcome.
 *
 * Every `reason` the release channel can return gets its own sentence, because
 * `未更新：newer-installed` tells an operator nothing about whether that is
 * expected, a refusal, or an escape hatch.
 */
function desktopUpdateMessage(result) {
  if (result.updated) return `desktop 封装已更新到 ${result.release.version}：${result.target}`;
  switch (result.reason) {
    case 'up-to-date':
      return `已是最新版本（${result.release.version}），无需更新。`;
    case 'newer-installed':
      return `本地启动器版本（${result.current?.version ?? '未知'}）比发布源上的 ${result.release.version} 更新，已拒绝降级；`
        + '确实要装旧版请显式加 --force 或改用 dpx desktop install。';
    case 'different-build':
      return `本地与发布源同版本（${result.release.version}）但字节不同（本地 sha256=${result.current?.digest ?? '未知'}，`
        + `发布 sha256=${result.release.sha256 ?? '未知'}），未自动替换；确认要覆盖时加 --force。`;
    case 'dry-run':
      return `将更新到 ${result.release.version}（--dry-run 未写入任何文件）。`;
    default:
      return `未更新：${result.reason}`;
  }
}

async function environmentCommand(args, home, environment) {
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
  if (verb === 'doctor') {
    // Registry scope is decided *before* `parseEnvironmentArguments`, for two
    // reasons that both have to be handled here:
    //
    //   * `parseEnvironmentArguments([])` throws `An environment name is
    //     required` — the parser demands a selector, so "no selector means
    //     registry scope" cannot be expressed as a post-parse check;
    //   * a bare `--json` is a perfectly valid environment selector to that
    //     parser (`'json'` matches ENVIRONMENT_NAME) and would otherwise be read
    //     as "the environment named json".
    //
    // Scope, not shape, is what the selector count selects:
    //   0 selectors  → registry-level report (JSON by default and by contract)
    //   1 selector   → single-environment report (always JSON, unchanged)
    // Explicitly naming `--json` as an environment is impossible; a registry
    // holdout can be reached with `dpx env show --json`.
    const wantsJson = rest.includes('--json');
    const selectors = rest.filter(arg => arg !== '--json');
    if (selectors.length === 0) {
      const report = await registryDoctorReport({ home, env: environment });
      console.log(JSON.stringify({ json: true, ...report }, null, 2));
      return report.ok ? 0 : 1;
    }
    const parsed = parseEnvironmentArguments(selectors, { parseDesktop: false });
    if (parsed.passthrough.length) throw new Error('env doctor accepts only an environment selector and --json.');
    const record = await resolveEnvironment(parsed.name, home);
    const registry = await loadRegistry(home);
    const report = doctorReport({
      paths: pathsFor(record.root),
      name: record.name,
      record,
      env: environment,
      registry,
      registryHome: home,
    });
    console.log(JSON.stringify({ json: wantsJson, scope: 'environment', ...report }, null, 2));
    return report.ok ? 0 : 1;
  }
  if (verb === 'use') {
    const { options, rest: selectors } = parseUseOptions(rest);
    const parsed = parseEnvironmentArguments(selectors, { parseDesktop: false });
    if (parsed.passthrough.length) throw new Error('env use accepts only an environment selector and --format.');
    const record = await resolveEnvironment(parsed.name, home);
    process.stdout.write(environmentShellScript(pathsFor(record.root), {
      name: record.name,
      format: options.format,
      env: environment,
      registryHome: home,
    }));
    return 0;
  }
  if (verb === 'remove') {
    const parsed = parseEnvironmentArguments(rest, { parseDesktop: false });
    const purge = parsed.passthrough.includes('--purge');
    // `--dry-run` prints the exact plan (root, registry record, discovery
    // pointer, desktop state) and writes nothing. It deliberately does not go
    // through `resolveEnvironment`: that helper repairs the environment
    // scaffold on the way, which would make a preview write files.
    const dryRun = parsed.passthrough.includes('--dry-run');
    const extras = parsed.passthrough.filter(arg => arg !== '--purge' && arg !== '--dry-run');
    if (extras.length) throw new Error('env remove accepts only an environment selector and optional --purge / --dry-run.');
    if (dryRun) {
      const plan = await environmentRemovalPlan({ name: parsed.name, home, purge });
      console.log(JSON.stringify({
        dryRun: true,
        environment: plan.name,
        wouldRemove: {
          registry: plan.registry,
          root: plan.root,
          desktop: plan.desktop,
          discovery: plan.discovery,
        },
        message: purge
          ? `将删除环境根 ${plan.root.path}（含桌面端与 desktop-state）并从 registry 注销 --${plan.name}；--dry-run 未写入任何文件。`
          : `将只从 registry 注销 --${plan.name}，环境目录 ${plan.root.path} 原样保留；--dry-run 未写入任何文件。`,
      }, null, 2));
      return 0;
    }
    const removed = await removeEnvironment({ name: parsed.name, home, purge });
    console.log(JSON.stringify({ removed: removed.record.name, root: removed.record.root, purged: removed.purged }, null, 2));
    return 0;
  }
  if (verb === 'repair') {
    const { options, rest: selectors } = parseRepairOptions(rest);
    const parsed = parseEnvironmentArguments(selectors, { parseDesktop: false });
    if (parsed.passthrough.length) throw new Error('env repair accepts only an environment selector and optional --profile / --dry-run.');
    const report = await repairEnvironment({
      name: parsed.name,
      home,
      profiles: options.profile ? [options.profile] : undefined,
      dryRun: options.dryRun,
      registryHome: home,
    });
    console.log(JSON.stringify({ ...report, message: repairSummary(report) }, null, 2));
    return report.profiles.some(row => row.repaired === false) ? 1 : 0;
  }
  throw new Error('Use `dpx env list`, `dpx env show --name`, `dpx env doctor [--name] [--json]`, `dpx env use --name [--format powershell|cmd|json]`, `dpx env repair --name [--profile <profile>] [--dry-run]`, or `dpx env remove --name [--purge] [--dry-run]`.');
}

/**
 * A one-line summary that claims only what actually ran.
 *
 * The fixed template this replaces said "patch 已备份 / bundles 已收窄" no matter
 * what happened — including for a profile whose patch file did not exist and
 * whose bundles already matched, and for a run that repaired nothing at all.
 * The patch file name comes from the rows, so it follows upstream's
 * `PROFILE_PATCH_FILENAME` instead of hardcoding it.
 */
function repairSummary(report) {
  const would = report.dryRun;
  const repaired = report.profiles.filter(row => row.repaired);
  const skipped = report.profiles.filter(row => !row.repaired);
  const backedUp = repaired.filter(row => row.patchExists);
  const made = repaired.filter(row => row.created);
  const parts = [];
  if (repaired.length === 0) {
    parts.push(would ? '没有需要处理的 profile' : '没有修复任何 profile');
  } else {
    parts.push(`${would ? '将修复' : '已修复'} ${repaired.length} 个 profile（${repaired.map(row => row.profile).join('、')}）`);
    if (made.length) parts.push(`${would ? '将创建' : '已创建'} ${made.map(row => row.profile).join('、')}`);
    if (backedUp.length) {
      parts.push(`${would ? '将备份' : '已备份'} ${backedUp.length} 个 ${basename(backedUp[0].patchPath)}`
        + `（${would ? '不' : '未'}解析内容，冲突时追加序号）`);
    } else {
      parts.push('没有 patch 文件需要备份');
    }
    // A row whose `changed` is false had nothing to narrow, and a created profile
    // was never narrowed — it was born on the template. Claiming otherwise is the
    // same defect this function replaced, one level down.
    const narrowed = repaired.filter(row => row.changed && !row.created);
    if (narrowed.length) {
      parts.push(`${would ? '将把' : '已把'} ${narrowed.length} 个 profile 的 bundles 收窄到上游内建集合，`
        + '其余 manifest 字段与已装包/`node_modules` 保留');
    } else if (!made.length) {
      parts.push('bundles 本就与上游内建集合一致，manifest 未被改写');
    }
  }
  if (skipped.length) {
    parts.push(`跳过 ${skipped.length} 个：${skipped.map(row => `${row.profile}（${row.reason}）`).join('、')}`);
  }
  if (report.ignored?.length) {
    parts.push(`忽略 ${report.ignored.length} 个非 profile 目录：${report.ignored.map(row => row.profile).join('、')}`);
  }
  parts.push(would ? '未写入任何文件' : `registry 已标记为 ${report.registryStamped}`);
  return `${parts.join('；')}。`;
}

/** Options that only `dpx env repair` accepts. */
function parseRepairOptions(args) {
  const options = { profile: undefined, dryRun: false };
  const rest = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const inline = arg.startsWith('--profile=') ? arg.slice('--profile='.length) : undefined;
      const value = inline ?? args[index + 1];
      // An empty value is rejected rather than passed along: it is falsy at the
      // call site, which silently downgrades a single-profile recovery into a
      // whole-environment rewrite. `--profile "$VAR"` with VAR unset is the way
      // this happens in practice.
      if (value === undefined || value.trim() === '' || (inline === undefined && value.startsWith('--'))) {
        throw new Error('--profile 需要一个非空的 profile 名。');
      }
      if (inline === undefined) index += 1;
      options.profile = value;
      continue;
    }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    rest.push(arg);
  }
  return { options, rest };
}

async function descriptorCommand(args, home) {
  const parsed = parseEnvironmentArguments(args, { parseDesktop: false });
  if (parsed.passthrough.length) throw new Error('descriptor accepts only an environment selector.');
  const record = await resolveEnvironment(parsed.name, home);
  console.log(JSON.stringify({
    descriptor: pathsFor(record.root).descriptor,
    instance: record.instance,
    discoverableEntry: record.discoverableEntry,
    // The anchor travels here, not inside `dsh-distribution.json`: that
    // descriptor's schema is `additionalProperties: false`, so an extra key
    // there would be a protocol violation rather than an extension.
    pluginCompat: PLUGIN_COMPAT,
  }, null, 2));
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`dpx: ${error.message}`);
  process.exitCode = 1;
});

export { main };
