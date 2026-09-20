# dpx 插件兼容锚点

本文是 `src/index.js` 里 `PLUGIN_COMPAT` 的散文对应物：那份常量是机器可读的一半，本文解释它为什么长这样、以及插件作者该怎么用。**锚点只在一个地方定义**（`PLUGIN_COMPAT`），本文不复制它的取值——取值以代码为准。

## 1. 它回答什么问题

一个插件作者和 `dpx env doctor` 需要同一个答案：**这份 dpx 所定义的插件契约，对哪些 `@deepseek-ai/dsh` 版本有效？**

这个问题在 dpx 里比在单体桌面应用里更尖锐：dpx 的核心语义是「**一个启动器服务多个 dsh 版本**」——`dpx npm install -g @deepseek-ai/dsh@latest --<env>` 只换环境内的包，不动启动器（见 `docs/desktop-release.md`）。于是"插件是否可用"绝不能由启动器版本来回答。

## 2. 锚点是什么

| 字段 | 含义 |
| --- | --- |
| `anchorPackage` | 被约束的协调点：`@deepseek-ai/dsh`（不是启动器、不是 dpx 自身） |
| `dshRange` | 声明"**读过并且验证过**"的 dsh 版本区间（npm semver range 语法） |
| `minimum` | 区间下界，用于人类可读的结论文案 |
| `protocolVersion` | **dpx 自己的**插件契约协议号，从 1 开始；只在破坏性变更时递增 |
| `target` | 插件作者解析版本时使用的 `dpx run` 目标名（`dsh`） |
| `forbiddenAnchor` | 明文写出**不许**用哪个东西做锚点，以及理由 |

**判定用 `pluginCompatible(version)`**，它按 semver 区间语义实现，且对读不出/非法的版本返回 `false`（而不是"默认兼容"）——未知永远不等于兼容。

## 3. 明文禁止：不要用桌面启动器版本号做锚点

理由有三条，任何一条单独成立就足够：

1. dpx 的启动器与 dsh **故意解耦、各自独立版本化**（`docs/desktop-release.md`：「Upgrading DSH never needs a new launcher, and upgrading the launcher never touches DSH.」）。
2. 用启动器版本做锚点，等于把两者**重新绑死**成"共资格（co-qualification）"——那正是官方桌面端为单一发行号付账的机制，而 dpx 存在的意义恰恰是不要它。
3. 官方已书面预留 **`.dsk.N` 独立修订**（`.agents/notes/proposed/feature/2026-09-08-desktop-update-extensions.zh.md`），一旦落地就会出现「同一 dsh 版本、多个 desktopVersion」。届时按启动器版本做 peer 约束的插件会**误判不可用或误判兼容**。

所以插件的兼容锚点应当是：**`@deepseek-ai/dsh` 版本区间 + 本文件声明的 `protocolVersion` + 运行期能力探测**（三者取交），永远不含桌面端版本号。

## 4. 为什么不写进 `dsh-distribution.json`

那个描述符的 schema 是 `additionalProperties: false`（`spec/dsh-distribution/packages/core/schema/descriptor.schema.json`），**多一个顶层键就是协议违规，不是扩展**。锚点因此不走描述符，而由两个既有出口暴露：

- `dpx descriptor --<env>`（该命令本来就拥有这份输出）；
- `dpx env doctor --<env>` 的 `plugin-compat` 检查。

## 5. `dpx env doctor` 的四种结论

检查项 id 是 `plugin-compat`，每种结论都带一条可执行的 `fix`：

| 情况 | 结论 | `fix` |
| --- | --- | --- |
| 环境内没有安装 `@deepseek-ai/dsh` | `ok`（锚点暂不适用） | `dpx npm install -g @deepseek-ai/dsh --<env>` |
| 装到了，但版本读不出来（文件损坏） | `error`（附损坏原因） | 重装该包 |
| 版本落在 `dshRange` 内 | `ok` | — |
| 版本不在区间内 | `error` | `dpx npm install -g @deepseek-ai/dsh@<区间内版本> --<env>` |

**"不在区间内"是"未验证"，不是"一定不能用"。** 这个区别很重要：dpx 只能声明自己验证过什么，不能替上游禁止什么。doctor 的职责是把事实与建议摆出来，让人决定。

## 6. 插件作者的最小实践

1. **peer 约束写 dsh 版本区间**，不写 dpx 版本、更不写桌面端版本。
2. **声明你需要的协议号**（`PLUGIN_COMPAT.protocolVersion`）；运行期发现协议号不认识时**整块不挂载**，不要"尽力而为"。
3. **能力探测优于版本嗅探**：需要某个上游导出时先探测它在不在（`dpx env repair` 就是这么做的——见 `src/index.js` 的 `probeAppBoot`），拿不到就走等价降级或明确报错。
4. **不要把状态写在 `$DSH_HOME` 之外**（未配置的路径不受"卸载保留用户数据"的承诺保护）。
5. 发布前用 `dpx env doctor --<env>` 核对锚点结论，而不是靠 README 里的版本表。

## 7. 与上游坐标的对应关系（供对照，不是我们的契约）

官方桌面端用两个数字隔离自己的边界：壳与宿主之间的 `DESKTOP_HOST_PROTOCOL_VERSION`（代际号）与产品文档 API 的 `protocolVersion`。dpx 借用的是**同一种做法**（一个代际数字 + "不认识就不挂载"），但**取值与语义完全由 dpx 自己拥有**，与官方那两个数字没有对应关系，也不要互相换算。

## 8. 变更规则

- 递增 `protocolVersion` **只在**插件契约发生破坏性变更时；递增时必须同步更新本文与 `docs/desktop-release.md` 的相关措辞。
- 扩大 `dshRange` 表示"我们又验证了更新的 dsh"，缩小它表示"我们不再保证"；两者都必须在提交信息里写明依据（跑过哪些验证）。
- 本文不复制 `PLUGIN_COMPAT` 的取值——取值改动只发生在 `src/index.js`，本文只解释规则。
