import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MODE_CONVERGE,
  MODE_IDEMPOTENT_SOAK,
  PHASE,
  beginInjection,
  newRun,
} from '../src/domain.js'
import {
  PLACEHOLDERS,
  findUnknownPlaceholders,
  footerLocaleOf,
  renderCheckMessage,
  renderKickoffMessage,
  renderTemplate,
} from '../src/prompt.js'

const now = Date.UTC(2026, 10, 17, 15, 0, 0)

/** Build a run for prompt fixtures. */
function runOf(mode = MODE_CONVERGE, options = {}) {
  const run = newRun({
    mode,
    durationMs: 8 * 3_600_000,
    streakRequired: 3,
    gate: 85,
    checkPrompt: options.checkPrompt
      ?? '现在是第 $endurance_id 轮检查，连续 $endurance_total_count 轮置信率高于 $endurance_gate 即可结束。'
        + '请调用 task_endurance_post 汇报，或调用 task_endurance_reset 继续。',
    idempotentIntervalMs: mode === MODE_IDEMPOTENT_SOAK ? 3_600_000 : undefined,
    runId: 'end_prompt',
    sessionId: 'session-1',
    setSeq: 0,
    now: now - 2 * 3_600_000,
  })
  return { ...run, streak: options.streak ?? 1 }
}

const render = {
  round: 3,
  attempt: 1,
  phase: PHASE.ACTIVE,
  now,
  maxChecks: 100,
  injectFooter: true,
  footerLocale: 'zh',
}

test('the template renders every documented placeholder', () => {
  const run = runOf()
  const template = PLACEHOLDERS.map(name => `${name}=$${name}`).join(' ')
  const text = renderTemplate(template, run, render)
  assert.match(text, /endurance_id=3/)
  assert.match(text, /endurance_total_count=3/)
  assert.match(text, /endurance_gate=85%/)
  assert.match(text, /endurance_phase=active/)
  assert.match(text, /endurance_streak=1/)
  assert.match(text, /endurance_duration=8h/)
  assert.doesNotMatch(text, /\$endurance_/)
})

test('unknown placeholders are detected and rejected', () => {
  assert.deepEqual(findUnknownPlaceholders('$endurance_unknown and $endurance_gate'), ['$endurance_unknown'])
  assert.deepEqual(findUnknownPlaceholders('plain text'), [])
})

test('double dollars escape to a literal dollar sign', () => {
  assert.equal(renderTemplate('cost $$5 and $endurance_id', runOf(), render), 'cost $5 and 3')
})

test('active-phase footer includes the rule and action', () => {
  const text = renderCheckMessage(runOf(), render)
  assert.match(text, /续航 · 第 3 轮/)
  assert.match(text, /连续达标 1\/3/)
  assert.match(text, /task_endurance_reset/)
  assert.match(text, /task_endurance_post/)
})

test('idempotent footer states that the artifact must stay unchanged', () => {
  const run = runOf(MODE_IDEMPOTENT_SOAK, { streak: 3 })
  const text = renderCheckMessage(run, { ...render, phase: PHASE.IDEMPOTENT })
  assert.match(text, /幂等巡检/)
  assert.match(text, /产物应保持不变/)
})

test('overrun footer appears after the plan time', () => {
  const run = runOf()
  const text = renderCheckMessage(run, { ...render, now: run.targetAt + 3_600_000 })
  assert.match(text, /已超过计划时长/)
})

test('repeated attempt adds a reminder', () => {
  const text = renderCheckMessage(runOf(), { ...render, attempt: 2 })
  assert.match(text, /上一轮检查未收到/)
})

test('footer language follows the template or the configured override', () => {
  assert.equal(footerLocaleOf('中文模板', 'auto'), 'zh')
  assert.equal(footerLocaleOf('english template', 'auto'), 'en')
  assert.equal(footerLocaleOf('english template', 'zh'), 'zh')
  assert.equal(footerLocaleOf('中文模板', 'en'), 'en')
})

test('English footer is produced for an English template', () => {
  const run = runOf(MODE_CONVERGE, { checkPrompt: 'Verify the objective and report confidence.' })
  const text = renderCheckMessage(run, { ...render, footerLocale: 'auto' })
  assert.match(text, /\[endurance · round 3\]/)
})

test('kickoff prompt states the mode-specific ending and forbids early completion', () => {
  const zh = renderKickoffMessage(runOf(), { footerLocale: 'auto' })
  assert.match(zh, /请先完整执行一个任务回合/)
  const en = renderKickoffMessage(
    runOf(MODE_CONVERGE, { checkPrompt: 'Verify the objective and report confidence.' }),
    { footerLocale: 'auto' },
  )
  assert.match(en, /First complete one full task round/)
})

test('an injected round can render the exact next round number', () => {
  const run = beginInjection(runOf(), { now, phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  const text = renderCheckMessage(run, { ...render, round: run.round })
  assert.match(text, /第 1 轮/)
})
