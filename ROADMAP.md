# dsh-dpx Roadmap

本路线图只描述 DPX 自己创建、登记或拥有的资源的生命周期。原则是：**DPX 注册由 DPX 管，DPX 创建的环境由 DPX 显式清理；绝不要求用户手改 registry、Windows Registry 或散落的状态目录。**

> 当前状态：`dpx` 可创建、安装、运行、发现、诊断和注销隔离环境（`dpx env remove [--purge]`）。

## Milestone 6 — 运行时身份与跨环境可用性（已实现）

隔离的三个面（`PATH` / `npm-prefix` / `DSH_HOME`）以前只在 `dpx` 进程内是绑在一起的：离开 `dpx run`
之后，终端里裸敲一个命令名命中的是 `PATH` 里第一个同名文件，可能是宿主机或其他环境的那一份，
它会连带使用那套副本自己的 DSH 状态。设计文档：`dpx-隔离路径设计评审.md`。

### 实现结果

1. **环境身份变量**：`dpx run` / `dpx exec` / `dpx env use` 与桌面启动器都给子进程设置
   `DSH_DPX_ENV` / `DSH_DPX_ENV_ROOT`，并传播 `DPX_HOME`。任何进程（包括 agent 在环境内再启动的 `dpx`）
   都能直接回答“我在哪个环境里”，而不是从 `DSH_HOME` 或路径反推。
2. **`dpx which --<name> [target]`**：离线预测“会命中谁”——环境内副本（绕过 `PATH` 与 shim）、
   该目标在 `npm-prefix` 与每个 profile 中的全部副本及版本、`PATH` 上每个同名文件（标注 `winner`
   与 `inEnvironment`）、`verdict`（`clean` / `host-leak` / `not-installed`）与一行可执行的 `advice`
   （命中环境外副本时同时报出它将会使用的 `DSH_HOME`）。
3. **`dpx env doctor --<name>`**：一次输出 registry 绑定、受控布局、生成指令文件格式、当前进程身份、
   registry 归属、`PATH` 冲突、全局副本 ↔ profile 副本版本、每个 profile 的安装器与 store；
   每条结论都附带可执行修法，`error` 级问题使退出码非零。
4. **`dpx exec --<name> [--cwd <dir>] -- <命令> …`**：在环境内运行任意命令（`dpx run` 只覆盖已知启动目标）。
5. **`dpx env use --<name> --format powershell|cmd|json`**：打印可求值脚本，把“当前 shell”切进环境；
   dpx 永不修改父进程环境。脚本按“前置、不替换”的约定处理 `PATH`。
6. **`dpx plugin add --<name> <spec> [--profile <p>] [--store-dir <path>]`**：仍走 `dsh plugin`
   （以保留 pnpm 安装与 bundle 层重建），但显式传入该 profile **既有 `node_modules` 的 store**，
   把 `ERR_PNPM_UNEXPECTED_STORE` 从事后报错变成可预防；安装后回读 profile 内与全局两侧的版本。
7. **registry 在环境内仍然可达**：环境的 `LOCALAPPDATA` 被隔离，而 DPX registry 默认正落在
   `%LOCALAPPDATA%\DSH\DPX`；现在解析顺序为 `DPX_HOME` → 平台默认（若已存在 `registry.json`）→
   本机发现指针（仅当 `DSH_DPX_ENV_ROOT` 证明当前进程在环境内），使环境内的 `dpx` 看到同一份 registry。
8. **环境级 `AGENTS.md`（生成块 v2）**：新增“先确认你在哪一套里”、装载方式、dpx 通用开发规则与
   已知失败模式；生成块作为**随包发布的内容**，只包含 dpx 通用规则，路径全部来自渲染时的环境布局。

### 验收与测试

- `test/identity.test.js`：身份变量、registry 回落、`PATH` 预测、`which` 三种 verdict、
  `doctor` 的双侧版本 / `PATH` 冲突 / store 撕裂 / 旧格式指令文件 / 进程身份、
  三种格式的 `env use`（PowerShell 脚本在真实 PowerShell 中求值验证）、`plugin add` 的 store 选择、
  以及“生成块不含任何本机字面路径”（用合成环境根断言）。
- `test/cli.test.js`：`which` / `env doctor` / `env use` / `exec` / `plugin add` 的黑盒 CLI 行为与退出码。
- 手工端到端：一次性隔离环境中安装 DSH + TUI → `which` 判定宿主机泄漏 → 清空 `PATH` 后判定 clean →
  `plugin add` 真实初始化 profile 并 pin 住环境内 store → `doctor` 全绿 → `dpx run` 启动真实 DSH →
  `env use` 后 `Get-Command dsh` 命中该环境副本 → `dpx env remove --purge` 清理。

### 仍未做

- registry 级（不带 `--<name>`）的 `dpx env doctor`，用于列出所有“root 已缺失”的失效记录。

## 目标

用户应能用一个明确、可预览、可恢复边界清晰的 DPX 命令完成环境清理：

```powershell
# 仅注销：保留环境目录，便于人工检查或恢复
 dpx env remove --test

# 删除 DPX 管理的环境目录和该环境的桌面端状态
 dpx env remove --test --purge

# 先预览，不改任何文件或注册表
 dpx env remove --test --purge --dry-run
```

`dpx env remove` 是唯一推荐的 DPX 环境卸载入口。它必须同时维护 DPX registry、环境描述符和 Windows discovery pointer；用户不需要、也不应手动修改它们。

---

## Milestone 1 — 受控注销（`dpx env remove`）

### 用户接口

```text
 dpx env remove --<name> [--purge] [--dry-run] [--yes]
```

- `--<name>`：必填，精确匹配一个已注册环境；禁止模糊匹配和扫盘。
- 默认（无 `--purge`）：只从 DPX registry 注销，不删除环境目录。
- `--purge`：删除该环境根目录及其受 DPX 控制的环境内资源。
- `--dry-run`：列出将修改的 registry、Windows discovery pointer、环境目录和桌面端状态；不改任何内容。
- `--yes`：仅与 `--purge` 配合，跳过交互确认；适合自动化。无 `--yes` 时必须要求用户确认环境名和绝对路径。

### 安全规则

1. 只根据 `%LOCALAPPDATA%\DSH\DPX\registry.json`（或 `DPX_HOME`）中的精确记录操作，**绝不扫描磁盘猜测环境**。
2. 删除前验证记录格式、环境实例 ID、根路径和受控布局；registry 损坏时失败关闭，不覆盖、不重建。
3. `--purge` 只能删除由 `environmentRoot(storageRoot, name)` 推导且与已注册 record 完全一致的 root；拒绝根目录、盘符根目录、home 目录及任何路径穿越异常。
4. 对已缺失的环境根目录，仍允许注销失效记录；报告“目录已不存在”，但不得当作错误阻止 registry 修复。
5. 默认注销保留所有文件，因此可通过重新注册/人工检查恢复；`--purge` 明确告知不可逆。
6. 删除和 registry 更新必须保持锁保护与原子写入；任何失败都报告实际完成/未完成的步骤，绝不声称全部成功。

### DPX 必须管理的资源

| 资源 | 默认 `remove` | `remove --purge` | 责任 |
| --- | --- | --- | --- |
| `registry.json` 内对应环境记录 | 删除 | 删除 | **DPX** |
| 环境根 `dsh-environments/<name>/` | 保留 | 删除 | **DPX** |
| 环境内 npm/DSH/agents/cache/workspace/desktop 文件 | 保留 | 随环境根删除 | **DPX** |
| 环境内 `.dpx-environment.json` 与 `dsh-distribution.json` | 保留 | 随环境根删除 | **DPX** |
| 该环境的桌面端日志、WebView 用户数据 | 保留 | 删除 | **DPX（改造后）** |
| `HKCU\Software\DSH\DPX` discovery pointer | 仅最后一个记录移除时评估 | 同左 | **DPX** |

### Windows discovery pointer 规则

- registry 仍有至少一个环境：保持 `HKCU\Software\DSH\DPX`，并确保其 `RegistryPath` 和 `Profile=dpx.dsh.dev/v1alpha1` 正确。
- 删除最后一个环境：DPX 删除自己创建的 `HKCU\Software\DSH\DPX` 值/键；不得删除 `HKCU\Software\DSH` 下不属于 DPX 的其他内容。
- `DPX_DISABLE_DISCOVERY=1` 时，DPX 不写 discovery pointer；清理命令仍只处理可证明为 DPX 自己拥有的 pointer。

### 验收与测试

- 正常注销、purge、dry-run、`--yes`、交互拒绝。
- 已缺失 root 的注册记录可被清理。
- 非空但未注册目录、不同 storage root、格式损坏 registry、锁竞争均失败关闭。
- 删除最后一个环境/删除多个环境时 Windows discovery pointer 的行为。
- `git diff --check`、`npm run check`、包安装后的黑盒 CLI 测试。

---

## Milestone 2 — 桌面端状态完全环境化（已实现）

### 实现结果

桌面 EXE 现在将启动日志写入环境根下的 `%ENV_ROOT%\desktop-state\shell.log`，并在 Tauri 窗口创建前将 WebView2 user-data directory 设置为 `%ENV_ROOT%\desktop-state\webview2`。每个 EXE 仍只从自身位置推导环境根，不读取 DPX registry，也不依赖 `dpx` 运行时。

### 目录布局

将桌面端所有可控状态放入环境根：

```text
<environment-root>/desktop-state/
├── shell.log          # 启动器日志
├── settings.json      # 关闭行为 / 托盘开关 / 更新源 / 最近一次更新检查
├── shell.json         # 可选：启动契约（DSH 入口、启动参数、node）
├── updates/           # 更新暂存与被替换下来的旧 EXE
└── webview2/          # WebView2 user-data directory
```

- EXE 继续仅由自身路径推导环境根，不引入 DPX registry 运行时依赖。
- WebView2 user-data folder 显式设置到 `desktop-state/webview2`。
- 日志写到 `desktop-state/shell.log`。
- `dpx env remove --purge` 一次性删除这些状态，不在 `%LOCALAPPDATA%` 留下 DPX 桌面端残留。

### 验收

- 两个环境的日志/WebView2 数据互不共享。
- 删除一个环境不影响另一个环境的桌面端。
- purge 后只保留 OS/第三方不可控状态，不保留 DPX 可控桌面状态。

---

## Milestone 4 — 桌面封装独立发布通道（已实现）

desktop 启动器有独立于 DPX 发行版与 DSH 本体的版本号和发布通道，通过 GitHub
Release 分发，契约见 [`docs/desktop-release.md`](docs/desktop-release.md)。

### 实现结果

- 发布 tag 为 `desktop-v<version>`，资产为版本化 EXE、`desktop-latest.json` 清单与
  `desktop-<version>.spdx.json`（SPDX 2.3 SBOM，内容为已发布文件的 sha256 清单 +
  `Cargo.lock` / `package-lock.json` 的锁定依赖集）；
- 发布不可覆盖：`release-desktop.yml` 对已存在的**已发布** release 原样不动（草稿不算已发布，
  `gh release view` 同样看得见草稿，因此门禁判的是 `isDraft` 而不是 tag 是否存在）；
- 发布分两步且可审计：`scripts/publish-desktop-release.ps1 -Upload` 建/补 draft 资产并写
  `desktop-upload-receipt.json` 回执，`-Publish` 读回执、用 GitHub API 复核远端每个资产的
  `size`/`state`/`digest`，全部一致才 `gh release edit --draft=false --latest`；
- CI 在同一个 build job 里跑 `npm test` 与 `cargo test --locked`（后者必须 Windows runner），
  并用一次构建同时刷新 `assets\windows\*` 与发布目录；tag 的版本与包内
  `desktop-manifest.json` 不一致时直接拒绝发布，避免 npm 包里那份启动器与 Release 那份分叉；
- `dpx desktop status|check|update|install` 与桌面端托盘菜单里的“设置 → 检查更新”走同一份清单契约；
- 下载内容必须通过 `size` 与 `sha256` 校验，校验失败拒绝安装并保留原启动器；
- 更新时会先重命名正在运行的 EXE（Windows 允许重命名运行中的可执行文件），再放入新文件，并记录 `desktop/.dpx-desktop.json`；
- `desktop-state/updates/` 的旧文件在下次启动时清理；
- 发布源可用 `--source` / 设置窗口覆盖为指定 tag、自建清单 URL 或本地清单路径，便于离线验证。

### 与 DSH 本体的边界

启动器不内嵌 DSH，也不假设 DSH 的内部入口或输出格式：它读取包自己声明的
`bin`，只解析 `dsh web: <url>` 这一公开就绪行（并容忍其他回环 URL 措辞）。
因此升级 DSH 包与升级桌面封装互不影响，任一方都不需要重建另一方。

### 验收与测试

- `test/desktop-release.test.js`：源解析、版本比较、清单校验、重定向/分块/CONNECT
  代理、摘要校验失败拒绝安装、无发行版时的降级行为、本地清单离线路径、CLI 黑盒。
- `desktop-shell/src-tauri/src/update.rs`：版本比较、源解析、摘要规范化、相对资产解析。
- `scripts/build-desktop-launcher.ps1 -OutputDirectory` 产出与发布流程一致的目录，
  可在不触网的情况下用 `dpx desktop update --source <该目录>` 端到端验证。

---

## Milestone 5 — 环境之间的进程级隔离（已实现）

所有环境共用同一份桌面启动器可执行文件，因此“隔离”不能靠文件名区分，必须由启动器
自己保证。`0.1.0` 使用 Tauri 单实例插件，其互斥量与辅助窗口按 bundle identifier
（`dev.dsh.dpx.desktop`）命名，导致：

- 环境 A 正在运行时启动环境 B，B 会**立即退出**，并把 A 的窗口弹到前台；
- 按镜像名（`DSH DeepSeek Harness Desktop.exe`）排查或结束进程时会误伤其他环境；
- 启动器被强制结束后，DSH 子进程成为孤儿并继续占用该环境的会话写句柄，下一次启动
  会以 `session … is already owned by an active write handle` 失败。

### 实现结果

1. 移除 `tauri-plugin-single-instance`，改为 `desktop-shell/src-tauri/src/instance.rs`：
   互斥来自 `<环境根>\desktop-state\shell.lock` 的独占文件锁（`share_mode(0)`），
   进程以任何方式结束都由操作系统释放，不会留下死锁；
2. 同一环境的第二次启动读取 `desktop-state/instance.json` 的 `{pid, hwnd}`，
   直接还原已有窗口后退出，不启动第二个 DSH 服务；
3. `desktop-shell/src-tauri/src/job.rs`：DSH 子进程被放入
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 作业对象，启动器被强杀时子进程树一并终止，
   不再产生占用会话锁的孤儿进程；
4. 桌面端全部状态（设置、日志、instance、更新暂存、WebView2 数据）都位于
   `<环境根>\desktop-state\`，不含任何共享目录。

### 验收

- `cargo test`：`instance` 的“两个环境可各自取得（Primary）”“记录读写与撤销”、
  `job` 的创建与赋值路径。
- 手工/脚本：两个不同环境同时运行互不干扰；同一环境重复启动只还原窗口；
  强杀启动器后 DSH 子进程随之消失。
- 测试脚本只按**进程 ID** 停止进程（启动器 PID + 从 `shell.log` 解析出的 DSH 子进程 PID），
  禁止按镜像名匹配（见 `scripts\verify-desktop-shell-window.ps1` 的 `Stop-ScratchEnvironment`）。

---

## Milestone 3 — 清理诊断与维护（部分实现）

`dpx env doctor --<name>` 已实现（见 Milestone 6），覆盖的环境内检查比这里最初设想的更多。
仍未做的是**registry 级**（不带 `--<name>`）的只读体检：

```powershell
# 列出 registry 中 root 已缺失的环境
dpx env doctor

# JSON 输出，供自动化消费（`--<name>` 形式已固定输出 JSON）
dpx env doctor --json
```

检查项：

- registry record 是否符合 DPX schema；
- 环境 root、manifest、descriptor 是否存在且实例 ID 一致；
- Windows desktop launcher 是否与记录的 desktop capability 一致；
- discovery pointer 是否指向当前 DPX registry；
- 是否存在可由 `dpx env remove --<name>` 安全注销的失效记录。

`doctor` 只能报告和建议命令；任何修复仍须由显式的 `dpx env remove` 完成。

---

## 明确不做

- 不扫描任意磁盘目录来“发现”或删除 DSH 安装。
- 不删除系统 Node.js、全局 npm prefix、用户默认 `~/.dsh`、全局插件或其他产品数据。
- 不尝试清理 npm 生命周期脚本、第三方包或恶意包越界写入的任意宿主资源；DPX 环境隔离不是操作系统沙箱。
- 不在 `--purge` 中静默删除无法证明属于该 DPX environment record 的路径。
- 不自动把未注册的已有目录“接管”为 DPX 环境。

## 实施顺序

1. 先完成 Milestone 1 的安全注销、purge、预览和 registry/discovery 生命周期测试。
2. 再完成 Milestone 2，将桌面端可控状态迁入环境根。
3. 补 Milestone 4 的桌面封装独立发布通道（GitHub Release + 校验后替换），
   使“升级 DSH”与“升级 desktop 封装”彻底分离。
4. 补 Milestone 5 的进程级隔离（按环境的单实例互斥 + 子进程作业对象），
   使多个环境可以安全地同时运行。
5. 补 Milestone 6 的运行时身份与跨环境可用性（身份变量、`which` / `doctor` / `exec` / `env use` /
   `plugin add`、registry 可达性与生成块 v2），使“我在哪一套里”成为可查询事实，
   而不是需要记在脑子里的规则。
6. 最后补 Milestone 3 的 registry 级只读体检；不把诊断变成隐式修复或自动删除。
