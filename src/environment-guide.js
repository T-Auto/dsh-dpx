// The environment-level DSH instruction file: `<env-root>/dsh-home/AGENTS.md`.
//
// DSH loads `$DSH_HOME/AGENTS.md` as its user-global instruction file, and every
// dsh-dpx launch path points `DSH_HOME` at `<env-root>/dsh-home`:
//
//   dpx run --<name> <target> …            src/index.js   runtimeEnvironment()
//   dpx exec --<name> -- <command> …
//   dpx env use --<name> --format …        (the shell the operator evaluates it in)
//   <env-root>\desktop\…Desktop.exe        desktop-shell/src-tauri/src/dsh.rs
//
// So one generated file explains the environment to every agent that runs inside
// it, no matter how the environment was started — and no matter whether the
// environment was created with a desktop launcher or with `--no-desktop`.
//
// dsh-dpx deliberately does **not** hijack npm: it never sets
// `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE`, so `npm` inside the environment keeps
// its native meaning. This file is what tells an agent how to aim npm at the
// environment explicitly instead.
//
// The block below is published content: it ships in the dpx package and runs in
// every environment, on every machine, for every user. It therefore states
// **rules about how dpx works**, and takes every concrete path from the
// environment it is rendered into (`paths`). It must never name a specific
// host, a specific checkout, or a specific product built on top of DSH.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GUIDE_FILE_NAME = 'AGENTS.md';
export const GUIDE_BEGIN_PREFIX = '<!-- dpx:environment-guide:begin';
export const GUIDE_END = '<!-- dpx:environment-guide:end -->';
export const GUIDE_FORMAT = 2;
/**
 * The environment's own identity record, written into the environment root.
 *
 * It is named here (rather than only in `index.js`) because the generated guide
 * has to tell an agent which piece of evidence dpx uses when the identity
 * variables have been stripped from its shell by a terminal layer.
 */
export const ENVIRONMENT_MANIFEST_NAME = '.dpx-environment.json';

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
- 环境身份变量：\`DSH_DPX_ENV\`=\`${name_}\`、\`DSH_DPX_ENV_ROOT\`=\`${paths.root}\`
- 本文件：\`${environmentGuidePath(paths)}\` —— DSH 的环境级全局指令，TUI / Web / 桌面端启动都会读它

## 0. 先确认你在哪一套里（读这一节能省掉一整轮排查）

- 本环境的可执行文件目录是 \`${prefix}\`；dpx 启动的子进程把它放在 \`PATH\` **第一项**。
- ⚠️ **\`PATH\` 上可能存在环境外的同名命令。** 裸敲一个命令名时，命中的是 \`PATH\` 里**第一个**同名文件，
  这一点**不是**由 \`DSH_HOME\` 决定的。命中环境外副本时，那个副本会连带使用**它自己**的 DSH 状态，
  所以你会看到“我在这个环境里装了东西，运行时却完全没变化”。
- 先问再跑，这三条都不会真正启动任何东西：

  \`\`\`powershell
  dpx which --${name_}              # 列出每个已识别启动目标：环境内副本 vs PATH 上会命中谁
  dpx which --${name_} <target>     # 只看一个目标
  dpx env doctor --${name_}         # 环境自洽性：registry / 布局 / PATH 冲突 / 双侧版本 / profile store
  \`\`\`

- 确定“我要用环境内那一套”的四条路，推荐第一条：

  1. \`dpx run --${name_} <target> …\` —— dpx 同时钉住 \`PATH\` 与 \`DSH_HOME\`，不依赖裸命令名
  2. \`dpx exec --${name_} -- <命令> …\` —— 在环境内跑**任意**命令（npm / pnpm / node / git / 又一个 dpx）
  3. \`dpx env use --${name_} --format powershell | Invoke-Expression\` —— 把**当前 shell** 切进环境
  4. 绝对路径：\`${prefix}\\<命令>.cmd\`

- **你的进程在哪个环境里**：\`DSH_DPX_ENV\` / \`DSH_DPX_ENV_ROOT\` 由每条启动路径（\`dpx run\`、\`dpx exec\`、
  \`dpx env use\`、桌面启动器）设置，任何进程（包括你在环境里再启动的 \`dpx\`）都能据此回答
  “我在哪个环境里”，不需要靠路径猜。
- ⚠️ 但**不要假设这两个变量一定在你手里**：DSH 的 shell / 终端层会为它交给 agent 的子进程
  **重建 \`DSH_*\` 命名空间**，只保留它自己声明过的键（\`DSH_HOME\` 等）。实测：在 dpx 环境里跑 agent 的 shell，
  能看到 \`DSH_HOME\`，但 \`DSH_DPX_ENV_ROOT\` 和 \`DSH_AGENTS_HOME\` 都已被丢掉。
  因此 dpx 判断“我在哪个环境里”时还会用结构化证据反推：\`DSH_HOME\`（或隔离的 \`LOCALAPPDATA\`）旁边
  是否存在声明 \`kind: DPXEnvironment\` 的 \`${ENVIRONMENT_MANIFEST_NAME}\`。你只要记住结论：
  **要确认自己在哪一套，跑 \`dpx env doctor --${name_}\` 的 \`process-identity\` 结论，不要只看某个变量是否为空。**

## 1. 这个隔离环境是怎么设计的

| 路径 | 用途 |
| --- | --- |
| \`${prefix}\` | 环境专属 npm 全局目录（显式 \`--prefix\` 的目标，也是 \`PATH\` 的第一项） |
| \`${cache}\` | 环境专属 npm 缓存（显式 \`--cache\` 的目标） |
| \`${paths.dshHome}\` | \`DSH_HOME\`：DSH profiles / settings / sessions / storages 与本文件 |
| \`${join(paths.dshHome, 'profiles')}\` | DSH profile 目录：每个 profile 是一份独立的插件依赖树（\`profiles\\<profile>\\package.json\`） |
| \`${paths.agentsHome}\` | \`DSH_AGENTS_HOME\`：agents / skills（**不是** AGENTS.md 的读取位置） |
| \`${paths.home}\` | \`HOME\` / \`USERPROFILE\`；\`home\\Desktop\` 是默认工作区位置 |
| \`${paths.appData}\`、\`${paths.localAppData}\`、\`${paths.tmp}\` | \`APPDATA\` / \`LOCALAPPDATA\` / \`TEMP\` \`TMP\` |
| \`${paths.xdgConfig}\`、\`${paths.xdgCache}\`、\`${paths.xdgData}\` | \`XDG_*\`；pnpm store 也落在 \`xdg-data\` 下 |
| \`${paths.workspace}\` | dpx 启动 DSH / 执行命令时的默认工作目录 |
| \`${paths.desktopDir}\`、\`${join(paths.root, 'desktop-state')}\` | Windows 桌面启动器及其状态（随环境隔离） |

同一台机器上还有别的环境（\`dpx env list\`）：它们彼此完全独立，改动当前环境不会影响它们，也不要去改动它们。

## 2. 往这个环境里装东西

**装普通 npm 全局包**（要能被 \`dpx run\` / 桌面端看到）：

\`\`\`powershell
dpx npm install -g <包名> --${name_}
# 等价展开，dpx 内部就是这条：
npm install -g --prefix "${prefix}" --cache "${cache}" <包名>
\`\`\`

**装 profile 插件**（DSH 的 profile 插件树，由 pnpm 安装）：

\`\`\`powershell
dpx plugin add --${name_} <包名[@版本|tarball路径]> --profile <profile>
dpx plugin add --${name_} <包名> --profile <profile> --dry-run   # 只看会执行什么
\`\`\`

dpx 会把该 profile **既有 \`node_modules\` 的 store 显式传下去**，并在安装后回读真实版本。
不要绕过它：手改 \`profiles\\*\\package.json\` 或手动往 \`node_modules\` 里塞包，
会让“全局副本 ↔ profile 副本”的版本漂移，且安装器与 store 的对应关系会丢失。

### npm 在这里是原生的（重要）

dsh-dpx 不劫持 npm：\`dpx run\`、\`dpx exec\` 与桌面启动器都不设置 \`NPM_CONFIG_PREFIX\` / \`NPM_CONFIG_CACHE\`，
\`npm\` 完全按原生规则工作。而本环境的 \`APPDATA\` / \`LOCALAPPDATA\` 本身是被隔离的，
所以 npm 的原生默认落点也在环境内 —— 只是落在**另一个**目录，不是 dpx 管理的那个：

| 你问的 | 答案 |
| --- | --- |
| \`npm prefix -g\` / \`npm root -g\` | \`${paths.appData}\\npm\`（原生默认 = \`%APPDATA%\\npm\`） |
| \`npm config get cache\` | \`${paths.localAppData}\\npm-cache\`（= \`%LOCALAPPDATA%\\npm-cache\`） |
| dpx / DSH 真正使用的环境 npm 目录（\`PATH\` 第一项） | \`${prefix}\` |
| dpx 管理的环境 npm 缓存 | \`${cache}\` |

- 裸跑 \`npm install -g <包名>\` 不会污染宿主机，但它装进 \`${paths.appData}\\npm\`：
  那个目录**不在 \`PATH\` 上**，也不是 \`dpx\`、DSH 或桌面端查找包的位置 —— 装在那里等于没人看得见。
- 所以别把 \`npm root -g\` 的输出当成“已经装进环境”的证据：它指向 \`appdata\\npm\`，不是 \`npm-prefix\`。
- 自查：\`$env:NPM_CONFIG_PREFIX\`、\`$env:NPM_CONFIG_CACHE\` 应当为空。若有值，说明启动器/父进程是旧版本，
  它会把 npm 的默认值改道；请升级桌面启动器（\`dpx desktop update --${name_}\`）或改用 \`dpx exec\`。

## 3. dpx 通用开发规则

1. **不要假设**当前 shell 的默认解析落在环境内。任何“装在哪 / 会跑哪个”的问题，
   以 \`dpx which --${name_}\` 与 \`dpx env doctor --${name_}\` 的输出为准，不要以版本号或目录名推断。
2. **跨环境操作永远显式指名环境**：\`dpx run|exec|npm|plugin … --<环境名>\`。
   不要靠 \`cd\`、\`PATH\`、改全局 npm prefix 去“让命令落到某个环境”，那些都会泄漏到环境之外。
3. **区分两层副本**：\`${prefix}\` 里的全局副本与 \`profiles\\<profile>\\node_modules\` 里的 profile 副本
   是两次独立安装，版本可以不同。两者不一致时用 \`dpx plugin add\`（对齐 profile）或
   \`dpx npm install -g\`（对齐全局）修，不要手动复制目录。
4. **不要为了让某个命令生效去改宿主机**：宿主全局 npm 目录、宿主 \`PATH\`、其他环境的目录都不属于你。
   环境之间的独立性是硬约束，不是建议。
5. **报错先取证再改**：把 \`dpx env doctor --${name_}\` 的结论、原始命令与完整输出一起报告；
   不要用“重建环境”“删除 node_modules”这类破坏性手段试探。
6. **需要真正的文件系统隔离/沙箱**时，在本机沙箱或容器层实现；dpx 只负责环境身份、受控布局与默认路径收容。

## 4. 已知失败模式

- **症状**：我在这个环境里装了包 / 改了插件，运行时却没生效、界面没变化。
  **原因**：命令命中了环境外的同名副本，它用的是那套副本自己的 DSH 状态。
  **处置**：\`dpx which --${name_}\` → 改用 \`dpx run --${name_} <target>\` 或 \`dpx exec --${name_} -- <命令>\`。
- **症状**：给 profile 装插件时报 \`ERR_PNPM_UNEXPECTED_STORE\`。
  **原因**：该 profile 的 \`node_modules\` 由另一处 store 链接而来，而当前 pnpm 想用环境内的 store。
  **处置**：\`dpx env doctor --${name_}\` 会报出两侧 store 差异；用
  \`dpx plugin add --${name_} <包名> --profile <profile> --store-dir "<既有 store>"\` 保持既有链接，
  或删掉该 profile 的 \`node_modules\` 后用 \`dpx plugin add\` 重建。
- **症状**：启动器报 \`launcher ↔ profile\` 版本不一致。
  **原因**：全局副本与 profile 副本分属两次安装。
  **处置**：\`dpx plugin add\` 与 \`dpx npm install -g\` 分别对齐两侧（\`dpx env doctor\` 会同时给出两侧版本）。
- **症状**：在环境里 \`dpx env list\` 看不到别的环境（只看到一个空的私有 registry）。
  **原因**：环境的 \`LOCALAPPDATA\` 是隔离的，dpx 的默认 registry 位置随之被收容；
  判定“我在环境里”所依赖的身份变量又可能被启动链上的终端层丢掉（见上一节）。
  **处置**：dpx 会用 \`DSH_HOME\` / 隔离的 \`LOCALAPPDATA\` 旁的 \`${ENVIRONMENT_MANIFEST_NAME}\` 反推环境根，
  并据此回落到本机的 DPX 发现指针（\`HKCU\\Software\\DSH\\DPX\`）；仍不对时显式设置 \`DPX_HOME\`。

## 边界

- 隔离只收容默认解析：命令行上的显式绝对路径（\`--prefix\`、\`--cache\`、\`--location\`、\`--userconfig\`）永远优先。
- 这**不是**沙箱：进程以当前用户权限运行，仍可写宿主机任意路径，也可以改宿主机全局 npm 目录；操作本环境时请始终写显式路径。
- 启动方式不同、规则相同：\`dpx run --${name_} <target>\`、\`dpx exec --${name_} -- …\`、
  \`dpx env use --${name_}\` 之后的 shell、双击环境根 \`desktop\` 下的桌面启动器，读到的都是本文件。
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
