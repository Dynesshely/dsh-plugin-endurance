# dsh-plugin-endurance — 设计

> 代号：**endurance（续航）**
> 仓库：`Dynesshely/Endurance` · 设计 issue：#1 · 状态：草案 v0.3（已按两轮评审修订，评审中）

---

## 1. 摘要

`dsh-plugin-endurance` 为 DSH 的长程任务加一条「收敛核验」约束：用户声明**计划时长**与**收敛门槛**（连续 N 轮自检置信率 ≥ G），并选择**收敛模式**。模型在理解用户提示词后，生成检查提示词模板，调用 `task_endurance_set` 登记本次续航运行。

两种收敛模式（详见 §5.3）：

- **`converge`（达标即结束）**：会话内连续 N 轮达标后立即结束，不等到计划时刻。
- **`idempotent_soak`（收敛后幂等巡检）**：先在会话内完成连续 N 轮达标，随后进入**幂等巡检阶段**：按固定「幂等间隔」定时重复核验，直到计划时刻才结束；巡检期间产物应保持不变，只做验证。

模式由用户明确选择。**用户没有明确说明模式时，模型必须先询问用户，不得自行猜测**（`set` 缺少模式会返回错误并要求询问）。

登记后，模型先完整执行一个任务回合；插件随后在回合结束、会话空闲时自动注入检查提示词。模型在检查回合里核验任务，然后二选一：

- 调用 `task_endurance_post` 汇报本轮置信率（达到门槛则累计一轮「连续达标」）；
- 调用 `task_endurance_reset` 表示任务尚未完成，需要继续（连续达标计数清零）。

计划时长是参考，不是结束门槛：它决定幂等巡检的终点与安全上限。若到计划时刻仍未达标，继续核验直到达标或触达安全上限。

---

## 2. 目标与非目标

### 2.1 目标

1. 用户用自然语言声明「计划时长 + 收敛轮数 + 置信率门槛 + 收敛模式」，模型转成结构化参数，经工具调用登记。
2. 检查提示词由模型根据任务生成（`check_prompt` 模板 + 占位符），插件不替模型编检查内容。
3. 插件自动驱动「任务回合 → 检查回合 → 任务回合」循环，直到满足所选模式的结束条件；用户无需守着。
4. 支持两种模式：**达标即结束**；**收敛后幂等巡检至计划时刻**。
5. 结束条件可审计：每轮注入、每次 post/reset、巡检跳过、终态原因都落会话日志；重启后可恢复。
6. 无人值守安全：轮次上限、宽限期、停滞判定、错误计数、用户中止优先级；不无限夜跑。
7. 与 DSH 既有机制（goal 自动轮次、schedule、用户消息、子代理）不打架。

### 2.2 非目标（v0.1）

- 不做跨会话、跨工作区的续航编排。
- 不替代 `goal` / `schedule`：goal 负责「把目标做完」，endurance 负责「多轮核验并确认收敛」。
- 不自动生成或改写用户的任务内容与检查标准。
- 不在 v0.1 提供客户端 UI（状态行、命令、设置页属 M2）。
- 不承诺模型一定产出合格产物；插件保证的是流程约束与可审计性。

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| **续航运行（run）** | 一次由 `task_endurance_set` 登记的约束，隶属于一个会话，同一时刻最多一个活动运行。 |
| **收敛模式** | `converge`（达标即结束）或 `idempotent_soak`（收敛后幂等巡检）。 |
| **计划时刻（target）** | `created_at + duration`，用户声明的计划结束时刻。`converge` 模式下仅作参考；`idempotent_soak` 模式下是幂等巡检的终点。 |
| **硬截止（hard deadline）** | `target + grace`，运行允许的最长墙钟时间；超过即进入终态 `exhausted`。 |
| **检查轮次（round）** | 插件注入一次检查提示词即一轮；同一轮内因未响应而重发只增加 `attempt`，不增加轮次。 |
| **达标（pass）** | 该轮 `post` 的置信率 `confidence >= gate`。 |
| **连续达标（streak）** | 自上次 `reset` 起，连续达标且已计分的轮次数。 |
| **收敛（converged）** | 正常成功终态，判定随模式不同（§5.3）。 |
| **幂等巡检阶段（idempotent phase）** | `idempotent_soak` 模式下、连续达标已满足后，按固定间隔重复核验直到计划时刻的阶段。 |
| **幂等间隔（idempotent interval）** | 幂等巡检阶段两次检查之间的固定时间。 |
| **幂等触发点（tick）** | 定时器按幂等间隔到点的那一刻；若此时会话正在运行，则跳过本次（不补发）。 |
| **Kickoff（启动提示）** | 首轮检查之前，若模型还没实际执行任务，插件发一次性的、不计轮次的「开始执行任务」提示。 |
| **检查消息（check message）** | 插件注入的 user 角色消息，`source.kind = plugin:dsh-plugin-endurance`，携带 `enduranceId/round/attempt/phase`。 |
| **状态尾注（footer）** | 插件在渲染后的模板末尾追加的、由插件生成的判定说明（阶段、轮次、连续达标数、计划进度）。 |

---

## 4. 端到端流程

对应用户给出的 5 步：

```text
用户：规划一个长程任务，时长 8h 左右，收敛检查至少 3 轮置信率均 ≥85%，
      并在达标后保持巡检（或：达标就结束）
  │
模型：若用户没明确说哪种收敛模式 → 先询问用户，不猜
模型：理解提示词 → 生成 check_prompt 模板
模型：调用 task_endurance_set(duration="8h", min_consecutive_passes=3,
                              confidence_gate=85, check_prompt="现在是第 $endurance_id 轮检查……",
                              convergence_mode="idempotent_soak", idempotent_interval="1h")
  │        ← 返回运行 id、计划时刻、门槛、模式；落一条 plugin record（armed）
模型：在同一回合内继续完整执行任务（工具调用、编辑、测试……），结束回合
  │
agent/status → idle
  │
插件：评估首轮条件
  ├─ set 之后已实际执行过任务 → 注入第 1 轮检查
  └─ 本回合只是规划/没有实际执行 → 先发一次 kickoff 提示，等下一回合再检查
  │
模型：收到检查 → 核验任务
  ├─ 任务未完成   → task_endurance_reset(reason)        → streak 清零，继续
  └─ 有把握完成   → task_endurance_post(confidence, …)  → 达标则 streak+1
  │
┌─ converge 模式 ─────────────────────────────────────────────┐
│ 连续 3 轮 ≥85% → converged → 停止注入                        │
└─────────────────────────────────────────────────────────────┘
┌─ idempotent_soak 模式 ──────────────────────────────────────┐
│ 连续 3 轮 ≥85% → 进入幂等巡检阶段                            │
│ 之后每 1h 一个 tick：session 空闲才注入幂等核验；运行中跳过  │
│ 到计划时刻 07:00 仍保持达标 → converged → 停止注入           │
│ 巡检中若发现回归（置信率低于门槛或 reset）→ 回到活跃阶段，   │
│ 重新累计 3 轮达标；计划时刻已过则达标后立即收敛              │
└─────────────────────────────────────────────────────────────┘
```

补充规则：

- 首轮检查在**模型完成一个任务回合之后**注入；`set` 本身不立即触发检查。
- 活跃阶段（未达标的检查轮次）使用 eager 节奏：会话空闲后尽快注入下一轮（受最小间隔约束）。
- `converge` 模式不要求到计划时刻；`idempotent_soak` 模式的幂等巡检才使用计划时刻作为终点。
- 计划时刻之后仍未达标 → `overrunning`，继续核验直到达标或硬截止。

---

## 5. 核心语义

### 5.1 时长语义：计划参考

- `created_at` = `task_endurance_set` 成功写入的时刻（墙钟）。
- `target = created_at + duration`：用户声明的「计划跑多久」，用于：
  - `idempotent_soak` 模式下幂等巡检的终点；
  - 状态展示（已用时长、剩余、是否超计划）；
  - 推导安全上限 `hard_deadline = target + grace`。
- **时长不参与「是否达标」的判定**；它只决定模式相关的结束时机（§5.3）。
- 到达 `target` 仍未收敛：进入 `overrunning`，继续检查；到达 `hard_deadline` 仍未收敛 → `exhausted`。
- 用户中止、取消、达到安全上限是提前退出途径。
- 时钟使用墙钟：机器休眠/宿主暂停期间时间照常流逝；恢复后按当前时刻重新评估。

### 5.2 检查轮次

- 轮次从 1 开始；每次**新注入**检查消息 `round += 1`。
- 注入后模型所在回合结束仍未调用 `post` / `reset`：视为「本轮未响应」，`attempt += 1`，重发**同一轮**（`$endurance_id` 不变），并在状态尾注中提示「上一轮检查未收到汇报」。
- `attempt` 达到 `maxUnansweredPrompts`（默认 3）→ 终态 `stalled`。
- 轮次总数（含重发与幂等巡检）不超过 `maxChecks`（默认 100）→ 终态 `exhausted`。
- Kickoff 消息不计入轮次。

### 5.3 达标、连续计数与两种收敛模式

`pass = confidence >= gate`（闭区间，`85` 表示 85%）。一个已计分轮次：

- `pass` → `streak += 1`；
- `!pass` → `streak = 0`；
- `reset` → `streak = 0`，该轮不计分。

**模式 A：`converge`（达标即结束）**

```
converged ⇔ streak >= min_consecutive_passes
```

达到门槛即停止注入、立即结束；即使远早于计划时刻。

**模式 B：`idempotent_soak`（收敛后幂等巡检）**

```
phase:
  active      ⇔ streak < N
  idempotent  ⇔ streak >= N ∧ now < target
converged    ⇔ streak >= N ∧ now >= target
```

- 在活跃阶段完成连续 N 轮达标后，不结束，而是切换到幂等巡检阶段。
- 幂等巡检阶段按固定 `idempotent_interval` 触发检查；检查只做验证，产物应保持不变（发现回归则通过低置信率或 reset 退出该阶段）。
- 巡检期间通过 → 保持（streak 继续累加）；未通过或 reset → 回到活跃阶段，`streak = 0`，按 eager 节奏继续，重新累计 N 轮。
- 到达计划时刻时若仍处于幂等巡检阶段（即连续达标仍成立）→ `converged`。
- 若计划时刻已过才重新累计到 N 轮 → 立即收敛，不再进入巡检。

### 5.4 幂等与防伪

- **post 必须发生在匹配的检查回合内**：当前开放回合中必须存在一条检查消息，其 `enduranceId`、`round` 与运行状态一致；否则拒绝（`ENDURANCE_NOT_A_CHECK_ROUND`）。
- **每轮最多计一次 post**：同轮重复 post 返回 `counted: false`（仍记录 summary 供审计，不影响 `streak`）。
- **reset 优先**：同一轮先 post 后 reset，reset 生效并回退该轮计分。
- 检查消息来源 `source.kind = plugin:dsh-plugin-endurance`，与真人消息、goal 轮次、schedule 投递可区分。
- `set` / `cancel` 需要当前回合存在直接人类输入（root agent），防止模型自导自演登记/取消（见 §7.7）。**`set` 只允许由用户授权设定（用户确认）。**

### 5.5 节奏（cadence）

| 情形 | 下一轮检查时机 |
|---|---|
| `armed` 后首轮 | 模型完成一个任务回合、会话空闲后注入（见 §9.2 首轮判定） |
| 活跃阶段：未达标（`!pass`）或 `reset` 后 | 空闲后尽快（eager，最小间隔 30s） |
| 活跃阶段：达标但未到 N | 空闲后尽快（eager） |
| `converge` 模式：`streak >= N` | 立即收敛 |
| `idempotent_soak`：达到 N → 幂等巡检 | 按 `idempotent_interval` 定时 tick |
| 幂等巡检：tick 到点但会话正在运行 | 跳过本次，不补发（§9.3） |
| 到达计划时刻（幂等阶段且仍达标） | 立即收敛 |
| 到硬截止 / 轮次上限 | 不再注入；可选注入一次收尾提示后终态 |

`idempotent_interval` 默认 `clamp(duration / 8, 5m, 2h)`（8h → 1h），也可由模型在 `set` 时指定（如 `"30m"`）。

### 5.6 幂等巡检阶段的语义

「幂等」指**重复的核验不会改变产物状态**：巡检阶段的每轮检查只验证产物是否仍满足用户目标，不要求模型继续改进；重复触发同一检查应得到同样的结论。

- 巡检检查使用同一 `check_prompt` 模板渲染，`$endurance_phase` 为 `idempotent`；状态尾注明确要求「保持产物不变，仅核验」。
- 若模型认为产物需要变更，说明出现了回归或新需求 → 应调用 `reset`（或如实给出低于门槛的置信率），回到活跃阶段处理。
- 巡检 tick 是幂等的调度：到点最多注入一条检查；若已有未响应的检查或会话正在运行，跳过且不补发，不会堆叠。
- 后台 shell、后台任务、长跑进程**不会**让会话进入「正在运行」状态；tick 只以 `agent.status` 为准，不检查操作系统进程（§9.3）。

---

## 6. 状态机

### 6.1 状态

| 状态 | 是否终态 | 含义 |
|---|---|---|
| `armed` | 否 | 已登记，尚未注入第一轮检查（可能已发过 kickoff）。 |
| `running` | 否 | 循环进行中（活跃阶段或幂等巡检阶段）。 |
| `converged` | 是 | 正常成功：`converge` 模式达标，或 `idempotent_soak` 模式到计划时刻仍达标。 |
| `cancelled` | 是 | 用户要求取消。 |
| `exhausted` | 是 | 达到硬截止/轮次上限仍未收敛。 |
| `stalled` | 是 | 连续多轮检查未收到 post/reset（模型不配合或反复失败）。 |

运行内阶段 `phase`：`active`（活跃检查阶段）或 `idempotent`（幂等巡检阶段）。

派生标志（随每次工具返回与状态查询给出）：`gate_met`（`streak >= N`）、`can_conclude`、`pending_round`、`paused`、`overrunning`（`now > target`）、`first_check`（`pending` / `kickoff_sent` / `started`）、`phase`。

### 6.2 转换

| 当前 | 触发 | 条件 | 动作 | 下一状态 |
|---|---|---|---|---|
| — | `set` | 无活动运行；校验通过；人类授权；模式明确 | 写 record（run）、计算 target 与安全上限 | `armed` |
| `armed` | 回合结束（idle） | 未暂停、无竞争消息；已有任务工作证据 | 注入第 1 轮 | `running`（active） |
| `armed` | 回合结束（idle） | 未暂停；尚无工作证据且未发过 kickoff | 发送 kickoff（不计轮） | `armed` |
| `armed` | kickoff 回合结束 | — | 注入第 1 轮（不再要求工作证据） | `running`（active） |
| `running` | `post` 计分 | `pass`；`mode=converge`；`streak >= N` | 记录收敛 | `converged` |
| `running` | `post` 计分 | `pass`；`mode=converge`；`streak < N` | `streak += 1` | `running`（active） |
| `running` | `post` 计分 | `pass`；`mode=idempotent_soak`；`streak >= N`；`now < target` | `streak += 1`；进入幂等巡检 | `running`（idempotent） |
| `running` | `post` 计分 | `pass`；`mode=idempotent_soak`；`streak >= N`；`now >= target` | 记录收敛 | `converged` |
| `running` | `post` 计分 | `!pass` | `streak = 0`；回到活跃阶段 | `running`（active） |
| `running` | `reset` | 匹配检查回合 | 回退该轮、`streak = 0`；回到活跃阶段 | `running`（active） |
| `running` | tick | `phase=idempotent`；会话空闲且无未响应检查 | 注入幂等检查 | `running`（idempotent） |
| `running` | tick | `phase=idempotent`；会话正在运行 / 有未响应检查 | 跳过本次，记录 skipped | 不变 |
| `running` | 计划时刻到达 | `phase=idempotent` 且 `streak >= N` | 记录收敛 | `converged` |
| `running` | 回合结束 | 本轮未响应，`attempt < max` | 重发同轮 | `running` |
| `running` | 回合结束 | 本轮未响应，`attempt == max` | 记录原因 | `stalled` |
| `running` | 定时器/回合结束 | `now >= hard_deadline` 或 `checks >= maxChecks` | 可选收尾提示，记录原因 | `exhausted` |
| `armed` / `running` | `cancel` | 人类授权回合 | 记录原因 | `cancelled` |
| 任意终态 | `set` | 新参数校验通过 | 新 run id，历史保留 | `armed` |

终态不可再被 `post` / `reset` 推进；工具返回 `ENDURANCE_NOT_ACTIVE` 并携带终态视图。

---

## 7. 工具契约

所有工具在插件加载时全局注册；是否使用由模型判断。返回值为 JSON（经 `output.render` 渲染为文本）。输入非法或状态不允许时抛出结构化错误（`HarnessError`，带稳定 `code`）。

### 7.1 `task_endurance_set`

登记一次续航运行。**用户没有明确收敛模式时必须先询问用户，不得猜测**；`set` 缺模式会返回 `ENDURANCE_MODE_REQUIRED` 提示询问。

**参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `duration` | string | 是 | `^\d+(\.\d+)?\s*[mhd]$`，1m ≤ d ≤ 24h（默认上限可配） | 计划时长（参考值），如 `8h`、`90m`、`1d`。 |
| `min_consecutive_passes` | integer | 是 | 1 ≤ N ≤ 20 | 连续达标轮数。 |
| `confidence_gate` | number | 是 | 0 ≤ G ≤ 100 | 达标置信率（百分比），如 `85`。 |
| `check_prompt` | string | 是 | 20 ≤ 长度 ≤ 8000 | 每轮检查提示词模板，支持 `$endurance_*` 占位符（见 §8）。 |
| `convergence_mode` | string | 是 | `converge` / `idempotent_soak` | 收敛模式；用户未明确选择时，先问用户再调用。 |
| `idempotent_interval` | string | 否 | 1m–duration；仅 `idempotent_soak` 模式 | 幂等巡检间隔，如 `"1h"`；省略时默认 `clamp(duration/8, 5m, 2h)`。 |

**返回（成功）**

```json
{
  "ok": true,
  "run": {
    "id": "end_0192f...",
    "status": "armed",
    "mode": "idempotent_soak",
    "phase": "active",
    "duration_ms": 28800000,
    "created_at": "2026-11-17T23:00:00+08:00",
    "target_at": "2026-11-18T07:00:00+08:00",
    "hard_deadline_at": "2026-11-18T09:00:00+08:00",
    "min_consecutive_passes": 3,
    "confidence_gate": 85,
    "idempotent_interval_ms": 3600000,
    "streak": 0,
    "rounds_injected": 0,
    "max_checks": 100
  },
  "message": "Endurance armed (idempotent_soak). Finish one full task round first; the first check is injected automatically after this turn. After 3 consecutive passes the run enters idempotent checks every 1h until 07:00."
}
```

**错误**：`ENDURANCE_ALREADY_ACTIVE`（附当前运行视图与建议）、`ENDURANCE_INVALID_PARAMS`（附具体字段）、`ENDURANCE_PROMPT_INVALID`（未知占位符）、`ENDURANCE_MODE_REQUIRED`（缺模式：必须先问用户）、`ENDURANCE_AUTHORITY_REQUIRED`（当前回合无直接人类输入）。

### 7.2 `task_endurance_post`

在检查回合汇报本轮置信率。

**参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `confidence` | number | 是 | 0–100 | 你对「任务已完全满足用户目标」的置信率（百分比）。 |
| `summary` | string | 是 | 1–4000 字符 | 本轮核验结论与证据摘要。 |
| `artifacts` | string[] | 否 | ≤50 项 | 产物路径/URL/标识。 |
| `remaining_work` | string[] | 否 | ≤50 项 | 仍待处理项（若置信率低）。 |

**返回**

```json
{
  "ok": true,
  "counted": true,
  "confidence": 86,
  "gate": 85,
  "mode": "idempotent_soak",
  "phase": "idempotent",
  "streak": 3,
  "streak_required": 3,
  "round": 4,
  "gate_met": true,
  "can_conclude": false,
  "target_at": "2026-11-18T07:00:00+08:00",
  "elapsed_ms": 13680000,
  "overrunning": false,
  "remaining_to_target_ms": 15120000,
  "next_check_after_ms": 3600000,
  "message": "Round 4 recorded (86 ≥ 85). 3/3 consecutive passes: entering idempotent checks every 1h until 07:00. Keep the artifact unchanged unless a regression is found."
}
```

- `can_conclude: true`：本轮使运行收敛，不再有检查注入；模型应给出最终产物说明。
- `phase`：`active` / `idempotent`；幂等阶段的检查只做验证。
- 同轮重复调用：`counted: false`，`streak` 不变，附提示。
- `next_check_after_ms`：幂等阶段为间隔；活跃阶段为 `0`（eager）。
- `overrunning: true`：已超过计划时刻，仍在继续核验。

**错误**：`ENDURANCE_NOT_ACTIVE`、`ENDURANCE_NOT_A_CHECK_ROUND`（当前回合不是匹配检查回合）、`ENDURANCE_INVALID_PARAMS`。

### 7.3 `task_endurance_reset`

声明任务未完成、需要继续；清零连续达标计数。

**参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `reason` | string | 是 | 1–2000 字符 | 为什么还不能结束。 |
| `unresolved_work` | string[] | 否 | ≤50 项 | 计划在下一轮前完成的事项。 |

**返回**

```json
{
  "ok": true,
  "streak": 0,
  "streak_required": 3,
  "round": 4,
  "phase": "active",
  "message": "Reset recorded. Consecutive passes cleared; the run returns to active checks and continues after this turn."
}
```

**错误**：`ENDURANCE_NOT_ACTIVE`、`ENDURANCE_NOT_A_CHECK_ROUND`。

### 7.4 `task_endurance_status`

只读查询当前运行（模型与用户排查用）。无参数。

**返回**：运行完整视图（`run` 字段，含模式、阶段、派生标志、最近若干轮历史、上限与暂停原因）；无活动运行时返回 `{ "ok": true, "run": null }`。

### 7.5 `task_endurance_cancel`

取消当前运行（仅当用户在对话中明确要求停止时使用）。

**参数**：`reason`（string，必填）、`confirm_user_request`（boolean，必填且必须为 true，用于暴露模型意图）。

**返回**：`{ ok: true, run: { status: "cancelled", ... } }`；错误：`ENDURANCE_NOT_ACTIVE`、`ENDURANCE_AUTHORITY_REQUIRED`。

### 7.6 错误码

| code | 含义 | 模型应做什么 |
|---|---|---|
| `ENDURANCE_INVALID_PARAMS` | 参数越界/格式错误 | 按 `field` 修正后重试，或询问用户。 |
| `ENDURANCE_PROMPT_INVALID` | 模板含未知占位符或长度越界 | 用返回的合法占位符清单修正。 |
| `ENDURANCE_MODE_REQUIRED` | 缺少收敛模式 | **先询问用户选哪种模式**，再重新调用 `set`。 |
| `ENDURANCE_ALREADY_ACTIVE` | 已有活动运行 | 先 `status`；按用户意图继续或 `cancel`。 |
| `ENDURANCE_NOT_ACTIVE` | 当前没有活动运行（或已终态） | 不要继续推进；必要时重新 `set`。 |
| `ENDURANCE_NOT_A_CHECK_ROUND` | 当前回合不是匹配的检查回合 | 等待检查消息；不要预支 post/reset。 |
| `ENDURANCE_AUTHORITY_REQUIRED` | 缺少直接人类授权（set/cancel） | 请用户明确确认，不要自行登记或取消。 |
| `ENDURANCE_INTERNAL` | 持久化/注入等内部失败 | 报告 `status` 与日志线索，不要重试风暴。 |

### 7.7 权限矩阵

| 工具 | 调用前提 | 校验方式 |
|---|---|---|
| `set` | 当前回合有直接人类输入；root agent；无活动运行；模式明确 | 开放回合内存在 `user/message.source.kind === 'user'`（对照 goal 工具的 `requireDirectHuman`） |
| `post` / `reset` | 当前回合是匹配的检查回合 | 开放回合内存在 `source.kind === 'plugin:dsh-plugin-endurance'` 且 `enduranceId/round` 匹配的检查消息 |
| `status` | 任意调用代理 | 只读，无副作用 |
| `cancel` | 当前回合有直接人类输入 + 模型显式确认 | 同 `set`；`confirm_user_request === true` |

设计理由：`post`/`reset` 的回合绑定让模型无法在普通工作回合里「刷」连续达标，也让每轮计数都有可追溯的检查消息；`set`/`cancel` 的人类回合绑定防止模型擅自给会话套上数小时的自动驱动或取消用户任务。**`set` 只能由用户授权设定（用户确认）。**

---

## 8. 检查提示词与模板

### 8.1 占位符

| 占位符 | 含义 | 示例 |
|---|---|---|
| `$endurance_id` | 当前检查轮次（1 起） | `3` |
| `$endurance_total_count` | 需要的连续达标轮数 | `3` |
| `$endurance_gate` | 门槛（含百分号） | `85%` |
| `$endurance_streak` | 当前连续达标数 | `1` |
| `$endurance_phase` | 当前阶段：`active` / `idempotent` | `idempotent` |
| `$endurance_deadline` | 计划结束时刻（本地时间 + 时区） | `2026-11-18 07:00 (Asia/Hong_Kong)` |
| `$endurance_remaining` | 距计划时刻剩余（超计划后为 `0m`） | `4h 12m` |
| `$endurance_duration` | 计划时长 | `8h` |
| `$endurance_round_attempt` | 本轮的注入次数（1 起） | `1` |
| `$endurance_checks_left` | 剩余可用轮次 | `96` |
| `$endurance_started_at` | 开始时刻 | `2026-11-17 23:00` |

规则：

- 只识别 `$endurance_*` 白名单；`set` 时做静态扫描，发现未知占位符直接拒绝并列出合法清单（防止模型写错变量导致注入内容失真）。
- `$$` 转义为字面量 `$`。
- 模板未使用某些占位符是允许的；关键判定信息由状态尾注保证。
- 渲染是纯函数：同一状态 + 模板必须得到同一文本（可单测）。

### 8.2 状态尾注

每次注入在模板渲染结果后追加一段由插件生成的状态说明（默认开启，可由配置关闭）。语言跟随模板：模板含 CJK 时用中文，否则英文；也可由配置强制。

**活跃阶段（未收敛、未超计划）：**

```text
---
【续航 · 第 3 轮】连续达标 1/3（门槛 85%）· 计划 8h（已用 2h10m / 剩余 5h50m）
【规则】连续 3 轮 ≥85% 即结束；若任务仍未完成，请调用 task_endurance_reset 继续。
【行动】完成核验后调用 task_endurance_post 汇报置信率。
```

**幂等巡检阶段：**

```text
---
【续航 · 幂等巡检】连续达标 3/3（门槛 85%）；本轮仅做核验，产物应保持不变。
【计划】每 1h 巡检一次，至 2026-11-18 07:00（剩余 5h50m）。
【行动】确认产物仍满足目标后调用 task_endurance_post；若发现回归或需要变更，调用 task_endurance_reset，回到活跃检查阶段。
```

**已超过计划时刻、仍未收敛：**

```text
【状态】已超过计划时长 1h20m（安全上限还剩 2h40m）；继续核验，直到达标或到达安全上限。
```

**本轮是重发（上一轮未收到 post/reset）：**

```text
【提醒】上一轮检查未收到 task_endurance_post 或 task_endurance_reset。本轮请务必用工具调用给出结论。
```

**Kickoff（首轮检查前的一次性提示，不计轮次）：**

```text
【续航】续航已登记（计划 8h，连续 3 轮 ≥85% 后进入幂等巡检）。请先完整执行一个任务回合：继续用工具推进任务，完成一轮后再汇报；在收到检查提示前不要声明最终完成。
```

### 8.3 渲染示例（用户给出的模板 + 第 3 轮）

```text
现在是第 3 轮检查，请你根据先前设定的目标检查当前任务的完成度并且核实是否满足用户设定的任务目标 ？
输出是否可以结束任务的置信率，连续 3 轮检查置信率均高于 85% 即可结束任务。
汇报置信率方式为工具调用：task_endurance_post ...，若你认为任务仍未完成尚需继续，请调用：task_endurance_reset

---
【续航 · 第 3 轮】连续达标 1/3（门槛 85%）· 计划 8h（已用 2h10m / 剩余 5h50m）
【规则】连续 3 轮 ≥85% 即结束；若任务仍未完成，请调用 task_endurance_reset 继续。
```

模型模板自己写的「达标即结束」描述在 `idempotent_soak` 模式下会与尾注冲突；尾注为权威判定，且 `$endurance_phase` 可用于让模板自行区分阶段。

---

## 9. 注入调度

### 9.1 触发源

| 触发 | 用途 |
|---|---|
| `agent/status` → `idle` | 活跃阶段主触发：回合结束且会话空闲时评估并注入。 |
| `agent/inbox/inserted` | 跟踪竞争入站消息（真人/schedule/goal 等），避免注入插队。 |
| `goal/changed` | goal 进入或离开活动轮次时暂停/恢复注入。 |
| 幂等 tick 定时器 | `idempotent_soak` 幂等巡检阶段：按固定间隔触发。 |
| 硬截止定时器 | `hard deadline` 到达时收尾。 |
| 工具调用 | `post`/`reset`/`cancel` 同步更新状态，可能立即收敛或切换阶段。 |
| `agent/created`（resume） | 从会话日志恢复运行并对空闲会话恢复驱动。 |
| 插件加载 | 对于已存在的活跃会话，重新挂载驱动（不要求重启 DSH）。 |

> 注意：`turn/end` 不是「会话空闲」信号——同一 driver 在 inbox 还有消息时会继续开下一个 turn，用 `turn/end` 触发注入会重复。必须以 `agent/status → idle`（无 driver 残留）为准。幂等 tick 则只按墙钟间隔触发，不看回合边界。

### 9.2 调度算法（伪代码）

```text
onTurnSettled(agent):
  run = stateOf(agent.session)
  if run == null or run.terminal: return
  if paused(run) or goalDriving(agent) or competingHumanMessage(agent): return
  if run.status == 'armed':
      if run.firstCheck == 'kickoff_sent' or workedSinceSet(agent):
          inject(run, round=1); return
      sendKickoff(run); return                 # 一次性，不计轮次
  if run.pendingRound != null:                # 检查消息已被消费但无 post/reset
      run.attempt += 1
      if run.attempt > maxUnansweredPrompts: settle('stalled'); return
      inject(run, sameRound, attempt, reminder=true); return
  if run.phase == 'idempotent': return        # 幂等阶段由 tick 驱动，回合结束不追加
  if exhausted(run): settle('exhausted'); return
  if run.streak >= run.streakRequired:        # 防御性：状态已达标但未结算
      settle(run.mode == 'converge' ? 'converged' : 'converged-or-idempotent')
      return
  scheduleInjectNow(run)                      # 活跃阶段 eager
```

```text
onIdempotentTick(agent):
  run = stateOf(agent.session)
  if run == null or run.terminal or run.phase != 'idempotent': return
  if now >= run.targetAt:
      if run.streak >= run.streakRequired): settle('converged'); return
  if run.pendingRound != null:                # 已有未响应检查
      run.skippedTicks += 1; return           # 幂等：跳过，不补发
  if agent.status !== 'idle' or goalDriving(agent) or paused(run):
      run.skippedTicks += 1; return           # 会话正在运行（真实回合），跳过
  if exhausted(run): settle('exhausted'); return
  inject(run, round+1, attempt=1, phase='idempotent')
```

```text
inject(run, round, attempt, phase):
  text = render(run.check_prompt) + footer(run, round, attempt, phase)
  msg  = createUserMessage({ content: [{type:'text', text}],
                             source: { kind: 'plugin:dsh-plugin-endurance',
                                       enduranceId: run.id, round, attempt, phase } })
  record('injected', { round, attempt, phase, at })
  run.roundsInjected += 1
  run.pendingRound = round
  agent.followup(msg)                         # 唤醒一个独立的检查回合
```

**首轮判定（`workedSinceSet`）**：从会话日志中找到 `task_endurance_set` 的调用事件，统计其之后是否出现至少一次**非 endurance 工具**的 `tool/result`（任务确实被执行过，而不是只做了规划）。是 → 直接注入第 1 轮；否 → 发一次 kickoff，等 kickoff 回合结束后**无论证据如何**都注入第 1 轮，避免空转。

结束评估（按优先级）：

```text
1. 模式 converge：streak >= N                     → converged
2. 模式 idempotent_soak：streak >= N ∧ now >= target → converged
3. checks >= maxChecks 或 now >= hardDeadline     → exhausted（可选注入一次收尾提示）
4. 未响应次数超限                                  → stalled
5. 否则按模式节奏继续注入
```

### 9.3 并发、幂等 tick 与「正在运行」

- 每个会话维护一个串行驱动（同一时刻只有一个评估/注入在途），所有触发合并到一次调度（对照 goal-round-driver 的 `state.run` 合并模式）。
- 注入前校验 `ctx.agents.get(id) === agent` 且 `agent.status === 'idle'`；不满足则丢弃本次触发，等待下一次 idle。
- 幂等 tick 的「正在运行」判定**只看 `agent.status === 'running'`**：
  - 该状态由 agent driver 的回合活动驱动；**后台 shell、后台任务、长跑进程、正在执行的 bash 不会让 `agent.status` 变为 running**，因此不会导致 tick 被跳过。
  - 插件**不检查操作系统进程表**，也不把「有后台任务」当作忙碌；避免误判导致整夜巡检都被跳过。
  - tick 到点时若 agent 正在真实回合中 → 跳过本次（记录 `skippedTicks`），不排队、不补发；下一次 tick 重新判定。
- 已有未响应检查时，tick 跳过（不堆叠检查消息），保证重复触发的效果幂等。
- 注入后立即持久化 `pendingRound`，并调用 `ctx.sessions.flush(agent.session)` 确认落盘；flush 返回 false（组合里没有持久化监听）时记录错误告警——消息已经投递、无法回滚，因此保留状态并继续，下一次注入前会再次尝试持久化。
- 定时器只保留一个「下一次动作」时间点，重复设置以最新为准；使用 `ctx.timeout`（Cordis timer，随 fiber 生命周期清理）或等价的 `unref` 定时器，重启后按绝对 epoch 时间重算。
- `withoutInitiator` 包裹调度，避免把插件自身误认成交互发起者（对照 goal-round-driver）。

### 9.4 用户介入与中止

- 真人消息到达时，清空 pending 定时器并让出本轮；该回合结束后再按节奏注入（不会在用户回合上「贴脸」连发）。
- 用户点「停止」导致回合以 `aborted` 结束时：设置短冷却（默认 10 分钟）后再恢复注入，避免与用户的即时意图对抗；冷却期间用户发消息则立即解除冷却。
- `cancel` 工具成功即终态，任何后续触发都不再注入。

### 9.5 与 goal 轮次协调

- 若会话存在 `goal` 且处于 `active + armed`（goal-round-driver 正在续跑）：**暂停 endurance 注入**（包括幂等 tick 也不触发）。goal 完成/暂停/解除武装后，在下一个 idle 恢复。
- 理由：goal 自身的轮次已经在驱动会话；同时注入会让每个回合收到两条自动消息，浪费 token 且语义冲突。
- goal 期间不产生 endurance 检查轮次，streak 不变；恢复后继续按自己的模式推进。

### 9.6 子代理

- 只为 root agent（`ctx.agents.roots()`）驱动注入；子代理的回合结束不触发。
- 模型在检查回合里可自行使用子代理；其完成通知按 DSH 既有语义处理，不影响 endurance 计数。

### 9.7 重启恢复

- 运行状态以 **session plugin record** 为唯一持久事实（§11）。插件加载或 `agent/created(resume)` 时读取最新记录重建内存态。
- 插件加载时遍历 `ctx.agents.list()` 中已存在的活 Agent 重新挂载驱动（安装/启用无需重启 DSH），但**不在加载当下立即 followup**——先等首个 `idle`，以免撞上进行中的回合。
- 定时器不持久化：重启后按记录中的绝对 `targetAt` / `nextTickAt` 重算；若 tick 时间已过，重启后的首个 idle 立即评估（幂等阶段最多补一次，不补发历史跳过的 tick）。
- 插件卸载时清除定时器、解除事件监听；若检查消息已排队但尚未消费，用 `agent.inbox.remove(messageId)` 撤回，避免插件消失后仍被检查消息唤醒。
- 会话未打开（归档/未恢复）时不注入；恢复打开后继续。

---

## 10. 停止、异常与安全上限

### 10.1 终态

| 终态 | 触发 | 记录内容 | 后续行为 |
|---|---|---|---|
| `converged` | `converge`：连续 N 轮达标；`idempotent_soak`：到计划时刻仍连续达标 | 结束时刻、模式、阶段、最终 streak、最后一轮 | 停止注入；客户端 M2 显示成功状态 |
| `cancelled` | 用户在对话中明确取消 | 取消原因、取消时刻 | 停止；用户可重新 `set` |
| `exhausted` | 硬截止 / 轮次上限 | 原因、模式、阶段、最后置信率、未解决项 | 可选注入 1 次收尾提示（要求模型给出当前产物与未完成清单），然后停止 |
| `stalled` | 连续未响应超限 | 未响应轮次、最近错误 | 停止并落记录；不无限重发 |

### 10.2 失败与异常

- **模型工具调用失败/报错**：不改变运行状态；在下一个检查回合重试。`agent/error` 计数达到 3 次连续错误 → `stalled`（避免夜间反复失败烧钱）；每次成功计分的 `post` 会把连续错误计数清零。
- **工具参数畸形**（非对象/缺字段/类型错误）：按 `ENDURANCE_INVALID_PARAMS` 或对应状态错误返回，不允许抛出未捕获的 `TypeError`。
- **注入失败**（`followup` 抛错）：记录 warn 日志，保留状态，下次 idle / 下一个 tick 重试；连续 3 次失败 → `stalled`。
- **幂等 tick 连续被跳过**：只记录 `skippedTicks`，不视为错误；到计划时刻会直接结算（若 streak 仍满足）。
- **插件卸载/禁用**：清除定时器与内存态；会话中已有记录保留，重新启用后恢复。
- **会话删除/归档**：记录随会话日志处理；插件无需额外清理。
- **状态记录损坏**：读取时 schema 校验失败 → 视为无活动运行并记录诊断，不阻塞会话。

### 10.3 上限与派生默认值

| 限制 | 默认值 | 说明 |
|---|---|---|
| 计划时长下限 | 1m | 低于此值拒绝 |
| 计划时长上限 | 24h | 可通过配置放宽；夜间场景足够 |
| 连续轮数上限 | 20 | 越大收敛越保守，token 越多 |
| 置信率门槛 | 0–100 | 85 为建议值 |
| 宽限期 grace | `clamp(25% × duration, 30m, 4h)` | 计划时刻之后允许继续核验的窗口；超过即硬截止 |
| 最大检查轮次 | 100 | 含重发与幂等巡检 |
| 未响应重发上限 | 3 | 每轮内 |
| 检查最小间隔 | 30s | 活跃阶段防紧密循环 |
| 幂等巡检间隔 | `clamp(duration / 8, 5m, 2h)` | `idempotent_soak` 专用；也可在 `set` 时指定 |

---

## 11. 持久化

### 11.1 方案

会话日志是唯一持久事实源。插件通过宿主 `dsh-session` 的 **plugin record** 机制写入（`appendPluginRecord`，类型须符合 `plugin:<segment>/<segment>` 语法），记录标记为 `ignorable`：即使插件缺失，会话仍可正常加载；fork/resume 会带着记录一起走。

记录类型（固定）：

```text
plugin:dsh-plugin-endurance/state
```

每次状态迁移追加一条**完整状态快照**（而非增量事件）。快照体积小（约 1–4 KB，历史轮次裁剪到最近 50 条），实现简单、恢复无歧义；记录不进入模型可见上下文。

备选方案（v0.1 不采用）：用 `ctx.storageDomain.open()` 建独立文件存储做跨会话索引。理由：运行状态天然属于会话，plugin record 随 fork/resume 一起走，无需额外生命周期与清理；只有未来需要「全局续航总览」时才考虑 storageDomain。

### 11.2 快照结构

```json
{
  "schemaVersion": 1,
  "runId": "end_...",
  "sessionId": "...",
  "status": "running",
  "mode": "idempotent_soak",
  "phase": "idempotent",
  "createdAt": 1763382000000,
  "targetAt": 1763410800000,
  "hardDeadlineAt": 1763418000000,
  "durationMs": 28800000,
  "gate": 85,
  "streakRequired": 3,
  "checkPrompt": "现在是第 $endurance_id 轮检查……",
  "idempotentIntervalMs": 3600000,
  "nextTickAt": 1763390000000,
  "firstCheck": "started",
  "round": 5,
  "attempt": 1,
  "streak": 3,
  "lastCountedRound": 5,
  "pendingRound": 5,
  "roundsInjected": 5,
  "ticksSent": 2,
  "skippedTicks": 0,
  "consecutiveErrors": 0,
  "pausedUntil": null,
  "pauseReason": null,
  "history": [
    { "at": 1763385600000, "kind": "post", "round": 2, "confidence": 86, "summary": "…" },
    { "at": 1763387400000, "kind": "reset", "round": 3, "reason": "…" }
  ],
  "toolNames": { "set": "task_endurance_set", "post": "task_endurance_post", "reset": "task_endurance_reset" }
}
```

- `mode` / `phase` / `idempotentIntervalMs` / `nextTickAt` 是幂等巡检恢复的关键。
- `firstCheck`：`pending` / `kickoff_sent` / `started`，用于恢复首轮判定。
- 历史只保留最近 50 条轮次记录（导出给 `status` 时同样截断）。

### 11.3 恢复与投影

- 恢复：从会话事件中筛出 `type` 匹配且 `ignorable` 的记录，取最后一条合法快照；校验 `schemaVersion` 与必填字段。失败则视为无运行。
- M2 客户端：注册 session projection（key `endurance`），由 plugin record 折叠出只读视图（状态、模式、阶段、计划进度、streak、最近轮次），供会话流状态行/设置页使用；`wire` 只暴露客户端所需字段。
- 记录只在状态变化时追加（set/kickoff/inject/post/reset/phase/tick/settle），不会每轮写多份。

### 11.4 版本与清理

- `schemaVersion` 单调递增；不兼容变更时旧记录视为过期（忽略并允许重新 `set`），不做原地迁移。
- 终态记录永久保留（体积极小，供审计）；会话删除时随日志一起消失。

---

## 12. 配置

v0.1 使用宿主 profile 的 `cordis.patch.yml` 配置，读取时钳制越界值（对照社区插件的 `readOptions` 模式），不做设置页。

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时仍注册工具但 `set` 返回禁用错误。 |
| `maxDurationHours` | `24` | `set` 的计划时长上限。 |
| `maxChecks` | `100` | 每次运行的最大注入轮次（含巡检）。 |
| `maxUnansweredPrompts` | `3` | 每轮未响应重发上限。 |
| `minCheckGapMs` | `30000` | 活跃阶段两次注入的最小间隔。 |
| `idempotentIntervalMinMs` / `idempotentIntervalMaxMs` | `300000` / `7200000` | 幂等间隔的钳制区间。 |
| `abortCooldownMs` | `600000` | 用户中止后的冷却。 |
| `injectFooter` | `true` | 是否追加状态尾注。 |
| `footerLocale` | `auto` | `auto` / `zh` / `en`。 |
| `finalizeOnExhaustion` | `true` | 耗尽时是否注入一次收尾提示。 |

---

## 13. 技术架构

### 13.1 交付形态

沿用社区插件的**零构建纯 ESM JS** 路线（`package.json` → `main: index.js`，无 bundler）：

```text
dsh-plugin-endurance/
├── package.json                 # dsh.bundle.patch + dsh.client（M2）
├── cordis.patch.yml             # 一行 insert：id=endurance, name=dsh-plugin-endurance
├── index.js                     # host 入口：apply() 组装依赖
├── src/
│   ├── host-modules.js          # 宿主模块桥（session/llm/tools 实例解析）
│   ├── config.js                # readOptions + 钳制
│   ├── domain/
│   │   ├── state.js             # 纯状态机、模式/阶段与派生标志
│   │   ├── prompt.js            # 模板校验、占位符渲染、尾注、kickoff 文案
│   │   └── limits.js            # 上限派生（grace、幂等间隔、maxChecks）
│   ├── service.js               # 运行注册表、持久化、状态迁移
│   ├── driver.js                # idle/tick 调度、首轮判定、注入、竞态防护
│   ├── authority.js             # 人类回合 / 检查回合判定
│   └── tools.js                 # 5 个工具定义
├── client.js                    # M2：状态行 / 命令 / 设置
├── locale/{en,zh}.json          # 包元数据
├── icon.svg
├── test/                        # node --test
├── docs/DESIGN.md
└── README.md
```

### 13.2 宿主模块桥

第三方插件目录不在宿主依赖图内，运行时不能直接 `import '@deepseek-ai/dsh-session'`。但有两处需要**宿主实例**：

- `appendPluginRecord` / `pluginRecordOf`：内部有 module-private brand 校验，必须用宿主已加载的那份 `@deepseek-ai/dsh-session`；
- `createUserMessage` / `HarnessError`：用宿主实例最稳（避免双份 brand/行为差异）。

实现方式（对照 `dsh-plugin-portara` 的 `records.js`）：以 `ctx.baseUrl`、`process.cwd()`、`import.meta.url` 为锚点 `createRequire(...).resolve('@deepseek-ai/dsh-session')`，向上找到包根，优先加载源码入口 `src/index.ts`（源码 checkout 由 TS loader 运行），再试 `lib/index.js`（构建部署），并用一个真实 append 探测确认实例可用。解析失败时：

- 工具仍注册，但 `set` 返回 `ENDURANCE_INTERNAL` 并说明「持久化不可用」；
- 或整体停用并打日志（v0.1 取后者：宁可不工作，也不要产生不可恢复的假状态）。

> 该桥不引入任何 npm 运行时依赖，只按路径加载宿主已安装的模块实例。

### 13.3 关键契约依赖

| 契约 | 位置（DSH 源码） | 用途 |
|---|---|---|
| `agent.followup(message)`、`agent/status`、`agent/inbox/inserted`、`agent/turn-stopping` | `packages/core/agent` | 注入检查回合、感知 idle 与竞争消息 |
| `agents.roots()`、`agents.get()`、`agents.list()`、`agents.turnBoundaryOf()`、`agents.withoutInitiator()` | `packages/core/agent` | 权限判定、liveness、回合边界、加载时重挂 |
| `createUserMessage`、`MessageSourceMap` 合并扩展 | `packages/llm/llm` | 构造检查/kickoff 消息、声明 `plugin:dsh-plugin-endurance` 来源 |
| `defineTool`、`ctx.tools.register` | `packages/interaction` / `packages/core/tools` | 工具注册与 output/render |
| `ctx.sessions.flush` | `packages/core/session` | 注入后的持久化确认（fail-closed） |
| `ctx.timeout`（Cordis timer） | `vendor/timer` | 幂等 tick / 硬截止定时，随 fiber 清理 |
| `appendPluginRecord`、`pluginRecordOf`、`SessionEventMap` | `packages/core/session` | 持久化运行状态 |
| `ctx.sessionProjections.register` | `packages/session/session-projection` | M2 客户端投影 |
| goal round driver 的 fencing/合并模式 | `packages/goal/goal-round-driver` | 调度实现参照 |
| `HarnessError` | `packages/llm/llm` | 结构化工具错误 |

### 13.4 模块职责

- `service.js`：内存运行注册表（sessionId → run），状态迁移唯一入口；所有迁移先落 record 再更新内存；提供 `get/ensure/transition`。
- `driver.js`：监听 agent 事件与定时器；持有串行队列；调用 `authority` 与 `prompt`，执行首轮判定、kickoff、活跃阶段注入与幂等 tick；不直接改状态字段，统一走 `service.transition`。
- `domain/state.js`：纯函数；输入快照 + 事件，输出新快照/阶段/派生标志；100% 单测覆盖。
- `tools.js`：参数校验 → 模式校验 → 授权 → 调 service → 返回视图；把 `HarnessError` 交给框架转成模型可见错误。
- `prompt.js`：占位符白名单与渲染；活跃/幂等/超计划/重发四种尾注；kickoff 文案；模板静态校验。
- `authority.js`：读取开放回合事件（`agents.turnBoundaryOf` + session 快照）判定直接人类输入 / 匹配检查消息，逻辑与 goal 工具同构。

---

## 14. 客户端呈现（M2）

- **检查回合行**：检查消息（`source.kind = plugin:dsh-plugin-endurance`）在会话流里渲染为可折叠的「续航检查 · 第 N 轮」或「续航巡检 · 第 N 次」行，展开显示门槛、streak、阶段、计划进度；区别于真人消息。
- **状态条**：会话顶部/输入区显示 `⏳ 续航 2/8h · 连续达标 1/3 · 85% · 活跃`；幂等阶段显示 `🔁 巡检中 · 3/3 · 每小时`；`converged` 后变为完成态，`exhausted/stalled/cancelled` 显示对应颜色与原因。
- **命令**（M2）：
  - `/endurance status`：查看当前运行（无运行返回提示）。
  - `/endurance stop`：等价于带人类授权的 `cancel`。
  - `/endurance extend <duration>`：追加计划时长（更新 target 与安全上限，不重置 streak；幂等阶段自动顺延巡检终点）。
- **设置页**：若配置改为 schemastery schema，可自动生成表单；否则 M2 先只读展示。
- 技术路径：host 注册 `endurance` session projection（§11.3），client 通过 `useProjection('endurance')` 取状态；检查行通过 conversation definition 按记录/来源渲染。

---

## 15. 测试计划

### 15.1 单元（node:test，纯函数）

- 时长解析：`8h` / `90m` / `1d` / `0.5h` / 越界 / 非法格式。
- 模式参数：缺模式 → `ENDURANCE_MODE_REQUIRED`；`idempotent_interval` 缺省派生与钳制；模式与间隔的组合校验。
- 占位符渲染：全部变量、`$$` 转义、未知变量、CJK/英文尾注选择、`$endurance_phase`。
- 上限派生：grace、幂等间隔、maxChecks 的钳制。
- 状态机：两种模式全部转换（post 同轮去重、reset 回退、达标立即收敛、进入幂等阶段、tick 跳过、到计划时刻收敛、回归后重算、硬截止、stalled、kickoff）。
- 授权判定：直接人类回合、检查回合匹配、非检查回合拒绝、root/子代理。
- 首轮判定：set 后有任务工具调用 → 直接检查；否则 kickoff 一次。

### 15.2 集成（伪造 Agent/Session + 真实纯函数）

- 回合结束 → 首轮判定 → 注入/kickoff。
- `converge`：连续达标即收敛。
- `idempotent_soak`：达标后按间隔 tick；tick 时 `agent.status='running'` 跳过；后台任务存在但状态 idle 时正常注入；到计划时刻收敛。
- 巡检阶段回归（低置信率/reset）→ 回活跃阶段重新累计。
- 用户消息插队 → 不注入；用户回合结束后恢复。
- goal 活动 → 暂停（含 tick）；goal 结束 → 恢复。
- 未响应 → 同轮重发 max 次 → stalled。
- 插件重载 → 从 plugin record 恢复（含 phase / nextTickAt）。

### 15.3 端到端（本地 DSH Web/headless）

| 场景 | 预期 |
|---|---|
| `converge` + 计划 8h / 3 轮 / 80%，模型很快连续通过 | 连续 3 轮达标后立即结束（可能远早于 8h） |
| `idempotent_soak` + 计划 8h / 3 轮 / 85% / 1h 间隔 | 先连续 3 轮达标 → 之后每小时巡检 → 07:00 收敛 |
| 同上，某个 tick 到点时模型正在长回合中 | 该 tick 跳过并记录；下一 tick 继续 |
| 同上，tick 到点时只有后台 shell 在跑、会话 idle | 正常注入巡检（不把后台 shell 当运行中） |
| 巡检中某轮报告 70% | streak 归零，回活跃阶段；重新累计 3 轮后（若已过计划时刻）立即收敛 |
| 模型首轮只做规划、结束回合 | 先收到一次 kickoff，执行一个任务回合后才开始检查 |
| 模型只 reset 不 post | 持续注入直到上限，终态 `stalled` |
| 检查回合中用户发消息 | 不插队；用户回合后恢复 |
| DSH 重启 | 运行从日志恢复（模式/阶段/tick 时间）；不重复计数 |
| 用户要求停止 | `cancel` 成功，不再注入 |

### 15.4 验收清单（对应 issue #1）

- [ ] 5 个工具契约与 JSON Schema 在文档定稿（含模式参数）。
- [ ] 两种收敛模式的判定、阶段转换、幂等 tick、跳过规则明确。
- [ ] 计划时长语义、连续计数、reset 语义、post 幂等均有明确规则。
- [ ] 占位符与尾注规则定稿，含渲染 fixture。
- [ ] 注入调度（首轮判定、kickoff、idle、tick、竞态、用户介入、goal、重启）定稿。
- [ ] 安全上限与终态表定稿。
- [ ] 持久化记录结构定稿。
- [ ] 测试计划覆盖上述规则。
- [ ] 用户确认 §18 待确认项。

---

## 16. 里程碑

| 里程碑 | 内容 | 交付 |
|---|---|---|
| M0 设计（本 issue） | 本文档评审通过 | PR |
| M1 Host MVP | 模块骨架、宿主模块桥、状态机（两种模式）、5 工具、首轮判定/kickoff、注入驱动、幂等 tick、持久化、单测 | 可在本地 profile 启用并跑通短场景 |
| M2 客户端 | 检查行、状态条、`/endurance status|stop|extend`、投影 | 可视化与用户控制 |
| M3 发布 | README、banner、CHANGELOG、release 流程 | 可安装版本 |

---

## 17. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 时长是**计划参考**（用户确认）；`converge` 模式不等到计划时刻 | 任务提前达标就应该结束；时长只决定模式相关时机与安全上限 |
| D2 | 同一会话同时最多一个活动运行；终态后可重新 `set` | 状态简单、可审计；避免多个循环互相插队 |
| D3 | 「轮次」= 注入次数；每轮最多计一次 post；reset 清零 | 防刷、可重放、与注入消息一一对应 |
| D4 | 两种收敛模式（用户确认）：`converge` 达标即结束；`idempotent_soak` 达标后幂等巡检至计划时刻 | 同时满足「尽快收尾」与「整夜保持核验」两种使用方式 |
| D5 | 检查提示词由模型生成，插件只做插值与尾注 | 检查内容依赖具体任务；插件不应假装理解业务 |
| D6 | 注入用 `agent.followup(source=plugin:...)`，在 idle 时发生 | 复用宿主既有续跑机制；不与进行中的回合竞争 |
| D7 | post/reset 绑定匹配检查回合；set/cancel 绑定人类回合 | 防止模型自导自演、凑轮次或擅自套上/取消长时约束 |
| D8 | `set`/`cancel` 要求 root agent 的直接人类输入；`set` 只能由用户授权设定（用户确认） | 长跑授权必须可追溯，与 goal create 一致 |
| D9 | 持久化用 plugin record 快照，宿主 session 模块桥写入 | 官方支持的第三方持久化路径；重启/fork 可恢复 |
| D10 | goal 活动期间暂停注入（含 tick） | 避免双驱动与 token 浪费 |
| D11 | 用户中止后短暂冷却再恢复 | 尊重「停止」意图，同时不永久中断夜间任务 |
| D12 | 安全上限：轮次、宽限期、未响应、连续错误 | 无人值守场景必须有界 |
| D13 | 零构建纯 ESM JS + JSDoc；node:test | 与社区插件生态一致，安装即用、无需构建 |
| D14 | v0.1 无客户端 UI；M2 再做投影与命令 | 先保证 Host 语义正确，UI 后置 |
| D15 | 检查消息来源用 `plugin:dsh-plugin-endurance` | 与真人/goal/schedule 可区分，客户端可定制渲染 |
| D16 | 首轮检查在完成一个任务回合后开始；必要时先发一次 kickoff | 避免「刚登记就自问自答」；也避免 set 后无人唤醒 |
| D17 | M2 提供 `/endurance status`、`/endurance stop`、`/endurance extend`（用户确认） | 需要用户侧可见的查询、停止与延长手段 |
| D18 | 收敛模式必须由用户明确选择；缺模式时 `set` 返回 `ENDURANCE_MODE_REQUIRED`，模型须先询问 | 用户明确要求「没说明时模型主动提问」；两种模式行为差异大，不能默认 |
| D19 | 幂等 tick 只看 `agent.status` 判断「正在运行」；后台 shell/任务不算；到点忙碌则跳过且不补发 | 后台进程不应导致整夜巡检被跳过；幂等语义要求重复触发不堆叠 |
| D20 | 幂等巡检只验证、产物保持不变；发现回归用低置信率或 reset 回到活跃阶段 | 保证「整夜巡检」验证的是同一份稳定产物 |

---

## 18. 评审结论与待确认项

### 18.1 已确认

1. 收敛语义：`converge`（设定时间内连续达标即结束）与 `idempotent_soak`（达标后幂等巡检至计划时刻）两种模式并存（§5.3 / D4）。
2. 模式未明确时由模型主动询问；`set` 缺模式会返回 `ENDURANCE_MODE_REQUIRED`（§7.1 / D18）。
3. `set`/`cancel` 严格授权：必须在用户直接输入的回合调用（§7.7 / D8）。
4. 幂等巡检按固定幂等时间 tick；tick 到点若会话正在运行则跳过，后台 shell 不算运行中（§5.6 / §9.3 / D19）。
5. 首轮检查等模型先完整执行一个任务回合；只做规划时先发一次 kickoff（§9.2 / D16）。
6. 安全默认值：时长上限 24h、轮次上限 100、未响应重发 3 次、宽限期 25%（§10.3）。
7. M2 命令：`/endurance status`、`/endurance stop`、`/endurance extend <duration>`（§14 / D17）。
8. 幂等间隔默认值：`clamp(duration / 8, 5m, 2h)`，模型也可在 `set` 时显式指定（§10.3 / §5.5）。
9. 幂等巡检阶段的产物策略：只验证、产物保持不变；任何返工或改进都必须调用 `reset`，回到活跃阶段重新累计（§5.6 / D20）。

### 18.2 待确认

无。设计已定稿，进入 M1 实现。


---

## 19. 参考

- 官方 goal 轮次驱动：`packages/goal/goal-round-driver`（同会话自动续跑、fencing）。
- 官方 goal 工具：`packages/goal/tool-goal`（人类授权、工具契约、系统提示段落）。
- 官方持久化：`packages/core/session`（`appendPluginRecord` / `pluginRecordOf`）。
- 社区插件：`dsh-plugin-portara`（宿主模块桥、plugin record、会话流 UI 行）、`dsh-plugin-btw`（零构建 bundle、命令注册、设计文档骨架）。
