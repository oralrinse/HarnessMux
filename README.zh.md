# agent-bridge

**两个编码 agent，一个邮箱——而且投递保证能扛住崩溃。**

`agent-bridge` 让同一台机器上的两个编码 agent 互相说话：一个指导，一个执行，双方都能追问。
它是为 [OpenAI Codex](https://github.com/openai/codex) ⇄ [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（DSH）做的，但传输层与 agent 无关：协议就是一堆 JSON 文件，任何能读写文件的进程都能加入。

[English](README.md) | 中文

---

## 为什么要这么做

你想让 Codex 指挥 DSH 干活，又不想自己当传声筒。而显而易见的做法都行不通，这决定了整个设计：

| 障碍 | 后果 |
|---|---|
| 运行中的 Codex 会话无法被外部进程注入（[openai/codex#33556](https://github.com/openai/codex/issues/33556)） | 协议层不能假设"推送"，投递必须是拉取式的 |
| 运行中的 DSH 会话同样无法被外部注入（每进程随机 launch token） | 只有**进程内插件**能唤醒会话，所以两端各需一个插件 |
| agent 只在人按下回车时才动 | 消息必须能安全地等待，且等待期间绝不丢失 |

于是设计干净地拆成两半：

- **协议**让"等待"是安全的（持久、可认领、可审计）；
- **各宿主的插件**让"唤醒"成为可能（进程内、尽力而为）。

## 你会得到什么

- **消息不可变，投递与消息分离。** 消息是"说 了什么"，投递是"正在交给谁、进行到哪"。一条消息可以扇出给多个接收方，重试是**同一条投递**上的新 attempt。
- **诚实声明的 at-least-once。** `queue → claim(租约) → ack`。握手成功与写 ack 之间的崩溃窗口是**被写进文档、被测试、并被重投**的：**duplicate but not lost**。不假装 exactly-once。
- **显式路由。** `actor / endpoint / session / thread` 严格区分。未绑定的线程保持 `awaitingBinding`——桥**绝不猜**你指的是哪个会话，也绝不广播。
- **信任分级。** `advisory`（对方输入是上下文，不是权威）与 `delegated`（受委托要执行）。由 binding/投递决定，不由正文决定。
- **可审计的迁移。** v1 桥导入时 legacy id 原样保留、v1 `read/` 绝不伪装成 v2 的 ack、副本冲突即中止、重复运行零变更。
- **核心与 DSH 插件零运行时依赖。** Node ≥ 22。

## 快速开始

```sh
git clone <本仓库> agent-bridge
cd agent-bridge
node lib/mailbox-v2.mjs --root ./bridge init
npm test                       # 8 套测试，不需要网络、不需要 API key
```

发一条消息并看它被投递：

```sh
node lib/mailbox-v2.mjs --root ./bridge endpoint --id dsh-endpoint --actor dsh
node lib/mailbox-v2.mjs --root ./bridge send --from codex --topic "ship it" --body "run the suite"
node lib/mailbox-v2.mjs --root ./bridge bind  <threadId> --endpoint dsh-endpoint --session <sessionId> --mode delegated
node lib/mailbox-v2.mjs --root ./bridge inbox --actor dsh
```

让一个**活着的**会话验证完整闭环（`<sessionId>` 是宿主报告的会话 id；DSH 下就是 `$DSH_SESSION_ID`）：

```sh
node tests/ask-session.mjs <sessionId> --marker HELLO-1
# 目标会话正在跑回合时，状态会从 queued 变成 acked
```

投递会落在"该会话在 pump 跳动（每 10 秒）时仍在运行"的那个回合里。如果会话是空闲的，投递会正确地等在 `queue/`——见[限制](#限制)。

## 装进 DeepSeek Harness

插件是一个 DSH profile bundle（由你的 profile patch 挂载的 Cordis 插件）：

```sh
node scripts/install.mjs --dsh-profile desktop     # 改写 package.json + cordis.patch.yml
# 然后重启 harness：已挂载的插件不会热重载
```

`--dry-run` 只打印计划，`--print-only` 打印等价的手工步骤。安装器只改你的 profile、写 `.bak-<时间戳>` 备份、且可重复运行。

装好后在会话里确认：让 agent 跑 `mailbox action=status`。它应该回 `protocol: v2 … invariants=ok`，而不是 v1 的计数器。

## 接上 Codex

`plugin-codex/` 是一个 Codex 插件（skills + 可选的钩子模板），并在 `.agents/plugins/marketplace.json` 提供本地 marketplace：

```sh
codex plugin marketplace add <本仓库路径>
codex plugin add agent-bridge@agent-bridge
```

那个 skill 教 Codex 何时该读、何时该回；即使不装，也仍然可以通过上面的 CLI 完成一切。

## 目录结构

```
lib/core-v2.mjs     协议 v2：消息、投递、认领、ack、路由、不变量
lib/mailbox-v2.mjs  v2 CLI（send/reply/deliver/inbox/claim/ack/release/verify/…）
lib/core.mjs        协议 v1（保留用于迁移与回滚）
lib/mailbox.mjs     v1 CLI，迁移器会用到
lib/migrate.mjs     v1 → v2 导入（带审计规则）
plugin/             DeepSeek Harness 宿主插件（工具 + 简报 + 投递 pump）
plugin-codex/       Codex 插件（清单、skill、钩子模板）
scripts/install.mjs DSH profile 安装器
docs/protocol.md    线格式与它的不变量
docs/cutover.md     如何把线上桥从 v1 切到 v2
docs/REPORT-*.md    一次真实 cutover，含证据与它挖出的缺陷
DESIGN.md           完整设计、评审裁定、以及未决问题
tests/              测试套件（见下）
```

## 测试

```sh
npm test          # 8 套：协议、CLI、迁移、插件、故障注入——全部离线
npm run test:live # 对真实 DSH harness + 真实模型（需要装好 DSH）
```

| 套件 | 固定住什么 |
|---|---|
| `mailbox.test.mjs` | v1 协议回归 |
| `protocol-v2.test.mjs` | 状态不变量 + 故障注入 T1–T15 |
| `cli-v2.test.mjs` | CLI 表面与退出码（0/1/3/4/5） |
| `migrate.test.mjs` | legacy id、`read/` ≠ ack、冲突即停、幂等 |
| `manifest.test.mjs` | DSH bundle 契约，以及测试绝不碰 root 缓存 |
| `plugin.test.mjs` | provider 可见的工具描述符、output 契约、注入消息的 id |
| `plugin-v2.test.mjs` | claim→steer→ack、失败即释放、会话隔离、unrouted 安全 |
| `cutover-faults.test.mjs` | V4-3/V4-4/V4-4b：steer 失败、崩溃窗口、长租约重启 |

## 限制

部署前请读。这些是宿主的性质，不是本项目要修的 bug。

1. **没有 idle 唤醒。** 只有目标会话**正在运行**时才会投递（实测：全空闲时投递在 `queued` 停留 45 秒）。能力表述：*运行中的会话 → 近实时注入；空闲会话 → 投递等到该会话下次运行为止。*
2. **恢复受租约约束。** 崩溃后，未 ack 的投递要等租约到期才重投（租约有效期内不会提前重投——这是刻意的）。
3. **插件改动不会热重载。** 改插件或其配置需要重启 harness。诊断可用 `debugLog` 配置项，它能让运行中的应用写跟踪文件。
4. **投递不是任务。** `ack` 的含义是"宿主已接受本次交接"。需要业务级幂等，请自带 `taskId`。

## 安全

邮箱内容由另一个 agent 写入，而它自身可能已被不可信输入影响。把它当作同伴的请求，而不是权威：

- 会话里的人类指令**永远**高于邮箱内容；
- `advisory` 投递是上下文，只有 `delegated` 才是工作指令；
- 破坏性、涉及凭据、或对外的操作仍需人类批准；
- 绝不往桥里写密钥——审计流会永久保留每一条消息。

## 许可

MIT — 见 [LICENSE](LICENSE)。
