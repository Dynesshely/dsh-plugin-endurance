/**
 * Model-facing endurance tools.
 *
 * Every tool returns one canonical JSON value rendered as text. Invalid calls
 * throw an `EnduranceToolError` carrying a stable code; the tool executor maps
 * the message into a model-visible tool error.
 *
 * @module dsh-plugin-endurance/tools
 */

import { randomUUID } from 'node:crypto'
import {
  MODE_IDEMPOTENT_SOAK,
  STATUS,
  applyPost,
  applyReset,
  formatClock,
  formatDuration,
  gateMet,
  isTerminal,
  newRun,
  normalizeSetInput,
  settle,
} from './domain.js'
import { hasDirectHumanInput, matchingCheckRound } from './authority.js'
import { findUnknownPlaceholders } from './prompt.js'

/** Stable tool error carrying a machine code. */
class EnduranceToolError extends Error {
  /** @param {string} code - stable code. @param {string} message - model-facing message. */
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.name = 'EnduranceToolError'
    this.code = code
  }
}

/** Canonical output declaration shared by every tool. */
const OUTPUT = Object.freeze({
  schema: { type: 'object' },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  },
})

/** Localized/compact instant rendering. */
function clockOf(epochMs) {
  return epochMs === null || epochMs === undefined ? null : formatClock(epochMs)
}

/**
 * Build the model-facing run view.
 * @param {object | null} run - run snapshot.
 * @returns {object | null} run view or null.
 */
export function runView(run) {
  if (run === null || run === undefined) return null
  const now = Date.now()
  return {
    id: run.runId,
    status: run.status,
    mode: run.mode,
    phase: run.phase,
    first_check: run.firstCheck,
    created_at: clockOf(run.createdAt),
    target_at: clockOf(run.targetAt),
    hard_deadline_at: clockOf(run.hardDeadlineAt),
    duration: formatDuration(run.durationMs),
    duration_ms: run.durationMs,
    confidence_gate: run.gate,
    min_consecutive_passes: run.streakRequired,
    streak: run.streak,
    gate_met: gateMet(run),
    can_conclude: run.status === STATUS.CONVERGED,
    overrunning: !isTerminal(run) && now > run.targetAt,
    remaining_to_target_ms: Math.max(0, run.targetAt - now),
    round: run.round,
    attempt: run.attempt,
    pending_round: run.pendingRound,
    rounds_injected: run.roundsInjected,
    idempotent_interval: run.idempotentIntervalMs === null
      ? null
      : formatDuration(run.idempotentIntervalMs),
    next_tick_at: clockOf(run.nextTickAt),
    ticks_sent: run.ticksSent,
    skipped_ticks: run.skippedTicks,
    settled_at: clockOf(run.settledAt),
    settle_reason: run.settleReason,
    recent_history: run.history.slice(-8),
  }
}

/** Map a domain rejection into a tool error. */
function domainFailure(error) {
  if (error?.name !== 'DomainError') return error
  const codes = {
    MODE_REQUIRED: 'ENDURANCE_MODE_REQUIRED',
    PROMPT_INVALID: 'ENDURANCE_PROMPT_INVALID',
    INVALID_DURATION: 'ENDURANCE_INVALID_PARAMS',
    DURATION_OUT_OF_RANGE: 'ENDURANCE_INVALID_PARAMS',
    INVALID_PARAMS: 'ENDURANCE_INVALID_PARAMS',
    NOT_ACTIVE: 'ENDURANCE_NOT_ACTIVE',
    NO_PENDING_ROUND: 'ENDURANCE_NOT_A_CHECK_ROUND',
  }
  return new EnduranceToolError(codes[error.code] ?? 'ENDURANCE_INVALID_PARAMS', error.message)
}

/** Require an active run for this agent's session. */
function requireActiveRun(agent, service) {
  const run = service.get(agent.session)
  if (run === null || isTerminal(run)) {
    throw new EnduranceToolError(
      'ENDURANCE_NOT_ACTIVE',
      'There is no active endurance run in this session. Call task_endurance_status, or register one with task_endurance_set when the user asked for it.',
    )
  }
  return run
}

/** Require a live calling agent. */
function requireAgent(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) {
    throw new EnduranceToolError('ENDURANCE_INTERNAL', 'endurance tools require a calling agent')
  }
  return agent
}

/** Require a direct human turn on a root agent. */
function requireHuman(ctx, agent) {
  if (!ctx.agents.roots().includes(agent) || !hasDirectHumanInput(ctx, agent)) {
    throw new EnduranceToolError(
      'ENDURANCE_AUTHORITY_REQUIRED',
      'This operation requires a direct human request in the current turn. Ask the user to confirm, then retry in the turn where they answer.',
    )
  }
}

/** Require the exact pending check round in the open turn. */
function requireCheckRound(ctx, agent, run) {
  if (matchingCheckRound(ctx, agent, run) === undefined) {
    throw new EnduranceToolError(
      'ENDURANCE_NOT_A_CHECK_ROUND',
      'This is not the pending endurance check round. Report only when the injected check prompt asks for a result; do not pre-report or double-report.',
    )
  }
}

const SET_DESCRIPTION = 'Register a convergence-check run for this session. Call only when the user explicitly '
  + 'asked for a long-running task with a plan duration, a consecutive-pass count, a confidence gate, and a '
  + 'convergence mode, and only in a turn where the user just spoke. If the user did not clearly choose the mode, '
  + 'ASK them before calling: "converge" ends the run as soon as the streak is met; "idempotent_soak" keeps '
  + 'idempotent checks every idempotent_interval until the plan time with the artifact frozen. Do not guess the mode.'

const POST_DESCRIPTION = 'Report this round\'s confidence (0-100) that the task fully satisfies the user objective. '
  + 'Call only inside a pending endurance check round injected by the plugin. The result tells you whether the run '
  + 'settled; if it did not, end your turn and the plugin injects the next check.'

const RESET_DESCRIPTION = 'Declare that the task still needs work; this clears the consecutive-pass streak and '
  + 'returns the run to active checks. Call only inside an endurance check round. During the idempotent phase, '
  + 'any rework or artifact change requires reset.'

const STATUS_DESCRIPTION = 'Read the current endurance run for this session: mode, phase, streak, plan progress, '
  + 'and recent check history.'

const CANCEL_DESCRIPTION = 'Cancel the current endurance run. Use only when the user explicitly asks to stop it; '
  + 'requires a direct human turn and confirm_user_request=true.'

/**
 * Register every endurance tool.
 * @param {{ctx: object, config: object, service: object, driver: object}} options - plugin dependencies.
 * @returns {void}
 */
export function registerTools(options) {
  const { ctx, config, service, driver } = options

  ctx.tools.register({
    name: 'task_endurance_set',
    description: SET_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['duration', 'min_consecutive_passes', 'confidence_gate', 'check_prompt', 'convergence_mode'],
      properties: {
        duration: {
          type: 'string',
          description: 'Plan duration, such as "8h", "90m", or "1d". It paces checks and bounds the idempotent soak; it does not decide convergence.',
        },
        min_consecutive_passes: {
          type: 'number',
          description: 'Required consecutive passing checks (1-20).',
        },
        confidence_gate: {
          type: 'number',
          description: 'Passing confidence threshold in percent (0-100), e.g. 85.',
        },
        check_prompt: {
          type: 'string',
          description: 'Prompt template injected for every check. Supports $endurance_id, $endurance_total_count, $endurance_gate, $endurance_streak, $endurance_phase, $endurance_deadline, $endurance_remaining, $endurance_duration, $endurance_round_attempt, $endurance_checks_left, $endurance_started_at.',
        },
        convergence_mode: {
          type: 'string',
          enum: ['converge', 'idempotent_soak'],
          description: 'User-chosen mode. Ask the user when unclear; do not guess.',
        },
        idempotent_interval: {
          type: 'string',
          description: 'Required only for idempotent_soak: interval between idempotent checks, e.g. "30m" or "1h". Defaults to plan duration / 8, clamped to 5m-2h.',
        },
      },
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      if (!config.enabled) {
        throw new EnduranceToolError('ENDURANCE_INTERNAL', 'the endurance plugin is disabled in this profile')
      }
      const agent = requireAgent(exec)
      requireHuman(ctx, agent)
      const existing = service.get(agent.session)
      if (existing !== null && !isTerminal(existing)) {
        throw new EnduranceToolError(
          'ENDURANCE_ALREADY_ACTIVE',
          `An endurance run is already active (${existing.runId}). Use task_endurance_status to inspect it, or ask the user before cancelling it.`,
        )
      }
      let normalized
      try {
        normalized = normalizeSetInput(args, config)
      } catch (error) {
        throw domainFailure(error)
      }
      const unknown = findUnknownPlaceholders(normalized.checkPrompt)
      if (unknown.length > 0) {
        throw new EnduranceToolError(
          'ENDURANCE_PROMPT_INVALID',
          `Unknown placeholders in check_prompt: ${unknown.join(', ')}. Use only the documented $endurance_* placeholders.`,
        )
      }
      const now = Date.now()
      const run = newRun({
        ...normalized,
        runId: `end_${randomUUID()}`,
        sessionId: agent.session.id,
        setSeq: agent.session.seq,
        now,
      })
      if (!service.update(agent.session, run)) {
        throw new EnduranceToolError('ENDURANCE_INTERNAL', 'the run could not be persisted to the session log')
      }
      driver.wake(agent)
      return {
        ok: true,
        run: runView(run),
        message: normalized.mode === MODE_IDEMPOTENT_SOAK
          ? `Endurance armed (idempotent_soak). Finish one full task round first. After ${normalized.streakRequired} consecutive passes the run re-verifies every ${formatDuration(normalized.idempotentIntervalMs)} until ${formatClock(run.targetAt)}.`
          : `Endurance armed (converge). Finish one full task round first. The run settles after ${normalized.streakRequired} consecutive passes at or above ${normalized.gate}%.`,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Register endurance run', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'task_endurance_post',
    description: POST_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['confidence', 'summary'],
      properties: {
        confidence: {
          type: 'number',
          description: 'Confidence that the whole objective is met, in percent (0-100).',
        },
        summary: { type: 'string', description: 'Evidence-backed verification summary (max 4000 chars).' },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional deliverable paths or URLs.',
        },
        remaining_work: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional remaining work when confidence is low.',
        },
      },
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const agent = requireAgent(exec)
      const run = requireActiveRun(agent, service)
      requireCheckRound(ctx, agent, run)
      let next
      try {
        next = applyPost(run, {
          now: Date.now(),
          confidence: args.confidence,
          summary: args.summary,
          artifacts: args.artifacts,
          remainingWork: args.remaining_work,
        })
      } catch (error) {
        throw domainFailure(error)
      }
      if (!service.update(agent.session, next)) {
        throw new EnduranceToolError('ENDURANCE_INTERNAL', 'the check result could not be persisted')
      }
      driver.wake(agent)
      return {
        ok: true,
        counted: true,
        run: runView(next),
        message: next.status === STATUS.CONVERGED
          ? 'Recorded. The run has converged; no further checks will be injected. Finish with the final artifact summary.'
          : next.phase === 'idempotent'
            ? `Recorded (${next.streak}/${next.streakRequired} consecutive passes). The run now verifies idempotently every ${formatDuration(next.idempotentIntervalMs)} until ${formatClock(next.targetAt)}; keep the artifact unchanged unless a regression appears.`
            : `Recorded (${next.streak}/${next.streakRequired} consecutive passes). Continue the task; the next check is injected after this turn.`,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Report endurance confidence', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'task_endurance_reset',
    description: RESET_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: 'Why the task cannot finish yet (max 2000 chars).' },
        unresolved_work: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional work planned before the next check.',
        },
      },
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const agent = requireAgent(exec)
      const run = requireActiveRun(agent, service)
      requireCheckRound(ctx, agent, run)
      let next
      try {
        next = applyReset(run, {
          now: Date.now(),
          reason: args.reason,
          unresolvedWork: args.unresolved_work,
        })
      } catch (error) {
        throw domainFailure(error)
      }
      if (!service.update(agent.session, next)) {
        throw new EnduranceToolError('ENDURANCE_INTERNAL', 'the reset could not be persisted')
      }
      driver.wake(agent)
      return {
        ok: true,
        run: runView(next),
        message: 'Reset recorded. Consecutive passes cleared; the next check is injected after this turn.',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Reset endurance streak', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'task_endurance_status',
    description: STATUS_DESCRIPTION,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    execute: async (_args, exec) => {
      const agent = requireAgent(exec)
      return { ok: true, run: runView(service.get(agent.session)) }
    },
    presentCall: () => ({ card: 'generic', title: 'Read endurance state', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'task_endurance_cancel',
    description: CANCEL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reason', 'confirm_user_request'],
      properties: {
        reason: { type: 'string', description: 'Why the run is being cancelled.' },
        confirm_user_request: {
          type: 'boolean',
          description: 'Must be true; set only after the user explicitly asked to stop the run.',
        },
      },
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const agent = requireAgent(exec)
      requireHuman(ctx, agent)
      if (args.confirm_user_request !== true) {
        throw new EnduranceToolError(
          'ENDURANCE_INVALID_PARAMS',
          'confirm_user_request must be true and only after the user explicitly asked to cancel.',
        )
      }
      const run = requireActiveRun(agent, service)
      const next = settle(run, STATUS.CANCELLED, typeof args.reason === 'string' ? args.reason : 'user-cancelled', Date.now())
      if (!service.update(agent.session, next)) {
        throw new EnduranceToolError('ENDURANCE_INTERNAL', 'the cancellation could not be persisted')
      }
      driver.wake(agent)
      return { ok: true, run: runView(next), message: 'Endurance cancelled; no further checks will be injected.' }
    },
    presentCall: () => ({ card: 'generic', title: 'Cancel endurance run', kind: 'other' }),
  })
}
