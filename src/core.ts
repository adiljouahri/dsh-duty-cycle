/**
 * dsh-duty-cycle — Pure duty-cycle scheduling logic (single source of truth).
 *
 * Custom fork: the plugin keeps exactly ONE function — a repeating duty cycle:
 * pause for `pauseMinutes`, run for `activeMinutes`, forever (default 15/45).
 * Everything the upstream plugin also offered (clock pause-windows, account
 * balance tracking/display, i18n, "end this window", model-tier exemptions)
 * has been REMOVED. Nothing in this module touches Cordis, services or the
 * sandbox; it is unit-tested (tests/cycle.test.js) and inlined into the Host
 * plugin body at build time (scripts/build.js).
 */

export interface CycleSettings {
  enabled: boolean
  /** Length of the paused phase, minutes (1-1440). */
  pauseMinutes: number
  /** Length of the active (running) phase, minutes (1-1440). */
  activeMinutes: number
  /**
   * Epoch-ms instant where the cycle starts (a pause phase begins here).
   * 0 = anchor at local midnight of the config timezone (with 15+45=60 the
   * boundaries land on every full hour: :00-:15 paused, :15-:00 active).
   */
  anchorAt: number
}

export interface WallClock {
  y: number
  mo: number
  d: number
  weekday: number
  minutes: number
}

export interface ValidationResult {
  ok: boolean
  error?: string
}

/** Convert a Date to wall-clock components in the given IANA timezone. */
export function wallClock(tz: string, date: Date): WallClock {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of f.formatToParts(date)) parts[p.type] = p.value
  const y = Number(parts.year), mo = Number(parts.month), d = Number(parts.day)
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return { y, mo, d, weekday, minutes }
}

/**
 * Convert a wall-clock HH:mm on a given date to an epoch-ms UTC instant.
 * Robust for any real offset (incl. ±12/±13h like Pacific/Auckland): first
 * align the wall-clock DATE (full-day steps), then align the minutes within
 * that day — forward-only stepping would cross days for large offsets.
 */
export function wallToUTC(tz: string, y: number, mo: number, d: number, hhmm: number): number {
  let ms = Date.UTC(y, mo - 1, d, Math.floor(hhmm / 60), hhmm % 60)
  const targetDay = Date.UTC(y, mo - 1, d)
  for (let i = 0; i < 8; i++) {
    const w = wallClock(tz, new Date(ms))
    if (w.y === y && w.mo === mo && w.d === d && w.minutes === hhmm) return ms
    const curDay = Date.UTC(w.y, w.mo - 1, w.d)
    const dayDiff = Math.round((curDay - targetDay) / 86400000)
    if (dayDiff !== 0) {
      ms -= dayDiff * 86400000
      continue
    }
    ms += (hhmm - w.minutes) * 60000
  }
  return ms
}

/** True when the string is a valid IANA timezone name. */
export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch (e) { return false }
}

/** Anchor instant of the cycle: anchorAt when set, else local midnight of tz. */
export function cycleBaseMs(cycle: CycleSettings, tz: string, now: Date): number {
  if (cycle.anchorAt > 0) return cycle.anchorAt
  const wc = wallClock(tz, now)
  return wallToUTC(tz, wc.y, wc.mo, wc.d, 0)
}

/** Minutes elapsed in the cycle timeline at `now` (anchor or midnight based). */
export function cycleElapsedMinutes(cycle: CycleSettings, tz: string, now: Date): number {
  return Math.floor((now.getTime() - cycleBaseMs(cycle, tz, now)) / 60000)
}

/**
 * Cycle phase at `elapsed` minutes from `baseMs`. Each cycle of length
 * pause+active is [pauseStart, pauseStart+pause) paused, then active until
 * the next pause start. Bucket math is epoch-exact, so every boundary is a
 * real instant (works for any anchor; midnight anchor re-bases daily).
 */
export function cyclePhaseInfo(cycle: CycleSettings, baseMs: number, elapsed: number):
  { paused: boolean; pauseStartMs: number; pauseEndMs: number; nextPauseStartMs: number } | null {
  const p = cycle.pauseMinutes, a = cycle.activeMinutes
  if (!Number.isFinite(p) || !Number.isFinite(a) || p <= 0 || a <= 0) return null
  const len = p + a
  const bucket = Math.floor(elapsed / len)
  const bs = baseMs + bucket * len * 60000
  return {
    paused: elapsed - bucket * len < p,
    pauseStartMs: bs,
    pauseEndMs: bs + p * 60000,
    nextPauseStartMs: bs + len * 60000,
  }
}

/** Validate cycle settings (shape + ranges). */
export function validateCycle(c: any): ValidationResult {
  if (!c || typeof c !== 'object') return { ok: false, error: 'cycle must be an object' }
  if (typeof c.enabled !== 'boolean') return { ok: false, error: 'cycle.enabled must be a boolean' }
  if (!Number.isInteger(c.pauseMinutes) || c.pauseMinutes < 1 || c.pauseMinutes > 1440) {
    return { ok: false, error: 'cycle.pauseMinutes must be an integer 1-1440' }
  }
  if (!Number.isInteger(c.activeMinutes) || c.activeMinutes < 1 || c.activeMinutes > 1440) {
    return { ok: false, error: 'cycle.activeMinutes must be an integer 1-1440' }
  }
  if (!Number.isFinite(c.anchorAt) || c.anchorAt < 0) {
    return { ok: false, error: 'cycle.anchorAt must be epoch ms >= 0 (0 = midnight anchor)' }
  }
  return { ok: true }
}
