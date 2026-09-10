# dsh-dpx

`dsh-dpx` 是给 **DeepSeek Harness（DSH）创建、安装、发现和启动多个彼此隔离环境的包管理器**。它不是 DSH 插件，也不修改 DSH 的核心或插件协议。

在 Windows 上，首次创建环境会**默认**同时放入一个可双击的桌面端 EXE；它以极简黑白启动页显示 `DSH / DeepSeek Harness Desktop / 隔离环境：<名称> / 正在启动本地 DSH 服务…`，随后在内置 WebView 中载入该环境的 DSH Web UI。

它服务于两个目标：

1. **开发与调试**：一台电脑可以保留多个命名 DSH 环境，例如 `test`、`stable`、`alpha`；它们可安装不同版本的 DSH、TUI 或第三方包，互不污染，便于复现和比较问题。
2. **未来的第三方整合包**：整合包可按 `dsh-distribution` 的环境身份与发现规则注册实例，让其他兼容包管理器不扫描磁盘也能找到它。

> 当前状态：实验性、Windows 优先。需要 Node.js `>=22.19.0`。`0.1.0` 已实现命名隔离安装、DPX 发现 profile、环境内 DSH/TUI 启动；`dsh-tui --环境名` 的全局启动器兼容层需要由 `dsh-tui` 项目接入，详见[“`dsh-tui --test`”](#dsh-tui---test-统一启动体验)。

## 与普通 DSH 插件安装的区别

例如，TUI 这类 DSH 插件可用普通 npm 全局安装：

```bash
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
```

此命令会在**全局 DeepSeek Harness** 上安装 DSH 与 TUI 启动器；TUI 首次运行时会通过 DSH 的插件机制写入默认的全局 DSH profile。它适合只有一个日常 DSH 环境的用户。

`dsh-dpx` 的定位不同：它是管理多个隔离 DSH 发行环境的**包管理器/环境管理器**。它可以经由 npm/npx 直接拉取，也可以从本仓库本地构建、链接和运行。每个环境独立拥有 npm 全局前缀、下载缓存、DSH 状态、agents/skills、工作目录和环境描述符；安装到 `test` 不会改变全局 DSH，也不会改变 `stable`。

## 安装 dpx

### 从 npm 安装（发布后）

```bash
npm install -g dsh-dpx
```

也可以按 npm 习惯一次性执行：

```bash
npx dsh-dpx --help
```

### 从本地源码运行

```powershell
git clone https://github.com/T-Auto/dsh-dpx.git
cd dsh-dpx
npm link
```

`npm link` 后可直接使用本地构建的 `dpx`。开发验证命令：

```powershell
npm test
npm run check
npm run pack:check
```

## 一条命令创建并安装独立环境

下面的命令创建名为 `test` 的环境，并把 DSH 与 TUI 都安装到 `D:\DevEnvs\Projects` 下的专属环境目录：

```bash
dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --test --"D:\DevEnvs\Projects"

# 若只需要命令行隔离环境，不复制桌面端 EXE：
# dpx npm install -g @deepseek-ai/dsh --test --"D:\DevEnvs\Projects" --no-desktop
```

这里的两个特殊参数含义为：

- 第一个 `--test`：环境名称，类似 conda 的环境名。名称使用 ASCII 字母、数字和连字符，且以字母开头。
- 第二个 `--"D:\DevEnvs\Projects"`：仅在**首次创建**环境时指定的绝对存储父目录。

命令会建立：

```text
D:\DevEnvs\Projects\dsh-environments\test\
├── npm-prefix\                # test 专属的 npm 全局包与命令 shim
├── npm-cache\                 # test 专属的 npm 下载/内容缓存
├── dsh-home\                  # test 专属 DSH_HOME：profiles、设置、会话、存储
│   └── AGENTS.md              # test 环境的用户全局 DSH 指令（可选）
├── agents-home\               # test 专属 DSH_AGENTS_HOME：agents / skills
├── home\
│   └── Desktop\               # Windows 首次建立工作区使用的默认位置
├── appdata\ localappdata\ tmp\
├── workspace\                 # dpx 启动 DSH 时的工作目录
├── desktop\
│   └── DSH DeepSeek Harness Desktop.exe
│                              # 默认复制的 Windows 桌面启动器，可直接双击
├── dsh-distribution.json       # 环境的 dsh-distribution 描述符
└── .dpx-environment.json       # 实例身份和 DPX 注册记录的本地副本
```

其中 Windows 的 `home\\Desktop` 会在首次创建环境时一并建立；复用旧环境时 dpx 也会自动补齐，避免首次建立工作区时出现“位置不可用”。

因此，该环境的 DSH、缓存、配置、会话、插件 profile 与用户目录变量全部是独立的；它不会修改：

- 系统或用户 npm 全局 prefix；
- 默认 `~/.dsh`、`~/.agents`；
- 任何其他 DPX 环境。

> `desktop\` 与 EXE 仅会在 Windows 上默认创建；macOS/Linux 保持纯 CLI 环境。加入 `--no-desktop` 时 Windows 也不会创建它；此参数只在首次创建环境时生效，已有环境不会因后续 `dpx npm install` 而被意外添加、替换或删除桌面端。

> npm 包的生命周期脚本仍以当前用户权限运行。目录隔离不是操作系统沙箱，不能把不可信包当作安全的执行环境。

## 在已有环境中继续安装

环境已经注册后，不再需要传存储目录：

```bash
dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --test
```

也可以只安装/升级一个包：

```bash
dpx npm install -g @deepseek-harness-tui/dsh-tui --test
```

DPX v0.1 只接受 npm 的全局安装语义（`-g` / `--global`），并自行固定环境专属的 `--prefix`；调用者不能覆盖该 prefix。

## Windows 桌面端（默认创建，可独立于 DSH 升级）

首次创建的每个 Windows 环境都包含：

```text
<环境根>\desktop\DSH DeepSeek Harness Desktop.exe
```

双击该 EXE 后，它只从**自身路径的父目录**推导环境根（可用 `DSH_DESKTOP_ENV` 临时覆盖），再从该环境的 `npm-prefix\node_modules\@deepseek-ai\dsh\package.json` 动态读取 DSH 的 `bin` 入口。它不读取 DPX registry、不调用 `dpx`、不依赖 `D:\AIPC\dsh-desktop`，也不硬编码 DSH 的内部 `lib/bin.js` 位置。它会设置与 `dpx run` 相同的隔离变量并启动 `dsh web --no-open --port 0`；关闭窗口时回收启动的 DSH 子进程树。

因此，desktop 启动的 DSH 全局 `AGENTS.md` 也放在：

```text
<环境根>\dsh-home\AGENTS.md
```

desktop EXE 本身没有另一份独立的全局 Agent 指令文件。

因此，后续升级核心版本仍是普通命令：

```bash
dpx npm install -g @deepseek-ai/dsh@latest --test
```

该升级只替换环境内的 DSH npm 包；既不会重建桌面 EXE，也不会改变 EXE 所属环境。EXE 本身不内嵌 Node 或 DSH，运行时需要已安装 Node.js 和 Windows WebView2（Windows 11 通常自带）。桌面外壳的可控状态也完全按环境隔离：启动日志位于 `<环境根>\desktop-state\shell.log`，WebView2 用户数据位于 `<环境根>\desktop-state\webview2`，不会使用 `%LOCALAPPDATA%\dsh-dpx-desktop` 共享目录。

环境描述符将 `./desktop` 声明为 DPX 专属桌面启动器目录（公共协议的受限相对路径语法不允许以含空格的 EXE 文件名作为资源位置）。

源码中保留了透明、可复现的 Tauri 构建目录 `desktop-shell/`。发布包包含预构建 x64 EXE，因此普通 dpx 用户无需安装 Rust/Tauri；维护者需要重建时运行：

```powershell
npm run desktop:build
```

该脚本仅会话级启用 `D:\DevEnvs\Rust` 工具链，npm/Cargo 下载走 `http://127.0.0.1:7897`，并将产物写入 `assets\windows\DSH DeepSeek Harness Desktop.exe`。图标来源为 `whale-app-icon-512.png` 与 `whale-app-icon.ico`；后者会在构建时明确覆盖 Tauri 的 Windows 原生图标资源。

## 启动隔离环境

当前 DPX 原生支持：

```bash
# 启动 test 环境内的 TUI
dpx run --test dsh-tui

# 启动 test 环境内的 Web UI
dpx run --test dsh web --no-open

# 将参数原样转发给 test 环境的 DSH
dpx run --test dsh --version
```

每次 `dpx run` 都会为子进程设置环境专属的绝对路径：

```text
DSH_HOME=<环境根>\dsh-home
DSH_AGENTS_HOME=<环境根>\agents-home
NPM_CONFIG_PREFIX
NPM_CONFIG_CACHE
HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / TMP
```

其中两者职责不同：

- `DSH_HOME` 是该隔离环境的 DSH 状态与配置根目录；DSH 的用户全局指令文件固定读取 `DSH_HOME\AGENTS.md`。因此，若要为某个 DPX 环境增加个人全局系统提示词/Agent 指令，应写入：
  ```text
  <环境根>\dsh-home\AGENTS.md
  ```
- `DSH_AGENTS_HOME` 是该环境的 agents / skills 专属目录；它**不是**用户全局 `AGENTS.md` 的读取位置。
- 直接运行非 DPX 隔离的 DSH 时，等价的默认位置通常是 `%USERPROFILE%\.dsh\AGENTS.md`；显式设置 `DSH_HOME` 后则以该变量为准。

上述 `DSH_HOME\AGENTS.md` 是环境级全局指令；实际 workspace 或项目目录中的 `AGENTS.md` 仍会按 DSH 的目录发现规则加载，并以更具体的项目规则为准。

同时会清除可能污染环境的 `NODE_OPTIONS`、`NODE_PATH` 及常见代理变量，并设置 `DSH_TELEMETRY_DISABLED=1`。DPX 的 `npm install` 默认显式传入 `--proxy=null --https-proxy=null`，覆盖用户 npmrc；因此创建、安装和升级隔离环境默认直连，**不会自动走**本机 Clash `127.0.0.1:7897`。

若某次安装确实需要代理，调用者必须在该次命令中明确写入 npm 标准参数；DPX 不保存、更不内嵌任何代理端口：

```powershell
dpx npm install -g @deepseek-ai/dsh --desktop --"D:\AIPC" --proxy=http://127.0.0.1:7897 --https-proxy=http://127.0.0.1:7897
```

该代理仅用于本次 npm 安装；桌面 EXE 和后续 `dpx run` 不会继承它。

TUI 首次自举会调用 DSH 的 `plugin` 子命令，而该子命令需要 `pnpm` 可在 `PATH` 中找到。若尚未安装 pnpm，请先执行：

```bash
npm install -g pnpm
# 或
corepack enable pnpm
```

## `dsh-tui --test` 统一启动体验

目标用户体验是：

```bash
dsh-tui --test
```

无论用户选择哪一种安装方式，都应优雅启动 `test` 环境的 TUI：

| 用户已有内容 | `dsh-tui --test` 应做什么 |
| --- | --- |
| 全局安装了 `dsh-tui`，但没有安装 dpx | 全局 TUI 启动器读取 DPX 发现 profile，定位 `test`，并委托给其中已安装的 TUI。 |
| 只安装了 dpx，TUI 只安装在 `test` 隔离环境 | 通过 dpx/DPX registry 定位隔离 TUI 后启动，无需全局再安装一份 TUI 包。 |
| 全局与隔离环境都安装了 TUI | 显式 `--test` 永远优先启动 `test` 的隔离副本，不混用全局 DSH state。 |
| `test` 不存在或没有安装 TUI | 输出简短、可执行的诊断和创建/安装命令，不扫盘、不猜测路径。 |

`dsh-tui` 已有全局启动器；为实现上述精确命令，**需要在 dsh-tui 项目中接入一个小型 DPX 兼容适配器**。DPX 已提供该适配器所需的稳定发现入口和记录格式。适配器应：

1. 解析开头的 `--<环境名>`，如 `--test`；其余参数仍是普通 TUI 参数；
2. 读取 `HKCU\Software\DSH\DPX`，只接受 `Profile=dpx.dsh.dev/v1alpha1`；
3. 读取并校验指向的 DPX `registry.json`，精确匹配环境名；**禁止扫盘**，也不能执行 registry 提供的任意命令；
4. 由环境 root 推导固定子路径（`npm-prefix`、`dsh-home`、`agents-home` 和已知的 TUI `bin/dsh-tui.js`），设置同样的隔离变量后委托；
5. 找不到 DPX/环境/TUI 时给出 `dpx run --test dsh-tui`、创建环境或安装 TUI 的明确提示。

在该适配器合并到 `dsh-tui` 前，等价且已验证的命令是：

```bash
dpx run --test dsh-tui
```

## 按 `dsh-distribution` 注册环境

每次创建环境时，DPX 都会同时执行以下注册工作：

1. 在环境根生成 `dsh-distribution.json`，声明 `DistributionDescriptor`、`ManagedLayout` 与 `EnvironmentDiscovery`；
2. 为安装实例生成独立的 `urn:uuid:` `EnvironmentInstance`，因此同一发行物的 `test` 与 `stable` 绝不会被认作同一份安装；
3. 在环境根的 `.dpx-environment.json` 保存实例与 `DiscoverableEntry` 形状的记录；
4. 以原子方式维护 DPX 自己的可枚举 `registry.json`；
5. 在 Windows 写入一个轻量、无执行权限的 discovery pointer：

   ```text
   HKCU\Software\DSH\DPX
     Profile      = dpx.dsh.dev/v1alpha1
     RegistryPath = <DPX registry.json 的绝对路径>
   ```

默认 registry 位置：

```text
%LOCALAPPDATA%\DSH\DPX\registry.json
```

也可以以绝对路径设置 `DPX_HOME` 改变 registry home。

`dsh-distribution` 的通用协议定义描述符、引用发现和可选 Lodgement 语义，但**不规定**所有产品必须使用某个固定目录、环境变量或 Windows Registry key。`HKCU\Software\DSH\DPX` 是 DPX 定义的 `dpx.dsh.dev/v1alpha1` 实现 profile：它让兼容工具无需扫描磁盘就能找到 DPX registry，但不代表通用协议已经标准化该物理位置，也不授予任何可执行权限或信任。

DPX 不会写入：

```text
HKCU\Software\DSH\EnvironmentInstallations
```

该 key 属于 `dsh-distribution-manager` 的独立、固定发行环境安装器；DPX 不应混用或破坏它的验证/导入边界。

## 查看环境与注册信息

```bash
# 所有 DPX 已注册环境
dpx env list

# test 的隔离路径和实例 ID
dpx env show --test

# test 的 DistributionDescriptor、EnvironmentInstance、DiscoverableEntry 信息
dpx descriptor --test
```

registry 损坏、重复名称、实例身份冲突或环境 root 缺失时，DPX 会失败关闭（拒绝覆盖和猜测），而不是自动重建/扫描/接管目录。

## 开发、验证与发布边界

```powershell
npm test
npm run check
npm run pack:check
```

测试只使用临时目录与 fake npm；不会下载上游包或启动真实 DSH profile。`dsh-distribution.json` 可用 `dsh-distribution` 仓库的 conformance CLI 验证：

```powershell
node ..\dsh-distribution\packages\conformance\lib\cli.js "$PWD\dsh-distribution.json"
```

## 注销与清理环境

DPX 负责自己 registry 中环境记录的生命周期；不需要手动编辑 `registry.json`。可使用：

```powershell
# 仅注销 registry 记录，保留环境文件
 dpx env remove --test

# 注销并删除该 DPX 环境根（含 npm、DSH、desktop-state 和桌面 EXE）
 dpx env remove --test --purge
```

`--purge` 只删除 registry 中已登记、且可由 DPX 受控布局推导验证的环境根；它不会扫描磁盘，也不会删除全局 Node/npm、默认 DSH 目录或其他环境。

## 项目链接

- 主仓库：https://github.com/T-Auto/dsh-dpx
- 私有备份仓库：`T-Auto/back-dsh-dpx`
- 环境协议与 conformance：[`dsh-distribution`](https://github.com/T-Auto/dsh-distribution)
