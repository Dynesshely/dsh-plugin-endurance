/**
 * Pure prompt rendering for endurance checks: template placeholders, the
 * agent-facing status footer, and the one-shot kickoff prompt.
 *
 * Rendering must be deterministic for one run snapshot and template; the
 * driver stores the rendered text only in the session log, never re-derives it.
 *
 * @module dsh-plugin-endurance/prompt
 */

import {
  MODE_CONVERGE,
  PHASE,
  formatClock,
  formatDuration,
  formatRemaining,
} from './domain.js'

/** Placeholders accepted in `check_prompt`. */
export const PLACEHOLDERS = Object.freeze([
  'endurance_id',
  'endurance_total_count',
  'endurance_gate',
  'endurance_streak',
  'endurance_phase',
  'endurance_deadline',
  'endurance_remaining',
  'endurance_duration',
  'endurance_round_attempt',
  'endurance_checks_left',
  'endurance_started_at',
])

const PLACEHOLDER_PATTERN = /\$endurance_[a-z_]+/g
const ESCAPED_DOLLAR = '\u0000ENDURANCE_DOLLAR\u0000'
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * List placeholders in a template that are not in the whitelist.
 * @param {string} template - check prompt template.
 * @returns {string[]} unknown tokens, unique.
 */
export function findUnknownPlaceholders(template) {
  const unknown = new Set()
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[0].slice(1)
    if (!PLACEHOLDERS.includes(name)) unknown.add(match[0])
  }
  return [...unknown]
}

/** Build the placeholder value map for one render. */
function valuesOf(run, render) {
  const { round, attempt, phase, now, maxChecks } = render
  return {
    endurance_id: String(round),
    endurance_total_count: String(run.streakRequired),
    endurance_gate: `${run.gate}%`,
    endurance_streak: String(run.streak),
    endurance_phase: phase,
    endurance_deadline: formatClock(run.targetAt),
    endurance_remaining: formatRemaining(run.targetAt - now),
    endurance_duration: formatDuration(run.durationMs),
    endurance_round_attempt: String(attempt),
    endurance_checks_left: String(Math.max(0, maxChecks - run.roundsInjected)),
    endurance_started_at: formatClock(run.createdAt),
  }
}

/**
 * Substitute whitelisted placeholders; `$$` renders one literal dollar sign.
 * Unknown placeholders are left untouched (the set tool rejects them earlier).
 * @param {string} template - check prompt template.
 * @param {object} run - run snapshot.
 * @param {{round: number, attempt: number, phase: string, now: number, maxChecks: number}} render - render context.
 * @returns {string} rendered prompt body.
 */
export function renderTemplate(template, run, render) {
  const values = valuesOf(run, render)
  const escaped = template.replaceAll('$$', ESCAPED_DOLLAR)
  const rendered = escaped.replace(PLACEHOLDER_PATTERN, (token) => {
    const name = token.slice(1)
    return Object.hasOwn(values, name) ? values[name] : token
  })
  return rendered.replaceAll(ESCAPED_DOLLAR, '$')
}

/**
 * Choose the footer language.
 * @param {string} template - check prompt template.
 * @param {'auto' | 'zh' | 'en'} configured - deployment preference.
 * @returns {'zh' | 'en'} footer language.
 */
export function footerLocaleOf(template, configured) {
  if (configured === 'zh' || configured === 'en') return configured
  return CJK_PATTERN.test(template) ? 'zh' : 'en'
}

/** Render the elapsed / remaining summary for one run. */
function progressOf(run, now) {
  return {
    elapsed: formatRemaining(now - run.createdAt),
    remaining: formatRemaining(run.targetAt - now),
    overrun: formatRemaining(now - run.targetAt),
    hardLeft: formatRemaining(run.hardDeadlineAt - now),
    interval: formatRemaining(run.idempotentIntervalMs ?? 0),
  }
}

/** Footer used in a normal active-phase check. */
function activeFooter(run, render, locale) {
  const { round, now, attempt } = render
  const progress = progressOf(run, now)
  const reminder = attempt > 1
    ? (locale === 'zh'
      ? `【提醒】上一轮检查未收到 task_endurance_post 或 task_endurance_reset。本轮请务必用工具调用给出结论。\n`
      : 'Reminder: the previous check received neither task_endurance_post nor task_endurance_reset. '
        + 'This round must end with one of those tool calls.\n')
    : ''
  if (locale === 'zh') {
    const endRule = run.mode === MODE_CONVERGE
      ? `连续 ${run.streakRequired} 轮 ≥${run.gate}% 即结束`
      : `连续 ${run.streakRequired} 轮 ≥${run.gate}% 后进入幂等巡检，至 ${formatClock(run.targetAt)}`
    return '---\n'
      + reminder
      + `【续航 · 第 ${round} 轮】连续达标 ${run.streak}/${run.streakRequired}（门槛 ${run.gate}%）`
      + ` · 计划 ${formatDuration(run.durationMs)}（已用 ${progress.elapsed} / 剩余 ${progress.remaining}）\n`
      + `【规则】${endRule}；若任务仍未完成，请调用 task_endurance_reset 继续。\n`
      + '【行动】完成核验后调用 task_endurance_post 汇报置信率。'
  }
  const endRule = run.mode === MODE_CONVERGE
    ? `the run settles after ${run.streakRequired} consecutive rounds at or above ${run.gate}%`
    : `${run.streakRequired} consecutive rounds at or above ${run.gate}% start idempotent checks until ${formatClock(run.targetAt)}`
  return '---\n'
    + reminder
    + `[endurance · round ${round}] streak ${run.streak}/${run.streakRequired} (gate ${run.gate}%)`
    + ` · plan ${formatDuration(run.durationMs)} (elapsed ${progress.elapsed} / remaining ${progress.remaining})\n`
    + `[rule] ${endRule}; if work remains, call task_endurance_reset to continue.\n`
    + '[action] After verifying, call task_endurance_post with your confidence.'
}

/** Footer used while the run idempotently re-verifies the frozen artifact. */
function idempotentFooter(run, render, locale) {
  const { round, now } = render
  const progress = progressOf(run, now)
  if (locale === 'zh') {
    return '---\n'
      + `【续航 · 幂等巡检】连续达标 ${run.streak}/${run.streakRequired}（门槛 ${run.gate}%）；`
      + '本轮仅做核验，产物应保持不变。\n'
      + `【计划】每 ${progress.interval} 巡检一次，至 ${formatClock(run.targetAt)}（剩余 ${progress.remaining}）。\n`
      + '【行动】确认产物仍满足目标后调用 task_endurance_post；若发现回归或需要变更，'
      + '调用 task_endurance_reset，回到活跃检查阶段。'
  }
  return '---\n'
    + `[endurance · idempotent check] streak ${run.streak}/${run.streakRequired} (gate ${run.gate}%); `
    + 'this round only verifies; the artifact must stay unchanged.\n'
    + `[plan] re-check every ${progress.interval} until ${formatClock(run.targetAt)} (remaining ${progress.remaining}).\n`
    + '[action] Call task_endurance_post if the artifact still satisfies the objective; if a regression appears '
    + 'or the artifact must change, call task_endurance_reset to return to active checks.'
}

/** Footer used once the plan time has passed without convergence. */
function overrunFooter(run, render, locale) {
  const { now } = render
  const progress = progressOf(run, now)
  return locale === 'zh'
    ? `【状态】已超过计划时长 ${progress.overrun}（安全上限还剩 ${progress.hardLeft}）；`
      + '继续核验，直到达标或到达安全上限。'
    : `[status] ${progress.overrun} past the plan time (${progress.hardLeft} until the safety cap); `
      + 'keep verifying until the gate is met or the cap is reached.'
}

/**
 * Render the complete injected check message.
 * @param {object} run - run snapshot.
 * @param {{round: number, attempt: number, phase: string, now: number, maxChecks: number,
 *   injectFooter: boolean, footerLocale: 'auto' | 'zh' | 'en'}} render - render context.
 * @returns {string} model-facing check text.
 */
export function renderCheckMessage(run, render) {
  const body = renderTemplate(run.checkPrompt, run, render)
  if (!render.injectFooter) return body
  const locale = footerLocaleOf(run.checkPrompt, render.footerLocale)
  const footer = render.phase === PHASE.IDEMPOTENT
    ? idempotentFooter(run, render, locale)
    : activeFooter(run, render, locale)
  const overrun = render.now > run.targetAt && render.phase !== PHASE.IDEMPOTENT
    ? `\n${overrunFooter(run, render, locale)}`
    : ''
  return `${body}\n\n${footer}${overrun}`
}

/**
 * Render the one-shot kickoff prompt used when the model ended the set turn
 * without doing any real task work.
 * @param {object} run - run snapshot.
 * @param {{footerLocale: 'auto' | 'zh' | 'en'}} options - locale preference.
 * @returns {string} model-facing kickoff text.
 */
export function renderKickoffMessage(run, options) {
  const locale = footerLocaleOf(run.checkPrompt, options.footerLocale)
  const plan = formatDuration(run.durationMs)
  if (locale === 'zh') {
    const endRule = run.mode === MODE_CONVERGE
      ? `连续 ${run.streakRequired} 轮 ≥${run.gate}% 即结束`
      : `连续 ${run.streakRequired} 轮 ≥${run.gate}% 后进入幂等巡检，至 ${formatClock(run.targetAt)}`
    return '【续航】续航已登记（计划 ' + plan + '，' + endRule + '）。'
      + '请先完整执行一个任务回合：继续用工具推进任务，完成一轮后再汇报；'
      + '在收到检查提示前不要声明最终完成。'
  }
  const endRule = run.mode === MODE_CONVERGE
    ? `the run settles after ${run.streakRequired} consecutive rounds at or above ${run.gate}%`
    : `${run.streakRequired} consecutive rounds at or above ${run.gate}% start idempotent checks until ${formatClock(run.targetAt)}`
  return '[endurance] The run is armed (plan ' + plan + '; ' + endRule + '). '
    + 'First complete one full task round: keep using tools and report only after finishing that round. '
    + 'Do not claim final completion before a check prompt arrives.'
}
