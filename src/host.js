/**
 * Host module bridge.
 *
 * A profile-installed bundle is outside the host's dependency graph, so it
 * cannot `import '@deepseek-ai/dsh-session'` directly, and the plugin-record
 * writer must use the exact module instance the host loaded (it commits through
 * a module-private binding). Resolve that instance from host anchors, mirroring
 * the community `dsh-plugin-portara` pattern, and fail closed when it is absent.
 *
 * @module dsh-plugin-endurance/host
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_PACKAGE = '@deepseek-ai/dsh-session'

/**
 * Walk up from a resolved entry file to the package root that owns it.
 * @param {string} file - absolute module file path.
 * @returns {string | undefined} package root directory.
 */
function packageRootOf(file) {
  let directory = dirname(file)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8'))?.name === SESSION_PACKAGE) return directory
      } catch {
        // Unreadable manifest: keep walking.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Build anchors whose `createRequire` resolution reaches the host's installation.
 * @param {object} ctx - plugin context (may carry `baseUrl`).
 * @returns {string[]} file URLs usable as `createRequire` anchors.
 */
function anchors(ctx) {
  const urls = []
  const base = typeof ctx?.baseUrl === 'string' && ctx.baseUrl !== '' ? ctx.baseUrl : undefined
  if (base !== undefined) {
    try {
      urls.push(new URL('package.json', base).href)
    } catch {
      // Not a URL-shaped base.
    }
  }
  const cwd = process.cwd()
  urls.push(pathToFileURL(join(cwd, 'package.json')).href)
  urls.push(pathToFileURL(join(cwd, 'apps', 'cli', 'package.json')).href)
  if (typeof process.argv[1] === 'string') {
    urls.push(pathToFileURL(join(dirname(process.argv[1]), 'package.json')).href)
  }
  urls.push(import.meta.url)
  return urls
}

/**
 * Candidate module URLs for the host's Session package, most likely first.
 * The resolved entry (what the host itself imports) leads; source and built
 * entries follow so a source checkout and an installed deployment both work.
 * @param {object} ctx - plugin context.
 * @returns {string[]} candidate file URLs.
 */
function candidateUrls(ctx) {
  const urls = []
  const seen = new Set()
  for (const anchor of anchors(ctx)) {
    let resolved
    try {
      resolved = createRequire(anchor).resolve(SESSION_PACKAGE)
    } catch {
      continue
    }
    let packageDirectory
    try {
      packageDirectory = packageRootOf(realpathSync(resolved))
    } catch {
      continue
    }
    if (packageDirectory === undefined) continue
    for (const entry of [
      realpathSync(resolved),
      join(packageDirectory, 'src', 'index.ts'),
      join(packageDirectory, 'lib', 'index.js'),
    ]) {
      if (!existsSync(entry)) continue
      let url
      try {
        url = pathToFileURL(entry).href
      } catch {
        continue
      }
      if (!seen.has(url)) {
        seen.add(url)
        urls.push(url)
      }
    }
    if (urls.length > 0) break
  }
  return urls
}

/**
 * Load every candidate host Session module instance that exposes the
 * plugin-record writer. The writer factory below probes which instance owns a
 * given live session, because the append function is fenced by a module-private
 * binding.
 * @param {object} ctx - plugin context.
 * @returns {Promise<object[]>} modules exposing `appendPluginRecord`.
 * @throws {Error} when no candidate provides the writer.
 */
export async function loadHostModules(ctx) {
  const attempted = []
  const modules = []
  for (const url of candidateUrls(ctx)) {
    try {
      const module = await import(url)
      if (typeof module.appendPluginRecord === 'function') modules.push(module)
      else attempted.push(`${url} (missing appendPluginRecord)`)
    } catch (error) {
      attempted.push(`${url} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (modules.length === 0) {
    throw new Error(
      'dsh-plugin-endurance cannot resolve the host @deepseek-ai/dsh-session module; '
        + 'plugin state persistence is unavailable. Tried: '
        + (attempted.length === 0 ? 'no candidates' : attempted.join('; ')),
    )
  }
  return modules
}

/**
 * Build a record writer that uses the exact host module instance owning a live
 * session. The first successful append pins that instance; a brand rejection
 * falls through to the next candidate.
 * @param {object[]} modules - candidate host Session modules.
 * @returns {{append: (session: object, type: string, data: object) => number}} writer.
 */
export function createRecordWriter(modules) {
  let active
  return {
    append(session, type, data) {
      if (active !== undefined) return active.appendPluginRecord(session, type, data)
      const failures = []
      for (const module of modules) {
        try {
          const seq = module.appendPluginRecord(session, type, data)
          active = module
          return seq
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      throw new Error(
        'dsh-plugin-endurance found no host Session module instance that can write this session: '
          + failures.join('; '),
      )
    },
  }
}

