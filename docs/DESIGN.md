# dsh-plugin-endurance — 设计

> 代号：**endurance（续航）**
> 仓库：`Dynesshely/dsh-plugin-endurance` · 设计 issue：#1 · 状态：草案 v0.1（评审中）
> 本文面向用户评审：先定语义与契约，再按里程碑实现。

---

## 1. 摘要

`dsh-plugin-endurance` 为 DSH 的长程任务加一条「续航约束」：用户为任务声明**最短墙钟时长**与**收敛门槛**（连续 N 轮自检置信率 ≥ G）。模型在理解用户提示词后，生成检查提示词模板，并调用 `task_endurance_set` 登记本次续航运行。

登记后，插件在**每个任务回合结束、会话转入空闲时**自动向同一会话注入一轮「按模板渲染出的检查提示词」（以插件自有来源的 user 消息形式）。模型在检查回合里核验任务，然后二选一：

- 调用 `task_endurance_post` 汇报本轮置信率（达到门槛则累计一轮「连续达标」）；
- 调用 `task_endurance_reset` 表示任务尚未完成，需要继续（连续达标计数清零）。

插件只在**时长已满且连续 N 轮达标**时收敛、停止注入。若模型提前收尾，剩余时长被用于多轮核验与加固；若模型始终无法达标，插件在安全上限处停止并留下明确的终态与原因。目标：用户第二天醒来拿到的不是「提前收尾的半成品」，而是一份经过多轮核验、满足声明的产物。

---

## 2. 目标与非目标

### 2.1 目标

1. 用户用自然语言声明「时长 + 收敛轮数 + 置信率门槛」，模型转成结构化参数，经工具调用登记。
2. 检查提示词由模型根据任务生成（`check_prompt` 模板 + 占位符），插件不替模型编检查内容。
3. 插件自动驱动「任务回合 → 检查回合 → 任务回合」循环，直到满足结束条件；用户无需守着。
4. 时长是**下限**：到点前即使置信率达标也不结束，剩余时间用于深化、加固与补充证据。
5. 结束条件可审计：每轮注入、每次 post/reset、终态原因都落会话日志；重启后可恢复。
6. 无人值守安全：轮次上限、宽限期、停滞判定、错误计数、用户中止优先级；不无限夜跑。
7. 与 DSH 既有机制（goal 自动轮次、schedule、用户消息、子代理）不打架。

### 2.2 非目标（v0.1）

- 不做跨会话、跨工作区的续航编排。
- 不替代 `goal` / `schedule`：goal 负责「把目标做完」，endurance 负责「做满时长并核验到位」。
- 不自动生成或改写用户的任务内容与检查标准。
- 不在 v0.1 提供客户端 UI（状态行、命令、设置页属 M2）。
- 不承诺模型一定产出合格产物；插件保证的是流程约束与可审计性。

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| **续航运行（run）** | 一次由 `task_endurance_set` 登记的约束，隶属于一个会话，同一时刻最多一个活动运行。 |
| **截止时刻（deadline）** | `created_at + duration`。到达后才可能收敛。 |
| **硬截止（hard deadline）** | `deadline + grace`，正常情况下不再注入检查的时间上限（用于收尾）。 |
| **检查轮次（round）** | 插件注入一次检查提示词即一轮；同一轮内因未响应而重发只增加 `attempt`，不增加轮次。 |
| **达标（pass）** | 该轮 `post` 的置信率 `confidence >= gate`。 |
| **连续达标（streak）** | 自上次 `reset` 起，连续达标且已计分的轮次数。 |
| **收敛（converged）** | 正常成功终态：`now >= deadline` 且 `streak >= required`。 |
| **检查消息（check message）** | 插件注入的 user 角色消息，`source.kind = plugin:dsh-plugin-endurance`，携带 `enduranceId/round/attempt`。 |
| **状态尾注（footer）** | 插件在渲染后的模板末尾追加的、由插件生成的判定说明（时间门槛、轮次、连续达标数）。 |

---

## 4. 端到端流程

对应用户给出的 5 步：

```text
用户：规划一个长程任务，时长 8h 左右，收敛检查至少 3 轮置信率均 ≥85%，……
  │
模型：理解提示词 → 生成 check_prompt 模板
模型：调用 task_endurance_set(duration="8h", min_consecutive_passes=3,
                              confidence_gate=85, check_prompt="现在是第 $endurance_id 轮检查……")
  │        ← 返回运行 id、deadline、门槛；落一条 plugin record（armed）
模型：正常推进任务（读文件、改代码、跑测试……），结束回合
  │
agent/status → idle
  │
插件：评估结束条件
  ├─ 未到点 / 未收敛 → 渲染第 1 轮检查消息 → agent.followup(check message)
  │
模型：收到检查 → 核验任务
  ├─ 任务未完成   → task_endurance_reset(reason)        → streak 清零，继续
  └─ 有把握完成   → task_endurance_post(confidence, …)  → 达标则 streak+1
  │
插件：更新状态、落记录；回合结束后按节奏注入下一轮
  │
……（循环，可能跨越数小时，期间可被用户消息或 goal 轮次打断/让位）……
  │
到点（deadline）且连续 3 轮 ≥85% → converged → 停止注入，留下终态记录
```

补充规则：

- 第 1 轮检查在 `set` 所在回合结束、会话空闲后注入；`set` 本身不立即触发检查。
- 到点时若 `streak` 已满足，插件**直接收敛**（不需要额外再检查一轮），由 deadline 定时器兜底。
- 到点时若 `streak` 未满足，继续按「未达标」节奏注入，直到达标或触达硬截止/轮次上限。

---

## 5. 核心语义

### 5.1 时长语义：下限，不是预算

- `created_at` = `task_endurance_set` 成功写入的时刻（墙钟）。
- `deadline = created_at + duration`；`hard_deadline = deadline + grace`。
- **到达 deadline 之前，插件不会因 `streak` 满足而收敛。** 剩余时间用于：
  - 继续注入检查（已达标时按 soak 节奏），促使模型深化、加固、补证据；
  - 让模型在两轮检查之间继续实际工作（模型在检查回合里可继续使用工具）。
- 用户中止、取消、达到安全上限是仅有的提前退出途径。
- 时钟使用墙钟：机器休眠/宿主暂停期间时间照常流逝；恢复后按当前时刻重新评估。

### 5.2 检查轮次

- 轮次从 1 开始；每次**新注入**检查消息 `round += 1`。
- 注入后模型所在回合结束仍未调用 `post` / `reset`：视为「本轮未响应」，`attempt += 1`，重发**同一轮**（`$endurance_id` 不变），并在状态尾注中提示「上一轮检查未收到汇报」。
- `attempt` 达到 `maxUnansweredPrompts`（默认 3）→ 终态 `stalled`。
- 轮次总数（含重发）不超过 `maxChecks`（默认 100）→ 终态 `exhausted`。

### 5.3 达标、连续计数与收敛

- `pass = confidence >= gate`（闭区间，`85` 表示 85%）。
- 一个已计分轮次：
  - `pass` → `streak += 1`；
  - `!pass` → `streak = 0`；
  - `reset` → `streak = 0`，该轮不计分。
- 收敛判定（任一次状态变化或定时器触发时求值）：
  ```
  converged ⇔ now >= deadline ∧ streak >= min_consecutive_passes
  ```
- 注意：达标之后继续 soak 检查时，若某轮置信率掉到门槛以下，`streak` 归零，需要重新累计 N 轮 —— 这是有意设计（后期发现新问题应阻止收敛）。

### 5.4 幂等与防伪

- **post 必须发生在匹配的检查回合内**：当前开放回合中必须存在一条检查消息，其 `enduranceId`、`round` 与运行状态一致；否则拒绝（`ENDURANCE_NOT_A_CHECK_ROUND`）。
- **每轮最多计一次 post**：同轮重复 post 返回 `counted: false`（仍记录 summary 供审计，不影响 `streak`）。
- **reset 优先**：同一轮先 post 后 reset，reset 生效并回退该轮计分。
- 检查消息来源 `source.kind = plugin:dsh-plugin-endurance`，与真人消息、goal 轮次、schedule 投递可区分。
- `set` / `cancel` 需要当前回合存在直接人类输入（root agent），防止模型自导自演登记/取消（见 §7.7）。

### 5.5 节奏（cadence）

| 情形 | 下一轮检查时机 |
|---|---|
| `armed` 后首轮 | 本回合结束、会话空闲后立即（受 `minCheckGap` 约束） |
| 未达标（`!pass`）或 `reset` 后 | 空闲后尽快（eager），让模型继续干活 |
| 已达标但未到 deadline | soak：距上次检查至少 `soakGap`（默认 `clamp(duration/(2N), 5m, 30m)`） |
| 到点且 `streak >= N` | 立即收敛，不再注入 |
| 到点且 `streak < N` | eager 继续，直到达标或硬截止 |
| 硬截止 / 轮次上限 | 不再注入；可选注入一次收尾提示后终态 |

soak 的意义：避免模型「每轮秒回 90%」把 8h 变成几十分钟的自我确认循环，同时给实际深化工作留出时间窗口。

---

## 6. 状态机

### 6.1 状态

| 状态 | 是否终态 | 含义 |
|---|---|---|
| `armed` | 否 | 已登记，尚未注入第一轮检查。 |
| `running` | 否 | 循环进行中（含未达标、已达标 soak、到点未达标三种子情形，由派生标志区分）。 |
| `converged` | 是 | 正常成功：到点且连续达标。 |
| `cancelled` | 是 | 用户要求取消。 |
| `exhausted` | 是 | 达到硬截止/轮次上限仍未收敛。 |
| `stalled` | 是 | 连续多轮检查未收到 post/reset（模型不配合或反复失败）。 |

派生标志（随每次工具返回与状态查询给出）：`time_gate_met`、`gate_met`（`streak >= N`）、`can_conclude`、`pending_round`、`paused`。

### 6.2 转换

| 当前 | 触发 | 条件 | 动作 | 下一状态 |
|---|---|---|---|---|
| — | `set` | 无活动运行；校验通过；直接人类回合 | 写 record（run）、计算 deadline | `armed` |
| `armed` | 回合结束（idle） | 未暂停、无竞争入站消息 | 注入第 1 轮 | `running` |
| `running` | `post` 计分 | `pass` | `streak += 1` | `running` 或 `converged`（到点且达标） |
| `running` | `post` 计分 | `!pass` | `streak = 0` | `running` |
| `running` | `reset` | 匹配检查回合 | 回退该轮、`streak = 0` | `running` |
| `running` | 回合结束 | 本轮未响应，`attempt < max` | 重发同轮 | `running` |
| `running` | 回合结束 | 本轮未响应，`attempt == max` | 记录原因 | `stalled` |
| `running` | 定时器/回合结束 | `now >= hard_deadline` 或 `checks >= maxChecks` | 可选收尾提示，记录原因 | `exhausted` |
| `armed` / `running` | `cancel` | 直接人类回合 | 记录原因 | `cancelled` |
| 任意终态 | `set` | 新参数校验通过 | 新 run id，历史保留 | `armed` |

终态不可再被 `post` / `reset` 推进；工具返回 `ENDURANCE_NOT_ACTIVE` 并携带终态视图。

---

## 7. 工具契约

所有工具在插件加载时全局注册；是否使用由模型判断。返回值为 JSON（经 `output.render` 渲染为文本）。输入非法或状态不允许时抛出结构化错误（`HarnessError`，带稳定 `code`）。

### 7.1 `task_endurance_set`

登记一次续航运行。

**参数**

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `duration` | string | 是 | `^\d+(\.\d+)?\s*[mhd]$`，1m ≤ d ≤ 24h（默认上限可配） | 最短墙钟时长，如 `8h`、`90m`、`1d`。 |
| `min_consecutive_passes` | integer | 是 | 1 ≤ N ≤ 20 | 连续达标轮数。 |
| `confidence_gate` | number | 是 | 0 ≤ G ≤ 100 | 达标置信率（百分比），如 `85`。 |
| `check_prompt` | string | 是 | 20 ≤ 长度 ≤ 8000 | 每轮检查提示词模板，支持 `$endurance_*` 占位符（见 §8）。 |

**返回（成功）**

```json
{
  "ok": true,
  "run": {
    "id": "end_0192f...",
    "status": "armed",
    "duration_ms": 28800000,
    "created_at": "2026-11-17T23:00:00+08:00",
    "deadline_at": "2026-11-18T07:00:00+08:00",
    "hard_deadline_at": "2026-11-18T09:00:00+08:00",
    "min_consecutive_passes": 3,
    "confidence_gate": 85,
    "streak": 0,
    "rounds_injected": 0,
    "max_checks": 100
  },
  "message": "Endurance armed. The first check runs after this turn ends. Keep working on the task until then."
}
```

**错误**：`ENDURANCE_ALREADY_ACTIVE`（附当前运行视图与建议）、`ENDURANCE_INVALID_PARAMS`（附具体字段）、`ENDURANCE_PROMPT_INVALID`（未知占位符）、`ENDURANCE_AUTHORITY_REQUIRED`（当前回合无直接人类输入）。

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
  "streak": 2,
  "streak_required": 3,
  "round": 4,
  "time_gate_met": false,
  "gate_met": false,
  "can_conclude": false,
  "deadline_at": "2026-11-18T07:00:00+08:00",
  "remaining_ms": 15120000,
  "next_check_after_ms": 1800000,
  "message": "Round 4 recorded (86 ≥ 85). 2/3 consecutive passes. Duration not reached; the run will continue."
}
```

- `can_conclude: true`：本轮使运行收敛，不再有检查注入；模型应在当前回合给出最终产物说明。
- 同轮重复调用：`counted: false`，`streak` 不变，附提示。
- `time_gate_met: true && streak < N`：提示「时长已满，还需连续 N 轮达标」。

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
  "message": "Reset recorded. Consecutive passes cleared; continue the task, the next check follows this turn."
}
```

**错误**：`ENDURANCE_NOT_ACTIVE`、`ENDURANCE_NOT_A_CHECK_ROUND`。

### 7.4 `task_endurance_status`

只读查询当前运行（模型与用户排查用）。无参数。

**返回**：运行完整视图（`run` 字段，含派生标志、最近若干轮历史、上限与暂停原因）；无活动运行时返回 `{ "ok": true, "run": null }`。

### 7.5 `task_endurance_cancel`

取消当前运行（仅当用户在对话中明确要求停止时使用）。

**参数**：`reason`（string，必填）、`confirm_user_request`（boolean，必填且必须为 true，用于暴露模型意图）。

**返回**：`{ ok: true, run: { status: "cancelled", ... } }`；错误：`ENDURANCE_NOT_ACTIVE`、`ENDURANCE_AUTHORITY_REQUIRED`。

### 7.6 错误码

| code | 含义 | 模型应做什么 |
|---|---|---|
| `ENDURANCE_INVALID_PARAMS` | 参数越界/格式错误 | 按 `field` 修正后重试，或询问用户。 |
| `ENDURANCE_PROMPT_INVALID` | 模板含未知占位符或长度越界 | 用返回的合法占位符清单修正。 |
| `ENDURANCE_ALREADY_ACTIVE` | 已有活动运行 | 先 `status`；按用户意图继续或 `cancel`。 |
| `ENDURANCE_NOT_ACTIVE` | 当前没有活动运行（或已终态） | 不要继续推进；必要时重新 `set`。 |
| `ENDURANCE_NOT_A_CHECK_ROUND` | 当前回合不是匹配的检查回合 | 等待检查消息；不要预支 post/reset。 |
| `ENDURANCE_AUTHORITY_REQUIRED` | 缺少直接人类授权（set/cancel） | 请用户明确确认，不要自行登记或取消。 |
| `ENDURANCE_INTERNAL` | 持久化/注入等内部失败 | 报告 `status` 与日志线索，不要重试风暴。 |

### 7.7 权限矩阵

| 工具 | 调用前提 | 校验方式 |
|---|---|---|
| `set` | 当前回合有直接人类输入；root agent；无活动运行 | 开放回合内存在 `user/message.source.kind === 'user'`（对照 goal 工具的 `requireDirectHuman`） |
| `post` / `reset` | 当前回合是匹配的检查回合 | 开放回合内存在 `source.kind === 'plugin:dsh-plugin-endurance'` 且 `enduranceId/round` 匹配的检查消息 |
| `status` | 任意调用代理 | 只读，无副作用 |
| `cancel` | 当前回合有直接人类输入 + 模型显式确认 | 同 `set`；`confirm_user_request === true` |

设计理由：`post`/`reset` 的回合绑定让模型无法在普通工作回合里「刷」连续达标，也让每轮计数都有可追溯的检查消息；`set`/`cancel` 的人类回合绑定防止模型擅自给会话套上数小时的自动驱动或取消用户任务。

---

## 8. 检查提示词与模板

### 8.1 占位符

| 占位符 | 含义 | 示例 |
|---|---|---|
| `$endurance_id` | 当前检查轮次（1 起） | `3` |
| `$endurance_total_count` | 需要的连续达标轮数 | `3` |
| `$endurance_gate` | 门槛（含百分号） | `85%` |
| `$endurance_streak` | 当前连续达标数 | `1` |
| `$endurance_deadline` | 截止时刻（本地时间 + 时区） | `2026-11-18 07:00 (Asia/Hong_Kong)` |
| `$endurance_remaining` | 距截止剩余 | `4h 12m`（到点后为 `0m`） |
| `$endurance_duration` | 总时长 | `8h` |
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

**到点前、未达标时：**

```text
---
【续航 · 第 3 轮】连续达标 1/3（门槛 85%）· 截止 2026-11-18 07:00（剩余 4h 12m）
【规则】时长未满前不会结束；即使置信率已达标，也请把时间用于深化、加固与补充证据。
【行动】完成核验后调用 task_endurance_post 汇报置信率；若任务仍未完成，调用 task_endurance_reset 继续。
```

**已达标、但未到点时：**

```text
【规则】核验门槛已满足，但续航未满（剩余 4h 12m）。请继续深化与加固，并在下一轮检查时重新评估；不要提前声明最终完成。
```

**到点后仍未达标时：**

```text
【规则】续航时长已满，还需连续 3 轮 ≥85% 才能结束。请如实汇报置信率；未完成则 reset 继续。
```

**本轮是重发（上一轮未收到 post/reset）时：**

```text
【提醒】上一轮检查未收到 task_endurance_post 或 task_endurance_reset。本轮请务必用工具调用给出结论。
```

### 8.3 渲染示例（用户给出的模板 + 第 3 轮）

```text
现在是第 3 轮检查，请你根据先前设定的目标检查当前任务的完成度并且核实是否满足用户设定的任务目标 ？
输出是否可以结束任务的置信率，连续 3 轮检查置信率均高于 85% 即可结束任务。
汇报置信率方式为工具调用：task_endurance_post ...，若你认为任务仍未完成尚需继续，请调用：task_endurance_reset

---
【续航 · 第 3 轮】连续达标 1/3（门槛 85%）· 截止 2026-11-18 07:00（剩余 4h 12m）
【规则】时长未满前不会结束；……
```

模板与尾注可能重复「连续 N 轮」的描述，这是可接受的冗余：尾注是权威判定，模板是模型自己的检查语。

---

## 9. 注入调度

### 9.1 触发源

| 触发 | 用途 |
|---|---|
| `agent/status` → `idle` | 主触发：回合结束且会话空闲时评估并注入。 |
| `agent/inbox/inserted` | 跟踪竞争入站消息（真人/schedule/goal 等），避免注入插队。 |
| `goal/changed` | goal 进入或离开活动轮次时暂停/恢复注入。 |
| 定时器 | soak 间隔、deadline 收敛、hard deadline 收尾。 |
| 工具调用 | `post`/`reset`/`cancel` 同步更新状态，可能立即收敛。 |
| `agent/created`（resume） | 从会话日志恢复运行并对空闲会话恢复驱动。 |
| 插件加载 | 对于已存在的活跃会话，重新挂载驱动（不要求重启 DSH）。 |

> 注意：`turn/end` 不是「会话空闲」信号——同一 driver 在 inbox 还有消息时会继续开下一个 turn，用 `turn/end` 触发注入会重复。必须以 `agent/status → idle`（无 driver 残留）为准。

### 9.2 调度算法（伪代码）

```text
onTurnSettled(agent):
  run = stateOf(agent.session)
  if run == null or run.terminal: return
  if paused(run) or goalDriving(agent) or competingHumanMessage(agent): return
  if run.pendingRound != null:                # 检查消息已被消费但无 post/reset
     run.attempt += 1
     if run.attempt > maxUnansweredPrompts: settle('stalled'); return
     inject(run, sameRound, attempt, reminder=true); return
  if run.status == 'armed': inject(run, round=1); return
  if convergedByTime(run): settle('converged'); return
  if exhausted(run): settle('exhausted'); return
  injectDelay = cadence(run)                  # eager: 0；soak: 剩余间隔
  schedule(run, injectDelay)
```

```text
inject(run, round, attempt):
  text = render(run.check_prompt) + footer(run, round, attempt)
  msg  = createUserMessage({ content: [{type:'text', text}],
                             source: { kind: 'plugin:dsh-plugin-endurance',
                                       enduranceId: run.id, round, attempt } })
  record('injected', { round, attempt, at })
  run.roundsInjected += 1
  run.pendingRound = round
  agent.followup(msg)                         # 唤醒一个独立的检查回合
```

结束评估（按优先级）：

```text
1. now >= deadline && streak >= N  → converged
2. checks >= maxChecks 或 now >= hardDeadline → exhausted（可选注入一次收尾提示）
3. 未响应次数超限                   → stalled
4. 否则继续注入
```

### 9.3 并发与幂等

- 每个会话维护一个串行驱动（同一时刻只有一个评估/注入在途），所有触发合并到一次调度（对照 goal-round-driver 的 `state.run` 合并模式）。
- 注入前校验 `ctx.agents.get(id) === agent` 且 `agent.status === 'idle'`；不满足则丢弃本次触发，等待下一次 idle。
- 注入后立即持久化 `pendingRound`，并调用 `ctx.sessions.flush(agent.session)` 确认落盘；flush 返回 false（组合里没有持久化监听）视为注入失败，fail-closed 处理，不假装已注入。
- 定时器只保留一个「下一次动作」时间点，重复设置以最新为准；使用 `ctx.timeout`（Cordis timer，随 fiber 生命周期清理）或等价的 `unref` 定时器，重启后按绝对 epoch 时间重算。
- `withoutInitiator` 包裹调度，避免把插件自身误认成交互发起者（对照 goal-round-driver）。

### 9.4 用户介入与中止

- 真人消息到达时，清空 pending 定时器并让出本轮；该回合结束后再按节奏注入（不会在用户回合上「贴脸」连发）。
- 用户点「停止」导致回合以 `aborted` 结束时：设置短冷却（默认 10 分钟）后再恢复注入，避免与用户的即时意图对抗；冷却期间用户发消息则立即解除冷却。
- `cancel` 工具成功即终态，任何后续触发都不再注入。

### 9.5 与 goal 轮次协调

- 若会话存在 `goal` 且处于 `active + armed`（goal-round-driver 正在续跑）：**暂停 endurance 注入**。goal 完成/暂停/解除武装后，在下一个 idle 恢复。
- 理由：goal 自身的轮次已经在驱动会话；同时注入会让每个回合收到两条自动消息，浪费 token 且语义冲突。
- goal 完成时的收敛判定不受影响：endurance 的时间门槛与 streak 仍按自己的节奏计算（goal 期间没有检查则不产生 post，属于预期）。

### 9.6 子代理

- 只为 root agent（`ctx.agents.roots()`）驱动注入；子代理的回合结束不触发。
- 模型在检查回合里可自行使用子代理；其完成通知按 DSH 既有语义处理，不影响 endurance 计数。

### 9.7 重启恢复

- 运行状态以 **session plugin record** 为唯一持久事实（§11）。插件加载或 `agent/created(resume)` 时读取最新记录重建内存态。
- 插件加载时遍历 `ctx.agents.list()` 中已存在的活 Agent 重新挂载驱动（安装/启用无需重启 DSH），但**不在加载当下立即 followup**——先等首个 `idle`，以免撞上进行中的回合。
- 定时器不持久化：重启后按「立即重新评估」处理；若处在 soak 等待中，重启可能提前一轮检查，可接受。
- 插件卸载时清除定时器、解除事件监听；若检查消息已排队但尚未消费，用 `agent.inbox.remove(messageId)` 撤回，避免插件消失后仍被检查消息唤醒。
- 会话未打开（归档/未恢复）时不注入；恢复打开后继续。

---

## 10. 停止、异常与安全上限

### 10.1 终态

| 终态 | 触发 | 记录内容 | 后续行为 |
|---|---|---|---|
| `converged` | 到点 + 连续达标 | 结束时刻、最终 streak、最后一轮 | 停止注入；客户端 M2 显示成功状态 |
| `cancelled` | 用户在对话中明确取消 | 取消原因、取消时刻 | 停止；用户可重新 `set` |
| `exhausted` | 硬截止 / 轮次上限 | 原因、最后置信率、未解决项 | 可选注入 1 次收尾提示（要求模型给出当前产物与未完成清单），然后停止 |
| `stalled` | 连续未响应超限 | 未响应轮次、最近错误 | 停止并落记录；不无限重发 |

### 10.2 失败与异常

- **模型工具调用失败/报错**：不改变运行状态；在下一个检查回合重试。`agent/error` 计数达到 3 次连续错误 → `stalled`（避免夜间反复失败烧钱）。
- **注入失败**（`followup` 抛错）：记录 warn 日志，保留状态，下次 idle 重试；连续 3 次失败 → `stalled`。
- **插件卸载/禁用**：清除定时器与内存态；会话中已有记录保留，重新启用后恢复。
- **会话删除/归档**：记录随会话日志处理；插件无需额外清理。
- **状态记录损坏**：读取时 schema 校验失败 → 视为无活动运行并记录诊断，不阻塞会话。

### 10.3 上限与派生默认值

| 限制 | 默认值 | 说明 |
|---|---|---|
| 时长下限 | 1m | 低于此值拒绝 |
| 时长上限 | 24h | 可通过配置放宽；夜间场景足够 |
| 连续轮数上限 | 20 | 越大收敛越保守，token 越多 |
| 置信率门槛 | 0–100 | 85 为建议值 |
| 宽限期 grace | `clamp(25% × duration, 30m, 4h)` | 到点未达标时的追加窗口 |
| 最大检查轮次 | 100 | 含重发 |
| 未响应重发上限 | 3 | 每轮内 |
| 检查最小间隔 | 30s | 防紧密循环 |
| soak 间隔 | `clamp(duration/(2N), 5m, 30m)` | 已达标但未到点时 |

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
  "createdAt": 1763382000000,
  "deadlineAt": 1763410800000,
  "hardDeadlineAt": 1763418000000,
  "durationMs": 28800000,
  "gate": 85,
  "streakRequired": 3,
  "checkPrompt": "现在是第 $endurance_id 轮检查……",
  "round": 3,
  "attempt": 1,
  "streak": 1,
  "lastCountedRound": 2,
  "pendingRound": 3,
  "roundsInjected": 3,
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

- `toolNames` 保留写入方版本信息，便于未来改名兼容。
- 历史只保留最近 50 条轮次记录（导出给 `status` 时同样截断）。

### 11.3 恢复与投影

- 恢复：从会话事件中筛出 `type` 匹配且 `ignorable` 的记录，取最后一条合法快照；校验 `schemaVersion` 与必填字段。失败则视为无运行。
- M2 客户端：注册 session projection（key `endurance`），由 plugin record 折叠出只读视图（状态、剩余时间、streak、最近轮次），供会话流状态行/设置页使用；`wire` 只暴露客户端所需字段。
- 记录只在状态变化时追加（set/inject/post/reset/settle），不会每轮写多份。

### 11.4 版本与清理

- `schemaVersion` 单调递增；不兼容变更时旧记录视为过期（忽略并允许重新 `set`），不做原地迁移。
- 终态记录永久保留（体积极小，供审计）；会话删除时随日志一起消失。

---

## 12. 配置

v0.1 使用宿主 profile 的 `cordis.patch.yml` 配置，读取时钳制越界值（对照社区插件的 `readOptions` 模式），不做设置页。

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时仍注册工具但 `set` 返回禁用错误。 |
| `maxDurationHours` | `24` | `set` 的时长上限。 |
| `maxChecks` | `100` | 每次运行的最大注入轮次。 |
| `maxUnansweredPrompts` | `3` | 每轮未响应重发上限。 |
| `minCheckGapMs` | `30000` | 两次注入最小间隔。 |
| `soakGapMinMs` / `soakGapMaxMs` | `300000` / `1800000` | soak 间隔钳制区间。 |
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
│   │   ├── state.js             # 纯状态机与派生标志
│   │   ├── prompt.js            # 模板校验、占位符渲染、尾注
│   │   └── limits.js            # 上限派生（grace、soak、maxChecks）
│   ├── service.js               # 运行注册表、持久化、状态迁移
│   ├── driver.js                # idle/timer 调度、注入、竞态防护
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
| `agents.roots()`、`agents.get()`、`agents.turnBoundaryOf()`、`agents.withoutInitiator()` | `packages/core/agent` | 权限判定、liveness、回合边界 |
| `createUserMessage`、`MessageSourceMap` 合并扩展 | `packages/llm/llm` | 构造检查消息、声明 `plugin:dsh-plugin-endurance` 来源 |
| `defineTool`、`ctx.tools.register` | `packages/interaction` / `packages/core/tools` | 工具注册与 output/render |
| `ctx.sessions.flush` | `packages/core/session` | 注入后的持久化确认（fail-closed） |
| `ctx.timeout`（Cordis timer） | `vendor/timer` | soak/deadline 定时，随 fiber 清理 |
| `appendPluginRecord`、`pluginRecordOf`、`SessionEventMap` | `packages/core/session` | 持久化运行状态 |
| `ctx.sessionProjections.register` | `packages/session/session-projection` | M2 客户端投影 |
| goal round driver 的 fencing/合并模式 | `packages/goal/goal-round-driver` | 调度实现参照 |
| `HarnessError` | `packages/llm/llm` | 结构化工具错误 |

### 13.4 模块职责

- `service.js`：内存运行注册表（sessionId → run），状态迁移唯一入口；所有迁移先落 record 再更新内存；提供 `get/ensure/transition`。
- `driver.js`：监听 agent 事件与定时器；持有串行队列；调用 `authority` 与 `prompt`，执行注入；不直接改状态字段，统一走 `service.transition`。
- `domain/state.js`：纯函数；输入快照 + 事件，输出新快照/派生标志；100% 单测覆盖。
- `tools.js`：参数校验 → 授权 → 调 service → 返回视图；把 `HarnessError` 交给框架转成模型可见错误。
- `prompt.js`：占位符白名单与渲染；尾注三种变体；模板静态校验。
- `authority.js`：读取开放回合事件（`agents.turnBoundaryOf` + session 快照）判定直接人类输入 / 匹配检查消息，逻辑与 goal 工具同构。

---

## 14. 客户端呈现（M2）

- **检查回合行**：检查消息（`source.kind = plugin:dsh-plugin-endurance`）在会话流里渲染为一条可折叠的「续航检查 · 第 N 轮」行，展开显示门槛、streak、剩余时间；区别于真人消息。
- **状态条**：会话顶部/输入区显示 `⏳ 续航 3/8h · 连续达标 1/3 · 85%`；`converged` 后变为完成态，`exhausted/stalled/cancelled` 显示对应颜色与原因。
- **命令**（M2）：`/endurance status`、`/endurance stop`、`/endurance extend <duration>`（是否做 extend 另行确认）。
- **设置页**：若配置改为 schemastery schema，可自动生成表单；否则 M2 先只读展示。
- 技术路径：host 注册 `endurance` session projection（§11.3），client 通过 `useProjection('endurance')` 取状态；检查行通过 conversation definition 按记录/来源渲染。

---

## 15. 测试计划

### 15.1 单元（node:test，纯函数）

- 时长解析：`8h` / `90m` / `1d` / `0.5h` / 越界 / 非法格式。
- 占位符渲染：全部变量、`$$` 转义、未知变量、CJK/英文尾注选择。
- 上限派生：grace、soakGap、maxChecks 的钳制。
- 状态机：全部转换（含 post 同轮去重、reset 回退、到点收敛、到点不达标继续、硬截止、stalled）。
- 授权判定：直接人类回合、检查回合匹配、非检查回合拒绝、root/子代理。

### 15.2 集成（伪造 Agent/Session + 真实纯函数）

- 回合结束 → 注入第 1 轮；检查回合 post → streak 累计；到点 → 收敛。
- 用户消息插队 → 不注入；用户回合结束后恢复。
- goal 活动 → 暂停；goal 结束 → 恢复。
- 未响应 → 同轮重发 max 次 → stalled。
- 插件重载 → 从 plugin record 恢复状态。

### 15.3 端到端（本地 DSH Web/headless）

| 场景 | 预期 |
|---|---|
| 2 分钟 / 2 轮 / 80% 的短任务：模型首轮就报 95% | 不提前收敛；到点后连续 2 轮 ≥80% 才结束 |
| 模型只 reset 不 post | 持续注入直到上限，终态 `stalled` |
| 任务 8h 内自然完成，置信率波动 | 掉到门槛以下时 streak 归零，重新累计 |
| 检查回合中用户发消息 | 不插队；用户回合后恢复 |
| DSH 重启 | 运行从日志恢复；不重复计数 |
| 用户在对话中要求停止 | `cancel` 成功，不再注入 |

### 15.4 验收清单（对应 issue #1）

- [ ] 5 个工具契约与 JSON Schema 在文档定稿。
- [ ] 时长下限语义、连续计数、reset 语义、post 幂等均有明确规则。
- [ ] 占位符与尾注规则定稿，含渲染 fixture。
- [ ] 注入调度（idle、竞态、用户介入、goal、重启）定稿。
- [ ] 安全上限与终态表定稿。
- [ ] 持久化记录结构定稿。
- [ ] 测试计划覆盖上述规则。
- [ ] 用户确认 §18 开放问题。

---

## 16. 里程碑

| 里程碑 | 内容 | 交付 |
|---|---|---|
| M0 设计（本 issue） | 本文档评审通过 | PR |
| M1 Host MVP | 模块骨架、宿主模块桥、状态机、5 工具、注入驱动、持久化、单测 | 可在本地 profile 启用并跑通短场景 |
| M2 客户端 | 检查行、状态条、命令、投影 | 可视化与用户控制 |
| M3 发布 | README、banner、CHANGELOG、release 流程 | 可安装版本 |

---

## 17. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 时长是**下限**：到点前即使达标也不收敛 | 插件的目的就是防止提前收尾；剩余时间用于深化核验 |
| D2 | 同一会话同时最多一个活动运行；终态后可重新 `set` | 状态简单、可审计；避免多个循环互相插队 |
| D3 | 「轮次」= 注入次数；每轮最多计一次 post；reset 清零 | 防刷、可重放、与注入消息一一对应 |
| D4 | 收敛 = 到点 ∧ 连续达标；到点未达标则继续到硬上限 | 同时表达「跑够时间」与「确定满足要求」 |
| D5 | 检查提示词由模型生成，插件只做插值与尾注 | 检查内容依赖具体任务；插件不应假装理解业务 |
| D6 | 注入用 `agent.followup(source=plugin:...)`，在 idle 时发生 | 复用宿主既有续跑机制；不与进行中的回合竞争 |
| D7 | post/reset 绑定匹配检查回合；set/cancel 绑定人类回合 | 防止模型自导自演、凑轮次或擅自套上/取消长时约束 |
| D8 | `set`/`cancel` 要求 root agent 的直接人类输入 | 与 goal create 的授权模型一致 |
| D9 | 持久化用 plugin record 快照，宿主 session 模块桥写入 | 官方支持的第三方持久化路径；重启/fork 可恢复 |
| D10 | goal 活动期间暂停注入 | 避免双驱动与 token 浪费 |
| D11 | 用户中止后短暂冷却再恢复 | 尊重「停止」意图，同时不永久中断夜间任务 |
| D12 | 安全上限：轮次、宽限期、未响应、连续错误 | 无人值守场景必须有界 |
| D13 | 零构建纯 ESM JS + JSDoc；node:test | 与社区插件生态一致，安装即用、无需构建 |
| D14 | v0.1 无客户端 UI；M2 再做投影与命令 | 先保证 Host 语义正确，UI 后置 |
| D15 | 检查消息来源用 `plugin:dsh-plugin-endurance` | 与真人/goal/schedule 可区分，客户端可定制渲染 |

---

## 18. 开放问题（请评审确认）

1. **时长语义**：确认采用「下限」——到点前即使连续达标也不结束（推荐，符合「跑够时长」的目的）？还是希望「达标即结束，时长只是计划参考」？
2. **首轮检查时机**：`set` 所在回合结束后立即注入第 1 轮（推荐），还是等模型先完整执行一轮任务后再开始检查？
3. **`set` 的授权**：是否同意要求「同一回合内有用户直接输入」？（更安全；代价是模型在后续回合里无法补登记。）
4. **soak 节奏**：已达标但未到点时，默认按 `clamp(T/(2N), 5m, 30m)` 继续检查（推荐）；还是立即高频检查直到到点？
5. **安全上限默认值**：时长上限 24h、轮次上限 100、未响应重发 3 次、宽限期 25%——是否合适？
6. **M2 的命令**：除 `/endurance status`、`/endurance stop`，是否需要 `/endurance extend <duration>`？

---

## 19. 参考

- 官方 goal 轮次驱动：`packages/goal/goal-round-driver`（同会话自动续跑、fencing）。
- 官方 goal 工具：`packages/goal/tool-goal`（人类授权、工具契约、系统提示段落）。
- 官方持久化：`packages/core/session`（`appendPluginRecord` / `pluginRecordOf`）。
- 社区插件：`dsh-plugin-portara`（宿主模块桥、plugin record、会话流 UI 行）、`dsh-plugin-btw`（零构建 bundle、命令注册、设计文档骨架）。
