/**
 * dsh-plugin-endurance host entry.
 *
 * The bundle patch mounts this module as the `endurance` row; the browser half
 * (status row, commands) arrives in M2 and will ride `dsh.client`.
 *
 * @module dsh-plugin-endurance
 */

export { apply, inject, name, SOURCE_KIND, TOOL_NAMES } from './src/plugin.js'
export { readConfig } from './src/config.js'
