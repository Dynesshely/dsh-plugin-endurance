/**
 * Endurance injection driver.
 *
 * Primary trigger: `agent/status === 'idle'` (the whole agent settled), never
 * `turn/end`. The driver evaluates the run, injects the next check round through
 * `agent.followup(createUserMessage(...))`, and schedules the idempotent tick
 * timer. A tick that lands while the agent is genuinely running is skipped and
 * never replayed; background shells and jobs are not consulted at all because
 * the decision uses `agent.status` only.
 *
 * @module dsh-plugin-endurance/driver
 */

import { randomUUID } from 'node:crypto'
import {
  FIRST_CHECK,
  PHASE,
  STATUS,
  beginInjection,
  beginRetry,
  checksExhausted,
  ensurePhase,
  evaluateSettlement,
  gateMet,
  isTerminal,
  recordTickSkip,
  settle,
} from './domain.js'
import {
  SOURCE_KIND,
  lastTurnAbortedByUser,
  workedSinceSet,
} from './authority.js'
import { footerLocaleOf, renderCheckMessage, renderKickoffMessage } from './prompt.js'

/** Build one plugin-source user message. */
function createMessage(text, source) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

/** Render an unknown thrown value for logs. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Localized one-shot wrap-up prompt used when a run exhausts without converging. */
function finalizeText(locale) {
  return locale === 'zh'
    ? '【续航】运行已到达安全上限，仍未完成收敛。请输出现有产物的最终摘要、已验证通过的部分，'
      + '以及明确未完成或存疑的清单；不要再扩大改动范围。'
    : '[endurance] The run reached its safety cap without converging. Produce a final summary of the current '
      + 'artifact, the verified parts, and an explicit list of unfinished or uncertain items. Do not expand scope.'
}

/**
 * Create the driver.
 * @param {{ctx: object, config: object, service: object, logger?: object}} options - dependencies.
 * @returns {{start: () => void, dispose: () => void, wake: (agent: object) => void}} driver API.
 */
export function createDriver(options) {
  const { ctx, config, service } = options
  const logger = options.logger ?? ctx.logger
  const states = new Map()
  let disposed = false

  /** Per-agent scheduler state. */
  function stateFor(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { actionTimer: null, deadlineTimer: null, deadlineAt: null, driving: false, queued: false }
      states.set(agent, state)
    }
    return state
  }

  /** Dispose one stored disposer safely. */
  function disposeOf(disposer) {
    if (typeof disposer !== 'function') return
    try {
      disposer()
    } catch {
      // Timer already fired or the context is disposing.
    }
  }

  /** Clear the next-action timer. */
  function clearAction(agent) {
    const state = stateFor(agent)
    disposeOf(state.actionTimer)
    state.actionTimer = null
  }

  /** Clear the hard-deadline timer. */
  function clearDeadline(agent) {
    const state = stateFor(agent)
    disposeOf(state.deadlineTimer)
    state.deadlineTimer = null
    state.deadlineAt = null
  }

  /** Clear every timer for one agent. */
  function clearAll(agent) {
    clearAction(agent)
    clearDeadline(agent)
  }

  /** Schedule the next drive pass at an absolute instant. */
  function scheduleAt(agent, at) {
    if (disposed) return
    const state = stateFor(agent)
    clearAction(agent)
    const delay = Math.max(0, at - Date.now())
    state.actionTimer = ctx.timeout(() => {
      state.actionTimer = null
      void fireScheduled(agent)
    }, delay)
  }

  /** Ensure one hard-deadline timer exists for the current run. */
  function ensureDeadline(agent, run) {
    if (disposed || run === null || isTerminal(run)) return
    const state = stateFor(agent)
    if (state.deadlineTimer !== null && state.deadlineAt === run.hardDeadlineAt) return
    clearDeadline(agent)
    state.deadlineAt = run.hardDeadlineAt
    const delay = Math.max(0, run.hardDeadlineAt - Date.now())
    state.deadlineTimer = ctx.timeout(() => {
      state.deadlineTimer = null
      state.deadlineAt = null
      void onDeadline(agent)
    }, delay)
  }

  /** Force the hard-deadline settlement even if a turn is still running. */
  async function onDeadline(agent) {
    if (disposed) return
    const run = service.get(agent.session)
    if (run === null || isTerminal(run) || Date.now() < run.hardDeadlineAt) return
    await settleRun(agent, run, STATUS.EXHAUSTED, 'hard-deadline', Date.now())
  }

  /** Whether a goal round driver currently owns same-session continuations. */
  function goalDriving(agent) {
    try {
      const goals = ctx.get('goals')
      if (goals === undefined) return false
      const goal = goals.get(agent)
      return goal?.phase === 'active' && goal.activation === 'armed'
    } catch {
      return false
    }
  }

  /** Whether the inbox already holds another producer's queued message. */
  function hasCompetingMessage(agent) {
    const isOurs = message => message?.source?.kind === SOURCE_KIND
    const lists = [agent.inbox?.nextTurn, agent.inbox?.nextStep]
    return lists.some(list => Array.isArray(list) && list.some(message => !isOurs(message)))
  }

  /** Whether the run is in its user-abort cooldown. */
  function paused(run, now) {
    return run.pausedUntil !== null && run.pausedUntil > now
  }

  /** Persist a run snapshot; log and keep going when the log rejects it. */
  function persist(agent, run) {
    return service.update(agent.session, run)
  }

  /** Settle a run and optionally inject one wrap-up prompt. */
  async function settleRun(agent, run, status, reason, now) {
    const next = settle(run, status, reason, now)
    persist(agent, next)
    clearAll(agent)
    if (status === STATUS.EXHAUSTED && config.finalizeOnExhaustion) {
      const locale = footerLocaleOf(run.checkPrompt, config.footerLocale)
      try {
        agent.followup(createMessage(finalizeText(locale), {
          kind: SOURCE_KIND,
          enduranceId: next.runId,
          round: next.round,
          attempt: 0,
          phase: 'finalize',
        }))
        await ctx.sessions.flush(agent.session)
      } catch (error) {
        logger?.warn?.(`endurance: could not inject the wrap-up prompt: ${messageOf(error)}`)
      }
    }
  }

  /** Inject one check round, persist it first, then wake the agent. */
  async function injectCheck(agent, run, input) {
    const now = input.now
    const nextRound = input.retry === true ? run.round : run.round + 1
    const phase = input.phase
    const text = renderCheckMessage(run, {
      round: nextRound,
      attempt: input.attempt,
      phase,
      now,
      maxChecks: config.maxChecks,
      injectFooter: config.injectFooter,
      footerLocale: config.footerLocale,
    })
    const message = createMessage(text, {
      kind: SOURCE_KIND,
      enduranceId: run.runId,
      round: nextRound,
      attempt: input.attempt,
      phase,
    })
    const base = { ...run, pausedUntil: null, pauseReason: null }
    const next = input.retry === true
      ? beginRetry(base, { now, attempt: input.attempt, messageId: message.id })
      : beginInjection(base, {
        now,
        phase,
        attempt: input.attempt,
        messageId: message.id,
      })
    next.consecutiveErrors = 0
    if (!persist(agent, next)) return
    try {
      agent.followup(message)
    } catch (error) {
      logger?.warn?.(`endurance: could not inject check round ${nextRound}: ${messageOf(error)}`)
      persist(agent, { ...next, consecutiveErrors: next.consecutiveErrors + 1 })
      return
    }
    try {
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      logger?.warn?.(`endurance: session flush failed after injection: ${messageOf(error)}`)
    }
    ensureDeadline(agent, next)
    if (phase === PHASE.IDEMPOTENT && next.nextTickAt !== null) {
      scheduleAt(agent, next.nextTickAt)
    }
  }

  /** Send the one-shot kickoff prompt for a set turn that did no real work. */
  async function sendKickoff(agent, run, now) {
    const message = createMessage(renderKickoffMessage(run, { footerLocale: config.footerLocale }), {
      kind: SOURCE_KIND,
      enduranceId: run.runId,
      round: 0,
      attempt: 0,
      phase: 'kickoff',
    })
    const next = { ...run, firstCheck: FIRST_CHECK.KICKOFF_SENT, updatedAt: now }
    next.consecutiveErrors = 0
    if (!persist(agent, next)) return
    try {
      agent.followup(message)
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      logger?.warn?.(`endurance: could not inject the kickoff prompt: ${messageOf(error)}`)
    }
    ensureDeadline(agent, next)
  }

  /** Handle the first check: kick off when no task work was observed. */
  async function handleFirstCheck(agent, run, now) {
    if (run.firstCheck === FIRST_CHECK.KICKOFF_SENT || workedSinceSet(agent.session, run.setSeq)) {
      const started = { ...run, firstCheck: FIRST_CHECK.STARTED, status: STATUS.RUNNING, updatedAt: now }
      if (!persist(agent, started)) return
      await injectCheck(agent, started, { phase: PHASE.ACTIVE, attempt: 1, now })
      return
    }
    await sendKickoff(agent, run, now)
  }

  /** Re-send an unanswered check round or settle as stalled. */
  async function handleUnanswered(agent, run, now) {
    if (run.attempt >= config.maxUnansweredPrompts) {
      await settleRun(agent, run, STATUS.STALLED, 'unanswered-prompts', now)
      return
    }
    const earliest = (run.lastInjectedAt ?? 0) + config.minCheckGapMs
    if (now < earliest) {
      scheduleAt(agent, earliest)
      return
    }
    await injectCheck(agent, run, { phase: run.phase, attempt: run.attempt + 1, now, retry: true })
  }

  /** Handle one idempotent tick. */
  async function handleTick(agent, run) {
    const now = Date.now()
    let current = { ...run }
    if (now >= current.targetAt) {
      if (gateMet(current)) {
        await settleRun(agent, current, STATUS.CONVERGED, 'idempotent-soak-complete', now)
        return
      }
    }
    if (current.pendingRound !== null) {
      persist(agent, recordTickSkip(current, now))
      scheduleAt(agent, current.nextTickAt ?? now + current.idempotentIntervalMs)
      return
    }
    if (agent.status !== 'idle' || goalDriving(agent) || paused(current, now)) {
      const skipped = recordTickSkip(current, now)
      persist(agent, skipped)
      scheduleAt(agent, skipped.nextTickAt ?? now + current.idempotentIntervalMs)
      return
    }
    await injectCheck(agent, current, { phase: PHASE.IDEMPOTENT, attempt: 1, now })
  }

  /** Evaluate one idle agent once. */
  async function driveOnce(agent) {
    if (disposed) return
    if (ctx.agents.get(agent.id) !== agent) {
      clearAll(agent)
      states.delete(agent)
      return
    }
    if (agent.status !== 'idle') return
    const run = service.get(agent.session)
    if (run === null || isTerminal(run)) {
      clearAll(agent)
      return
    }
    const now = Date.now()
    ensureDeadline(agent, run)

    if (paused(run, now)) {
      scheduleAt(agent, run.pausedUntil)
      return
    }
    if (run.pausedUntil !== null) {
      persist(agent, { ...run, pausedUntil: null, pauseReason: null, updatedAt: now })
    }
    if (goalDriving(agent)) return
    if (hasCompetingMessage(agent)) return

    if (now >= run.hardDeadlineAt) {
      await settleRun(agent, run, STATUS.EXHAUSTED, 'hard-deadline', now)
      return
    }
    if (checksExhausted(run, config.maxChecks)) {
      await settleRun(agent, run, STATUS.EXHAUSTED, 'check-limit', now)
      return
    }

    if (run.status === STATUS.ARMED) {
      await handleFirstCheck(agent, run, now)
      return
    }

    if (run.pendingRound !== null) {
      await handleUnanswered(agent, run, now)
      return
    }

    let current = ensurePhase(run, now)
    if (current !== run) persist(agent, current)
    const verdict = evaluateSettlement(current, now)
    if (verdict !== null) {
      await settleRun(agent, current, verdict, verdict === STATUS.CONVERGED ? 'converged' : 'hard-deadline', now)
      return
    }
    if (current.status === STATUS.ARMED) {
      await handleFirstCheck(agent, current, now)
      return
    }
    if (current.phase === PHASE.IDEMPOTENT) {
      const tickAt = current.nextTickAt ?? now + current.idempotentIntervalMs
      if (now >= tickAt) {
        await handleTick(agent, current)
      } else {
        scheduleAt(agent, tickAt)
      }
      return
    }
    const earliest = (current.lastInjectedAt ?? 0) + config.minCheckGapMs
    if (now < earliest) {
      scheduleAt(agent, earliest)
      return
    }
    await injectCheck(agent, current, { phase: PHASE.ACTIVE, attempt: 1, now })
  }

  /** Run the action that was scheduled: an idempotent tick or an ordinary drive pass. */
  async function fireScheduled(agent) {
    if (disposed) return
    const run = service.get(agent.session)
    if (run === null || isTerminal(run)) {
      clearAll(agent)
      return
    }
    const now = Date.now()
    if (run.phase === PHASE.IDEMPOTENT && run.nextTickAt !== null) {
      await handleTick(agent, run)
      return
    }
    await drive(agent)
  }

  /** Serialize drive passes per agent and coalesce triggers. */
  async function drive(agent) {
    if (disposed) return
    const state = stateFor(agent)
    if (state.driving) {
      state.queued = true
      return
    }
    state.driving = true
    try {
      await driveOnce(agent)
    } catch (error) {
      logger?.warn?.(`endurance: drive pass failed for agent "${agent.id}": ${messageOf(error)}`)
    } finally {
      state.driving = false
      if (state.queued) {
        state.queued = false
        void drive(agent)
      }
    }
  }

  /** Handle a settled agent turn. */
  function onIdle(agent) {
    const run = service.get(agent.session)
    if (run === null || isTerminal(run)) {
      clearAll(agent)
      return
    }
    ensureDeadline(agent, run)
    const now = Date.now()
    if (lastTurnAbortedByUser(agent.session) && (run.pausedUntil === null || run.pausedUntil <= now)) {
      const pausedRun = {
        ...run,
        pausedUntil: now + config.abortCooldownMs,
        pauseReason: 'user-abort',
        updatedAt: now,
      }
      persist(agent, pausedRun)
      scheduleAt(agent, pausedRun.pausedUntil)
      return
    }
    void drive(agent)
  }

  /** Clear a user-abort cooldown when the human speaks again. */
  function onInboxInserted(agent, message) {
    if (message?.source?.kind !== 'user') return
    const run = service.get(agent.session)
    if (run === null || run.pausedUntil === null) return
    persist(agent, { ...run, pausedUntil: null, pauseReason: null, updatedAt: Date.now() })
  }

  /** Track consecutive agent errors and stop a looping run. */
  function onAgentError(agent) {
    const run = service.get(agent.session)
    if (run === null || isTerminal(run)) return
    const now = Date.now()
    const errors = run.consecutiveErrors + 1
    if (errors >= 3) {
      void settleRun(agent, run, STATUS.STALLED, 'agent-errors', now)
      return
    }
    persist(agent, { ...run, consecutiveErrors: errors, updatedAt: now })
  }

  /** Called by tools after a state-changing call. */
  function wake(agent) {
    const run = service.get(agent.session)
    if (run === null || isTerminal(run)) {
      clearAll(agent)
      return
    }
    ensureDeadline(agent, run)
    void drive(agent)
  }

  /** Register listeners and recover existing runs without injecting immediately. */
  function start() {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') onIdle(agent)
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => onInboxInserted(agent, message))
    ctx.on('agent/error', ({ agent }) => onAgentError(agent))
    ctx.on('goal/changed', ({ agent }) => void drive(agent))
    ctx.on('agent/created', ({ agent }) => {
      const run = service.get(agent.session)
      if (run !== null && !isTerminal(run)) ensureDeadline(agent, run)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      clearAll(agent)
      states.delete(agent)
      service.forget(agent.session)
    })
    for (const agent of ctx.agents.list()) {
      const run = service.get(agent.session)
      if (run !== null && !isTerminal(run)) ensureDeadline(agent, run)
    }
  }

  /** Clear timers and withdraw a queued check message that was never consumed. */
  function dispose() {
    disposed = true
    for (const agent of states.keys()) {
      const run = service.get(agent.session)
      if (run?.pendingMessageId !== null && run?.pendingMessageId !== undefined) {
        try {
          agent.inbox?.remove?.(run.pendingMessageId)
        } catch {
          // The message was already claimed.
        }
      }
      clearAll(agent)
    }
    states.clear()
  }

  return { start, dispose, wake }
}
