/**
 * Shared fakes for endurance tests: a session whose log is an array, a host
 * Session module stand-in, a tiny context with a manual timer queue, and an
 * agent whose `followup` records injected messages.
 */

/** Create an in-memory session with a contiguous event log. */
export function createFakeSession(id = 'session-1') {
  const session = {
    id,
    events: [],
    seq: 0,
    openTurnStartSeq: null,
    snapshotEvents() {
      return session.events.slice()
    },
    eventAt(index) {
      return session.events[index]
    },
    push(event) {
      const stored = { ...event, seq: session.events.length }
      session.events.push(stored)
      session.seq = session.events.length
      return stored
    },
  }
  return session
}

/** A host Session module stand-in that commits `plugin:` records. */
export function createFakeSessionModule() {
  return {
    appendPluginRecord(session, type, data) {
      session.push({ type, ignorable: true, data })
      return session.seq
    },
    pluginRecordOf(event) {
      return event?.ignorable === true ? { type: event.type, data: event.data } : undefined
    },
  }
}

/** A record writer over the fake host Session module. */
export function createFakeWriter() {
  const sessionModule = createFakeSessionModule()
  return {
    append(session, type, data) {
      return sessionModule.appendPluginRecord(session, type, data)
    },
  }
}

/** Create an agent whose followup records the injected message. */
export function createFakeAgent(session, id = 'agent-1') {
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove() {
        return true
      },
    },
    followups: [],
    followup(message) {
      agent.followups.push(message)
      agent.inbox.nextTurn.push(message)
      agent.status = 'running'
    },
  }
  return agent
}

/** Create a minimal host context with a manual timer queue and event bus. */
export function createFakeCtx(agents) {
  const listeners = new Map()
  const timers = []
  const tools = []
  const ctx = {
    baseUrl: undefined,
    logger: { warn() {}, info() {}, error() {} },
    agents: {
      get(id) {
        return [...agents.values()].find(agent => agent.id === id)
      },
      list() {
        return [...agents.values()]
      },
      turnBoundaryOf(session) {
        return { openTurnStartSeq: session.openTurnStartSeq }
      },
    },
    sessions: {
      async flush() {
        return true
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    timeout(callback, delay) {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return () => {
        timer.cleared = true
      }
    },
    get() {
      return undefined
    },
    effect() {},
    systemPrompt: {
      getSectionOrder() {
        return 100
      },
      section() {},
    },
  }
  return { ctx, listeners, timers, tools }
}

/** Fire one timer and wait for the async drive pass it started. */
export async function fireTimer(timer) {
  if (timer.cleared) throw new Error('timer was cleared')
  timer.cleared = true
  timer.callback()
  await flushMicrotasks()
}

/** Let queued microtasks and immediate callbacks settle. */
export async function flushMicrotasks() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setImmediate(resolve))
}
