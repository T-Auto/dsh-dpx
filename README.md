# dsh-dpx

## 项目概览

`dsh-dpx` 是给 **DeepSeek Harness创建、安装、发现和启动多个彼此隔离环境的包管理器**。像python的uv/pip和.venv一样，将dsh主目录视为全局环境，可以在其他目录建立独立环境，便于把不稳定的开发版本和稳定的版本隔离开，以及提供dsh整合包之间的统一通讯和管理方式。

`dsh-dpx`遵循[spec](https://github.com/T-Auto/dsh-ecosystem-spec)提出的方案，统一管理各大独立dsh运行时，和所有遵循[spec](https://github.com/T-Auto/dsh-ecosystem-spec)方案的独立环境/整合包兼容。

在此之前，在默认目录安装DeepSeek Harness是：

```bash
npx @deepseek-ai/dsh web
```

tui之类的dsh插件的安装方式是：

```bash
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
```

这个命令会自动给 **全局** 的deepseek-harness安装插件。

对本项目，使用

```bash
dpx npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --envname --"D:\DevEnvs\Projects"
```

命令，就可以在"D:\DevEnvs\Projects"目录下，创建注册名为`envname`的环境，命令会建立：

```text
D:\DevEnvs\Projects\dsh-environments\envname\
├── npm-prefix\                # envname 专属的 npm 全局包与命令 shim
├── npm-cache\                 # envname 专属的 npm 下载/内容缓存
├── dsh-home\                  # envname 专属 DSH_HOME：profiles、设置、会话、存储
├── agents-home\               # envname 专属 DSH_AGENTS_HOME：agents / skills
├── home\ appdata\ localappdata\ tmp\
├── workspace\                 # dpx 启动 DSH 时的工作目录
├── dsh-distribution.json       # 环境的 dsh-distribution 描述符
└── .dpx-environment.json       # 实例身份和 DPX 注册记录的本地副本
```

之后你便可以：

```bash
# 启动 envname 环境内的 Web UI
dpx run --envname dsh web --no-open

# 启动 envname 环境内的 TUI
dpx run --envname dsh-tui
# 或
dsh-tui --test

# 将参数原样转发给 test 环境的 DSH
dpx run --envname dsh --version
```

如果你想管理建立环境的插件，你可以执行诸如

```bash
dpx npm install -g @deepseek-harness-tui/dsh-tui --test
```

就命令，在命名为`envname`的环境里安装/升级`dsh-tui`或者其他插件


## 安装 dpx

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

每次 `dpx run` 都会为子进程设置环境专属的绝对路径：

```text
DSH_HOME
DSH_AGENTS_HOME
NPM_CONFIG_PREFIX
NPM_CONFIG_CACHE
HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / TMP
```

同时会清除可能污染环境的 `NODE_OPTIONS`、`NODE_PATH`，并设置 `DSH_TELEMETRY_DISABLED=1`。网络代理变量会保留，便于 npm/DSH 按用户已有的 Clash 等代理配置联网。

TUI 首次自举会调用 DSH 的 `plugin` 子命令，而该子命令需要 `pnpm` 可在 `PATH` 中找到。若尚未安装 pnpm，请先执行：

```bash
npm install -g pnpm
# 或
corepack enable pnpm
```

## `dsh-tui --test` 统一启动体验

无论用户选择哪一种安装方式，都应优雅启动 `test` 环境的 TUI：

| 用户已有内容 | `dsh-tui --test` 应做什么 |
| --- | --- |
| 全局安装了 `dsh-tui`，但没有安装 dpx | 全局 TUI 启动器读取 DPX 发现 profile，定位 `test`，并委托给其中已安装的 TUI。 |
| 只安装了 dpx，TUI 只安装在 `test` 隔离环境 | 通过 dpx/DPX registry 定位隔离 TUI 后启动，无需全局再安装一份 TUI 包。 |
| 全局与隔离环境都安装了 TUI | 显式 `--test` 永远优先启动 `test` 的隔离副本，不混用全局 DSH state。 |
| `test` 不存在或没有安装 TUI | 输出简短、可执行的诊断和创建/安装命令，不扫盘、不猜测路径。 |

对未来的

```bash
dsh-tui --test
```

的更好支持，会在在 dsh-tui 项目中接入一个小型 DPX 兼容适配器

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

v0.1 没有自动删除环境的命令。删除 DSH state、会话或 npm cache 是不可逆操作，必须有单独设计、明确确认和恢复策略；注销环境不能默默删除用户文件。

## 项目链接

- 主仓库：https://github.com/T-Auto/dsh-dpx
- 环境协议与 conformance：[`dsh-distribution`](https://github.com/T-Auto/dsh-distribution)
