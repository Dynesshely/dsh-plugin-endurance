/**
 * Endurance host plugin: wiring.
 *
 * Fails closed when the host Session module cannot be resolved: without the
 * plugin-record writer the run state cannot survive a reload, and pretending it
 * was persisted would be worse than not loading.
 *
 * @module dsh-plugin-endurance/plugin
 */

import { readConfig } from './config.js'
import { createRecordWriter, loadHostModules } from './host.js'
import { createService } from './service.js'
import { createDriver } from './driver.js'
import { registerTools } from './tools.js'
import { SOURCE_KIND } from './authority.js'

/** Cordis plugin name; must match the bundle patch row id. */
export const name = 'endurance'

/** Host services used by the plugin. */
export const inject = ['agents', 'tools', 'sessions', 'systemPrompt', 'timer']

/** Producer-owned message source kind of injected messages. */
export { SOURCE_KIND }

/** Model-facing tool names owned by this plugin. */
export const TOOL_NAMES = Object.freeze([
  'task_endurance_set',
  'task_endurance_post',
  'task_endurance_reset',
  'task_endurance_status',
  'task_endurance_cancel',
])

const GUIDANCE = 'Endurance tools (task_endurance_*) constrain a long-running task with convergence checks. '
  + 'Convergence mode is user-owned: if the user did not clearly choose between "converge" (settle as soon as the '
  + 'streak is met) and "idempotent_soak" (keep idempotent checks until the plan time with the artifact frozen), '
  + 'ASK before calling task_endurance_set. Call set only in a turn where the user just spoke; never register '
  + 'endurance on your own initiative. In a check round, verify the whole objective against current evidence and '
  + 'call exactly one of task_endurance_post or task_endurance_reset. During the idempotent phase the artifact '
  + 'must stay unchanged; any rework or improvement requires task_endurance_reset. Call task_endurance_cancel '
  + 'only when the user explicitly asks to stop the run.'

const PERSISTENCE_UNAVAILABLE = 'dsh-plugin-endurance: host session persistence is unavailable; the plugin '
  + 'will not register tools. Check the DSH version compatibility and the host @deepseek-ai/dsh-session module.'

/**
 * Mount the endurance plugin.
 * @param {object} ctx - Cordis host context.
 * @param {Record<string, unknown>} [rawConfig] - plain config from the bundle patch.
 * @returns {Promise<void>} resolves after tools and the driver are mounted.
 */
export async function apply(ctx, rawConfig = {}) {
  const config = readConfig(rawConfig)
  let writer
  try {
    writer = createRecordWriter(await loadHostModules(ctx))
  } catch (error) {
    ctx.logger?.warn?.(`${PERSISTENCE_UNAVAILABLE} ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const service = createService({ logger: ctx.logger, writer })
  const driver = createDriver({ ctx, config, service, logger: ctx.logger })

  registerTools({ ctx, config, service, driver })
  try {
    ctx.systemPrompt.section({
      name: 'tool:endurance',
      order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + 1,
      text: GUIDANCE,
    })
  } catch (error) {
    ctx.logger?.warn?.(`endurance: could not add the system-prompt section: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => () => driver.dispose(), 'dsh-plugin-endurance: release timers and pending checks')
  driver.start()
  ctx.logger?.info?.(`dsh-plugin-endurance: mounted (${config.enabled ? 'enabled' : 'disabled'})`)
}
