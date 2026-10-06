# harnessmux — 项目方案（工程记录）

> ⚠️ **定位已更新（2026-10-06，本轮）。** 本文档的**定位表述**已被取代，**工程结论与技术事实不变**。
>
> | | |
> |---|---|
> | **旧定位（本文档原文）** | Codex ⇄ DeepSeek Harness 的双向桥；"其他应用也能调用 DSH"是附注 |
> | **新定位** | **用你已经在用的 AI 客户端控制 DeepSeek Harness** —— 面向多客户端（Codex / Claude Code / Cursor / VS Code·Copilot / 通用 MCP）的**插件优先互操作层**，DeepSeek Harness 是当前的 **Native Receiver** |
> | **改变原因** | P0.5 真机验证证明了"消息可送进**已存在的活动 DSH 会话**"这一性质，而它与具体客户端无关；继续以某个客户端命名会让第二个客户端看起来像一次分叉，也会掩盖真正差异化的能力（活动会话 + 持久投递 + 会话级路由 + 崩溃恢复） |
>
> **权威文档（本节之后的表述以它们为准）**：
> - [`docs/positioning.md`](docs/positioning.md) —— 项目是什么、承诺什么、**刻意不承诺**什么
> - [`docs/roadmap.md`](docs/roadmap.md) —— 阶段（P3 更名与拆分）、规划目录结构、未决决策
> - [`docs/receiver-api.md`](docs/receiver-api.md) —— Receiver 接口与 capability model（**规范，尚未落地**）
> - [`docs/REPORT-p0.5-cutover.md`](docs/REPORT-p0.5-cutover.md) —— 真机证据与已修缺陷
>
> **本轮明确未改动**：协议 v2 语义（`ack`/delivery/lease/binding/at-least-once）、迁移规则、DSH receiver 的运行时实现、任何现有回归测试。
>
> 状态：核心库、CLI、DSH receiver、Codex 客户端插件清单已实现并通过自动化测试；MCP 工具层、peer 适配器、其他客户端 adapter 为设计待实现（每节都标注状态）。
> 文档中所有"已核实"的结论都附本机实测证据（命令 + 结果），"推断"一律标注。

---

## 0. 停点状态（2026-10-06，供续做）

**已完成并验证**
- 协议核心 + CLI + 三套测试（`mailbox` 12 断言 / `manifest` 打包契约 / `plugin` 含输出契约与 dispose）全绿。
- DSH 侧插件**已在真实 DSH 进程装载**：`dsh --profile acp` 探针从"装载被跳过"→"工具注册被拒"→**进入执行阶段**，逐层暴露并修掉了 3 个真实缺陷（见 6.0 与 §12 缺陷清单）。
- 两个 profile（`desktop`、`acp`）都已接线：`dependencies` 指向 `…/harnessmux/plugin`、`bundles` 已含 `@local/harnessmux`、`cordis.patch.yml` 有 insert 行；真实邮箱在 `default-workspace\.harnessmux`。
- Codex 侧插件清单与 SKILL 已写好（`.codex-plugin/plugin.json`、`skills/harnessmux/SKILL.md`、`hooks/hooks.template.json`、`.agents/plugins/marketplace.json`）。

**未完成（续做顺序）**
1. **重跑 `tests/acp-live-probe.mjs`**：确认 `mailbox` 工具这次真的出现在模型工具集里，并观察到自动唤醒（`agent_thought_chunk` 里出现桥消息内容）。工具契约已修好但**修复后尚未再跑探针**——这是唯一未闭合的验证环。
2. **在真实桌面端挂载**：`~/.dsh/profiles/desktop` 的接线已就位，但运行中的 `DeepSeek Harness.exe` 仍需**重启**才会加载插件（本会话尚未重启，避免打断进行中的工作）。
3. Codex 侧真机安装验证（`codex plugin marketplace add` + `codex plugin add`）。
4. MCP 服务器、peer 适配器、README/dsh-setup/codex-setup 文档、examples/demo。

**已知未决策**：DESIGN Q1–Q6（尤其 Q1 是否存在唤醒手开 Codex 桌面会话的机制、Q3 Codex 侧巡检用哪个钩子）。

---

## 0.1 端到端验证结果（2026-10-06，实测）

真实进程 + 真实模型，全链路闭环：

| 步骤 | 证据 |
|---|---|
| 插件在真实 ACP profile 装载 | `dsh --profile acp` 的 `session/new` 成功，再无 `skipping profile bundle` / 注册被拒告警 |
| `mailbox` 工具进入模型工具集并被调用 | 探针观测到 `tool_call mailbox in_progress` → `tool_call_update completed` |
| 模型**无需提示**即知道桥存在 | 提示词只问"Do you have anything waiting from the peer agent right now?"，从未提到 mailbox/harnessmux |
| 模型主动读取未读消息 | 回答原文引用了两条消息正文，含标记 `ZEBRA-917` |
| 模型主动回执且线程正确 | 生成 `…-84bd2f9e`，`dsh -> codex (report)`，`replyTo=…-d80ae6b2`，`threadId=autonomous-check-cd3ea2d1` |
| Codex 侧可读到该回执 | 邮箱状态 `pendingByActor: { codex: 1 }`，`read --actor codex --peek` 打出完整回执 |

**结论**：`Codex 写指令 → DSH 自动看到并执行 → 回执回流 Codex` 这条主链路**已被真机验证**（在 ACP 形态下；桌面端只差一次重启）。

### 本轮修掉的工具契约阻塞（审查未发现，但它是当时唯一真正的阻塞）

`ctx.tools.register` 不做 schema 编译：直接注册"每属性规格"会让 provider 侧的函数 schema 缺
`type: "object"`，首个 turn 即失败：

```
Internal error: turn failed: Invalid schema for function 'mailbox':
schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

修法：插件内实现 `compileParameters()`，按 `defineTool` 已确证的编译规则（源码
`parameterSchemaSpecToJsonSchema`）生成 `{type:"object",properties,required[]}`，保持零依赖；
并由 `tests/plugin.test.mjs` 断言 `parameters.type === "object"` 与"属性内不得残留 inline required"防回归。
另：`output` 契约同批修复（注册器要求 `output{schema,render}`，且 `execute` **返回的值**必须符合该 schema）。

---

## 0.2 对 Codex 评审的裁定（哪些成立、哪些不成立、哪些用本机证据改写）

评审的整体判断（方向对、协议可靠性不足、先别急着扩面）**成立且有价值**。逐条裁定：

| # | 评审主张 | 裁定 | 依据 / 处置 |
|---|---|---|---|
| R1 | 消费是 destructive receive，崩溃会丢消息（已标记消费但业务未消费） | ✅ **成立，最高优先级** | `read` 直接 `inbox→read` 移动，无 ack 阶段。改为 `pending→claimed→acked` + `claimOwner/leaseUntil/attempt`，实现 at-least-once |
| R2 | 不能用 cursor 承担消费正确性（同毫秒随机后缀可永久跳过） | ✅ **成立** | 我的 id 是"时间戳+32bit 随机"，同毫秒内随机序，游标前进后低序消息会被永久跳过。改为"目录状态=权威，cursor 仅扫描优化" |
| R3 | `inbox`/`read`/`log` 三份副本带来事务缺口 | ✅ 成立（程度中等） | `writeJson(inbox)` 与 `writeJson(log)` 之间崩溃则 log 不再"保存每一条"。改为 immutable `messages/<id>.json` 单一正文 |
| R4 | C3 过时：Codex 插件支持 MCP server / 插件内 hooks | ✅ **成立，已用本机证据改写** | `codex.exe` 字符串：`mcp.json`×12、`hooks/hooks.json`×1、`plugin.json`×78、`.codex-plugin`×25。原 C3 表述过窄 |
| R5 | 因此 MCP 应成为 Codex 侧的工具层，Skill 不必教 CLI 参数 | ✅ 成立 | 直接工具比"让模型记住 CLI 参数"稳。P3/P4 合并为"Codex 插件内置 MCP" |
| R6 | 主架构改为两通道：Managed(MCP→ACP) + Async mailbox | ✅ 成立，与原方案不冲突 | 原 §7 已把 ACP 列为入口，只是没当主干。两条路都已本机验证可行（ACP 探针 + 邮箱闭环） |
| R7 | 不用改全局 `~/.codex/hooks.json`，改用插件内 `hooks/hooks.json` | ✅ 成立 | 见 R4 证据；卸载/版本隔离/trust 都更好 |
| R8 | 巡检用 `SessionStart + UserPromptSubmit`，`PreToolUse` 不宜作主轮询 | ⚠️ **部分成立** | "高频轮询会刷上下文"成立；但**手开 Codex 会话在 idle 时任何钩子都无法唤醒**（C1 仍成立，评审自己也承认），所以这只能改善"有活动时"的时延 |
| R9 | `steer()` 在 idle 时会唤醒并起一个 turn（故 DESIGN 那句"非 running 被忽略"过时） | ❓ **未验证，暂不改** | 我无本机证据（官方 Agent API 文档不在 asar 内）。已记为待验证项 V1；在我用真实 idle agent 复现前不改文档结论 |
| R10 | actor ≠ session：多 DSH 会话时 `to: dsh` 路由不确定，会污染其他会话 | ✅ **成立，第二大结构问题** | 协议只有 `from/to`。需引入 `actor / endpoint / session / thread` 四层 + 显式绑定；默认改为**专用 bridge executor 会话**，不往人类当前会话随机塞外部指令 |
| R11 | MCP 用官方 SDK，不手写 JSON-RPC；core 保持零依赖 | ✅ 成立 | 依赖边界："核心零依赖，适配器可用官方 SDK"。Q4 采纳 SDK（包可用性待验，见 V2） |
| R12 | 安全不足：需要 advisory/delegated 两级信任，而非只靠提示词 | ✅ **成立** | "人类优先"是给模型的 instruction，不是 capability boundary。`instruction` 类消息默认不得在当前会话自动触发工具；delegated 才交沙箱+审批策略约束 |
| R13 | `log/ 永不删除` 与"禁止写 secret"冲突，需要可配置保留 + `gc` | ✅ 成立 | 改为 `audit{enabled,retentionDays,maxBytes}` + `harnessmux gc` |
| R14 | id 随机后缀仅 32bit，建议 UUIDv7 | ✅ 成立（低风险但改动便宜） | 换 UUIDv7；**同时明确**：顺序不再用于正确性（与 R2 配套） |
| R15 | 示例消息 `replyTo` 指向自己 | ✅ 成立（文档笔误） | 已在 §5 修正说明；实现侧本就只在回复时写该字段 |
| R16 | 阶段重排：P0.5 协议改造 → P2 真机 gate → P3 portable plugin → P4 ACP controller | ⚠️ 顺序部分不采纳 | P2 的真机 gate **本轮已完成核心部分**（见 §0.1），剩下的只是桌面端重启；因此 P0.5 与"桌面端收尾"应并行，而不是先停 P2 |
| R17 | 补 T1–T15 故障注入验收（崩溃点、双 reader、时钟回拨、损坏 JSON 等） | ✅ 成立 | 这批比再加普通断言有价值，纳入 P0.5 的验收清单 |
| R18 | 评审未提及：工具 schema 契约（parameters 编译、output{schema,render}） | ⚠️ **评审遗漏的真实阻塞** | 见 §0.1；它是本轮唯一挡住"工具可用"的问题 |

**评审没有推翻的东西**：协议中立、宿主插件分离、外部入口分层的抽象；以及"mailbox 继续保留"这一结论 —— 评审明确建议把它从"唯一主干"降级为"异步耐久通道"，而非删除，这与已完成的 P0/P1 不浪费一致。

---

## 0.3 协议 v2 —— 冻结设计（2026-10-06 定稿，P0.5 实施依据）

v2 的据本判断：**消息（说了什么）与投递（送给谁、送到了没）是两层状态**。把两者压在同一个 id 上，
路由一多（同一正文发给 desktop 会话 + 审计端点，或一条投递重试三次）状态就会互相污染。

### 0.3.1 六条冻结决定

| # | 决定 | 含义 |
|---|---|---|
| D1 | **messageId ≠ deliveryId** | `messages/<messageId>.json` 是 immutable 正文；`queue/`、`claims/`、`acks/` 只存 delivery 记录，且**只引用** `messageId`。一条 message 可派生多条 delivery（不同 endpoint/session），一条 delivery 可多次 attempt。 |
| D2 | **ACK = 宿主已接受本次投递**，不是"模型已完成任务" | 例如 `agent.steer()` 成功返回即可 ack。崩溃发生在 steer 成功、ack 之前 → 允许重复投递，这是 at-least-once 的正常边界，不是缺陷。 |
| D3 | **路由状态不进 immutable message** | `actor` / `endpointId` / `sessionId` 属于 delivery 与 binding；只有 `threadId` 属于逻辑对话、可以进 message。 |
| D4 | **advisory / delegated 放在 binding / delivery 上** | 信任级别由"这条消息经哪个通道进入哪个 session"决定，不由正文天然决定。同一条 message 可对 A 会话是 advisory、对受管 executor 是 delegated。 |
| D5 | **cursor 彻底退出 correctness** | 可保留作扫描优化/观测指标，但**任何消息都不得因 `id <= cursor` 而失去投递资格**。 |
| D6 | **ID 用 `crypto.randomUUID()`（零依赖优先）** | UUIDv7 可用但不承担正确性；排序交给 `createdAt`，去重交给 `messageId`/`deliveryId`。 |

### 0.3.2 目录布局与状态机

```
<bridge-root>/
  bridge.json                        manifest + 配置(audit, defaultMode)
  messages/<messageId>.json          immutable 正文 + createdAt + from + topic + threadId + kind + refs
  queue/<deliveryId>.json            待投递（delivery record）
  claims/<deliveryId>.json           租约投递中
  acks/<deliveryId>.json             宿主已接受
  bindings/<threadId>.json           thread → (actor, endpointId, sessionId, mode)
  endpoints/<endpointId>.json        {actor, endpointId, transport, sessions[]}
  audit/YYYY-MM-DD.jsonl             可配置保留的审计流
  state/*.json                       仅观测/扫描优化，不参与正确性
```

```
queue/<deliveryId>.json
      │ atomic claim
      ▼
claims/<deliveryId>.json ──accepted──▶ acks/<deliveryId>.json
      │
      └──lease expires / failure──▶ queue/<deliveryId>.json   (attempt += 1)
```

delivery record（`queue/`、`claims/`）：

```jsonc
{
  "deliveryId": "…",                 // 投递身份（重试不变）
  "messageId": "…",                  // 指向 immutable 正文
  "target": { "actor": "dsh", "endpointId": "…", "sessionId": "…" },
  "threadId": "…",
  "mode": "advisory",                // advisory | delegated
  "attempt": 2,
  "createdAt": "…"
}
```

claim record 在其上追加：`claimOwner`、`leaseUntil`、`attempt`、`claimedAt`。

### 0.3.3 必须接受的边界（写进 README，不掩饰）

```
Transport guarantees at-least-once delivery; consumers must tolerate duplicate delivery.
```

无法消灭的窗口：

```
agent.steer(message) 成功
        ↓
进程崩溃
        ↓
还没写 ack
```

恢复后 bridge **必须重投**，否则可能真丢消息；于是 DSH 可能第二次看到同一 `deliveryId`。
在宿主不提供原子事务或 idempotency key 的前提下，文件协议无法知道第一次 steer 是否已真正进入宿主 ——
**这不是实现缺陷，是协议边界**。业务幂等请用上层稳定的 `taskId`/`jobId`，不要指望 mailbox 做到 exactly-once。

### 0.3.4 binding 规则（R10 的真正修复）

```jsonc
// bindings/<threadId>.json
{ "threadId": "…", "actor": "dsh", "endpointId": "dsh-desktop-…", "sessionId": "…", "mode": "advisory" }
```

**定死的规则**：存在多个 eligible DSH session 时，**没有 binding 就不得自动选择** ——
既不"第一个 session 收到"，也不"所有 session 都 steer"。
无 binding 时的处置由配置决定：进 `queue` 等待显式绑定，或投给配置指定的专用 bridge executor 会话。

### 0.3.5 P0.5 完成条件（状态不变量，而非"目录写完"）

1. 对每条未 ACK 的 delivery，正常状态下**恰好存在于 `queue` 或 `claims` 之一**（不得两处都有、也不得都不在）。
2. ACK 后，该 delivery **不得**仍留在 `queue`/`claims`。
3. 每条 delivery 永远可追溯到其 immutable message。
4. 过期 claim 可被恢复（回到 queue，`attempt` 递增）。
5. 并发 claim 只有一个 owner 获胜。
6. 没有明确 session binding 时，**不得**把消息自动送入任意桌面会话。

故障注入验收（T1–T15，围绕上述不变量；三个 crash window 为重点）：

| 编号 | 场景 | 期望 |
|---|---|---|
| T1 | 消费前崩溃 | delivery 仍在 queue |
| T2 | **`queue → claim` 之后崩溃** | 租约过期后回到 queue，消息不丢 |
| T3 | **`claim → steer` 之前崩溃** | 同上，且不产生"已消费"的假象 |
| T4 | **`steer` 成功 → `ack` 之前崩溃** | **重复但不丢失**（不得为让测试"只收到一次"而改语义） |
| T5 | duplicate delivery | 消费方按 deliveryId 去重；同一 message 不被重复执行 |
| T6 | 两个 reader 同时抢一条 delivery | 只有一个 claimOwner 获胜 |
| T7 | 两个 DSH session 同时存在且无 binding | 双方都**不**自动消费（D-规则 6） |
| T8 | 同毫秒创建大量 message | 无丢失；排序按 createdAt 稳定 |
| T9 | 系统时钟回拨 | 不影响投递资格（D5） |
| T10 | 损坏的 JSON | 单条隔离报错，不阻断其余投递 |
| T11 | `inbox`/`queue` 残留临时文件 | 被忽略并可清理 |
| T12 | 审计写成功、queue 写失败 | 不产生"半条消息"；以 message 正文为权威 |
| T13 | bridge root 突然不可写 | 明确报错，不静默吞掉 |
| T14 | plugin reload | 不重复 steer 已 ack 的 delivery |
| T15 | DSH restart 后未 ack 消息 | 恢复投递；binding 亦恢复 |

> 当前 v1 文档把消费描述成 `inbox → read` 的 destructive move，并要求"单 reader 保持 watermark 正确" ——
> 这正是 v2 要彻底拿掉的耦合（见 D1/D2/D5）。

### 0.3.6 P0.5 实施状态（2026-10-06）

**已实现并全部通过测试**（`npm test` 五套全绿）：

- `lib/core-v2.mjs` —— messages/queue/claims/acks 状态机、bindings/endpoints 路由、audit+gc、`verifyInvariants`
- `lib/mailbox-v2.mjs` —— v2 CLI（`send/reply/deliver/inbox/claim/ack/release/reconcile/verify/status/endpoint/bind/gc/policy`），退出码 0/1/3/4
- `tests/protocol-v2.test.mjs` —— T1–T15 + 六条状态不变量，**全绿**
- `tests/cli-v2.test.mjs` —— CLI 层同样覆盖 claim/ack/租约/发布/不变量与退出码，**全绿**

**实施过程中被测试挖出的 5 个真实缺陷**（都属"不测就发不出去"的类别）：

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | `undefined` 语义重载 | "没有显式目标→走绑定" 与 "显式不路由" 都传 `undefined`，产生**孤儿未路由投递** | 契约改为三态：`{…}`=显式目标、`null`=显式未路由、键缺失=走绑定 |
| 2 | `--no-` 前缀解析 | `--no-deliver` 被解析成 `deliver: false`，导致该开关**反而触发投递** | 解析器先匹配具名布尔开关（`BOOLEAN_FLAGS`），再做 `--no-X` 取反 |
| 3 | claim 判定顺序 | 已占租约的重复 claim 返回 `not-queued`，掩盖真实冲突 | 顺序改为 ack → 活租约 → 未入队 |
| 4 | deliveryId 唯一性不足 | 已 acked 的 id 可被重用，静默产生"同一 id 的新投递" | 全生命周期唯一（queue/claims/acks 三处都查），拒绝并提示换新 id |
| 5 | 不变量语义写错 | 把"等待绑定的投递"误判为违规 | 改为独立报告 `awaitingBinding`（冻结决定要求它合法地留在队列） |

附带修正：claim owner 校验放宽到允许 `:`/`@`（`dsh:session-a` 这类惯用 id）；测试在 Windows 上对 `EPERM` 加删除重试。

**v2 接线状态（P0.5-cutover，2026-10-06）**

- `lib/migrate.mjs` + `harnessmux-v2 migrate --source <v1> [--dry-run]`：**已实现并测试**
  （`tests/migrate.test.mjs` 全绿）。规则：legacy id 原样保留；v1 `read/` → `legacy-consumed`（**绝不**伪造 ack）；
  `inbox/read/log` 取并集、正文不一致即 `MIGRATION_CONFLICT` 停止；journal 记录 message/delivery 映射以保证可重入；
  迁移出的投递一律 **unrouted**（v1 没有路由信息，v2 不猜）。
- `plugin/index.js` 支持 `protocolVersion: "v1" | "v2"`，**默认仍为 v1**；
  v2 路径严格按 `discover → claim → load → steer → **ack**` 执行，steer 失败则 `release` 回队列（**绝不先 ack**），
  并对失败投递加了 `attempt × 1s`（上限 30s）退避，避免 watcher 空转刷 attempt。已由 `tests/plugin-v2.test.mjs` 覆盖
  （成功路径 ack 一次、失败路径 release、跨 session 不越界消费、unrouted 不自动消费、v1 仍为默认）。
- 切换步骤与验收矩阵见 [`docs/cutover.md`](docs/cutover.md)（含 quiescence window、V4-1…V4-6 与 V1）。

**设计原则（由本轮真实缺陷升级，已固化）**

> **插件契约测试必须检查 provider-facing 的编译后工具描述，而不只检查宿主注册 API。**

实证：`ctx.tools.register(...)` 返回成功 ≠ 模型 provider 可调用（缺 `output{schema,render}` 或未编译的
`parameters` 都会在**首个 turn** 才炸成 `Invalid schema for function ...`）。因此 `tests/plugin.test.mjs` 现在
同时断言"参数是 object-rooted JSON Schema、属性无 inline required"与"`execute` 返回值符合 `output.schema`、
`render` 产出内容块"。Codex MCP 侧同样适用：要测最终暴露给模型的 descriptor，而不是内部对象。



---

## 1. 问题定义

**主目标**：Codex 作为"指导方"（advisor/lead），DSH 作为"执行方"（executor），两者能互相发消息、互相追问，而不是人类在中间复制粘贴。

**次目标（本次新增）**：同一套机制要能扩展到"其他应用调用 DSH"，且两端都做成**各自生态里的插件形态**，便于分发。

**非目标**：不做云端中继、不做多用户、不做长期任务队列（v1 只保证"可靠投递 + 可唤醒 + 可审计"）。

---

## 2. 硬约束（实测证据）

这四条决定了方案形状，无法绕过：

| # | 约束 | 证据（本机实测） |
|---|---|---|
| C1 | **无法向"用户手动打开的 Codex 会话"注入新回合**。只有注入方自己通过 app-server 拥有的线程可被注入 | 上游 issue [openai/codex#33556](https://github.com/openai/codex/issues/33556)、[#47193](https://github.com/openai/codex/issues/47193)（子代理调研结论，标注为"上游声明"而非本机实测） |
| C2 | **外部进程无法向运行中的 DSH 桌面会话注入**：`/api` 与 `/api/remote.mux` 需要进程级随机 launch token，只接受 `GET /` 兑换 cookie，token 不在 argv、不在磁盘 | 端口 19387 监听者 pid 42236 = `DeepSeek Harness.exe`；`dsh-client-connection` README："Every Host RPC method and WebSocket stream requires one browser session"；`dsh-desktop-host/lib/index.js` 用 `ctx.connection.authenticatedUrl()` 交给 Electron |
| C3 | **Codex 插件不能注册任意进程内 JS 工具**；但它能声明 skills / apps(connectors) / **MCP servers** / **插件内 hooks** | `codex plugin add|list|marketplace` 存在；本地 marketplace 样本 `.agents/plugins/marketplace.json`；`plugin.json` 字段含 `skills`、`apps`、`interface`；`codex.exe` 字符串 `mcp.json`×12、`hooks/hooks.json`×1（见 §0.2 R4） |
| C4 | **Codex hooks 确实是命令钩子**（可做自动巡检） | `codex.exe` 二进制内字符串 `hooks.json`×5、`PreToolUse`×54、`SessionStart`×54、`UserPromptSubmit`×37、`PostToolUse`×41；`codex --help` 暴露 `--dangerously-bypass-hook-trust`（说明存在"钩子信任"闭环） |

**推论**：唯一同时满足两端的机制是**"拉取式邮箱 + 各自生态内的插件负责唤醒"**。推送语义不可能来自协议层，只能由各自的插件在本地实现（DSH 侧插件可以 steer，Codex 侧插件可用 hooks 在每次工具调用前巡检）。

---

## 3. 候选方案对比与取舍

| 方案 | Codex→DSH | DSH→Codex | 唤醒能力 | Windows | 取舍 |
|---|---|---|---|---|---|
| **A. 文件邮箱 + 双端插件（选定）** | ✅ | ✅ | 两端插件各自本地唤醒 | ✅ 纯 fs | 无第三方依赖、可审计、可移植；代价是需要各自装插件 |
| B. MCP 邮箱服务器（[agentmail](https://github.com/meetdave3/agentmail)、[mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)） | ✅（DSH 有 mcp-client） | ⚠️ 需对方是 MCP 客户端 | ❌ 纯拉取，无唤醒 | 较成熟 | 生态最通用，但 Codex 桌面端不是 MCP 客户端、且无唤醒 → **作为通用补充而非主干** |
| C. Codex app-server 线程注入（[codex-mcp-bridge](https://github.com/buidangminh23/codex-mcp-bridge)、[agent-intercom](https://github.com/ctliz/agent-intercom-codex)） | ✅ | ✅ | ✅（能唤醒被托管的 Codex） | 部分（intercom 是 Unix socket，AGPL） | 受 C1 限制：够不到用户手开的会话；AGPL 有传染性 |
| D. ACP 驱动（[acpx](https://github.com/openclaw/acpx) + 官方 [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)） | ✅ | ⚠️ Codex 不是 ACP 客户端 | ❌ | ✅（Windows 必须用 `agents.<name>.argv`） | **保留为"其他应用调用 DSH"的通用入口**，不作为双端对话主干 |
| E. 复用 Codex 的 hooks/hook 桥做拦截 | — | — | 部分 | ✅ | 已吸收为 Codex 侧插件的巡检手段 |

**结论**：主干用 A（协议中立、可唤醒、可移植），通用性用 B/D 补齐（MCP 服务器 + 登记 ACP/SDK 入口）。这也解释了为什么不能直接把现成项目改造成兼容 DSH：它们把对端写死为 Claude Code/Codex 会话（C1 之外的第二层限制），而 DSH 的会话模型、插件机制、进程内唤醒点都与它们不同。

---

## 4. 架构

```
                     ┌──────────────────── harnessmux 仓库（无依赖，可移植）────────────────────┐
                     │  lib/core.mjs   协议唯一实现：原子写 / 游标 / 线程 / 清单                  │
                     │  lib/mailbox.mjs   CLI：任何语言、任何进程都能收发                          │
                     │  plugin-dsh/     DSH 宿主插件（工具 + 简报 + 自动唤醒）                     │
                     │  plugin-codex/   Codex 插件（marketplace + plugin.json + SKILL + hooks）    │
                     │  mcp/            MCP 服务器（通用入口，任何 MCP 客户端可接入）              │
                     │  peers/          peer 适配器（文件 / webhook / ACP 通知）                    │
                     └────────────────────────────────┬───────────────────────────────────────────┘
                                                      │ 读写
                                        <bridge-root>/ (inbox, read, state, log)
                                        ▲                                    ▲
                                        │                                    │
                        ┌───────────────┴──────────┐          ┌──────────────┴───────────────┐
                        │ Codex（插件 + hooks）     │          │ DSH（本地插件）               │
                        │ SKILL 教它收发；hooks 巡检 │          │ mailbox 工具 + steer 唤醒     │
                        └──────────────────────────┘          └──────────────┬───────────────┘
                                                                             │ 其他应用
                                                              ACP / SDK / headless / web / webhook
```

**数据流（一次指导）**
1. Codex 写 `inbox/<id>.json`（`from: codex, to: dsh, kind: instruction`）。
2. DSH 插件 10s 巡检发现有未读 → `agent.steer(...)` 把内容送进当前会话（C2 的正解：进程内插件可以注入）。
3. DSH 执行后用 `mailbox action=reply` 回执（同线程）。
4. Codex 侧 hooks 在下次工具调用前调用 `harnessmux read --actor codex`，看到回执。

**降级路径**（任一插件缺失时仍可用）：人喊一声 → DSH 调 `mailbox read`；或 Codex 用 `codex exec` 调 CLI。协议不依赖插件。

---

## 5. 协议规范（v1）— 已实现并测试

```
<bridge-root>/
  bridge.json                 清单：version, actors
  inbox/<message-id>.json     待读消息
  read/<message-id>.json      已消费（同内容，移动而来）
  state/<actor>-cursor.json   每个 actor 的读游标
  log/<message-id>.json       审计副本（永不删除）
```

消息字段（`id` 字典序 == 时间序，因此游标比较就是字符串比较）：

```jsonc
{
  "id": "20261006084139259-a6e96890",
  "createdAt": "2026-10-06T08:41:39.260Z",
  "from": "codex", "to": "dsh",
  "topic": "ship the bridge",
  "threadId": "ship-the-bridge-fa332835",
  "kind": "instruction",        // instruction | question | answer | report | note
  "expectReply": true,
  "replyTo": "20261006084139259-a6e96890",
  "refs": ["src/x.ts"],
  "body": "markdown"
}
```

不变式（写入方与读取方都必须遵守）：
1. **原子写**：同目录临时文件 + `rename`，读者永不见半截 JSON。
2. **按字段寻址**：`to` 决定归属，目录只是状态。
3. **消费即移动**：`inbox/`→`read/`；崩溃最坏重复投递，绝不丢消息。
   **⚠️ 已被评审否定，见 §0.1 R1**：这是 destructive receive，不是 claim/ack。
4. **游标只前进**：`state/<actor>-cursor.json` 不回退。
   **⚠️ 已被评审否定，见 §0.1 R2**：游标不能承担消费正确性。
5. **回复同线程**：复制父消息 `threadId`/`topic`，交换 `from`/`to`，置 `replyTo`。
6. **未知字段必须忽略**：这是协议向前兼容的唯一保证。

> 原型中的示例消息**不应**带 `replyTo`（只有回复才带）——早期文档里首条 `instruction` 的
> `replyTo` 指向了自己，属笔误，已在本节修正；实现侧（`postMessage`）始终只在回复时写入该字段。

---

## 6. 仓库结构与各模块（含状态）

```
harnessmux/
  package.json  LICENSE(MIT)  .gitignore  README.md  DESIGN.md(本文)
  .agents/plugins/marketplace.json  ✅ 已实现 Codex 本地 marketplace（列 plugin-codex）
  lib/core.mjs              ✅ 已实现 协议 + 校验（无依赖）
  lib/mailbox.mjs           ✅ 已实现 CLI（init/post/reply/read/list/get/done/status/cursor/root）
  plugin/                   ✅ 已实现 DSH 宿主插件包
  plugin/package.json       ✅ 已实现（name=@local/harnessmux，**必须声明 dsh.bundle.patch**）
  plugin/cordis.patch.yml   ✅ 已实现（insert 行；**单 YAML 文档**）
  plugin/index.js           ✅ 已实现
  plugin-codex/             ✅ 已实现（清单 + SKILL；hooks 模板）
  plugin-codex/.codex-plugin/plugin.json  ✅
  plugin-codex/skills/harnessmux/SKILL.md ✅
  plugin-codex/hooks/hooks.template.json  ✅ 模板（opt-in）
  mcp/server.mjs            ⏳ 设计（见 6.3）
  peers/*.mjs               ⏳ 设计（见 6.4）
  scripts/install.mjs       ✅ 已实现（DSH 侧自动接线 + 手动步骤打印）
  docs/protocol.md          ✅ 已实现
  docs/dsh-setup.md         ⏳
  docs/codex-setup.md       ⏳
  tests/mailbox.test.mjs    ✅ 已实现（12 组断言通过）
  tests/manifest.test.mjs   ✅ 已实现（打包契约防回归）
  tests/plugin.test.mjs     ✅ 已实现（7 组断言通过，含 dispose）
  tests/acp-live-probe.mjs  ✅ 已实现（真实 DSH ACP 端到端探针）
  examples/demo.mjs         ⏳
```

### 6.0 DSH 插件打包契约（踩坑后固化，已实测）

DSH 装载一个 profile bundle 时要同时满足三件事，缺一即**静默跳过**（只在 stderr 报一行 warning）：

1. profile 的 `dependencies` 里有该包，且 `node_modules` 里真的有链接；
2. 该包的 `package.json` **必须声明 `dsh.bundle.patch`**，否则报
   `skipping profile bundle "@local/harnessmux": declares no dsh.bundle in its package.json`；
3. 该 patch 文件必须是**单个 YAML 文档**。DSH 出厂的空 profile patch 是 `[]`，若在其后追加 `- insert:`，
   就是两个文档，启动直接 `dsh: failed to parse overlay ...` 而崩溃。

另外：**改了 `link:` 目标后必须 `pnpm install --force`**，否则 pnpm 认为 lockfile 已满足、不会重建旧符号链接（实测踩到）。

上述四条已分别由 `tests/manifest.test.mjs`（1–3）和安装器的 `retargeted → --force` 逻辑（4）固化。


### 6.1 DSH 侧插件 `plugin/index.js`（状态：已实现/已测试/已在真实 DSH 进程装载）

**扩展点（从 asar 中读出的官方 hook 桥源码确证签名）**
| 扩展点 | 用途 | 签名要点 |
|---|---|---|
| `ctx.tools.register(tool)` | 注册 `mailbox` 工具 | 普通对象即可（`defineTool` 在运行时是恒等包装，故本插件不依赖 `dsh-tools`） |
| `ctx.systemPrompt.section({name, order, text})` | 注入协议说明 | 用 `getSectionOrder("TOOL_GOAL") + 1` |
| `ctx.on("agent/created", ({agent}) => agent.inject(msg))` | 会话级简报 | `msg` 由 `createUserMessage({content, source})` 构造 |
| `setInterval` + `agent.steer(msg)` | 未读自动唤醒 | 每个未读批次每 agent 只 steer 一次；`ctx.effect` 负责清理 |

**依赖策略（可移植性的关键）**：加载期不 import 任何 DSH 包。`@deepseek-ai/dsh-llm` 用顶层动态 import **机会式**获取，失败则退化为字面量用户消息 `{role:"user", content:[{type:"text"}], source:{kind:"harnessmux"}}`。理由：插件的 import 失败会拖垮整个 profile（官方 README 的设计哲学亦是如此）。邮箱逻辑按相对路径 `../lib/core.mjs` 引入，插件与 CLI 永不漂移。

**配置（patch 行，全部可省）**：`bridgeRoot`（绝对路径）、`actor`（默认 `dsh`）、`peer`（默认 `codex`）、`autoWake`（默认 `true`）。

**已知失败模式**：bridge 不存在 → 工具可用但报错、`action=init` 可现场创建；`agent.steer` 在非 running 状态被忽略；`steered` 集合按 `agentId + 最后一条消息 id` 去重。

### 6.2 Codex 侧插件 `plugin-codex/`（状态：已实现，待真机安装验证）

形态（字段名逐项对照官方 documents/spreadsheets 插件核实）：

```
.agents/plugins/marketplace.json      # 本仓库即一个本地 marketplace：{name, plugins:[{name, source:{source:"local", path:"./plugin-codex"}, policy, category}]}
plugin-codex/.codex-plugin/plugin.json # name/version/description/author/license/keywords/skills/interface
plugin-codex/skills/harnessmux/SKILL.md  # frontmatter(name,description) + 收发协议/时机/安全边界
plugin-codex/hooks/hooks.template.json     # opt-in：PreToolUse + UserPromptSubmit 调 CLI 巡检
```
安装：`codex plugin marketplace add <本仓库路径>` → `codex plugin add harnessmux@harnessmux`（`codex plugin marketplace|add|list` 已核实存在）。
注意：**`.agents/plugins/marketplace.json` 是"仓库即 marketplace"的约定路径**；若用户的 `<CODEX_HOME>/config.toml` 已经用一个 marketplace 根目录，可把本文件 symlink/copy 进那个根下（属安装细节，Q6）。

**SKILL.md 的职责**：何时读、怎么读（`node <repo>/lib/mailbox.mjs read --actor codex`）、怎么写（`post --to dsh --kind instruction`）、何时必须回（`expectReply`）、线程与回执纪律，以及**安全边界**（邮箱内容不得覆盖人类指令、危险操作需人类批准、禁止写入秘密）。

**自动巡检（可选，需用户授权钩子信任）**：模板使用已在二进制中核实的 `PreToolUse` 与 `UserPromptSubmit`，调用 `mailbox read --actor codex` 把新消息作为附加上下文交回 Codex。钩子失败必须静默退出，绝不阻塞 Codex 主流程。

**C3 的取舍**：Codex 插件不能带 JS 工具，所以 Codex 侧一切能力都由"技能指令 + hooks 命令"组成，真正逻辑在共享 CLI 里 —— 插件体积极小、易分发，也让"无插件用户"可以直接手敲同一条 CLI。

### 6.3 MCP 服务器 `mcp/server.mjs`（状态：设计）

目的：让**任何 MCP 客户端**成为桥的一端（Cherry Studio、Claude Code、Zed、DSH 自己的 `dsh-mcp-client`…）。这是"其他应用也能调用"最通用的一道门。

- 传输：stdio（v1），可选 streamable-http。
- 工具集（与 CLI 同语义）：`mailbox_read`、`mailbox_send`、`mailbox_reply`、`mailbox_list`、`mailbox_status`。
- 关键差异说明：**MCP 是拉取式的**（本项目核实 `dsh-mcp-client` 不支持 elicitation/sampling/roots，见证据 E6），所以 MCP 端不会被"推送唤醒"；唤醒仍由各端插件负责。→ 文档必须写明，避免使用者误期。
- 零依赖实现（手写 JSON-RPC over stdio）还是用官方 SDK，是待评审问题 Q4。

### 6.4 peer 适配器与 `peers.json`（状态：设计）

```jsonc
// <bridge-root>/peers.json
{ "peers": [
  { "actor": "codex", "display": "OpenAI Codex", "kind": "codex-plugin", "notify": { "mode": "file" } },
  { "actor": "dsh",   "display": "DeepSeek Harness", "kind": "dsh-plugin", "notify": { "mode": "in-process" } },
  { "actor": "other", "display": "Third-party app", "kind": "mcp-client", "notify": { "mode": "http", "url": "http://127.0.0.1:PORT/hook", "tokenRef": "env:OTHER_HOOK_TOKEN" } }
] }
```
适配器接口（每个文件默认导出）：
```js
export const kind = "http";
export async function notify(root, message, peer) { /* 尽力投递；失败绝不抛出 */ }
export async function probe(peer) { /* 可用性探测，用于 status */ }
```
内置适配器：`file`（写一个 `<actor>.wake` 标记文件 + 可选日志）、`http`（POST，带超时与重试上限）、`acp`（用 ACP 客户端驱动一个 DSH 会话；依赖 `@deepseek-ai/dsh-subagent-acp`，**版本兼容性未验证**，属 Q2）。

安全约定：适配器**只做通知**，不解析消息内容；凭据一律走 `env:` 引用，绝不写入 `peers.json`；网络目标默认只允许 loopback。

### 6.5 安装器 `scripts/install.mjs`（状态：已实现/已测试）

- 幂等：重复运行不会重复接线。
- 每次改动前写 `<file>.bak-<timestamp>`。
- 修改 DSH profile：`dependencies` 加 `link:`、`dsh.profile.bundles` 加包名、`cordis.patch.yml` 追加 `insert` 行（含 `bridgeRoot`）。
- pnpm 探测顺序：`DSH_PNPM` → 内置 pnpm（`resources/runtime/pnpm/bin/pnpm.cjs`）→ PATH。
- `--print-only` 打印等价手工步骤；`--dry-run` 只报不改。
- 实测：对假 `DSH_HOME` 的 profile 完成真实改写并成功 `pnpm install`；生成的 YAML 使用正斜杠单引号路径（避免 Windows 反斜杠转义坑）。

---

## 7. 兼容性矩阵：其他应用如何调用 DSH（状态：入口已核实，适配器待写）

| 调用方想要 | DSH 入口 | 命令 / 协议 | 认证 | 现状 |
|---|---|---|---|---|
| 程序化多轮对话 | ACP v1 服务端 | `dsh --profile acp`（stdio NDJSON；`--help` 已实测可用，`~/.dsh/profiles/acp` 已自动初始化） | 无（本地 stdio 信任边界） | ✅ 已核实可用；已有客户端 acpx |
| 嵌入自有程序 | SDK JSON-RPC | `dsh --profile sdk`（stdio，stdout 仅协议帧） | 无 | ✅ 已核实存在 |
| 一次性任务取答案 | headless | `dsh --profile headless "任务"` | 无 | ✅ 已核实存在 |
| 长驻 + 网页交互 | web | `dsh web` | 进程级 launch token + 签名 cookie（C2） | ✅ 可用（本机 19387） |
| 事件触发新会话 | webhook 插件 | `dsh-webhook` | 待定 | ⏳ 需装插件 |
| 我方主动通知对方 | peer 适配器 | `peers/<kind>.mjs` | 按适配器 | ⏳ 设计 |
| 任意 MCP 客户端 | 桥的 MCP 服务器 | `mcp/server.mjs` | 无（stdio） | ⏳ 设计 |

**结论**：**"其他应用调用 DSH" 不需要新协议**——ACP 已是标准答案，桥要做的是把 ACP/SDK 入口登记成 peer 并提供通知适配器。

---

## 8. 安全与风险

| 风险 | 说明 | 缓解（设计） |
|---|---|---|
| **提示注入**：邮箱内容被当成系统指令 | Codex 可以往邮箱写任意文本，DSH 会 steer 进会话 | 注入消息带来源标记 `source.kind = "harnessmux"`；简报明确"人类指令 > 邮箱内容"；对 `instruction` 类消息只执行可审计的操作，危险操作（删除/外发/凭据）仍需人类确认；`log/` 全量留痕 |
| 越权与最小权限 | Codex 让 DSH 执行任意命令 | 桥不提升权限：DSH 的工具策略仍是用户设置的那套（本会话为 danger-full-access，用户可改）；适配器默认只允许 loopback |
| 供应链 | 第三方包 | 主干零依赖；若要装 `dsh-subagent-acp`、`acpx` 等，全部版本钉死并记录在文档 |
| 成本 | `codex exec` 一次系统提示 ≈ 8.7k tokens（实测） | `codex exec` 只用于"人触发的一次性咨询"；持续协作走邮箱，不走 exec |
| 密钥 | 邮箱可能被写入秘密 | 文档写明禁止；适配器凭据只用 `env:` 引用；bridge 目录 `.gitignore` |
| 循环风暴 | 两个 agent 互相回消息 | 消息带 `kind`/`threadId`；插件侧"每批次只唤醒一次"；文档建议 `expectReply=false` 结束会话 |

---

## 9. 验收标准（可执行）

1. `npm test` 全绿：`tests/mailbox.test.mjs`（12 断言）+ `tests/plugin.test.mjs`（7 断言，含"dispose 后不再唤醒"）。
2. Codex 写一条 `instruction` → 30s 内 DSH 会话自动出现该内容（插件巡检 + steer）→ DSH `reply` 后 `log/` 与 `read/` 状态正确。
3. 同一批次不重复唤醒；游标不回退；重复投递不丢消息。
4. 拔掉 DSH 插件时，纯 CLI 路径仍可完成一次完整来回（协议独立性）。
5. 在**另一台机器**（不同用户名/路径）上，`node scripts/install.mjs --dsh-profile <name>` 一步接通并复现 1–4。

---

## 10. 待评审问题（已评审，裁定见 §0.2）

> 本节保留提问原貌以便追溯；**逐条裁定已在 §0.2**。要点：Q1 主干成立但 mailbox 降级为异步通道；Q2 不依赖 `dsh-subagent-acp`、直接驱动 `dsh --profile acp`；Q3 以 `SessionStart + UserPromptSubmit` 为主；Q4 采纳官方 MCP SDK（core 保持零依赖）；Q5 引入 advisory/delegated 两级信任；Q6 DSH 侧发 npm bundle、Codex 侧发 portable plugin、CLI 永久保留。

- **Q1（架构）**：主干选择"文件邮箱 + 双端插件唤醒"是否成立？有没有被忽略的更优机制（例如 Codex app-server daemon + `codex queue` 的组合，能否在不违反 C1 的前提下唤醒**桌面端手开会话**）？
- **Q2（可行性）**：`@deepseek-ai/dsh-subagent-acp` 只有 `0.0.1-rc.1`，而本机 DSH 是 `0.2.0-rc.2`，peer 对不齐。是否值得装？还是应优先用 `acpx` + `dsh --profile acp` 做"外部驱动 DSH"，把 in-process 唤醒留给 DSH 自己的插件？
- **Q3（插件形态）**：Codex 侧只能 skills+hooks（C3）。hooks 需要用户授权"钩子信任"，且 `PreToolUse` 只拿到工具名与 `tool_input.command` 形状。用 `UserPromptSubmit` 还是 `PreToolUse` 巡检更稳？是否应完全不依赖 hooks，改为纯 SKILL + 人类触发？
- **Q4（MCP）**：`mcp/server.mjs` 手写 JSON-RPC（零依赖，约 200 行）还是引入官方 SDK（多一个依赖，但协议兼容性有保障）？注意 DSH 的 mcp-client 不支持 elicitation/sampling，MCP 端天然只能拉取。
- **Q5（安全）**：注入来源标记 + "人类优先"约定是否足够？是否需要"邮箱消息默认只读上下文、不得直接触发写操作"的更严模式？
- **Q6（分发）**：DSH 侧插件目前靠 profile 的 `link:` + `cordis.patch.yml`（本机可行）。若要给别人用，是否应做成 npm 包（`@local/harnessmux` → 公开发布名）？Codex 侧是否应同时提供一个"无插件纯 CLI"模式给拒绝装插件的用户？

---

## 11. 分阶段实施（按评审重排）

> ⚠️ **本节已被 [`docs/roadmap.md`](docs/roadmap.md) 取代**（2026-10-06 定位调整）。
> 主要变化：`P3 Codex plugin` → **`P3 Portable Client Plugin`**（拆为 P3.1 共享核心 / P3.2 Codex adapter / P3.3 Claude Code adapter / P3.4 其他客户端 / P3.5 兼容性矩阵+CI）；
> 原 `P4 MCP` 并入 P3.1 的共享工具层；原 `P5 peers` 与 Receiver 抽象合并为 P6（并明确"等第二个 receiver 实现后再验证抽象"）；
> 新增 **P4 Install/Update/UX**；`Managed MCP→ACP` 降级为 **P5 的可选模式**（不再是主干）。
> 下表保留为工程记录。

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 协议核心 + CLI + 测试 | ✅ 完成 |
| P1 | DSH 侧插件（工具/简报/唤醒）+ 安装器 | ✅ 完成（含工具 schema 与 output 契约修复） |
| **P2** | **真实 DSH E2E：插件装载 → 工具进工具集 → 模型自动读信回执** | ✅ **已完成（ACP 形态，见 §0.1）**；桌面端只差一次重启 |
| P0.5 | 协议 v2：`messages`/`queue`/`claims`/`acks` + `bindings`/`endpoints` + advisory/delegated + 审计保留 + 零依赖 ID；故障注入 T1–T15 | ✅ 核心+CLI+T1–T15 全绿 |
| P0.5-cutover | `migrate`（legacy id 保留 / read≠ack / 并集冲突即停 / 可重入）+ 插件 v2 路径（claim→steer→ack）+ 切换手册 | ✅ 已实现并测试 |
| **P0.5 真机 cutover** | 真实迁移 + 真实模型下的 V4-1/V4-2/V4-3/V4-4/V4-4b/V4-5/V4-6 验收 | ✅ **PASS WITH DOCUMENTED LIMITATION** — 见 [`docs/REPORT-p0.5-cutover.md`](docs/REPORT-p0.5-cutover.md)。限制：idle session 无唤醒（transport 只投递给 running agent）；Desktop 仍需一次重启走 v2 |
| P3 | Codex **portable plugin**：`plugin.json` + `skills/` + `mcp.json` + `hooks/hooks.json`（不再改全局 hooks.json） | ⏳ 与 P0.5 并行 |
| P4 | ACP controller：正式支持 `dsh --profile acp` 作为受管 executor（Managed 模式主干） | ⏳ 设计 |
| P5 | MCP 独立暴露给其他客户端 + peers 适配器（http/webhook） | ⏳ 设计 |
| P6 | 文档：README（中英）、dsh-setup、codex-setup、examples/demo | ⏳ 部分（protocol.md 完成） |
| P7 | 发布：npm bundle（DSH 侧）、版本、CHANGELOG、CI 跑 `npm test` | ⏳ 设计 |

> **本节历史映射（供追溯）**：旧 P3 Codex plugin → 新 **P3.1–P3.5 Portable Client Plugin**；
> 旧 P4 ACP controller → 新 **P5（可选模式，不再是主干）**；旧 P5 MCP+peers → 新 **P3.1 共享工具层** + **P6 Generic Receiver API**；
> 旧 P6 文档 → 新 **P4 Install/Update/UX + P7 发布**。以 [`docs/roadmap.md`](docs/roadmap.md) 为准。
> 另注：旧 P1 中的"auto-wake"措辞不准确——当前能力是"投递进 **running** 会话"，idle 不唤醒（见 V1 与 L1）。

**待验证项（不要当结论用）**
- **V1**：`steer()` / `followup()` / `inject()` 在 idle agent 上的真实语义（评审称 idle steer 会唤醒起 turn）。需用真实 idle root agent 复现后再改 §6.1。
- **V2**：`@modelcontextprotocol/sdk` 的可用版本与体积（Q4 采纳官方 SDK 的前提）。
- **V3**：Codex portable plugin 的根 `plugin.json` + `mcp.json` 的确切 schema（目前只有二进制字符串证据，尚未找到本机样本）。
- **V4**：桌面端重启后 `mailbox` 工具是否在**桌面 profile** 里同样出现（ACP profile 已验证）。

---

## 附录 A：本机实测证据清单

| 编号 | 结论 | 证据 |
|---|---|---|
| E1 | Codex CLI 0.154.0 已登录，`codex exec` 可用 | `codex login status` → `Logged in using ChatGPT`；`codex exec` exit 0，输出含 session id，tokens 8,736 |
| E2 | DSH 桌面端在 19387 监听，属主为 `DeepSeek Harness.exe` (pid 42236) | `Get-NetTCPConnection -LocalPort 19387`；`Get-Process -Id 42236` |
| E3 | DSH 提供 ACP/SDK/headless 三种自动化入口 | `dsh --help`、`dsh --profile acp --help`（exit 0）；`@deepseek-ai/dsh-acp-app` README；profile 目录出现 `acp` |
| E4 | DSH 插件扩展点签名（本方案依据） | 从 asar 提取的 `dsh-hooks-claude-code/lib/index.js`：`ctx.on("agent/created"|"agent/pre-step"|"tools/pre-execute"|"tools/post-execute"|"agent/turn-stopping")`、`agent.inject`/`agent.steer`、`createUserMessage({content, source})` |
| E5 | DSH 无外部注入通道 | `dsh-client-connection` README（每进程 launch token、cookie 绑定）；`dsh-desktop-host/lib/index.js` 用 `authenticatedUrl()` |
| E6 | DSH 的 MCP 客户端只支持 tools+resources，不支持 elicitation/sampling/roots | `dsh-mcp-client/README.md` 限制章节；`lib/index.js` 内无 `elicit`/`sampling`/`roots` 字符串 |
| E7 | DSH 会话日志不可作为实时状态源（正文在 fsync 屏障前不落盘） | 当前会话 `session.v4.jsonl.zstd` 为 175KB，解压后仅 244 字节（只有 session 头），Node `zstdDecompressSync` 与 stream 两种方式一致 |
| E8 | Codex 支持 hooks 事件 | `codex.exe` 字符串计数：`hooks.json`×5、`PreToolUse`×54、`SessionStart`×54、`UserPromptSubmit`×37、`PostToolUse`×41 |
| E9 | Codex 插件机制与清单字段 | `codex plugin list`（含本地 marketplace `openai-primary-runtime`）；样本 `plugin.json`（`skills`, `apps`, `interface`）、`marketplace.json`（`source.source=local`, `policy`, `category`）、`.app.json`（`{"apps":{...}}`） |
| E10 | DSH 自带插件已是"本地 link"形态，可复用同一机制 | `~/.dsh/profiles/desktop/package.json` 内 `@local/sidebar-balance`、`@local/harness-source-note` 均为 `link:`；`cordis.patch.yml` 用 `insert` 行 |
| E11 | 实现已通过测试 | `mailbox.test.mjs` 全绿；`plugin.test.mjs` 全绿（含自动唤醒与 dispose），且测试进程能自然退出 |

## 附录 B：生态项目参考（不直接改其代码的原因）

| 项目 | 机制 | 为什么不能直接用 |
|---|---|---|
| [acpx](https://github.com/openclaw/acpx)（MIT, 3316★） | headless ACP 客户端 | 是"驱动 ACP agent"的客户端，没有反向通道让 Codex 参与；**保留为"其他应用调用 DSH"的入口** |
| [codex-mcp-bridge](https://github.com/buidangminh23/codex-mcp-bridge)（MIT, 1.20.1） | 推入 live Codex 线程 / Claude 会话 | 对端写死 Claude/Codex 会话（受 C1 限制）；DSH 不是它的目标 |
| [agent-intercom-codex](https://github.com/ctliz/agent-intercom-codex)（AGPL-3.0-or-later） | `coi` 守护 + 唤醒被托管 Codex | AGPL 传染性；Unix socket 风味，Windows 未验证 |
| [agentmail](https://github.com/meetdave3/agentmail)（MIT）/ [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)（MIT+Rider） | 通用 MCP 邮箱 | 纯拉取、无唤醒；作为 MCP 服务器的设计参考 |
| [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)（Apache-2.0, 433★） | 把 Codex 包成 ACP 服务端 | 方向相反（Codex 当服务端），不能接收外部消息 |
