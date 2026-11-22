/**
 * dsh-duty-cycle — Goal freeze/resume manager (Host side, custom fork).
 *
 * Owns the pause record (which goals this plugin froze, for restore on
 * resume/unload) and the agents/goals interactions: collecting active tasks,
 * freezing them at pause time, resuming them at release, and reconciling
 * paused goals at startup. Goal freeze is TURN-BOUNDARY only and never
 * interrupts a running tool/command.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 *
 * `S` is the shared plugin state object (created by the host body): the
 * pause record lives on S.pauseRecord so other modules (status, gate) can
 * read it without extra plumbing.
 */

// Sandbox global (declared so the module type-checks standalone; the host
// body provides it at runtime).
declare const console: any

interface GoalRef {
  sessionId: string
  goalId: string
  revision: number
  pausedAt?: number
}
interface TaskInfo {
  agent: any
  sessionId: string
  goalId: string
  revision: number
  phase: string
}

/**
 * Create the goal manager for one plugin instance.
 * @param ctx - plugin context (ctx.get for agents / goals services).
 * @param S - shared plugin state (S.pauseRecord is owned here).
 * @param getCfg - returns the live config (kept for symmetry/debug).
 */
export function createGoalManager(ctx: any, S: any, getCfg: () => any) {
  function collectTasks(): { ok: boolean; tasks: TaskInfo[]; reason?: string } {
    const agents = ctx.get('agents')
    const goals = ctx.get('goals')
    if (!agents || !goals) return { ok: false, tasks: [], reason: 'agents/goals services unavailable' }
    const tasks: TaskInfo[] = []
    for (const agent of agents.list()) {
      let gv: any = undefined
      try { gv = goals.get(agent) } catch (e) { gv = undefined }
      if (gv && (gv.phase === 'active' || (S.pauseRecord && S.pauseRecord.paused && S.pauseRecord.paused.some((p: GoalRef) => p.sessionId === agent.id)))) {
        tasks.push({ agent, sessionId: agent.id, goalId: gv.id, revision: gv.revision, phase: gv.phase })
      }
    }
    return { ok: true, tasks }
  }
  /** Freeze every active goal; endsAtMs = exact epoch-ms end of the pause
   * phase (recorded for display only, restore is driven by the state flip). */
  function freeze(endsAtMs?: number): { frozen: number; record: any } {
    const col = collectTasks()
    if (!col.ok) { console.error('[duty-cycle] freeze skipped:', col.reason); return { frozen: 0, record: null } }
    const freezeTargets = col.tasks.filter((t) => t.phase === 'active')
    if (freezeTargets.length === 0) {
      console.log('[duty-cycle] pause phase reached but no active tasks; not pausing')
      return { frozen: 0, record: null }
    }
    const goals = ctx.get('goals')
    const paused: GoalRef[] = []
    for (const t of freezeTargets) {
      try {
        goals.pause(t.agent, { id: t.goalId, revision: t.revision })
        paused.push({ sessionId: t.sessionId, goalId: t.goalId, revision: t.revision, pausedAt: Date.now() })
      } catch (e: any) {
        console.error('[duty-cycle] goals.pause failed for ' + t.sessionId + ': ' + String((e && e.message) || e))
      }
    }
    S.pauseRecord = {
      pausedBySaveMoney: true,
      at: new Date().toISOString(),
      endsAt: typeof endsAtMs === 'number' ? new Date(endsAtMs).toISOString() : null,
      paused,
      cascaded: true,
    }
    console.log('[duty-cycle] FROZEN ' + paused.length + ' goal(s), record written')
    return { frozen: paused.length, record: S.pauseRecord }
  }
  function unfreeze(): { resumed: number; record: any } {
    if (!S.pauseRecord) return { resumed: 0, record: null }
    const agents = ctx.get('agents')
    const goals = ctx.get('goals')
    const remaining: GoalRef[] = []
    let resumed = 0
    const targets = S.pauseRecord.paused || []
    for (const p of targets) {
      const agent = agents && agents.get(p.sessionId)
      if (!agent) continue
      try {
        const gv = goals.get(agent)
        if (gv && gv.phase === 'paused') {
          goals.resume(agent, { id: gv.id, revision: gv.revision })
          resumed++
        } else if (gv && gv.phase === 'active') {
          resumed++
        }
      } catch (e: any) {
        console.error('[duty-cycle] goals.resume failed for ' + p.sessionId + ': ' + String((e && e.message) || e))
        remaining.push(p)
      }
    }
    S.pauseRecord = remaining.length > 0 ? { ...S.pauseRecord, paused: remaining } : null
    console.log('[duty-cycle] RESUMED ' + resumed + ' goal(s)' + (remaining.length > 0 ? ', ' + remaining.length + ' still pending' : ', record cleared'))
    return { resumed, record: S.pauseRecord }
  }
  // Startup reconciliation: any goal still paused when the plugin starts
  // (e.g. a previous crash while frozen) is resumed — nothing must stay
  // frozen across restarts.
  function reconcile(): { restored: number; reason?: string } {
    const col = collectTasks()
    if (!col.ok) return { restored: 0, reason: col.reason }
    const goals = ctx.get('goals')
    const agents = ctx.get('agents')
    let restored = 0
    for (const agent of agents.list()) {
      let gv: any = undefined
      try { gv = goals.get(agent) } catch (e) { gv = undefined }
      if (gv && gv.phase === 'paused') {
        try {
          goals.resume(agent, { id: gv.id, revision: gv.revision })
          restored++
          console.log('[duty-cycle] reconcile: restored paused goal of ' + agent.id)
        } catch (e: any) {
          console.error('[duty-cycle] reconcile resume failed for ' + agent.id + ': ' + String((e && e.message) || e))
        }
      }
    }
    return { restored }
  }
  return { collectTasks, freeze, unfreeze, reconcile }
}
