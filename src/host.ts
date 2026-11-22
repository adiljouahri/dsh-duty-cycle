/**
 * dsh-duty-cycle — Host half (custom fork: duty-cycle ONLY).
 *
 * Single source for both the dynamic-plugin code.host and the official
 * plugin/index.js bundle form. Exactly one function remains: the duty cycle
 * (pause 15 min / run 45 min, repeat — configurable). Layers:
 *  - goal freeze/resume (turn-boundary, state preserved) + PauseRecord
 *  - llm/stream request-level gate: while PAUSED, NEW model requests are
 *    suspended (never killed; in-flight requests and running tool commands
 *    finish untouched) and resume automatically when the active phase starts
 *  - config persistence (duty-cycle.config.json in the resolved workspace)
 *  - status/configure tools + RPC/HTTP for the Client half
 * Upstream features removed in this fork: clock pause-windows, account
 * balance display, i18n, "end this window", model-tier exemptions.
 *
 * Config persistence: written to the workspace duty-cycle.config.json,
 * surviving refresh/restart. The workspace root is resolved AT RUNTIME from
 * the sandboxPolicy service (ctx.get('sandboxPolicy').workspaceRoot) — no
 * machine path is ever hard-coded, so the plugin works from any
 * checkout/workspace.
 */

// --- Type-only declarations (erased at build time) ---
// `harness` is injected as a global ONLY in the dynamic-plugin sandbox
// (cordis-host-runner); the official module form (plugin/index.js, mounted via
// --patch or a bundle) has no harness global and registers tools through the
// ctx.tools service instead. Runtime detection keeps one source working in
// both forms. (The `harness` declaration itself comes from the typecheck
// wrapper; see scripts/typecheck.js.)
interface RawState {
  name: 'NORMAL' | 'PAUSED'
  reason?: string
  endsAtMs?: number
  nextPauseMs?: number
}
interface CtxLike {
  get(name: string): any
  on(event: string, listener: (...args: any[]) => any, opts?: any): () => void
  effect(fn: () => void | (() => void)): void
  inject?(deps: string[], callback: (ctx: any) => void): any
  timer: {
    timeout(fn: () => void, ms: number): any
    interval(fn: () => void, ms: number): any
  }
}

// --- Pure helpers inlined from src/core.ts, src/config.ts and src/state.ts
// at build time (scripts/build.js) — declared below to keep this file
// type-checked; the real implementations are unit-tested in the modules.
declare function createConfig(deps: any): any
declare function computeRawState(now: Date, input: any): RawState
// Host sub-modules (inlined at build time; factories share the state object
// `S` and receive the live config via getCfg).
declare function createGoalManager(ctx: any, S: any, getCfg: () => any): {
  collectTasks(): { ok: boolean; tasks: { agent: any; sessionId: string; goalId: string; revision: number; phase: string }[]; reason?: string }
  freeze(endsAtMs?: number): { frozen: number; record: any }
  unfreeze(): { resumed: number; record: any }
  reconcile(): { restored: number; reason?: string }
}
declare function createGate(deps: any): any
declare function registerHttpEndpoints(ws: any, deps: any): (() => void) | void
declare function createToolRegistrar(deps: any): void

return {
  inject: ['timer'],
  apply(ctx: CtxLike) {
    // ---- Config (src/config.ts) ----
    const getFs = (): any => ctx.get('fs')
    const getSessions = (): any => ctx.get('sessions')
    const getAgents = (): any => ctx.get('agents')
    const getSandboxPolicy = (): any => ctx.get('sandboxPolicy')
    const cfgRef = createConfig({
      getFs, getSessions, getAgents, getSandboxPolicy,
      // Wake suspended requests whenever a config change opens the gate
      // (disable / cycle change / re-enable / resume-now skip). Late-bound:
      // the gate and goals are created below; the callback runs at apply time,
      // after this apply(). Also release frozen goals immediately rather than
      // waiting for the next 60s tick.
      onConfigOpened: () => {
        const now = new Date()
        if (gate && !gate.gateClosedAt(now)) {
          gate.wakeGateWaiters()
          if (S.pauseRecord) goals.unfreeze()
        }
      },
    })
    const cfg = cfgRef.cfg
    const applyConfig = (patch: any) => cfgRef.apply(patch)
    const snapshot = () => cfgRef.snapshot()
    const loadConfig = () => cfgRef.load()
    const unwrap = (args: any) => (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args)
    // Shared plugin state (cross-module).
    const S: any = {
      lastStateKey: 'NORMAL',
      pauseRecord: null,
    }

    // ---------- Goals: freeze/resume/reconcile (src/host-goals.ts) ----------
    const goals = createGoalManager(ctx, S, () => cfg)

    // ---------- State computation ----------
    // Pure decision logic lives in src/state.ts (computeRawState); here we
    // wrap it to feed the live config.
    function computeRawStateLocal(now: Date): RawState {
      return computeRawState(now, {
        enabled: cfg.enabled,
        timezone: cfg.timezone,
        cycle: cfg.cycle,
        manualHold: cfg.manualHold === true,
        skipPauseUntilMs: cfg.skipPauseUntilMs,
      })
    }
    function onTick(now: Date) {
      const raw = computeRawStateLocal(now)
      let st = raw
      if (raw.name === 'PAUSED') {
        if (!S.pauseRecord) {
          const col = goals.collectTasks()
          if (!col.ok || col.tasks.length === 0) st = { name: 'NORMAL', reason: 'no-task' }
        }
      }
      const key = st.name
      if (key !== S.lastStateKey) {
        const prevName = S.lastStateKey
        S.lastStateKey = key
        if (st.name === 'PAUSED' && prevName !== 'PAUSED') {
          goals.freeze(st.endsAtMs)
        } else if (st.name !== 'PAUSED' && prevName === 'PAUSED') {
          goals.unfreeze()
        }
        console.log('[duty-cycle] state -> ' + key)
      }
    }

    // ---------- Request-level gate (src/gate.ts) ----------
    // Event-driven suspension, never throws, zero timer dependencies — full
    // implementation notes live in the module.
    const gate = createGate({
      ctx,
      getCfg: () => cfg,
      computeRawStateLocal,
    })
    gate.install()
    // Unload: restore any goals this plugin froze (fail-open, never hang).
    ctx.effect(() => {
      return () => {
        if (S.pauseRecord && S.pauseRecord.paused && S.pauseRecord.paused.length > 0) {
          console.log('[duty-cycle] plugin unloading: restoring paused goals')
          goals.unfreeze()
        }
      }
    })

    // ---------- Startup reconciliation + owned timers ----------
    // ctx.timer.timeout/interval are fiber effects cleaned up automatically on
    // dispose, but hot-updates (run/update) must not rely on that: save both
    // disposers and call them explicitly in the unload effect, so a repeated
    // update can never leak a 60s tick or a boot timeout.
    ctx.effect(() => {
      const boot = ctx.timer.timeout(() => {
        // Load the persisted config first, then run startup reconciliation.
        void loadConfig().then(() => {
          if (cfg.reconcileOnStart) {
            const r = goals.reconcile()
            if (r.restored > 0) console.log('[duty-cycle] startup reconcile restored ' + r.restored + ' goal(s)')
          }
        })
      }, 100)
      const tick = ctx.timer.interval(() => {
        try {
          // Fallback release: whenever the gate is open (cycle active phase /
          // disabled) wake the waiters — this MUST run before the enabled
          // check, so disabling also releases waiters and suspended requests
          // never hang forever.
          if (!gate.gateClosedAt(new Date())) gate.wakeGateWaiters()
          if (!cfg.enabled) return
          onTick(new Date())
        } catch (e: any) {
          // A timer callback is a host callback: an escaping exception would
          // be an uncaughtException and crash the harness. Log and continue.
          console.error('[duty-cycle] tick failed: ' + String((e && e.message) || e))
        }
      }, 60000)
      return () => {
        for (const dispose of [boot, tick]) {
          try { dispose() } catch (e) { /* unload must never throw */ }
        }
      }
    })
    // fs may activate AFTER the 100ms boot timer on compositions where the
    // duty-cycle row precedes the base bundle's fs-sandbox row. Wait for the
    // service and run the same boot load + reconcile then — loadConfig is
    // idempotent, so the second run only fills the gap of the first attempt.
    if (typeof ctx.inject === 'function') {
      // Bind keeps `this` (the ctx) when Cordis calls the returned inject
      // function, and gives the closure a non-optional reference so the
      // strict-null check in the delayed callback is satisfied.
      const inject: (deps: string[], callback: (sub: any) => void) => any = ctx.inject.bind(ctx)
      ctx.effect(() => inject(['fs'], (sub: any) => {
        sub.effect(() => {
          void loadConfig().then(() => {
            if (cfg.reconcileOnStart) {
              const r = goals.reconcile()
              if (r.restored > 0) console.log('[duty-cycle] late-fs reconcile restored ' + r.restored + ' goal(s)')
            }
          })
        })
      }))
    }

    // ---------- Status ----------
    function status(now: Date) {
      const st = computeRawStateLocal(now)
      const col = goals.collectTasks()
      const out: any = {
        enabled: cfg.enabled,
        state: st.name,
        reason: st.reason || null,
        gate: gate.gateClosedAt(now) ? 'closed' : 'open',
        gateInstalled: gate.gateInstalled,
        // Diagnostics (runtime workspace resolution) — helps verify where the
        // config file is loaded from / persisted to. resolveWorkspaceRoot is
        // async (pointer + fs probes), so report the last resolved value.
        workspaceRoot: cfgRef.resolvedConfigDir || cfgRef.defaultWorkspaceRoot,
        configLoaded: cfgRef.configLoaded,
        configPath: cfgRef.configPath,
        nowUTC: now.toISOString(),
        nowLocal: String(now),
        busy: col.ok ? (col.tasks.length > 0) : null,
        activeGoals: col.ok ? col.tasks.filter((t) => t.phase === 'active').length : null,
      }
      // Cycle phase timeline (exact epoch instants + whole-minute countdowns,
      // consumed by the client UI header + settings page).
      if (typeof st.endsAtMs === 'number') {
        out.pauseEndsUTC = new Date(st.endsAtMs).toISOString()
        out.minutesToResume = Math.max(0, Math.ceil((st.endsAtMs - now.getTime()) / 60000))
      }
      if (typeof st.nextPauseMs === 'number') {
        out.nextPauseUTC = new Date(st.nextPauseMs).toISOString()
        out.minutesToPause = Math.max(0, Math.ceil((st.nextPauseMs - now.getTime()) / 60000))
      }
      // Full cycle timeline for the UI progress bar: current bucket bounds
      // (pause start -> pause end -> next pause start) + exact position in ms.
      if (cfg.enabled && cfg.cycle && cfg.cycle.enabled) {
        const ph2 = cyclePhaseInfo(cfg.cycle, cycleBaseMs(cfg.cycle, cfg.timezone, now), cycleElapsedMinutes(cfg.cycle, cfg.timezone, now))
        if (ph2) {
          const lenMs = (cfg.cycle.pauseMinutes + cfg.cycle.activeMinutes) * 60000
          out.cycle = {
            cycleStartUTC: new Date(ph2.pauseStartMs).toISOString(),
            pauseEndUTC: new Date(ph2.pauseEndMs).toISOString(),
            nextPauseUTC: new Date(ph2.nextPauseStartMs).toISOString(),
            cyclePosMs: Math.min(Math.max(now.getTime() - ph2.pauseStartMs, 0), lenMs),
            cycleLenMs: lenMs,
            pauseMs: cfg.cycle.pauseMinutes * 60000,
            activeMs: cfg.cycle.activeMinutes * 60000,
          }
        }
      }
      out.pauseRecord = S.pauseRecord ? {
        at: S.pauseRecord.at,
        endsAt: S.pauseRecord.endsAt || null,
        pausedCount: (S.pauseRecord.paused || []).length,
        paused: (S.pauseRecord.paused || []).map((p: any) => ({ sessionId: p.sessionId, goalId: p.goalId })),
      } : null
      out.config = snapshot()
      return out
    }

    // ---- Host RPC (dynamic-plugin form: harness sandbox) + HTTP endpoints
    // ---- (official bundle form ONLY: same-origin webServer /duty-cycle/*;
    //      the dynamic Client half never registers host routes).
    const harnessApi = typeof harness !== 'undefined' ? harness : null
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('duty-cycle/status', async () => status(new Date())))
      ctx.effect(() => harnessApi.handle('duty-cycle/configure', async (args: any) => applyConfig(unwrap(args) || {})))
    }
    const webServer = ctx.get('webServer')
    // The plugin row only injects timer, so in the official bundle form apply()
    // can run BEFORE the webServer service is registered. Register the HTTP
    // endpoints via Cordis' inject() dependency waiting — it runs the callback
    // as soon as webServer is available, so the bundled Client half never sees
    // 404s. Skipped entirely in the dynamic form (harnessApi present).
    const httpDeps = {
      status: () => status(new Date()),
      applyConfig,
    }
    if (!harnessApi && webServer && typeof webServer.register === 'function') {
      ctx.effect(() => registerHttpEndpoints(webServer, httpDeps) as any)
    } else if (!harnessApi && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub: any) => {
        sub.effect(() => registerHttpEndpoints(sub.get('webServer'), httpDeps) as any)
      })
    }

    // ---- Dynamic tools (src/host-tools.ts) ----
    createToolRegistrar({
      harnessApi,
      ctx,
      status: () => status(new Date()),
      configure: (args: any) => applyConfig(unwrap(args) || {}),
    })
  },
}
