/**
 * Deployment config for the endurance plugin.
 *
 * The bundle runs without a schemastery schema (zero host imports), so the
 * Loader hands `apply()` a plain object from `cordis.patch.yml`. Every value is
 * clamped here so a newer patch file or a typo can never break activation.
 *
 * @module dsh-plugin-endurance/config
 */

/** Default bounds and limits for every endurance run. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  maxDurationHours: 24,
  maxChecks: 100,
  maxUnansweredPrompts: 3,
  minCheckGapMs: 30_000,
  idempotentIntervalMinMs: 5 * 60_000,
  idempotentIntervalMaxMs: 2 * 60 * 60_000,
  abortCooldownMs: 10 * 60_000,
  injectFooter: true,
  footerLocale: 'auto',
  finalizeOnExhaustion: true,
})

/** Clamp a number into a closed range, falling back when it is not finite. */
function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Keep a boolean config value, falling back to the default. */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Validate and materialize the runtime configuration.
 * @param {Record<string, unknown>} [raw] - plain config object from the bundle patch.
 * @returns {typeof DEFAULT_CONFIG} frozen resolved config.
 */
export function readConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const footerLocale = source.footerLocale === 'zh' || source.footerLocale === 'en'
    ? source.footerLocale
    : 'auto'
  return Object.freeze({
    enabled: booleanOr(source.enabled, DEFAULT_CONFIG.enabled),
    maxDurationHours: clampNumber(source.maxDurationHours, DEFAULT_CONFIG.maxDurationHours, 1, 72),
    maxChecks: clampNumber(source.maxChecks, DEFAULT_CONFIG.maxChecks, 4, 1000),
    maxUnansweredPrompts: clampNumber(
      source.maxUnansweredPrompts,
      DEFAULT_CONFIG.maxUnansweredPrompts,
      1,
      20,
    ),
    minCheckGapMs: clampNumber(source.minCheckGapMs, DEFAULT_CONFIG.minCheckGapMs, 1_000, 3_600_000),
    idempotentIntervalMinMs: clampNumber(
      source.idempotentIntervalMinMs,
      DEFAULT_CONFIG.idempotentIntervalMinMs,
      60_000,
      24 * 3_600_000,
    ),
    idempotentIntervalMaxMs: clampNumber(
      source.idempotentIntervalMaxMs,
      DEFAULT_CONFIG.idempotentIntervalMaxMs,
      60_000,
      24 * 3_600_000,
    ),
    abortCooldownMs: clampNumber(source.abortCooldownMs, DEFAULT_CONFIG.abortCooldownMs, 1_000, 3_600_000),
    injectFooter: booleanOr(source.injectFooter, DEFAULT_CONFIG.injectFooter),
    footerLocale,
    finalizeOnExhaustion: booleanOr(source.finalizeOnExhaustion, DEFAULT_CONFIG.finalizeOnExhaustion),
  })
}
