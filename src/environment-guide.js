// The environment-level DSH instruction file: `<env-root>/dsh-home/AGENTS.md`.
//
// DSH loads `$DSH_HOME/AGENTS.md` as its user-global instruction file, and every
// dsh-dpx launch path points `DSH_HOME` at `<env-root>/dsh-home`:
//
//   dpx run --<name> dsh web …             src/index.js   runtimeEnvironment()
//   dpx run --<name> dsh-tui …
//   <env-root>\desktop\…Desktop.exe        desktop-shell/src-tauri/src/dsh.rs
//
// So one generated file explains the environment to every agent that runs inside
// it, no matter how the environment was started — and no matter whether the
// environment was created with a desktop launcher or with `--no-desktop`.
//
// dsh-dpx deliberately does **not** hijack npm any more: it never sets
// `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE`, so `npm` inside the environment keeps
// its native meaning. This file is what tells an agent how to aim npm at the
// environment explicitly instead.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GUIDE_FILE_NAME = 'AGENTS.md';
export const GUIDE_BEGIN_PREFIX = '<!-- dpx:environment-guide:begin';
export const GUIDE_END = '<!-- dpx:environment-guide:end -->';
export const GUIDE_FORMAT = 1;

export function environmentGuidePath(paths) {
  return join(paths.dshHome, GUIDE_FILE_NAME);
}

/**
 * Render the managed block. It is generated from the environment's own layout,
 * so the absolute paths inside it are always the ones actually in use.
 */
export function renderEnvironmentGuide(paths, { name, version } = {}) {
  const name_ = name ?? '<name>';
  const prefix = paths.npmPrefix;
  const cache = paths.npmCache;
  const begin = `${GUIDE_BEGIN_PREFIX} v${GUIDE_FORMAT} dsh-dpx@${version ?? '0'} -->`;
  return `${begin}
# 运行环境：dsh-dpx 隔离环境 \`${name_}\`

你（这个 agent）运行在一个由 **dsh-dpx** 创建并管理的**命名隔离环境**里，不是宿主机的默认 DSH。
隔离的做法是给子进程设置一套环境变量，把*默认解析*收容到下面这个环境根内；它不是文件系统沙箱。

- 环境名：\`${name_}\`
- 环境根：\`${paths.root}\`
- \`DSH_HOME\`（该环境的 DSH 状态与配置根）：\`${paths.dshHome}\`
- 本文件：\`${environmentGuidePath(paths)}\` —— DSH 的环境级全局指令，TUI / Web / 桌面端启动都会读它

## 这个隔离环境是怎么设计的

| 路径 | 用途 |
| --- | --- |
| \`${prefix}\` | 环境专属 npm 全局目录（显式 \`--prefix\` 的目标，也是 \`PATH\` 的第一项） |
| \`${cache}\` | 环境专属 npm 缓存（显式 \`--cache\` 的目标） |
| \`${paths.dshHome}\` | \`DSH_HOME\`：DSH profiles / settings / sessions / storages 与本文件 |
| \`${paths.agentsHome}\` | \`DSH_AGENTS_HOME\`：agents / skills（**不是** AGENTS.md 的读取位置） |
| \`${paths.home}\` | \`HOME\` / \`USERPROFILE\`；\`home\\Desktop\` 是默认工作区位置 |
| \`${paths.appData}\`、\`${paths.localAppData}\`、\`${paths.tmp}\` | \`APPDATA\` / \`LOCALAPPDATA\` / \`TEMP\` \`TMP\` |
| \`${paths.xdgConfig}\`、\`${paths.xdgCache}\`、\`${paths.xdgData}\` | \`XDG_*\`；pnpm store 也落在 \`xdg-data\` 下 |
| \`${paths.workspace}\` | \`dpx run\` 与桌面端启动 DSH 时的默认工作目录 |
| \`${paths.desktopDir}\`、\`${join(paths.root, 'desktop-state')}\` | Windows 桌面启动器及其状态（随环境隔离） |

同一台机器上还有别的环境（\`dpx env list\`）：它们彼此完全独立，改动当前环境不会影响它们，也不要去改动它们。

## npm 在这里是原生的（重要）

dsh-dpx 不劫持 npm：\`dpx run\` 与桌面启动器都不设置 \`NPM_CONFIG_PREFIX\` / \`NPM_CONFIG_CACHE\`，
\`npm\` 完全按原生规则工作。而本环境的 \`APPDATA\` / \`LOCALAPPDATA\` 本身是被隔离的，
所以 npm 的原生默认落点也在环境内 —— 只是落在**另一个**目录，不是 dpx 管理的那个：

| 你问的 | 答案 |
| --- | --- |
| \`npm prefix -g\` / \`npm root -g\` | \`${paths.appData}\\npm\`（原生默认 = \`%APPDATA%\\npm\`） |
| \`npm config get cache\` | \`${paths.localAppData}\\npm-cache\`（= \`%LOCALAPPDATA%\\npm-cache\`） |
| dpx / DSH 真正使用的环境 npm 目录（\`PATH\` 第一项，\`dsh\`、\`dsh-tui\` 所在处） | \`${prefix}\` |
| dpx 管理的环境 npm 缓存 | \`${cache}\` |

> 自查：\`$env:NPM_CONFIG_PREFIX\`、\`$env:NPM_CONFIG_CACHE\` 应当为空。
> 若仍有值，说明本环境的桌面启动器还是旧版本（它硬编码了这两个变量）；
> 用 \`dpx desktop update --${name_}\` 升级启动器并重启即可消失。

- 裸跑 \`npm install -g <pkg>\` 不会污染宿主机（profile 被隔离），但它装进 \`${paths.appData}\\npm\`：
  那个目录**不在 \`PATH\` 上**，也不是 \`dpx\`、DSH 或桌面端查找包的位置 —— 装在那里等于没人看得见。
- 所以别把 \`npm root -g\` 的输出当成“已经装进环境”的证据：它指向 \`appdata\\npm\`，不是 \`npm-prefix\`。

要把包安装进**这个环境**（能被 \`dpx run\`、\`dsh\`、桌面端看到），必须显式给出路径与缓存：

\`\`\`powershell
npm install -g --prefix "${prefix}" --cache "${cache}" <包名>
\`\`\`

等价的 dsh-dpx 封装（推荐，它做的就是上面这条命令）：

\`\`\`powershell
dpx npm install -g <包名> --${name_}
\`\`\`

装完可以用这两条确认落点：

\`\`\`powershell
npm ls -g --prefix "${prefix}" --depth=0
Get-Command <命令名> | Select-Object Source
\`\`\`

## 边界

- 隔离只收容默认解析：命令行上的显式绝对路径（\`--prefix\`、\`--cache\`、\`--location\`、\`--userconfig\`）永远优先。
- 这**不是**沙箱：进程以当前用户权限运行，仍可写宿主机任意路径，也可以改宿主机全局 npm 目录；操作本环境时请始终写显式路径。
- 启动方式不同、规则相同：\`dpx run --${name_} dsh web\`、\`dpx run --${name_} dsh-tui\`、
  双击环境根 \`desktop\` 下的桌面启动器，读到的都是本文件。
- 本文件由 dsh-dpx 维护：标记块（\`dpx:environment-guide\` 的 begin / end 注释）之间的内容是生成的，
  会在环境被复用时自动刷新；你自己的全局指令请写在标记块**之外**。
${GUIDE_END}`;
}

/**
 * Merge a freshly rendered block into an existing instruction file:
 * replace the managed region in place, or append it to user content.
 */
export function mergeEnvironmentGuide(existing, block) {
  const begin = existing.indexOf(GUIDE_BEGIN_PREFIX);
  const end = existing.indexOf(GUIDE_END);
  if (begin >= 0 && end > begin) {
    return `${existing.slice(0, begin)}${block}${existing.slice(end + GUIDE_END.length)}`;
  }
  if (existing.trim()) return `${existing.replace(/\s+$/, '')}\n\n${block}\n`;
  return `${block}\n`;
}

/**
 * Ensure `<env-root>/dsh-home/AGENTS.md` explains this environment.
 *
 * Idempotent: the file is only rewritten when its managed block actually
 * changed, and any instructions a user wrote outside the markers are preserved.
 */
export async function ensureEnvironmentGuide(paths, info = {}) {
  const path = environmentGuidePath(paths);
  const block = renderEnvironmentGuide(paths, info);
  let existing = '';
  if (existsSync(path)) {
    try {
      existing = await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const next = mergeEnvironmentGuide(existing, block);
  if (next.replace(/\s+$/, '') === existing.replace(/\s+$/, '')) return { path, changed: false };
  await mkdir(paths.dshHome, { recursive: true });
  await writeFile(path, next, { encoding: 'utf8' });
  return { path, changed: true };
}
