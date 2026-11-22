/**
 * cycle.test.js — Unit tests for the duty-cycle fork (pause 15 / run 45,
 * repeating — the ONLY remaining function).
 *
 * Core helpers live in src/core.ts and the state machine in src/state.ts;
 * exercised through dist/core.js / dist/state.js. Run with: npm test
 * (builds first, then `node --test tests/cycle.test.js`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wallClock, wallToUTC, isValidTz, cycleBaseMs, cycleElapsedMinutes, cyclePhaseInfo, validateCycle } from '../dist/core.js'
import { computeRawState } from '../dist/state.js'

const MIN = 60000

test('wallClock: UTC instant -> Shanghai wall clock (+08:00)', () => {
  const wc = wallClock('Asia/Shanghai', new Date(Date.UTC(2025, 0, 1, 0, 0)))
  assert.equal(wc.y, 2025)
  assert.equal(wc.mo, 1)
  assert.equal(wc.d, 1)
  assert.equal(wc.minutes, 8 * 60)
})

test('wallToUTC round-trip: Shanghai midnight -> 16:00 UTC of previous day', () => {
  const ms = wallToUTC('Asia/Shanghai', 2025, 6, 15, 0)
  assert.equal(ms, Date.UTC(2025, 5, 14, 16, 0))
})

test('wallToUTC handles DST zones (Pacific/Auckland, +13 in January)', () => {
  const ms = wallToUTC('Pacific/Auckland', 2025, 1, 15, 0)
  assert.equal(ms, Date.UTC(2025, 0, 14, 11, 0))
})

test('isValidTz', () => {
  assert.equal(isValidTz('Asia/Shanghai'), true)
  assert.equal(isValidTz('Not/AZone'), false)
})

test('cycleBaseMs: anchorAt wins; 0 means tz-midnight anchor', () => {
  const anchor = Date.UTC(2025, 0, 1, 12, 0)
  const now = new Date(Date.UTC(2025, 0, 2, 3, 0))
  assert.equal(cycleBaseMs({ anchorAt: anchor }, 'Asia/Shanghai', now), anchor)
  // midnight of 2025-01-02 in Shanghai = 2025-01-01T16:00Z
  assert.equal(cycleBaseMs({ anchorAt: 0 }, 'Asia/Shanghai', now), Date.UTC(2025, 0, 1, 16, 0))
})

test('cyclePhaseInfo (15/45): buckets are epoch-exact, incl. negative elapsed', () => {
  const cycle = { pauseMinutes: 15, activeMinutes: 45 }
  const base = Date.UTC(2025, 0, 1, 0, 0)
  const ph = (elapsed) => cyclePhaseInfo(cycle, base, elapsed)
  // Bucket 0: [0,15) paused, [15,60) active.
  assert.equal(ph(0).paused, true)
  assert.equal(ph(14).paused, true)
  assert.equal(ph(15).paused, false)
  assert.equal(ph(59).paused, false)
  // Bucket 1 starts at 60: paused again.
  assert.equal(ph(60).paused, true)
  assert.equal(ph(74).paused, true)
  assert.equal(ph(75).paused, false)
  // Negative elapsed (clock before the anchor): floor buckets still exact.
  assert.equal(ph(-1).paused, false)   // pos 59 of bucket -1
  assert.equal(ph(-15).paused, false)  // pos 45
  assert.equal(ph(-45).paused, false)  // pos 15
  assert.equal(ph(-46).paused, true)   // pos 14
  assert.equal(ph(-60).paused, true)   // pos 0 of bucket -1
  // Exact instants for bucket 0.
  const p0 = ph(5)
  assert.equal(p0.pauseStartMs, base)
  assert.equal(p0.pauseEndMs, base + 15 * MIN)
  assert.equal(p0.nextPauseStartMs, base + 60 * MIN)
  // Invalid cycle -> null.
  assert.equal(cyclePhaseInfo({ pauseMinutes: 0, activeMinutes: 45 }, base, 0), null)
  assert.equal(cyclePhaseInfo({ pauseMinutes: 15, activeMinutes: NaN }, base, 0), null)
})

test('cycleElapsedMinutes: anchored timeline counts real minutes', () => {
  const anchor = Date.UTC(2025, 0, 1, 0, 0)
  const cycle = { pauseMinutes: 15, activeMinutes: 45, anchorAt: anchor }
  assert.equal(cycleElapsedMinutes(cycle, 'UTC', new Date(anchor + 90 * MIN)), 90)
})

test('validateCycle: shape + range checks', () => {
  assert.equal(validateCycle({ enabled: true, pauseMinutes: 15, activeMinutes: 45, anchorAt: 0 }).ok, true)
  assert.equal(validateCycle({ enabled: 'yes', pauseMinutes: 15, activeMinutes: 45, anchorAt: 0 }).ok, false)
  assert.equal(validateCycle({ enabled: true, pauseMinutes: 0, activeMinutes: 45, anchorAt: 0 }).ok, false)
  assert.equal(validateCycle({ enabled: true, pauseMinutes: 15, activeMinutes: 1441, anchorAt: 0 }).ok, false)
  assert.equal(validateCycle({ enabled: true, pauseMinutes: 1.5, activeMinutes: 45, anchorAt: 0 }).ok, false)
  assert.equal(validateCycle({ enabled: true, pauseMinutes: 15, activeMinutes: 45, anchorAt: -1 }).ok, false)
})

test('computeRawState: disabled / cycle-off / paused / active', () => {
  const anchor = Date.UTC(2025, 0, 1, 0, 0)
  const cycle = { enabled: true, pauseMinutes: 15, activeMinutes: 45, anchorAt: anchor }
  // Master switch off.
  assert.equal(computeRawState(new Date(anchor + 5 * MIN), { enabled: false, timezone: 'UTC', cycle }).reason, 'disabled')
  // Cycle switch off.
  assert.equal(computeRawState(new Date(anchor + 5 * MIN), { enabled: true, timezone: 'UTC', cycle: { ...cycle, enabled: false } }).reason, 'cycle-off')
  // Inside a pause bucket: PAUSED with the exact resume instant.
  const paused = computeRawState(new Date(anchor + 5 * MIN), { enabled: true, timezone: 'UTC', cycle })
  assert.equal(paused.name, 'PAUSED')
  assert.equal(paused.endsAtMs, anchor + 15 * MIN)
  // Active phase: NORMAL with the next pause instant (end of THIS cycle).
  const active = computeRawState(new Date(anchor + 30 * MIN), { enabled: true, timezone: 'UTC', cycle })
  assert.equal(active.name, 'NORMAL')
  assert.equal(active.nextPauseMs, anchor + 60 * MIN)
})

test('computeRawState: midnight-anchored 15/45 pauses at :00-:15 every hour', () => {
  const cycle = { enabled: true, pauseMinutes: 15, activeMinutes: 45, anchorAt: 0 }
  // 2025-06-15 10:05 Shanghai (02:05 UTC) -> pause bucket of the 10:00 hour.
  const inPause = computeRawState(new Date(Date.UTC(2025, 5, 15, 2, 5)), { enabled: true, timezone: 'Asia/Shanghai', cycle })
  assert.equal(inPause.name, 'PAUSED')
  // 2025-06-15 10:20 Shanghai (02:20 UTC) -> active.
  const inActive = computeRawState(new Date(Date.UTC(2025, 5, 15, 2, 20)), { enabled: true, timezone: 'Asia/Shanghai', cycle })
  assert.equal(inActive.name, 'NORMAL')
})

test('computeRawState: manualHold overrides the cycle (pause now / resume now)', () => {
  const anchor = Date.UTC(2025, 0, 1, 0, 0)
  const cycle = { enabled: true, pauseMinutes: 15, activeMinutes: 45, anchorAt: anchor }
  // Active phase + manual hold -> PAUSED (manual-hold), no schedule end.
  const held = computeRawState(new Date(anchor + 30 * MIN), { enabled: true, timezone: 'UTC', cycle, manualHold: true })
  assert.equal(held.name, 'PAUSED')
  assert.equal(held.reason, 'manual-hold')
  assert.equal(held.endsAtMs, undefined)
  // Hold with the cycle OFF still pauses (on-demand pause independent of cycle).
  const heldNoCycle = computeRawState(new Date(anchor + 30 * MIN), { enabled: true, timezone: 'UTC', cycle: { ...cycle, enabled: false }, manualHold: true })
  assert.equal(heldNoCycle.name, 'PAUSED')
  assert.equal(heldNoCycle.reason, 'manual-hold')
  // Master switch OFF outranks the hold (nothing to pause).
  const off = computeRawState(new Date(anchor + 30 * MIN), { enabled: false, timezone: 'UTC', cycle, manualHold: true })
  assert.equal(off.reason, 'disabled')
})
