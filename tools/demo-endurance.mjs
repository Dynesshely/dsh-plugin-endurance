/**
 * End-to-end demo of the endurance loop without a live Host.
 *
 * Drives the real domain, tools, service, and driver over fake Agent/Session
 * objects: register a 10-minute `converge` run (2 rounds at 80%), complete a
 * work turn, answer two injected checks, and print the settlement.
 *
 * Usage: node tools/demo-endurance.mjs
 */

import { readConfig } from '../src/config.js'
import { createService } from '../src/service.js'
import { createDriver } from '../src/driver.js'
import { registerTools } from '../src/tools.js'
import { MODE_CONVERGE } from '../src/domain.js'
import {
  createFakeAgent,
  createFakeCtx,
  createFakeSession,
  createFakeWriter,
  flushMicrotasks,
} from '../test/helpers.js'

const config = readConfig({ minCheckGapMs: 1000 })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const session = createFakeSession()
const agent = createFakeAgent(session)
const agents = new Map([[agent.id, agent]])
const { ctx } = createFakeCtx(agents)
const service = createService({ logger: ctx.logger, writer: createFakeWriter() })
const driver = createDriver({ ctx, config, service, logger: ctx.logger })

const registered = []
const register = ctx.tools.register.bind(ctx.tools)
ctx.tools.register = definition => {
  registered.push(definition)
  register(definition)
}
registerTools({ ctx, config, service, driver })
driver.start()

const exec = { agent }
const byName = name => registered.find(tool => tool.name === name)
const line = text => console.log(text)

/** Append one human turn and keep it open. */
function openTurn() {
  session.push({ type: 'turn/start', data: { turn: session.seq + 1 } })
  session.openTurnStartSeq = session.seq - 1
  session.push({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [] } })
  agent.status = 'running'
}

/** Close the open turn and let the driver react to the idle transition. */
async function endTurn() {
  agent.status = 'idle'
  agent.inbox.nextTurn = []
  agent.inbox.nextStep = []
  ctx.emit('agent/status', { agent, status: 'idle' })
  await flushMicrotasks()
}

/** Admit the injected check message as the next open turn. */
function admitCheck(followup) {
  session.push({ type: 'turn/start', data: { turn: session.seq + 1 } })
  session.openTurnStartSeq = session.seq - 1
  session.push({
    type: 'user/message',
    data: { role: 'user', content: followup.content, source: followup.source },
  })
  agent.status = 'running'
}

line('=== endurance demo: 10m / 2 rounds / 80% / converge ===')

openTurn()
const setResult = await byName('task_endurance_set').execute({
  duration: '10m',
  min_consecutive_passes: 2,
  confidence_gate: 80,
  convergence_mode: MODE_CONVERGE,
  check_prompt: '现在是第 $endurance_id 轮检查，连续 $endurance_total_count 轮置信率高于 $endurance_gate 即可结束。'
    + '请调用 task_endurance_post 汇报，或调用 task_endurance_reset 继续。',
}, exec)
line(`set -> ${setResult.run.id} (${setResult.run.status}, ${setResult.run.mode})`)

// One real task round: the agent runs a tool after registering, then settles.
session.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } })
await endTurn()
const first = agent.followups.at(-1)
line(`\ninjected round ${first.source.round}:`)
line(first.content[0].text.split('\n').slice(0, 5).join('\n'))

admitCheck(first)
const post1 = await byName('task_endurance_post').execute({ confidence: 88, summary: 'tests + review pass' }, exec)
line(`\npost 88 -> streak ${post1.run.streak}/${post1.run.min_consecutive_passes}, ${post1.run.status}`)
await sleep(1_100) // respect the deployment's minimum check gap
await endTurn()

const second = agent.followups.at(-1)
line(`\ninjected round ${second.source.round}:`)
line(second.content[0].text.split('\n').slice(0, 5).join('\n'))

admitCheck(second)
const post2 = await byName('task_endurance_post').execute({ confidence: 86, summary: 'second verification pass' }, exec)
line(`\npost 86 -> streak ${post2.run.streak}/${post2.run.min_consecutive_passes}, ${post2.run.status}`)
line(`settle: ${post2.run.settle_reason} at ${post2.run.settled_at}`)

const status = await byName('task_endurance_status').execute({}, exec)
line(`\nfinal status: ${status.run.status}, rounds ${status.run.rounds_injected}, streak ${status.run.streak}`)
line(`extra checks after convergence: ${agent.followups.length - 2} (expected 0)`)
