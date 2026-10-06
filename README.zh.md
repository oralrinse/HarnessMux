# HarnessMux

> **用你已经在用的 AI 客户端，直接控制 DeepSeek Harness。**
>
> 面向 AI 客户端与 DeepSeek Harness 的「插件优先」互操作层。

```text
Codex • Claude Code • Cursor • VS Code / Copilot • MCP 客户端
                          │
                          ▼
                       HarnessMux
                          │
                          ▼
                   DeepSeek Harness
```

- ✓ **插件优先** —— 装进 harness、装进你的客户端，完成
- ✓ **面向已存在的活动会话** —— 能送到你已经打开、正在用的 DSH 会话
- ✓ **持久投递** —— 没人在跑时到达的消息会被**留下**，而不是丢掉
- ✓ **会话级路由** —— 由一条明确的 binding 决定目标，绝不靠猜
- ✓ **抗崩溃** —— at-least-once，崩溃窗口已被测试：**duplicate, not lost**
- ✓ **离线/异步** —— 报告、提问、通知都能走这条线，不只是派活
- ✓ **agent 之间不再靠人复制粘贴**

[English](README.md) | 中文

---

## 它解决什么

你已经习惯待在某一个 AI 客户端里，而你要做的活在 DeepSeek Harness 里。这个项目把两者接起来，让你不必当传声筒：

| 你的诉求 | 它提供 |
|---|---|
| 在编辑器/CLI 里直接指挥 DSH 干活 | 你的客户端可以调用的 mailbox 工具 |
| 合上电脑或崩溃后指令还在 | 带租约、重试与审计流的持久投递 |
| 送到你**此刻开着**的那个会话 | 活动会话投递，由明确 binding 指定目标 |
| 会话之间互不串味 | `actor / endpoint / session / thread` 严格区分；未绑定就保持未绑定 |
| 让同伴 agent 反过来问你 | 双向线程；回复留在同一 thread |
| 同时保证安全 | `advisory` / `delegated` 信任分级，由 binding 决定 |

### 与「worker 编排器」的区别

外部编排器的做法是：派一个任务，然后**启动并管理一个 worker** 去跑。

> 与 worker 编排器不同，本项目能把消息投递到**已存在的** DeepSeek Harness 会话，而不是要求每个任务都必须跑在新拉起的 worker 里。

由此带来几个只有这种设计才有的性质：目标可以是**人正在看着**的会话；回合进行中到达的工作会并入该回合；什么都没在跑时到达的消息会**等待**并在该会话下次运行时送达；同一套底座也承载离线通知与提问，而不只是任务派发。托管 worker 模式计划作为**并列的另一种模式**（P5），不是替代品。

## 状态：哪些已验证，哪些没有

已在真机 + 真实模型上端到端验证（[完整报告](docs/REPORT-p0.5-cutover.md)）：

| 能力 | 状态 |
|---|---|
| 投递进**运行中**的 DSH 会话（claim → steer → ack，恰好一次） | ✅ 已验证 |
| 会话路由：被绑定的会话收到，另一个活动会话收不到 | ✅ 已验证 |
| 未绑定投递绝不被消费（`awaitingBinding`） | ✅ 已验证 |
| 握手成功与 ack 之间崩溃 | ✅ 已验证：**duplicate, not lost** |
| 租约恢复、重试退避、watcher 单例 | ✅ 已验证 |
| v1 → v2 迁移：legacy id 保留、`read/` 绝不变成 ack、幂等 | ✅ 已验证 |
| provider 侧工具契约（模型真的会调用该工具） | ✅ 已验证 |

诚实的边界——部署前请读：

| 边界 | 说明 |
|---|---|
| **没有 idle 唤醒** | 只有会话在运行时才会投递。空闲会话不会被唤醒，投递会等待。*运行中 → 近实时；空闲 → 等它下次运行。* |
| **不是 exactly-once** | 传输层按设计是 at-least-once，消费方需容忍重复的 deliveryId。 |
| **Codex 之外的客户端** | **计划中**，尚未支持（P3.3/P3.4）。每个都要按 Codex 的标准验证过之后才会列进上表。 |
| **只有一个 receiver** | DeepSeek Harness 是唯一已实现的 receiver。Receiver 接口只是规范，尚未落地（[receiver-api.md](docs/receiver-api.md)）。 |

## 快速开始

```sh
git clone <本仓库> agent-interlink
cd agent-interlink
node lib/mailbox-v2.mjs --root ./bridge init
npm test                       # 8 套测试，离线，不需要 API key
```

发一条消息并看它被投递：

```sh
node lib/mailbox-v2.mjs --root ./bridge endpoint --id dsh-endpoint --actor dsh
node lib/mailbox-v2.mjs --root ./bridge send --from codex --topic "ship it" --body "run the suite"
node lib/mailbox-v2.mjs --root ./bridge bind  <threadId> --endpoint dsh-endpoint --session <sessionId> --mode delegated
node lib/mailbox-v2.mjs --root ./bridge inbox --actor dsh
```

让一个**活着的**会话验证闭环（`<sessionId>` 是客户端/harness 报告的会话 id；DSH 下为 `$DSH_SESSION_ID`）：

```sh
node tests/ask-session.mjs <sessionId> --marker HELLO-1
# 该会话跑回合期间，状态从 queued 变成 acked
```

投递落在"pump 跳动（每 10 秒）时该会话仍在运行"的那个回合里。会话空闲时它会正确地等在 `queue/`——见上面的边界。

## 装进 DeepSeek Harness

receiver 是一个 DSH profile bundle（由 profile patch 挂载的 Cordis 插件）：

```sh
node scripts/install.mjs --dsh-profile desktop     # 改写 package.json + cordis.patch.yml
# 然后重启 harness：已挂载的插件不会热重载
```

`--dry-run` 只打印计划，`--print-only` 打印等价手工步骤。安装器只改你的 profile、写 `.bak-<时间戳>` 备份、可重复运行。

装好后在会话里确认：让 agent 跑 `mailbox action=status`，应回 `protocol: v2 … invariants=ok`。

## 接入客户端

任何支持 MCP 的客户端都从**同一个共享 server** 拿到邮箱工具：

```sh
node packages/mcp/server.mjs            # stdio；由客户端的 MCP 配置拉起
```

```jsonc
// 客户端配置需要的内容——必须是绝对路径，因为 MCP 客户端不会在这里解析包名
// （packages/portable-plugin/index.mjs 可以直接帮你打印这段）
{
  "mcpServers": {
    "harnessmux": {
      "command": "node",
      "args": ["<仓库>/packages/mcp/server.mjs"],
      "env": { "HARNESSMUX_DIR": "<桥根目录>", "HARNESSMUX_ACTOR": "client" }
    }
  }
}
```

每个客户端看到的 8 个工具 —— `send_message`、`read_messages`、`reply_message`、
`list_threads`、`list_endpoints`、`list_sessions`、`bind_thread`、`get_status` ——
全部调用同一个 protocol-v2 核心，因此**任何客户端都不可能看到不同的 `ack`/delivery/lease/binding 语义**。
它们的契约（工具名、schema、错误语义、以及在同一 v2 状态下的行为一致性）由
`tests/mcp-contract.test.mjs` 固定。

**Codex** —— `packages/adapter-codex/` 提供 Codex 清单、skill 与可选钩子模板，并带本地 marketplace：

```sh
codex plugin marketplace add <本仓库路径>
codex plugin add harnessmux@harnessmux
```

**Claude Code、Cursor、VS Code / Copilot** —— 计划中的 adapter（P3.3/P3.4）。它们复用同一套 MCP 工具，
因此工作量是一个 manifest + 一层薄 adapter，而不是再写一个客户端实现。

**其它任何东西** —— CLI 是一等公民，不是降级方案：它是调试路径、CI 路径，也是那些本项目永远不会为其写插件的语言与客户端的集成路径。

## 目录结构

```
packages/core/            协议 v1 + v2 + 迁移（平台无关，零依赖）
packages/cli/             harnessmux CLI（send/reply/deliver/inbox/claim/ack/verify/…）
packages/mcp/             所有客户端共用的 MCP 工具层
packages/portable-plugin/ 共享客户端资产：skill、MCP 注册模板、路径解析
packages/adapter-codex/   Codex 客户端插件（清单、skill、钩子模板）
packages/receiver-dsh/    DeepSeek Harness **receiver**（工具 + 简报 + 投递 pump）
docs/positioning.md       项目是什么、以及刻意不声称什么
docs/roadmap.md           阶段、规划中的仓库结构、未决决策
docs/receiver-api.md      receiver 接口 + 能力模型（规范）
docs/adr/                 带推理过程的决策记录（例如为何手写 MCP）
docs/protocol.md          线格式与它的不变量
docs/cutover.md           如何把线上桥从 v1 切到 v2
docs/REPORT-*.md          一次真实 cutover，含证据与它挖出的缺陷
DESIGN.md                 工程记录与评审裁定
examples/live/            现场探针与实地诊断（需要真实 harness）
tests/                    测试套件（见下）
tools/relink.mjs          目录搬迁后修复相对引用
```

## 测试

```sh
npm test          # 9 套：协议、CLI、迁移、receiver、MCP 契约、故障注入
npm run test:live # 对真实 DSH harness + 真实模型（需要装好 DSH）
npm run mcp       # 手工启动 MCP server，检查工具清单
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
| `mcp-contract.test.mjs` | 客户端可见的工具清单、schema、报文信封与错误语义 |
| `cutover-faults.test.mjs` | steer 失败、崩溃窗口、长租约重启 |

现场探针与安装器都从环境变量解析宿主，因此仓库里不写死任何机器：设 `DSH_CLI`（launcher 路径）或 `DSH_INSTALL_ROOT`（安装目录），以及 `HARNESSMUX_CWD`（探针会话使用的工作区）。

pre-commit 钩子会阻止"开发机绝对路径"与"凭据"进入本仓库历史：

```sh
sh scripts/install-hooks.sh    # 每个 clone 执行一次（钩子不受版本控制）
```

## 安全

邮箱内容由另一个 agent 写入，而它自身可能已被不可信输入影响。把它当作同伴的请求，而不是权威：

- 会话里的人类指令**永远**高于邮箱内容；
- `advisory` 投递是上下文，只有 `delegated` 才是工作指令；
- 破坏性、涉及凭据、或对外的操作仍需人类批准；
- 绝不往桥里写密钥——审计流会永久保留每一条消息。

## 许可

MIT — 见 [LICENSE](LICENSE)。
