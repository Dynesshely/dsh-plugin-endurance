# dsh-plugin-endurance

> 代号：**续航**（endurance）· 让长程任务持续接受收敛核验，直到所选模式结算。

`dsh-plugin-endurance` 是 DeepSeek Harness（DSH）的插件。用户为长程任务声明**计划时长**、**连续达标轮数**与**置信率门槛**，并选择一种收敛模式；插件在任务回合结束后自动注入检查提示词，模型用工具汇报置信率或要求继续，直到收敛或到达安全上限。

## 两种收敛模式

| 模式 | 行为 |
|---|---|
| `converge` | 连续 N 轮达标即结束，不等到计划时刻 |
| `idempotent_soak` | 先连续 N 轮达标，之后按固定「幂等间隔」重复核验，直到计划时刻；巡检阶段产物保持不变，任何返工/改进都必须 `reset` |

模式必须由用户明确选择；用户未说明时，模型应先询问，`set` 缺少模式会返回 `ENDURANCE_MODE_REQUIRED`。

## 工具

| 工具 | 作用 |
|---|---|
| `task_endurance_set` | 登记运行（时长 / 连续轮数 / 门槛 / 检查模板 / 模式 / 幂等间隔） |
| `task_endurance_post` | 在检查回合汇报置信率，累计连续达标 |
| `task_endurance_reset` | 任务未完成，清零连续达标并继续 |
| `task_endurance_status` | 查询运行状态（模式、阶段、streak、计划进度） |
| `task_endurance_cancel` | 用户明确要求时取消运行 |

- `set` / `cancel` 只允许在用户直接输入的回合、由 root agent 调用。
- `post` / `reset` 只允许在插件注入的匹配检查回合内调用。
- 计划时长是参考：`converge` 模式不等待计划时刻；`idempotent_soak` 用计划时刻作为巡检终点。

## 安装（本地 profile）

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugin-endurance
```

把该 bundle 加入 profile 的 `dsh.profile.bundles` 后启用。改 host 代码后在 Plugins 页关闭/开启该行即可生效，不需要重启 DSH 进程。

## 配置

在 profile 的 `cordis.patch.yml` 中按行 id `endurance` 覆盖：

```yaml
- id: endurance
  config:
    maxDurationHours: 24
    maxChecks: 100
    idempotentIntervalMinMs: 300000
    idempotentIntervalMaxMs: 7200000
```

## 开发

```bash
npm test    # node --test
npm run check
```

设计文档见 [`docs/DESIGN.md`](docs/DESIGN.md)。当前状态：M1 Host MVP；客户端状态行与 `/endurance` 命令属 M2。

## 结构

```text
index.js              host 入口
src/
  plugin.js           装配：工具、驱动、系统提示
  host.js             宿主 Session 模块桥 + plugin record 写入
  config.js           配置钳制
  domain.js           纯状态机（双模式、幂等阶段、上限）
  prompt.js           占位符渲染、状态尾注、kickoff
  authority.js        人类回合 / 检查回合判定
  service.js          运行注册表与持久化
  driver.js           idle / tick 调度与注入
  tools.js            5 个模型工具
test/                 领域、提示词、工具、驱动、宿主桥测试
```

## License

MIT
