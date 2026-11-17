import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MODE_CONVERGE,
  MODE_IDEMPOTENT_SOAK,
  PHASE,
  STATUS,
  applyPost,
  applyReset,
  beginInjection,
  defaultIdempotentInterval,
  deriveGrace,
  deserializeRun,
  ensurePhase,
  evaluateSettlement,
  formatDuration,
  formatRemaining,
  gateMet,
  newRun,
  normalizeSetInput,
  parseDuration,
  recordTickSkip,
  serializeRun,
  settle,
} from '../src/domain.js'
import { readConfig } from '../src/config.js'

const config = readConfig({})

/** Normalized set parameters for a 1h / 2-pass / 80% converge run. */
function normalized(overrides = {}) {
  return {
    mode: MODE_CONVERGE,
    durationMs: 3_600_000,
    streakRequired: 2,
    gate: 80,
    checkPrompt: 'Check the objective and report confidence with task_endurance_post.',
    idempotentIntervalMs: undefined,
    ...overrides,
  }
}

/** Create a run and advance it to `running` by injecting round 1. */
function runningRun(overrides = {}, now = 1_000_000) {
  const run = newRun({
    ...normalized(overrides),
    runId: 'end_test',
    sessionId: 'session-1',
    setSeq: 0,
    now,
  })
  return beginInjection(run, { now, phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
}

/** Report one check round and return the resulting run. */
function report(run, confidence, now) {
  return applyPost(run, { now, confidence, summary: 'evidence' })
}

test('parseDuration accepts m/h/d and rejects invalid input', () => {
  assert.equal(parseDuration('8h'), 8 * 3_600_000)
  assert.equal(parseDuration('90m'), 90 * 60_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.equal(parseDuration('0.5h'), 1_800_000)
  assert.throws(() => parseDuration('8x'), /look like/)
  assert.throws(() => parseDuration(undefined), /must be a string/)
  assert.throws(() => parseDuration(''), /look like/)
  assert.throws(() => parseDuration('0m'), /between/)
  assert.throws(() => parseDuration('25h'), /between/)
})

test('format helpers render stable human strings', () => {
  assert.equal(formatDuration(8 * 3_600_000), '8h')
  assert.equal(formatDuration(90 * 60_000), '90m')
  assert.equal(formatDuration(1.5 * 3_600_000), '90m')
  assert.equal(formatRemaining(4 * 3_600_000 + 12 * 60_000), '4h 12m')
  assert.equal(formatRemaining(0), '0m')
})

test('grace and default idempotent interval clamp to their windows', () => {
  assert.equal(deriveGrace(8 * 3_600_000), 2 * 3_600_000)
  assert.equal(deriveGrace(10 * 60_000), 30 * 60_000)
  assert.equal(deriveGrace(24 * 3_600_000), 4 * 3_600_000)
  assert.equal(defaultIdempotentInterval(8 * 3_600_000, 300_000, 7_200_000), 3_600_000)
  assert.equal(defaultIdempotentInterval(60_000, 300_000, 7_200_000), 300_000)
})

test('normalizeSetInput validates the mode, bounds, and interval', () => {
  assert.throws(() => normalizeSetInput({}, config), error => error.code === 'MODE_REQUIRED')
  assert.throws(
    () => normalizeSetInput({ convergence_mode: 'forever' }, config),
    error => error.code === 'INVALID_PARAMS',
  )
  const converge = normalizeSetInput({
    duration: '1h',
    min_consecutive_passes: 2,
    confidence_gate: 80,
    check_prompt: 'Check the objective and report confidence.',
    convergence_mode: 'converge',
  }, config)
  assert.equal(converge.idempotentIntervalMs, undefined)
  const soak = normalizeSetInput({
    duration: '8h',
    min_consecutive_passes: 3,
    confidence_gate: 85,
    check_prompt: 'Check the objective and report confidence.',
    convergence_mode: 'idempotent_soak',
    idempotent_interval: '30m',
  }, config)
  assert.equal(soak.idempotentIntervalMs, 1_800_000)
  const defaulted = normalizeSetInput({
    duration: '8h',
    min_consecutive_passes: 3,
    confidence_gate: 85,
    check_prompt: 'Check the objective and report confidence.',
    convergence_mode: 'idempotent_soak',
  }, config)
  assert.equal(defaulted.idempotentIntervalMs, 3_600_000)
  assert.throws(
    () => normalizeSetInput({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check the objective and report confidence.',
      convergence_mode: 'converge',
      idempotent_interval: '10m',
    }, config),
    error => error.code === 'INVALID_PARAMS',
  )
})

test('run starts armed with derived plan and safety windows', () => {
  const run = newRun({
    ...normalized(),
    runId: 'end_1',
    sessionId: 'session-1',
    setSeq: 3,
    now: 1_000_000,
  })
  assert.equal(run.status, STATUS.ARMED)
  assert.equal(run.targetAt, 1_000_000 + 3_600_000)
  assert.equal(run.hardDeadlineAt, 1_000_000 + 3_600_000 + 30 * 60_000)
  assert.equal(run.firstCheck, 'pending')
  assert.equal(run.round, 0)
})

test('converge mode settles as soon as the streak is met', () => {
  let run = runningRun()
  run = report(run, 90, 1_100_000)
  assert.equal(run.streak, 1)
  assert.equal(run.status, STATUS.RUNNING)
  run = beginInjection(run, { now: 1_100_000, phase: PHASE.ACTIVE, attempt: 1, messageId: 'm2' })
  run = report(run, 85, 1_200_000)
  assert.equal(run.streak, 2)
  assert.equal(run.status, STATUS.CONVERGED)
  assert.equal(gateMet(run), true)
  assert.equal(evaluateSettlement(run, 1_300_000), null)
})

test('a low-confidence report clears the streak and keeps running', () => {
  let run = runningRun()
  run = report(run, 90, 1_100_000)
  run = beginInjection(run, { now: 1_100_000, phase: PHASE.ACTIVE, attempt: 1, messageId: 'm2' })
  run = report(run, 40, 1_200_000)
  assert.equal(run.streak, 0)
  assert.equal(run.status, STATUS.RUNNING)
})

test('a counted post clears the consecutive error count', () => {
  let run = runningRun()
  run = { ...run, consecutiveErrors: 2 }
  run = report(run, 90, 1_100_000)
  assert.equal(run.consecutiveErrors, 0)
})

test('reset clears the streak and returns to the active phase', () => {
  let run = runningRun({ mode: MODE_IDEMPOTENT_SOAK })
  run = report(run, 90, 1_100_000)
  run = applyReset(run, { now: 1_150_000, reason: 'needs work' })
  assert.equal(run.streak, 0)
  assert.equal(run.phase, PHASE.ACTIVE)
  assert.equal(run.status, STATUS.RUNNING)
})

test('idempotent mode enters the soak phase and settles at the plan time', () => {
  let run = runningRun({ mode: MODE_IDEMPOTENT_SOAK, streakRequired: 2 }, 1_000_000)
  run = report(run, 90, 1_100_000)
  assert.equal(run.phase, PHASE.ACTIVE)
  run = beginInjection(run, { now: 1_100_000, phase: PHASE.ACTIVE, attempt: 1, messageId: 'm2' })
  run = report(run, 90, 1_200_000)
  assert.equal(run.status, STATUS.RUNNING)
  assert.equal(run.phase, PHASE.IDEMPOTENT)
  assert.equal(run.nextTickAt, 1_200_000 + run.idempotentIntervalMs)
  assert.equal(evaluateSettlement(run, run.targetAt - 1), null)
  const settled = settle(run, STATUS.CONVERGED, 'idempotent-soak-complete', run.targetAt)
  assert.equal(settled.status, STATUS.CONVERGED)
})

test('a regression during the idempotent phase returns to active checks', () => {
  let run = runningRun({ mode: MODE_IDEMPOTENT_SOAK, streakRequired: 1 }, 1_000_000)
  run = report(run, 90, 1_100_000)
  assert.equal(run.phase, PHASE.IDEMPOTENT)
  run = beginInjection(run, { now: 1_100_000, phase: PHASE.IDEMPOTENT, attempt: 1, messageId: 'm2' })
  run = report(run, 30, 1_200_000)
  assert.equal(run.phase, PHASE.ACTIVE)
  assert.equal(run.streak, 0)
  assert.equal(run.status, STATUS.RUNNING)
})

test('hard deadline settles a non-converged run as exhausted', () => {
  const run = runningRun()
  assert.equal(evaluateSettlement(run, run.hardDeadlineAt + 1), STATUS.EXHAUSTED)
})

test('skipped ticks roll the next tick forward', () => {
  const run = runningRun({ mode: MODE_IDEMPOTENT_SOAK, streakRequired: 1 }, 1_000_000)
  const skipped = recordTickSkip({ ...run, nextTickAt: 1_500_000 }, 1_600_000)
  assert.equal(skipped.skippedTicks, 1)
  assert.equal(skipped.nextTickAt, 1_600_000 + skipped.idempotentIntervalMs)
})

test('ensurePhase only enters the idempotent phase before the plan time', () => {
  const run = runningRun({ mode: MODE_IDEMPOTENT_SOAK, streakRequired: 1 }, 1_000_000)
  const passed = { ...run, streak: 1, phase: PHASE.ACTIVE }
  assert.equal(ensurePhase(passed, run.targetAt - 1).phase, PHASE.IDEMPOTENT)
  assert.equal(ensurePhase(passed, run.targetAt + 1).phase, PHASE.ACTIVE)
})

test('serialize/deserialize round-trips a run and rejects stale versions', () => {
  const run = runningRun()
  const restored = deserializeRun(JSON.parse(JSON.stringify(serializeRun(run))))
  assert.equal(restored.runId, run.runId)
  assert.equal(restored.status, run.status)
  assert.equal(restored.checkPrompt, run.checkPrompt)
  assert.equal(restored.history.at(-1).kind, 'inject')
  assert.equal(deserializeRun({ ...serializeRun(run), schemaVersion: 99 }), null)
  assert.equal(deserializeRun({}), null)
})
