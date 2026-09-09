# dsh-dpx Roadmap

本路线图只描述 DPX 自己创建、登记或拥有的资源的生命周期。原则是：**DPX 注册由 DPX 管，DPX 创建的环境由 DPX 显式清理；绝不要求用户手改 registry、Windows Registry 或散落的状态目录。**

> 当前状态：`dpx` 可创建、安装、运行和发现隔离环境；尚未提供删除/注销命令。直接手动删除环境根目录会在 DPX registry 留下失效记录，因此不应作为推荐卸载方式。

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
├── shell.log
└── webview2/
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

## Milestone 3 — 清理诊断与维护

新增只读诊断命令：

```powershell
# 列出 registry 中 root 已缺失的环境
 dpx env doctor

# JSON 输出，供自动化消费
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
3. 最后补 Milestone 3 的只读诊断；不把诊断变成隐式修复或自动删除。
