import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from '../src/config.js'
import {
  MODE_CONVERGE,
  MODE_IDEMPOTENT_SOAK,
  PHASE,
  STATUS,
  newRun,
} from '../src/domain.js'
import { SOURCE_KIND } from '../src/authority.js'
import { createDriver } from '../src/driver.js'
import { createService } from '../src/service.js'
import {
  createFakeAgent,
  createFakeCtx,
  createFakeSession,
  createFakeWriter,
  fireTimer,
  flushMicrotasks,
} from './helpers.js'

const config = readConfig()

/** Build a driver over one fake agent; optionally start it later. */
function harness({ start = true } = {}) {
  const session = createFakeSession()
  const agent = createFakeAgent(session)
  const agents = new Map([[agent.id, agent]])
  const { ctx, timers } = createFakeCtx(agents)
  const service = createService({ logger: ctx.logger, writer: createFakeWriter() })
  const driver = createDriver({ ctx, config, service, logger: ctx.logger })
  if (start) driver.start()
  return { session, agent, ctx, service, driver, timers }
}

/** Create a run in the given status and persist it. */
function seedRun(h, overrides = {}, now = Date.now()) {
  const run = {
    ...newRun({
      mode: MODE_CONVERGE,
      durationMs: 3_600_000,
      streakRequired: 2,
      gate: 80,
      checkPrompt: 'Check the objective and report confidence with task_endurance_post.',
      idempotentIntervalMs: 60_000,
      runId: 'end_driver',
      sessionId: h.session.id,
      setSeq: 1,
      now,
    }),
    ...overrides,
  }
  h.service.update(h.session, run)
  return run
}

/** Mark the agent idle and emit the idle transition. */
async function settleTurn(h) {
  h.agent.status = 'idle'
  h.agent.inbox.nextTurn = []
  h.agent.inbox.nextStep = []
  h.ctx.emit('agent/status', { agent: h.agent, status: 'idle' })
  await flushMicrotasks()
}

test('the first check is injected after the set turn did real task work', async () => {
  const h = harness()
  h.session.openTurnStartSeq = 0
  h.session.push({ type: 'turn/start', data: { turn: 1 } })
  h.session.push({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [] } })
  h.session.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } })
  seedRun(h)
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 1)
  const message = h.agent.followups[0]
  assert.equal(message.source.kind, SOURCE_KIND)
  assert.equal(message.source.round, 1)
  assert.equal(message.source.phase, PHASE.ACTIVE)
  assert.match(message.content[0].text, /\[endurance · round 1\]/)
  const run = h.service.get(h.session)
  assert.equal(run.status, STATUS.RUNNING)
  assert.equal(run.pendingRound, 1)
})

test('a set turn with no task work gets one kickoff, then the first check', async () => {
  const h = harness()
  h.session.openTurnStartSeq = 0
  h.session.push({ type: 'turn/start', data: { turn: 1 } })
  h.session.push({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [] } })
  seedRun(h, { setSeq: 2 })
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 1)
  assert.equal(h.agent.followups[0].source.phase, 'kickoff')
  assert.equal(h.agent.followups[0].source.round, 0)
  assert.equal(h.service.get(h.session).firstCheck, 'kickoff_sent')

  await settleTurn(h)
  assert.equal(h.agent.followups.length, 2)
  assert.equal(h.agent.followups[1].source.round, 1)
  assert.equal(h.agent.followups[1].source.phase, PHASE.ACTIVE)
})

test('an unanswered check is re-sent with the same round and attempt 2', async () => {
  const h = harness()
  const run = seedRun(h, {
    status: STATUS.RUNNING,
    firstCheck: 'started',
    round: 1,
    pendingRound: 1,
    roundsInjected: 1,
    attempt: 1,
    lastInjectedAt: Date.now() - 60_000,
  })
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 1)
  const message = h.agent.followups[0]
  assert.equal(message.source.round, run.round)
  assert.equal(message.source.attempt, 2)
})

test('an unanswered round settles as stalled at the retry limit', async () => {
  const h = harness()
  seedRun(h, {
    status: STATUS.RUNNING,
    firstCheck: 'started',
    round: 1,
    pendingRound: 1,
    roundsInjected: 1,
    attempt: 3,
    lastInjectedAt: Date.now() - 60_000,
  })
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 0)
  assert.equal(h.service.get(h.session).status, STATUS.STALLED)
})

test('converge mode settles immediately when the streak is already met', async () => {
  const h = harness()
  seedRun(h, {
    status: STATUS.RUNNING,
    firstCheck: 'started',
    streak: 2,
    phase: PHASE.ACTIVE,
  })
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 0)
  assert.equal(h.service.get(h.session).status, STATUS.CONVERGED)
})

test('idempotent ticks are skipped while the agent is genuinely running', async () => {
  const h = harness()
  const now = Date.now()
  seedRun(h, {
    mode: MODE_IDEMPOTENT_SOAK,
    status: STATUS.RUNNING,
    firstCheck: 'started',
    phase: PHASE.IDEMPOTENT,
    streak: 2,
    nextTickAt: now + 40,
  }, now)
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 0)
  const tickTimer = h.timers
    .filter(timer => timer.cleared === false)
    .sort((left, right) => left.delay - right.delay)[0]
  assert.ok(tickTimer, 'a tick timer should be scheduled')
  h.agent.status = 'running'
  await fireTimer(tickTimer)
  const run = h.service.get(h.session)
  assert.equal(run.skippedTicks, 1)
  assert.equal(h.agent.followups.length, 0)
})

test('an idle idempotent tick injects a verification round', async () => {
  const h = harness()
  const now = Date.now()
  seedRun(h, {
    mode: MODE_IDEMPOTENT_SOAK,
    status: STATUS.RUNNING,
    firstCheck: 'started',
    phase: PHASE.IDEMPOTENT,
    streak: 2,
    nextTickAt: now - 1,
  }, now)
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 1)
  assert.equal(h.agent.followups[0].source.phase, PHASE.IDEMPOTENT)
  assert.match(h.agent.followups[0].content[0].text, /\[endurance · idempotent check\]/)
})

test('a user-aborted turn starts the cooldown instead of injecting at once', async () => {
  const h = harness()
  h.session.openTurnStartSeq = 0
  h.session.push({ type: 'turn/start', data: { turn: 1 } })
  h.session.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  seedRun(h, { status: STATUS.RUNNING, firstCheck: 'started' })
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 0)
  assert.ok(h.service.get(h.session).pausedUntil > Date.now())
})

test('an active run on an already-idle agent is recovered after plugin start', async () => {
  const h = harness({ start: false })
  h.session.openTurnStartSeq = 0
  h.session.push({ type: 'turn/start', data: { turn: 1 } })
  h.session.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } })
  seedRun(h, { status: STATUS.RUNNING, firstCheck: 'started' })
  h.driver.start()
  const recovery = h.timers
    .filter(timer => timer.cleared === false)
    .sort((left, right) => left.delay - right.delay)[0]
  assert.ok(recovery, 'a recovery timer should be scheduled')
  await fireTimer(recovery)
  assert.equal(h.agent.followups.length, 1)
  assert.equal(h.agent.followups[0].source.round, 1)
})

test('goal rounds suspend endurance injection', async () => {
  const h = harness()
  h.ctx.get = service => service === 'goals'
    ? { get: () => ({ phase: 'active', activation: 'armed' }) }
    : undefined
  h.session.openTurnStartSeq = 0
  h.session.push({ type: 'turn/start', data: { turn: 1 } })
  h.session.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } })
  seedRun(h)
  await settleTurn(h)
  assert.equal(h.agent.followups.length, 0)
})
