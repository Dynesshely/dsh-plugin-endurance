/**
 * Per-session endurance run registry.
 *
 * The session log is the only durable source of truth: every transition appends
 * a full `plugin:dsh-plugin-endurance/state` record through the host Session
 * module. The in-memory map is a cache rebuilt lazily from that log, so a
 * restart, resume, or plugin reload all converge on the same state.
 *
 * @module dsh-plugin-endurance/service
 */

import { deserializeRun, serializeRun } from './domain.js'
import { readSessionEvents } from './authority.js'

/** Plugin record type persisted into the owning session. */
export const RECORD_TYPE = 'plugin:dsh-plugin-endurance/state'

/** Render an unknown thrown value for logs. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the run registry.
 * @param {{logger?: {warn?: (message: string) => void}, sessionModule: object}} options - dependencies.
 * @returns {object} registry API.
 */
export function createService(options) {
  const { logger, writer } = options
  const runs = new Map()

  /** Stable key for one live session. */
  function keyOf(session) {
    return typeof session?.id === 'string' ? session.id : String(session?.id ?? '')
  }

  /** Rebuild the newest usable snapshot from the session log. */
  function restore(session) {
    const events = readSessionEvents(session)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== RECORD_TYPE || event.ignorable !== true) continue
      const run = deserializeRun(event.data)
      if (run !== null) return run
      logger?.warn?.('endurance: ignoring an unreadable persisted run snapshot')
    }
    return null
  }

  /** Read the current run for a session, restoring it on first access. */
  function get(session) {
    const key = keyOf(session)
    if (runs.has(key)) return runs.get(key)
    const run = restore(session)
    runs.set(key, run)
    return run
  }

  /** Persist one run snapshot and update the cache. Returns false when the log rejects it. */
  function update(session, run) {
    const key = keyOf(session)
    runs.set(key, run)
    if (run === null) return true
    try {
      writer.append(session, RECORD_TYPE, serializeRun(run))
      return true
    } catch (error) {
      logger?.warn?.(`endurance: could not persist run state: ${messageOf(error)}`)
      return false
    }
  }

  /** Drop the cached run for a session (agent disposal). */
  function forget(session) {
    runs.delete(keyOf(session))
  }

  return { get, update, forget }
}
