import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from '../src/config.js'
import {
  MODE_CONVERGE,
  MODE_IDEMPOTENT_SOAK,
  PHASE,
  STATUS,
  beginInjection,
  newRun,
} from '../src/domain.js'
import { SOURCE_KIND } from '../src/authority.js'
import { registerTools } from '../src/tools.js'
import { createService } from '../src/service.js'
import {
  createFakeAgent,
  createFakeCtx,
  createFakeSession,
  createFakeWriter,
} from './helpers.js'

/** Mount the real tools over fake host services. */
function harness(options = {}) {
  const session = createFakeSession()
  const agent = createFakeAgent(session)
  const agents = new Map([[agent.id, agent]])
  const { ctx, tools } = createFakeCtx(agents)
  const config = readConfig(options.config)
  const service = createService({ logger: ctx.logger, writer: createFakeWriter() })
  const woken = []
  const driver = { wake: target => woken.push(target.id) }
  registerTools({ ctx, config, service, driver })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const exec = { agent }
  return { session, agent, ctx, service, driver, tools: byName, exec, config, woken }
}

/** Open a turn and add one direct human user message to it. */
function addHumanTurn(session) {
  session.push({ type: 'turn/start', data: { turn: session.eventAt(0)?.data?.turn ?? 1 } })
  session.openTurnStartSeq = session.events.length - 1
  session.push({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [] } })
}

/** Add the injected check message for the run's pending round. */
function addCheckMessage(session, run) {
  session.push({
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: SOURCE_KIND, enduranceId: run.runId, round: run.pendingRound, attempt: 1 },
      content: [],
    },
  })
}

/** Register a run through the set tool. */
async function setRun(h, args = {}) {
  addHumanTurn(h.session)
  const result = await h.tools.get('task_endurance_set').execute({
    duration: '1h',
    min_consecutive_passes: 2,
    confidence_gate: 80,
    check_prompt: 'Check the objective and report confidence with task_endurance_post.',
    convergence_mode: MODE_CONVERGE,
    ...args,
  }, h.exec)
  return result
}

test('set rejects a subagent-origin session even inside a human-looking turn', async () => {
  const h = harness()
  h.agent.session.header = { origin: 'subagent' }
  addHumanTurn(h.session)
  await assert.rejects(
    h.tools.get('task_endurance_set').execute({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check the objective and report confidence with task_endurance_post.',
      convergence_mode: MODE_CONVERGE,
    }, h.exec),
    error => error.code === 'ENDURANCE_AUTHORITY_REQUIRED',
  )
  delete h.agent.session.header
})

test('set rejects a stale agent that is no longer the registry instance', async () => {
  const h = harness()
  addHumanTurn(h.session)
  h.ctx.agents.get = () => ({ id: h.agent.id })
  await assert.rejects(
    h.tools.get('task_endurance_set').execute({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check the objective and report confidence with task_endurance_post.',
      convergence_mode: MODE_CONVERGE,
    }, h.exec),
    error => error.code === 'ENDURANCE_AUTHORITY_REQUIRED',
  )
})

test('unexpected throws are wrapped as ENDURANCE_INTERNAL instead of escaping raw', async () => {
  const h = harness()
  h.service.get = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'roots')")
  }
  await assert.rejects(
    h.tools.get('task_endurance_status').execute({}, h.exec),
    error => error.code === 'ENDURANCE_INTERNAL' && /failed unexpectedly/.test(error.message),
  )
})

test('set requires a direct human turn', async () => {
  const h = harness()
  await assert.rejects(
    h.tools.get('task_endurance_set').execute({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check the objective and report confidence with task_endurance_post.',
      convergence_mode: MODE_CONVERGE,
    }, h.exec),
    error => error.code === 'ENDURANCE_AUTHORITY_REQUIRED',
  )
})

test('set requires an explicit convergence mode', async () => {
  const h = harness()
  addHumanTurn(h.session)
  await assert.rejects(
    h.tools.get('task_endurance_set').execute({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check the objective and report confidence with task_endurance_post.',
    }, h.exec),
    error => error.code === 'ENDURANCE_MODE_REQUIRED',
  )
})

test('set rejects unknown template placeholders', async () => {
  const h = harness()
  addHumanTurn(h.session)
  await assert.rejects(
    h.tools.get('task_endurance_set').execute({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check $endurance_typo and report confidence with task_endurance_post.',
      convergence_mode: MODE_CONVERGE,
    }, h.exec),
    error => error.code === 'ENDURANCE_PROMPT_INVALID',
  )
})

test('set persists an armed run and wakes the driver', async () => {
  const h = harness()
  const result = await setRun(h)
  assert.equal(result.ok, true)
  assert.equal(result.run.status, STATUS.ARMED)
  assert.equal(result.run.phase, PHASE.ACTIVE)
  assert.equal(h.service.get(h.session).status, STATUS.ARMED)
  assert.deepEqual(h.woken, [h.agent.id])
  assert.equal(h.session.events.at(-1).type, 'plugin:dsh-plugin-endurance/state')
})

test('a second set is rejected while a run is active', async () => {
  const h = harness()
  await setRun(h)
  addHumanTurn(h.session)
  await assert.rejects(
    h.tools.get('task_endurance_set').execute({
      duration: '1h',
      min_consecutive_passes: 2,
      confidence_gate: 80,
      check_prompt: 'Check the objective and report confidence with task_endurance_post.',
      convergence_mode: MODE_CONVERGE,
    }, h.exec),
    error => error.code === 'ENDURANCE_ALREADY_ACTIVE',
  )
})

test('post is rejected outside the pending check round', async () => {
  const h = harness()
  const { run } = await setRun(h)
  await assert.rejects(
    h.tools.get('task_endurance_post').execute({ confidence: 90, summary: 'done' }, h.exec),
    error => error.code === 'ENDURANCE_NOT_A_CHECK_ROUND',
  )
  assert.equal(h.service.get(h.session).runId, run.id)
})

test('post counts a passing round and advances the streak', async () => {
  const h = harness()
  await setRun(h)
  let run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  h.service.update(h.session, run)
  addCheckMessage(h.session, run)
  const result = await h.tools.get('task_endurance_post').execute(
    { confidence: 90, summary: 'verified by tests', artifacts: ['dist/app.js'] },
    h.exec,
  )
  assert.equal(result.ok, true)
  assert.equal(result.run.streak, 1)
  assert.equal(result.run.status, STATUS.RUNNING)
  assert.equal(h.service.get(h.session).streak, 1)
})

test('a passing post can converge the run', async () => {
  const h = harness()
  await setRun(h)
  let run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  h.service.update(h.session, run)
  addCheckMessage(h.session, run)
  h.session.push({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [] } })
  const first = await h.tools.get('task_endurance_post').execute(
    { confidence: 90, summary: 'first pass' },
    h.exec,
  )
  assert.equal(first.run.streak, 1)
  run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm2' })
  h.service.update(h.session, run)
  addCheckMessage(h.session, run)
  const second = await h.tools.get('task_endurance_post').execute(
    { confidence: 88, summary: 'second pass' },
    h.exec,
  )
  assert.equal(second.run.status, STATUS.CONVERGED)
  assert.equal(second.run.can_conclude, true)
})

test('a duplicate post in the same round is not counted twice', async () => {
  const h = harness()
  await setRun(h)
  let run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  h.service.update(h.session, run)
  addCheckMessage(h.session, run)
  const first = await h.tools.get('task_endurance_post').execute(
    { confidence: 90, summary: 'first pass' },
    h.exec,
  )
  assert.equal(first.run.streak, 1)
  const duplicate = await h.tools.get('task_endurance_post').execute(
    { confidence: 95, summary: 'duplicate' },
    h.exec,
  )
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.counted, false)
  assert.equal(duplicate.run.streak, 1)
  assert.equal(h.service.get(h.session).streak, 1)
})

test('reset after a same-round post takes priority and clears the streak', async () => {
  const h = harness()
  await setRun(h)
  let run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  h.service.update(h.session, run)
  addCheckMessage(h.session, run)
  await h.tools.get('task_endurance_post').execute({ confidence: 90, summary: 'pass' }, h.exec)
  const reset = await h.tools.get('task_endurance_reset').execute({ reason: 'rework needed' }, h.exec)
  assert.equal(reset.ok, true)
  assert.equal(reset.run.streak, 0)
  assert.equal(h.service.get(h.session).streak, 0)
})

test('malformed post arguments fail as a tool error, not a TypeError', async () => {
  const h = harness()
  await setRun(h)
  let run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  h.service.update(h.session, run)
  addCheckMessage(h.session, run)
  await assert.rejects(
    h.tools.get('task_endurance_post').execute({}, h.exec),
    error => error.code === 'ENDURANCE_INVALID_PARAMS',
  )
})

test('reset clears the streak and keeps the run active', async () => {
  const h = harness()
  await setRun(h)
  let run = h.service.get(h.session)
  run = beginInjection(run, { now: Date.now(), phase: PHASE.ACTIVE, attempt: 1, messageId: 'm1' })
  h.service.update(h.session, { ...run, streak: 1 })
  run = h.service.get(h.session)
  addCheckMessage(h.session, run)
  const result = await h.tools.get('task_endurance_reset').execute(
    { reason: 'missing coverage' },
    h.exec,
  )
  assert.equal(result.ok, true)
  assert.equal(result.run.streak, 0)
  assert.equal(result.run.phase, PHASE.ACTIVE)
  assert.equal(result.run.status, STATUS.RUNNING)
})

test('status reports the current run and null when idle', async () => {
  const h = harness()
  const empty = await h.tools.get('task_endurance_status').execute({}, h.exec)
  assert.equal(empty.ok, true)
  assert.equal(empty.run, null)
  await setRun(h)
  const result = await h.tools.get('task_endurance_status').execute({}, h.exec)
  assert.equal(result.run.mode, MODE_CONVERGE)
  assert.equal(result.run.status, STATUS.ARMED)
})

test('cancel requires confirmation and a human turn', async () => {
  const h = harness()
  await setRun(h)
  addHumanTurn(h.session)
  await assert.rejects(
    h.tools.get('task_endurance_cancel').execute(
      { reason: 'stop', confirm_user_request: false },
      h.exec,
    ),
    error => error.code === 'ENDURANCE_INVALID_PARAMS',
  )
  const result = await h.tools.get('task_endurance_cancel').execute(
    { reason: 'user asked to stop', confirm_user_request: true },
    h.exec,
  )
  assert.equal(result.run.status, STATUS.CANCELLED)
  assert.equal(h.service.get(h.session).status, STATUS.CANCELLED)
})

test('idempotent_soak is accepted with the default interval', async () => {
  const h = harness()
  const result = await setRun(h, { convergence_mode: MODE_IDEMPOTENT_SOAK, duration: '8h' })
  assert.equal(result.run.mode, MODE_IDEMPOTENT_SOAK)
  assert.equal(result.run.idempotent_interval, '1h')
  assert.equal(h.service.get(h.session).idempotentIntervalMs, 3_600_000)
})
