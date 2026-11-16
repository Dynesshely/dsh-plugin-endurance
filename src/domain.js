/**
 * Pure endurance domain: durations, derived limits, and the run state machine.
 *
 * Nothing in this module touches the host. Every function returns fresh values
 * (or a new run object) so the whole file is unit-testable with a fake clock.
 *
 * Modes:
 * - `converge`: the run settles as soon as `streak >= streakRequired`.
 * - `idempotent_soak`: after `streak >= streakRequired` the run enters the
 *   idempotent phase and keeps verifying every `idempotentIntervalMs` until the
 *   plan time; the run settles at or after `targetAt` while still passing.
 *
 * @module dsh-plugin-endurance/domain
 */

/** Version of the persisted run snapshot. */
export const RUN_SCHEMA_VERSION = 1

/** Convergence stops as soon as the streak is met. */
export const MODE_CONVERGE = 'converge'

/** Convergence is followed by idempotent checks until the plan time. */
export const MODE_IDEMPOTENT_SOAK = 'idempotent_soak'

/** Supported convergence modes. */
export const MODES = Object.freeze([MODE_CONVERGE, MODE_IDEMPOTENT_SOAK])

/** Run statuses. */
export const STATUS = Object.freeze({
  ARMED: 'armed',
  RUNNING: 'running',
  CONVERGED: 'converged',
  CANCELLED: 'cancelled',
  EXHAUSTED: 'exhausted',
  STALLED: 'stalled',
})

/** Settled statuses that must never be advanced again. */
export const TERMINAL_STATUSES = Object.freeze([
  STATUS.CONVERGED,
  STATUS.CANCELLED,
  STATUS.EXHAUSTED,
  STATUS.STALLED,
])

/** Run phases inside `running`. */
export const PHASE = Object.freeze({ ACTIVE: 'active', IDEMPOTENT: 'idempotent' })

/** First-check progress markers. */
export const FIRST_CHECK = Object.freeze({
  PENDING: 'pending',
  KICKOFF_SENT: 'kickoff_sent',
  STARTED: 'started',
})

/** Bounds that are part of the product contract, not deployment config. */
export const LIMITS = Object.freeze({
  minDurationMs: 60_000,
  maxStreakRequired: 20,
  graceMinMs: 30 * 60_000,
  graceMaxMs: 4 * 3_600_000,
  historyLimit: 50,
  promptMinLength: 20,
  promptMaxLength: 8_000,
})

const DURATION_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$/
const UNIT_MS = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000 })

/** A domain-level rejection with a stable code. */
export class DomainError extends Error {
  /** @param {string} code - stable machine code. @param {string} message - human message. */
  constructor(code, message) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

/** Clamp a finite number into a closed range. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Parse a human duration such as `8h`, `90m`, `1d`, or `0.5h`.
 * @param {unknown} text - candidate duration string.
 * @param {{minMs?: number, maxMs?: number}} [bounds] - accepted range.
 * @returns {number} duration in milliseconds.
 * @throws {DomainError} when the input is not a supported duration or is out of range.
 */
export function parseDuration(text, bounds = {}) {
  const minMs = bounds.minMs ?? LIMITS.minDurationMs
  const maxMs = bounds.maxMs ?? 24 * 3_600_000
  if (typeof text !== 'string') {
    throw new DomainError('INVALID_DURATION', 'duration must be a string such as "8h", "90m", or "1d"')
  }
  const match = DURATION_PATTERN.exec(text)
  if (match === null) {
    throw new DomainError('INVALID_DURATION', 'duration must look like "8h", "90m", or "1d"')
  }
  const amount = Number.parseFloat(match[1])
  const ms = Math.round(amount * UNIT_MS[match[2]])
  if (!Number.isFinite(ms) || ms < minMs || ms > maxMs) {
    throw new DomainError(
      'DURATION_OUT_OF_RANGE',
      `duration must be between ${formatDuration(minMs)} and ${formatDuration(maxMs)}`,
    )
  }
  return ms
}

/** Render a duration in milliseconds as a compact human string. */
export function formatDuration(ms) {
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`
  const hours = Math.floor(ms / UNIT_MS.h)
  const minutes = Math.round((ms % UNIT_MS.h) / UNIT_MS.m)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** Render a non-negative remaining duration as `4h 12m` (or `0m`). */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const hours = Math.floor(ms / UNIT_MS.h)
  const minutes = Math.round((ms % UNIT_MS.h) / UNIT_MS.m)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${Math.max(1, minutes)}m`
}

/**
 * Render an absolute instant in the host's local zone.
 * @param {number} epochMs - instant to render.
 * @returns {string} `YYYY-MM-DD HH:mm (Zone)`.
 */
export function formatClock(epochMs) {
  const date = new Date(epochMs)
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = type => parts.find(part => part.type === type)?.value ?? ''
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local'
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')} (${zone})`
}

/**
 * Derive the extra window after the plan time before a run is declared exhausted.
 * @param {number} durationMs - declared plan duration.
 * @returns {number} grace in milliseconds.
 */
export function deriveGrace(durationMs) {
  return clamp(Math.round(durationMs * 0.25), LIMITS.graceMinMs, LIMITS.graceMaxMs)
}

/**
 * Derive the default idempotent-check interval from the plan duration.
 * @param {number} durationMs - declared plan duration.
 * @param {number} minMs - deployment lower clamp.
 * @param {number} maxMs - deployment upper clamp.
 * @returns {number} interval in milliseconds.
 */
export function defaultIdempotentInterval(durationMs, minMs, maxMs) {
  return clamp(Math.round(durationMs / 8), minMs, maxMs)
}

/**
 * Validate and normalize the `task_endurance_set` parameters.
 * @param {object} input - raw tool arguments.
 * @param {object} config - resolved deployment config.
 * @returns {object} normalized run parameters without time-dependent fields.
 * @throws {DomainError} on any invalid field.
 */
export function normalizeSetInput(input, config) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('INVALID_PARAMS', 'arguments must be an object')
  }
  const mode = input.convergence_mode
  if (mode === undefined || mode === null || mode === '') {
    throw new DomainError(
      'MODE_REQUIRED',
      'convergence_mode is required. Ask the user whether the run should stop on convergence '
        + '("converge") or keep idempotent checks until the plan time ("idempotent_soak"), then retry.',
    )
  }
  if (!MODES.includes(mode)) {
    throw new DomainError('INVALID_PARAMS', `convergence_mode must be one of ${MODES.join(', ')}`)
  }
  const durationMs = parseDuration(input.duration, {
    minMs: LIMITS.minDurationMs,
    maxMs: config.maxDurationHours * 3_600_000,
  })
  const streakRequired = input.min_consecutive_passes
  if (!Number.isSafeInteger(streakRequired) || streakRequired < 1
    || streakRequired > LIMITS.maxStreakRequired) {
    throw new DomainError(
      'INVALID_PARAMS',
      `min_consecutive_passes must be an integer between 1 and ${LIMITS.maxStreakRequired}`,
    )
  }
  const gate = input.confidence_gate
  if (typeof gate !== 'number' || !Number.isFinite(gate) || gate < 0 || gate > 100) {
    throw new DomainError('INVALID_PARAMS', 'confidence_gate must be a number between 0 and 100')
  }
  const checkPrompt = input.check_prompt
  if (typeof checkPrompt !== 'string'
    || checkPrompt.trim().length < LIMITS.promptMinLength
    || checkPrompt.length > LIMITS.promptMaxLength) {
    throw new DomainError(
      'PROMPT_INVALID',
      `check_prompt must be a string between ${LIMITS.promptMinLength} and ${LIMITS.promptMaxLength} characters`,
    )
  }
  let idempotentIntervalMs
  if (mode === MODE_IDEMPOTENT_SOAK) {
    idempotentIntervalMs = input.idempotent_interval === undefined || input.idempotent_interval === null
      ? defaultIdempotentInterval(
        durationMs,
        config.idempotentIntervalMinMs,
        config.idempotentIntervalMaxMs,
      )
      : parseDuration(input.idempotent_interval, {
        minMs: 60_000,
        maxMs: durationMs,
      })
  } else if (input.idempotent_interval !== undefined && input.idempotent_interval !== null) {
    throw new DomainError(
      'INVALID_PARAMS',
      'idempotent_interval is only valid with convergence_mode "idempotent_soak"',
    )
  }
  return {
    mode,
    durationMs,
    streakRequired,
    gate,
    checkPrompt: checkPrompt.trim(),
    idempotentIntervalMs,
  }
}

/**
 * Create a fresh armed run.
 * @param {object} input - normalized parameters plus identity and observation points.
 * @returns {object} new run snapshot.
 */
export function newRun(input) {
  const now = input.now
  const targetAt = now + input.durationMs
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: input.runId,
    sessionId: input.sessionId,
    status: STATUS.ARMED,
    mode: input.mode,
    phase: PHASE.ACTIVE,
    createdAt: now,
    targetAt,
    hardDeadlineAt: targetAt + deriveGrace(input.durationMs),
    durationMs: input.durationMs,
    gate: input.gate,
    streakRequired: input.streakRequired,
    checkPrompt: input.checkPrompt,
    idempotentIntervalMs: input.idempotentIntervalMs ?? null,
    nextTickAt: null,
    setSeq: input.setSeq,
    firstCheck: FIRST_CHECK.PENDING,
    round: 0,
    attempt: 0,
    streak: 0,
    lastCountedRound: 0,
    pendingRound: null,
    pendingMessageId: null,
    roundsInjected: 0,
    ticksSent: 0,
    skippedTicks: 0,
    consecutiveErrors: 0,
    pausedUntil: null,
    pauseReason: null,
    settledAt: null,
    settleReason: null,
    lastInjectedAt: null,
    lastPostAt: null,
    history: [],
    updatedAt: now,
  }
}

/** Whether a run has already settled. */
export function isTerminal(run) {
  return run === null || run === undefined || TERMINAL_STATUSES.includes(run.status)
}

/** Whether the plan time has passed while the run is still active. */
export function isOverrunning(run, now) {
  return !isTerminal(run) && now > run.targetAt
}

/** Append one history entry, keeping only the newest entries. */
function pushHistory(history, entry) {
  const next = history === undefined ? [] : [...history, entry]
  return next.length > LIMITS.historyLimit ? next.slice(-LIMITS.historyLimit) : next
}

/** Whether the current streak satisfies the gate. */
export function gateMet(run) {
  return run.streak >= run.streakRequired
}

/**
 * Keep the phase consistent with the streak and the plan time.
 * @param {object} run - current run.
 * @param {number} now - wall clock.
 * @returns {object} run with a consistent phase.
 */
export function ensurePhase(run, now) {
  if (isTerminal(run)) return run
  if (run.streak < run.streakRequired) {
    return run.phase === PHASE.ACTIVE ? run : { ...run, phase: PHASE.ACTIVE, nextTickAt: null, updatedAt: now }
  }
  if (run.mode === MODE_IDEMPOTENT_SOAK && now < run.targetAt && run.phase !== PHASE.IDEMPOTENT) {
    return {
      ...run,
      status: STATUS.RUNNING,
      phase: PHASE.IDEMPOTENT,
      nextTickAt: now + run.idempotentIntervalMs,
      updatedAt: now,
    }
  }
  return run
}

/**
 * Record a counted post for the current check round.
 * @param {object} run - current run in `running`.
 * @param {{now: number, confidence: number, summary: string, artifacts?: string[], remainingWork?: string[]}} input - report.
 * @returns {object} next run snapshot.
 * @throws {DomainError} when no round is pending or the report is invalid.
 */
export function applyPost(run, input) {
  if (isTerminal(run) || run.status !== STATUS.RUNNING) {
    throw new DomainError('NOT_ACTIVE', 'there is no active endurance round to report on')
  }
  if (run.pendingRound === null) {
    throw new DomainError('NO_PENDING_ROUND', 'no check prompt is pending a result')
  }
  const { now, confidence, summary } = input
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new DomainError('INVALID_PARAMS', 'confidence must be a number between 0 and 100')
  }
  if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > 4_000) {
    throw new DomainError('INVALID_PARAMS', 'summary must be a non-empty string of at most 4000 characters')
  }
  const pass = confidence >= run.gate
  const streak = pass ? run.streak + 1 : 0
  const next = {
    ...run,
    status: STATUS.RUNNING,
    streak,
    lastCountedRound: Math.max(run.lastCountedRound, run.round),
    pendingRound: null,
    pendingMessageId: null,
    attempt: 0,
    lastPostAt: now,
    updatedAt: now,
    history: pushHistory(run.history, {
      kind: 'post',
      at: now,
      round: run.round,
      confidence,
      pass,
      summary,
      ...(Array.isArray(input.artifacts) ? { artifacts: input.artifacts.slice(0, 50) } : {}),
      ...(Array.isArray(input.remainingWork) ? { remainingWork: input.remainingWork.slice(0, 50) } : {}),
    }),
  }
  if (next.streak < next.streakRequired) {
    return { ...next, phase: PHASE.ACTIVE, nextTickAt: null }
  }
  if (next.mode === MODE_CONVERGE || now >= next.targetAt) {
    return settle(next, STATUS.CONVERGED, 'consecutive-passes-reached', now)
  }
  return {
    ...next,
    phase: PHASE.IDEMPOTENT,
    nextTickAt: now + next.idempotentIntervalMs,
  }
}

/**
 * Record a reset: the task is not done, clear the streak and continue actively.
 * @param {object} run - current run.
 * @param {{now: number, reason: string, unresolvedWork?: string[]}} input - reset reason.
 * @returns {object} next run snapshot.
 */
export function applyReset(run, input) {
  if (isTerminal(run) || run.status !== STATUS.RUNNING) {
    throw new DomainError('NOT_ACTIVE', 'there is no active endurance run to reset')
  }
  const { now, reason } = input
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2_000) {
    throw new DomainError('INVALID_PARAMS', 'reason must be a non-empty string of at most 2000 characters')
  }
  return {
    ...run,
    status: STATUS.RUNNING,
    phase: PHASE.ACTIVE,
    streak: 0,
    attempt: 0,
    pendingRound: null,
    pendingMessageId: null,
    nextTickAt: null,
    lastPostAt: now,
    updatedAt: now,
    history: pushHistory(run.history, {
      kind: 'reset',
      at: now,
      round: run.round,
      reason,
      ...(Array.isArray(input.unresolvedWork) ? { unresolvedWork: input.unresolvedWork.slice(0, 50) } : {}),
    }),
  }
}

/**
 * Mark one freshly injected check round as pending.
 * @param {object} run - current run.
 * @param {{now: number, phase: string, attempt: number, messageId: string}} input - injection facts.
 * @returns {object} next run snapshot.
 */
export function beginInjection(run, input) {
  const round = run.round + 1
  const isIdempotent = input.phase === PHASE.IDEMPOTENT
  return {
    ...run,
    status: STATUS.RUNNING,
    phase: input.phase,
    round,
    attempt: input.attempt,
    pendingRound: round,
    pendingMessageId: input.messageId,
    roundsInjected: run.roundsInjected + 1,
    ...(isIdempotent ? { ticksSent: run.ticksSent + 1 } : {}),
    ...(isIdempotent
      ? { nextTickAt: input.now + run.idempotentIntervalMs }
      : {}),
    lastInjectedAt: input.now,
    updatedAt: input.now,
    history: pushHistory(run.history, {
      kind: 'inject',
      at: input.now,
      round,
      attempt: input.attempt,
      phase: input.phase,
    }),
  }
}

/** Mark a re-sent check for the SAME round as pending again. */
export function beginRetry(run, input) {
  return {
    ...run,
    status: STATUS.RUNNING,
    pendingRound: run.round,
    pendingMessageId: input.messageId,
    attempt: input.attempt,
    roundsInjected: run.roundsInjected + 1,
    lastInjectedAt: input.now,
    updatedAt: input.now,
    history: pushHistory(run.history, {
      kind: 'retry',
      at: input.now,
      round: run.round,
      attempt: input.attempt,
      phase: run.phase,
    }),
  }
}

/** Record a skipped idempotent tick and roll the tick deadline forward. */
export function recordTickSkip(run, now) {
  return {
    ...run,
    skippedTicks: run.skippedTicks + 1,
    nextTickAt: now + run.idempotentIntervalMs,
    updatedAt: now,
    history: pushHistory(run.history, { kind: 'tick-skip', at: now, round: run.round }),
  }
}

/** Settle a run into a terminal status. */
export function settle(run, status, reason, now) {
  return {
    ...run,
    status,
    pendingRound: null,
    pendingMessageId: null,
    attempt: 0,
    settledAt: now,
    settleReason: reason,
    nextTickAt: null,
    updatedAt: now,
  }
}

/**
 * Decide whether the run should settle right now.
 * @param {object} run - current run.
 * @param {number} now - wall clock.
 * @returns {null | 'converged' | 'exhausted'} settlement status, or null to continue.
 */
export function evaluateSettlement(run, now) {
  if (isTerminal(run) || run.status === STATUS.ARMED) return null
  const phased = ensurePhase(run, now)
  if (phased.streak >= phased.streakRequired) {
    if (phased.mode === MODE_CONVERGE) return STATUS.CONVERGED
    if (now >= phased.targetAt) return STATUS.CONVERGED
  }
  if (now >= phased.hardDeadlineAt) return STATUS.EXHAUSTED
  return null
}

/** Whether a run has reached the maximum number of injected checks. */
export function checksExhausted(run, maxChecks) {
  return run.roundsInjected >= maxChecks
}

/** Snapshot payload persisted in the session log. */
export function serializeRun(run) {
  const {
    schemaVersion, runId, sessionId, status, mode, phase, createdAt, targetAt, hardDeadlineAt,
    durationMs, gate, streakRequired, checkPrompt, idempotentIntervalMs, nextTickAt, setSeq,
    firstCheck, round, attempt, streak, lastCountedRound, pendingRound, roundsInjected, ticksSent,
    skippedTicks, consecutiveErrors, pausedUntil, pauseReason, settledAt, settleReason,
    lastInjectedAt, lastPostAt, updatedAt,
  } = run
  return {
    schemaVersion,
    runId,
    sessionId,
    status,
    mode,
    phase,
    createdAt,
    targetAt,
    hardDeadlineAt,
    durationMs,
    gate,
    streakRequired,
    checkPrompt,
    idempotentIntervalMs,
    nextTickAt,
    setSeq,
    firstCheck,
    round,
    attempt,
    streak,
    lastCountedRound,
    pendingRound,
    roundsInjected,
    ticksSent,
    skippedTicks,
    consecutiveErrors,
    pausedUntil,
    pauseReason,
    settledAt,
    settleReason,
    lastInjectedAt,
    lastPostAt,
    updatedAt,
    history: run.history.slice(-LIMITS.historyLimit),
  }
}

/**
 * Restore a persisted run snapshot.
 * @param {unknown} data - record payload from the session log.
 * @returns {object | null} validated snapshot, or null when it is unusable.
 */
export function deserializeRun(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.schemaVersion !== RUN_SCHEMA_VERSION) return null
  const requiredStrings = ['runId', 'sessionId', 'status', 'mode', 'phase', 'checkPrompt', 'firstCheck']
  for (const key of requiredStrings) {
    if (typeof data[key] !== 'string' || data[key].length === 0) return null
  }
  const requiredNumbers = ['createdAt', 'targetAt', 'hardDeadlineAt', 'durationMs', 'gate', 'streakRequired']
  for (const key of requiredNumbers) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) return null
  }
  if (!MODES.includes(data.mode)) return null
  if (!TERMINAL_STATUSES.includes(data.status) && data.status !== STATUS.ARMED && data.status !== STATUS.RUNNING) {
    return null
  }
  const numbers = [
    'round', 'attempt', 'streak', 'lastCountedRound', 'roundsInjected', 'ticksSent', 'skippedTicks',
    'consecutiveErrors',
  ]
  const run = { ...data }
  for (const key of numbers) {
    run[key] = typeof data[key] === 'number' && Number.isFinite(data[key]) ? data[key] : 0
  }
  run.pendingRound = typeof data.pendingRound === 'number' ? data.pendingRound : null
  run.pendingMessageId = typeof data.pendingMessageId === 'string' ? data.pendingMessageId : null
  run.idempotentIntervalMs = typeof data.idempotentIntervalMs === 'number' ? data.idempotentIntervalMs : null
  run.nextTickAt = typeof data.nextTickAt === 'number' ? data.nextTickAt : null
  run.setSeq = typeof data.setSeq === 'number' ? data.setSeq : 0
  run.pausedUntil = typeof data.pausedUntil === 'number' ? data.pausedUntil : null
  run.pauseReason = typeof data.pauseReason === 'string' ? data.pauseReason : null
  run.settledAt = typeof data.settledAt === 'number' ? data.settledAt : null
  run.settleReason = typeof data.settleReason === 'string' ? data.settleReason : null
  run.lastInjectedAt = typeof data.lastInjectedAt === 'number' ? data.lastInjectedAt : null
  run.lastPostAt = typeof data.lastPostAt === 'number' ? data.lastPostAt : null
  run.updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : data.createdAt
  run.history = Array.isArray(data.history) ? data.history.slice(-LIMITS.historyLimit) : []
  return run
}
