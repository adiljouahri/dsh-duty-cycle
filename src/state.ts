/**
 * dsh-duty-cycle — Pure state machine (duty-cycle decision only, custom fork).
 *
 * computeRawState decides PAUSED / NORMAL from the live config. PAUSED means:
 * the request gate closes (NEW model requests are suspended — in-flight
 * requests and running tool commands are never interrupted) and goals freeze
 * at the turn boundary. Pure and side-effect free — the caller (host.ts
 * onTick) owns the mutable state and performs the freeze/resume effects.
 *
 * Inlined into the Host plugin body at build time (scripts/build.js): the
 * `import` below is stripped by the inline pass and resolves to the same-scope
 * core helpers at runtime, while dist/state.js stays a runnable ESM module for
 * the unit tests.
 */

import { cycleBaseMs, cycleElapsedMinutes, cyclePhaseInfo } from './core.js'
import type { CycleSettings } from './core.js'

export interface RawState {
  name: 'NORMAL' | 'PAUSED'
  reason?: string
  /** PAUSED: exact epoch-ms instant this pause phase ends. */
  endsAtMs?: number
  /** NORMAL (cycle active): exact epoch-ms instant the next pause begins. */
  nextPauseMs?: number
}

/** Immutable inputs the state machine reads (snapshot of the live config). */
export interface StateInput {
  enabled: boolean
  timezone: string
  cycle?: CycleSettings
  /** On-demand hold: overrides the cycle — gate stays closed until released. */
  manualHold?: boolean
  /** One-shot skip: ignore an already-active scheduled pause until this epoch. */
  skipPauseUntilMs?: number
}

/**
 * Decide the raw plugin state at `now`: disabled → NORMAL; manual hold →
 * PAUSED (overrides the cycle, no schedule end); cycle off → NORMAL; inside a
 * cycle pause bucket → PAUSED (endsAtMs = bucket pause end); otherwise NORMAL
 * with nextPauseMs = the next bucket's pause start.
 */
export function computeRawState(now: Date, input: StateInput): RawState {
  const { enabled, timezone, cycle, manualHold, skipPauseUntilMs } = input
  if (!enabled) return { name: 'NORMAL', reason: 'disabled' }
  if (manualHold) return { name: 'PAUSED', reason: 'manual-hold' }
  if (!cycle || !cycle.enabled) return { name: 'NORMAL', reason: 'cycle-off' }
  const baseMs = cycleBaseMs(cycle, timezone, now)
  const ph = cyclePhaseInfo(cycle, baseMs, cycleElapsedMinutes(cycle, timezone, now))
  if (!ph) return { name: 'NORMAL', reason: 'invalid-cycle' }
  if (ph.paused) {
    // "Resume now" skips only the pause that is active right now. Once that
    // pause ends, the normal cycle resumes; future pauses are not cancelled.
    if (typeof skipPauseUntilMs === 'number' && skipPauseUntilMs > now.getTime()) {
      return { name: 'NORMAL', reason: 'skip-pause', nextPauseMs: ph.nextPauseStartMs }
    }
    return { name: 'PAUSED', endsAtMs: ph.pauseEndMs }
  }
  return { name: 'NORMAL', reason: 'active', nextPauseMs: ph.nextPauseStartMs }
}
