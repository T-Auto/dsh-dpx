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

`dsh-dpx` 的定位不同：它是管理多个隔离 DSH 发行环境的**包管理器/环境管理器**。它可以经由 npm/npx 直接拉取，也可以从本仓库本地构建、链接和运行。每个环境独立拥有 npm 全局前缀、下载缓存、DSH 状态、agents/skills、工作目录和环境描述符；安装到 `test` 不会改变全局 DSH，也不会改变 `stable`。环境里的 `npm` 保持原生行为，要写进环境必须显式给出 `--prefix` / `--cache`（或直接用 `dpx npm install`），并且每个环境都会自动得到一份说明自己在哪、怎么设计的 `dsh-home\AGENTS.md`。

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
├── npm-prefix\                # test 专属的 npm 全局包与命令 shim（需显式 --prefix 才会写入）
├── npm-cache\                 # test 专属的 npm 下载/内容缓存（需显式 --cache 才会写入）
├── dsh-home\                  # test 专属 DSH_HOME：profiles、设置、会话、存储
│   └── AGENTS.md              # dpx 自动写入的环境级全局指令（TUI / Web / 桌面端都会读）
├── agents-home\               # test 专属 DSH_AGENTS_HOME：agents / skills
├── home\
│   └── Desktop\               # Windows 首次建立工作区使用的默认位置
├── appdata\ localappdata\ tmp\
├── workspace\                 # dpx 启动 DSH 时的工作目录
├── desktop\
│   ├── DSH DeepSeek Harness Desktop.exe
│   │                          # 默认复制的 Windows 桌面启动器，可直接双击
│   └── .dpx-desktop.json      # dpx 记录的启动器版本/摘要，供更新检查使用
├── desktop-state\             # 桌面启动器自己的状态（随环境隔离）
│   ├── settings.json          # 关闭行为、更新源、托盘开关
│   ├── shell.json             # 可选：启动契约（入口/参数/node），见下文
│   ├── shell.log              # 启动器日志
│   ├── updates\               # 更新暂存与被替换下来的旧 EXE
│   └── webview2\              # WebView2 用户数据目录
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

DPX v0.1 只接受 npm 的全局安装语义（`-g` / `--global`），并自行固定环境专属的 `--prefix` 与 `--cache`；调用者不能覆盖这两个值。这两个旗标是**命令行显式参数**，DPX 不通过 `NPM_CONFIG_*` 改写 npm 的默认行为（原因见[「npm 在隔离环境里是原生的」](#npm-在隔离环境里是原生的)）。

## Windows 桌面端（默认创建，与 DSH 本体完全解耦）

首次创建的每个 Windows 环境都包含：

```text
<环境根>\desktop\DSH DeepSeek Harness Desktop.exe
<环境根>\desktop\.dpx-desktop.json      # dpx 记录的启动器版本与 sha256
```

双击该 EXE 后，它只做四件事：

1. 从**自身路径的父目录**推导环境根（可用 `DSH_DESKTOP_ENV` 临时覆盖）；
2. 在该环境的 `npm-prefix\node_modules\<包名>\package.json` 里读取包自己声明的 `bin` 入口并启动它——**不硬编码** `lib/bin.js`、不读 DPX registry、不调用 `dpx`、不依赖任何 DSH 内部文件布局；
3. 只从子进程输出中解析就绪 URL：优先取官方 `dsh web: <url>` 行，也接受任何回环地址 URL，因此 DSH 改写日志措辞不会让已安装的启动器失效；
4. 关闭窗口默认**缩小到右下角托盘图标并继续运行**，托盘图标右键可打开设置或关闭程序。

启动参数默认 `web --no-open --port 0`。如果将来 DSH 改变了入口位置或 CLI 参数形状，可以在环境根放一份启动契约，**无需重新编译启动器**：

```jsonc
// <环境根>\desktop-state\shell.json
{
  "dshPackage": "@deepseek-ai/dsh",
  "dshEntry": "npm-prefix/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "launchArgs": ["web", "--no-open", "--port", "0"],
  "node": "C:\\Program Files\\nodejs\\node.exe",
  "extraEnv": { "EXAMPLE": "1" }
}
```

因此“升级 DSH 本体”和“升级 desktop 封装”是两件互不影响的事：

```bash
# 只替换环境内的 DSH npm 包；不重建、不替换桌面启动器
dpx npm install -g @deepseek-ai/dsh@latest --test

# 只替换 desktop 封装（Windows 启动器）；不动 DSH 包
dpx desktop update --test
```

因此，desktop 启动的 DSH 全局 `AGENTS.md` 也放在：

```text
<环境根>\dsh-home\AGENTS.md
```

这份文件由 `dpx` 自动写入（内容见[「环境级 `AGENTS.md`」](#环境级-agentsmddpx-自动写入所有启动方式都会读到)），桌面端、TUI 与 Web 读的是同一份；desktop EXE 本身没有另一份独立的全局 Agent 指令文件。

EXE 本身不内嵌 Node 或 DSH，运行时需要已安装 Node.js 和 Windows WebView2（Windows 11 通常自带）。桌面外壳的可控状态也完全按环境隔离：设置位于 `<环境根>\desktop-state\settings.json`，启动日志位于 `<环境根>\desktop-state\shell.log`，更新暂存位于 `<环境根>\desktop-state\updates\`，WebView2 用户数据位于 `<环境根>\desktop-state\webview2`，不会使用共享的 `%LOCALAPPDATA%\dsh-dpx-desktop` 目录。

### 关闭行为与托盘

| 位置 | 行为 |
| --- | --- |
| 右上角 `□ X` | 按设置执行：**缩小到托盘图标并保持运行**（默认）/ 关闭程序 / 每次询问 |
| 首次点击 `□ X` | 弹出与 Web UI 同风格的确认框：默认勾选“缩小到右下角托盘图标并保持运行”和“下次不再提醒我” |
| 托盘图标左键 | 恢复主窗口 |
| 托盘图标右键 | `打开主窗口` / `设置` / `重启 DSH 服务` / `关闭程序` |
| `设置 → 关闭窗口` | 随时在“缩小到托盘图标 / 关闭程序 / 每次询问”之间切换 |

“关闭程序”会回收该环境内的 DSH 子进程树；缩小到托盘只是隐藏窗口，DSH 仍在后台运行。

### 环境之间的隔离（重要）

每个环境的桌面启动器都是**同一个文件名、同一个可执行文件副本**，所以“多个环境互不影响”必须由启动器自己保证，而不是靠文件名区分。当前实现保证：

| 资源 | 归属 | 说明 |
| --- | --- | --- |
| 单实例互斥 | 每个环境一份 | 用 `<环境根>\desktop-state\shell.lock` 的独占文件锁；**不使用** Tauri 单实例插件的全局互斥量（它按 bundle identifier 命名，会让不同环境互相排斥、并互相把窗口弹到前台） |
| 第二次启动同一环境 | 恢复已有窗口 | 通过 `<环境根>\desktop-state\instance.json` 里的 `{pid, hwnd}` 还原窗口，绝不启动第二个 DSH 服务，避免污染同一 `DSH_HOME` |
| 两个不同环境 | 可同时运行 | 互斥键来自环境根，环境 A 与 B 完全不知道对方存在 |
| DSH 子进程生命周期 | 绑定启动器 | 子进程被放入一个 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 作业对象：启动器无论是正常退出、崩溃还是被任务管理器强杀，操作系统都会一并终止该 DSH 进程树，不会留下占用会话写句柄的孤儿进程 |
| 设置 / 日志 / 托盘状态 / WebView2 数据 / 更新暂存 | 每个环境一份 | 全部位于 `<环境根>\desktop-state\`，不使用任何共享目录 |

> 升级说明：`0.1.0` 的启动器使用 Tauri 单实例插件，因此**两个环境不能同时运行**（后启动的那个会立即退出，并把先启动的窗口弹到前台）。`0.2.0` 起改为上面的按环境隔离实现；旧环境的 EXE 用 `dpx desktop update --<环境名>` 升级即可。

### 桌面封装的更新（GitHub Release）

desktop 封装有自己独立的版本号与发布通道，不随 DSH 本体变化：

```powershell
# 查看当前环境的启动器版本与摘要
dpx desktop status --test

# 检查 GitHub Release 上是否有新版本（只读，不写任何文件）
dpx desktop check --test

# 下载、校验并替换启动器
dpx desktop update --test

# 为 --no-desktop 创建的环境补装启动器
dpx desktop install --test
```

也可以在托盘图标右键 → `设置` 中点击“检查更新 / 立即更新”。两条路径共用同一份清单契约，详见 [`docs/desktop-release.md`](docs/desktop-release.md)。

默认源是 `github:T-Auto/dsh-dpx`（即 `https://github.com/T-Auto/dsh-dpx/releases/latest/download/desktop-latest.json`）。`--source` 也接受：

```powershell
dpx desktop update --test --source github:T-Auto/dsh-dpx@desktop-v0.2.0   # 指定 tag
dpx desktop update --test --source https://example.com/desktop-latest.json # 自建清单
dpx desktop update --test --source .\dist\desktop-latest.json              # 本地清单
```

下载内容必须通过清单里的 `size` 与 `sha256` 校验才会被安装；校验失败会拒绝安装并保留原启动器。需要代理时用 `--proxy`，或依赖环境里的 `HTTPS_PROXY` / `ALL_PROXY`（桌面端还会读取 Windows 系统代理）。

环境描述符将 `./desktop` 声明为 DPX 专属桌面启动器目录（公共协议的受限相对路径语法不允许以含空格的 EXE 文件名作为资源位置）。

源码中保留了透明、可复现的 Tauri 构建目录 `desktop-shell/`。发布包包含预构建 x64 EXE，因此普通 dpx 用户无需安装 Rust/Tauri；维护者需要重建时运行：

```powershell
# 重建内置产物 assets\windows\DSH DeepSeek Harness Desktop.exe 与 desktop-manifest.json
npm run desktop:build

# 额外产出可发布的 Release 目录（版本化 EXE + desktop-latest.json）
powershell -ExecutionPolicy Bypass -File scripts/build-desktop-launcher.ps1 -Version 0.2.1 -OutputDirectory dist -SkipPackagedArtifact
```

该脚本会话级启用本机 `D:\DevEnvs\Rust` 工具链（若存在），下载走 `-Proxy` / `DPX_BUILD_PROXY`；版本号同时写入编译期常量（`DPX_DESKTOP_VERSION`），所以启动器总能报告自己的真实版本。图标来源为 `whale-app-icon.ico`，会在构建时明确覆盖 Tauri 的 Windows 原生图标资源。

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
HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / TMP
XDG_CONFIG_HOME / XDG_CACHE_HOME / XDG_DATA_HOME
PATH=<环境根>\npm-prefix;…
```

注意这里**没有** `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE`：dsh-dpx 不再劫持 npm 的默认值（见下文[「npm 在隔离环境里是原生的」](#npm-在隔离环境里是原生的)）。

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

### npm 在隔离环境里是原生的

隔离环境**不劫持 npm**：dsh-dpx（`dpx run`）与桌面启动器都不再设置 `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE`，`npm` 在环境里就是原生命令行。

- `npm install -g <pkg>`、`npm root -g`、`npm config get cache` 读写的都是**宿主机**的全局 prefix / 缓存，
  **不会**装进、也不会改变这个隔离环境；
- 所以要往环境里装东西，必须显式给出路径与缓存：

  ```powershell
  npm install -g --prefix "<环境根>\npm-prefix" --cache "<环境根>\npm-cache" <包名>
  ```

  或使用等价的封装（推荐，dpx 内部就是把这两个旗标拼上去）：

  ```powershell
  dpx npm install -g <包名> --test
  ```

  `dpx npm install` 只接受全局安装语义（`-g` / `--global`），并自行固定 `--prefix` 与 `--cache`；调用者不能覆盖这两个值。这样即使宿主或其他工具设置了 `NPM_CONFIG_*`，dpx 的一次安装也不会被静默改道。

之所以改成显式旗标，是因为“环境变量重定向 npm 默认值”这种收容方式会让**同一台机器上的其他 npm 调用**也被改道：只要从隔离环境里派生的任何进程执行 `npm i -g`，它就会装进隔离环境而不是宿主全局目录——这既反直觉，也让宿主全局 npm 目录变得难以解释。现在只有显式写路径的那条命令会写进环境。

> 已存在的环境：`dpx run` 用的是 dpx 自己的代码，升级 dpx 后立即生效；桌面端是独立二进制，需要用 `dpx desktop update --<环境名>` 换上包含该修改的版本。旧 EXE 在被替换前仍会设置这两个变量（此时 `--prefix` / `--cache` 的显式写法依然有效，只是裸跑 `npm` 的默认落点仍在环境内）。环境级 `AGENTS.md` 里也写明了这条自查方法。

### 环境级 `AGENTS.md`（dpx 自动写入，所有启动方式都会读到）

创建环境时（以及每次复用/升级已有环境时），dpx 会写入并刷新：

```text
<环境根>\dsh-home\AGENTS.md
```

内容由环境自身布局生成，包含：

- **你在哪个隔离环境里运行**：环境名、环境根、`DSH_HOME`、本文件位置；
- **这个隔离环境是怎么设计的**：`npm-prefix` / `npm-cache` / `dsh-home` / `agents-home` / `home` / `appdata` / `tmp` / `xdg-*` / `workspace` / `desktop` 各是什么、哪个环境变量指向它；
- **npm 的行为**：正常 `npm install -g` 改变的是宿主全局目录、不会改变本环境，要装进本环境必须 `--prefix` + `--cache`（或 `dpx npm install`），并给出可直接复制的命令；
- **边界**：隔离只收容默认解析、不是沙箱，以及不要动其他环境。

因为 `DSH_HOME` 指向该目录，**不管环境是怎么启动的**——`dpx run --test dsh web`、`dpx run --test dsh-tui`、还是双击 `<环境根>\desktop\DSH DeepSeek Harness Desktop.exe`——DSH 都会把这同一个文件当作环境级全局指令读进来。

该文件由 dpx 托管：`<!-- dpx:environment-guide:begin … -->` 与 `<!-- dpx:environment-guide:end -->` 之间的内容会自动刷新，你自己写的全局指令放在标记块之外即可，不会被覆盖。用 `--no-desktop` 创建的环境同样会得到这个文件。

### 隔离的边界：收容「默认解析」，不是写入沙箱

`runtimeEnvironment()` 保证的是**默认路径解析**落在环境内。只要调用方不显式指定绝对路径，pnpm、DSH 与各类工具的默认读写都会落在 `<环境根>` 下：

| 资源 | 环境内位置 |
| --- | --- |
| 用户 home | `<环境根>\home`（同时作为 `HOME` / `USERPROFILE`） |
| `APPDATA` / `LOCALAPPDATA` / `TEMP` | `<环境根>\appdata`、`<环境根>\localappdata`、`<环境根>\tmp` |
| XDG 三件套 | `<环境根>\xdg-config`、`<环境根>\xdg-cache`、`<环境根>\xdg-data` |
| pnpm store | `<环境根>\xdg-data\pnpm\store` |
| DSH 状态与配置 | `<环境根>\dsh-home`、`<环境根>\agents-home` |
| npm 全局 prefix / cache | **不自动收容**：需要显式 `--prefix` / `--cache`（见上一节） |

三条命令即可确认当前的实际落点：

```powershell
pnpm store path  # <环境根>\xdg-data\pnpm\store\v11
$HOME            # <环境根>\home
npm root -g      # 宿主全局 root（%APPDATA%\npm\node_modules），不是环境内
```

但隔离的机制是**环境变量重定向**，不是文件系统边界。以下三点不在保证范围内：

| 逃逸口 | 机制 | 表现 |
| --- | --- | --- |
| 显式绝对路径 | 命令行参数优先于环境变量 | `npm install -g --prefix C:\Users\... <pkg>` 直接写入宿主；`--cache`、`--location` 同理 |
| `PATH` 是**前置**而非替换 | `env.PATH = [paths.npmPrefix, inherited.PATH]` | 环境内没有的工具会静默回落到宿主的同名二进制。环境内只装了 `dsh` 时，`dsh-tui`、`pnpm` 很可能解析到 `%APPDATA%\npm` 下的宿主副本 |
| 无写入拦截 | DPX 是环境管理器，不挂文件过滤驱动 | 拥有写权限的进程仍可写宿主任意绝对路径 |

`PATH` 前置只是让**已经显式装进环境**的二进制优先解析，并不改变 npm 的默认安装目标。想确认某个工具来自环境内还是宿主，看 `Get-Command <名字>` 解析到的路径，不要看版本号。

实践建议：

- 要往环境里装包，永远写全 `--prefix` 与 `--cache`，或用 `dpx npm install -g <包名> --<环境名>`。
- 需要真正的文件系统边界时，请在本机沙箱／容器层面实现；DPX 只负责环境身份、受控布局与默认路径收容。

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
4. 由环境 root 推导固定子路径（`npm-prefix`、`dsh-home`、`agents-home` 和已知的 TUI `bin/dsh-tui.js`），设置同样的隔离变量（`DSH_HOME` / `DSH_AGENTS_HOME` / 隔离 profile 目录；**不设置** `NPM_CONFIG_*`）后委托；
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
