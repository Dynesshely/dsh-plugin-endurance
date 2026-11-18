/**
 * Authority and session-log helpers.
 *
 * Tools are fenced to concrete turns:
 * - `set` / `cancel` require a direct human message in the open turn of a root
 *   agent (mirrors the goal tools' `requireDirectHuman`).
 * - `post` / `reset` require the open turn to be the exact injected check round.
 *
 * @module dsh-plugin-endurance/authority
 */

/** Producer-owned source kind of every injected endurance message. */
export const SOURCE_KIND = 'plugin:dsh-plugin-endurance'

/** Model-facing tools owned by this plugin (never counted as task work). */
export const ENDURANCE_TOOL_NAMES = Object.freeze(new Set([
  'task_endurance_set',
  'task_endurance_post',
  'task_endurance_reset',
  'task_endurance_status',
  'task_endurance_cancel',
]))

/**
 * Read the committed session events without depending on a private accessor.
 * @param {object} session - live session.
 * @returns {object[]} committed events in sequence order, empty when unreadable.
 */
export function readSessionEvents(session) {
  if (session === null || typeof session !== 'object') return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents()
    } catch {
      // Fall through to point reads.
    }
  }
  const events = []
  if (typeof session.eventAt === 'function' && typeof session.seq === 'number') {
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq)
      if (event !== undefined && event !== null) events.push(event)
    }
  }
  return events
}

/**
 * Events admitted after the open turn boundary, or null when no turn is open.
 * @param {object} ctx - plugin context carrying `agents`.
 * @param {object} agent - calling agent.
 * @returns {object[] | null} open-turn events.
 */
export function openTurnEvents(ctx, agent) {
  const boundary = ctx.agents.turnBoundaryOf(agent.session)
  if (boundary === null || boundary === undefined || boundary.openTurnStartSeq === null) return null
  const events = readSessionEvents(agent.session)
  return events.slice(boundary.openTurnStartSeq + 1)
}

/**
 * Whether one agent is the registry's live root agent.
 *
 * There is no `agents.roots()` on the Host registry. The supported definition
 * is the one the official goal tools use: the exact live agent plus a Session
 * whose header is not `origin: 'subagent'`.
 * @param {object} ctx - plugin context carrying `agents`.
 * @param {object} agent - candidate agent.
 * @returns {boolean} true for a live top-level agent.
 */
export function isRootAgent(ctx, agent) {
  return ctx.agents.get(agent.id) === agent && agent?.session?.header?.origin !== 'subagent'
}

/**
 * Whether the open turn of a root agent contains a direct human message.
 * @param {object} ctx - plugin context carrying `agents`.
 * @param {object} agent - calling agent.
 * @returns {boolean} true for an authenticated human turn.
 */
export function hasDirectHumanInput(ctx, agent) {
  if (!isRootAgent(ctx, agent)) return false
  const events = openTurnEvents(ctx, agent)
  if (events === null) return false
  return events.some(event => event?.type === 'user/message' && event.data?.source?.kind === 'user')
}

/**
 * Find the injected check message for one exact round in the open turn.
 * Kickoff and finalize messages never count as check rounds.
 * @param {object} ctx - plugin context carrying `agents`.
 * @param {object} agent - calling agent.
 * @param {object} run - current run snapshot.
 * @param {number} round - exact check round.
 * @returns {object | undefined} matching user/message event.
 */
export function checkRoundInOpenTurn(ctx, agent, run, round) {
  if (run === null || run === undefined || !Number.isSafeInteger(round)) return undefined
  const events = openTurnEvents(ctx, agent)
  if (events === null) return undefined
  return events.find(event => event?.type === 'user/message'
    && event.data?.source?.kind === SOURCE_KIND
    && event.data.source.enduranceId === run.runId
    && event.data.source.round === round
    && event.data.source.phase !== 'kickoff'
    && event.data.source.phase !== 'finalize')
}

/**
 * Find the injected check message of the run's current pending round.
 * @param {object} ctx - plugin context carrying `agents`.
 * @param {object} agent - calling agent.
 * @param {object} run - current run snapshot.
 * @returns {object | undefined} matching user/message event.
 */
export function matchingCheckRound(ctx, agent, run) {
  if (run === null || run === undefined || run.pendingRound === null) return undefined
  return checkRoundInOpenTurn(ctx, agent, run, run.pendingRound)
}

/**
 * Whether the session performed any task work after the set call.
 * @param {object} session - live session.
 * @param {number} setSeq - session sequence when `task_endurance_set` ran.
 * @returns {boolean} true when a non-endurance tool call was admitted afterwards.
 */
export function workedSinceSet(session, setSeq) {
  const events = readSessionEvents(session)
  const start = Number.isSafeInteger(setSeq) ? setSeq + 1 : 0
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && typeof event.data?.name === 'string'
      && !ENDURANCE_TOOL_NAMES.has(event.data.name)) {
      return true
    }
  }
  return false
}

/**
 * Whether the newest finished turn was cancelled by the user (Stop button).
 * @param {object} session - live session.
 * @returns {boolean} true for a user-aborted turn.
 */
export function lastTurnAbortedByUser(session) {
  const events = readSessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const reason = event.data?.reason
    return reason?.kind === 'aborted' && reason.reason?.kind === 'user'
  }
  return false
}
