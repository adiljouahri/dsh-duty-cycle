/**
 * dsh-duty-cycle — Request-level gate (Host side, custom fork).
 *
 * While the duty cycle is PAUSED every NEW streaming model call is intercepted
 * (llm/stream is the mandatory waterfall every call goes through). The gate
 * does NOT depend on the freeze record: even when no active goal is frozen,
 * manual-conversation model requests are still suspended — that is the
 * saving-money semantics. A request already released through the gate, its
 * in-flight turn, and any running tool/command complete UNTOUCHED (nothing is
 * ever killed): suspension only ever happens before a new request starts.
 *
 * Implementation notes (unchanged from upstream, model-tier exemption removed):
 *  - Cordis 3 registration API is ctx.on only; llm.stream dispatches via
 *    ctx.waterfall, and listeners must synchronously return an AsyncIterable
 *    (the caller for-await's it; an async listener would break the return
 *    type). So we return a WRAPPER stream: iteration waits for the gate to
 *    open first, then calls next() to get the real stream — options pass
 *    through untouched, routing/retry/validation are unaffected (we are
 *    registered at the chain tail; the suspend happens before the actual
 *    adapterStream).
 *  - The sandbox has no Node timer globals (setTimeout throws and fails the
 *    turn as "this run failed"); ctx.timer.timeout is a fiber effect and can
 *    still throw when registered inside an agent-turn fiber context. So
 *    waiting is EVENT-DRIVEN: suspending = registering the resolve into
 *    gateWaiters, woken by: ① the 60s tick (registered in the plugin apply
 *    context, runs reliably); ② applyConfig (disable / cycle change);
 *    ③ plugin unload (fail-open); ④ request signal abort. No timers /
 *    fiber-effect calls → cannot throw, cannot interrupt a turn.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

// `console` is a sandbox global (declared so this module type-checks
// standalone; the host body provides it at runtime).
declare const console: any

/**
 * Create the request gate for one plugin instance.
 * @param deps.ctx - plugin context (ctx.on registration, ctx.effect).
 * @param deps.getCfg - returns the live config (enabled master switch).
 * @param deps.computeRawStateLocal - state-machine wrapper (same check as the
 *   tick, fed with the live config).
 */
export function createGate(deps: any) {
  const ctx = deps.ctx
  let gateDisposed = false
  let gateWaiters: (() => void)[] = []
  const wakeGateWaiters = () => {
    const waiters = gateWaiters
    gateWaiters = []
    if (waiters.length > 0) {
      console.log('[duty-cycle] gate opened: releasing ' + waiters.length + ' held request(s) now')
    }
    for (const release of waiters) {
      // Each waiter synchronously calls next() inside release(); if the
      // waterfall chain (DSH's own llm/stream invariants run first) throws
      // synchronously — e.g. the request context was torn down while the
      // gate held it — the exception must NOT escape into the host callback
      // that woke us (60s tick / applyConfig / unload). That would surface as
      // an uncaughtException and crash the harness. We swallow it here; the
      // pending request then rejects with the same error via the promise.
      try { release() } catch (e: any) {
        console.error('[duty-cycle] gate release failed: ' + String((e && e.message) || e))
      }
    }
  }
  const gateClosedAt = (now: Date): boolean => {
    if (!deps.getCfg().enabled) return false
    // The gate follows the state machine exactly.
    return deps.computeRawStateLocal(now).name === 'PAUSED'
  }
  const gateInstalled = typeof ctx.on === 'function'
  const install = (): void => {
    if (typeof ctx.on !== 'function') {
      console.error('[duty-cycle] ctx.on unavailable; llm/stream gate not installed')
      return
    }
    ctx.effect(() => {
      const dispose = ctx.on('llm/stream', (options: any, next: any) => {
        if (!gateClosedAt(new Date())) return next()
        const waitForOpen = () => new Promise((resolve) => {
          const ready = () => gateDisposed || !gateClosedAt(new Date())
            || !!(options && options.signal && options.signal.aborted)
          // Release helper: call next() defensively. A synchronous throw from
          // the waterfall chain (request context torn down / invariant fail)
          // must surface as a rejected promise — never as an exception
          // escaping into the abort event dispatch or wakeGateWaiters.
          // Once-guard: the abort listener AND wakeGateWaiters (60s tick /
          // config change / unload) can both reach release() in the same
          // instant — resolve() is idempotent but next() is NOT, so a second
          // call would invoke the downstream chain twice.
          let released = false
          const release = () => {
            if (released) return
            released = true
            try { resolve(next()) } catch (e) {
              resolve(Promise.reject(e))
            }
          }
          if (ready()) return release()
          const waiter = () => { release() }
          gateWaiters.push(waiter)
          if (gateWaiters.length === 1) {
            // Visibility: a held request keeps the session "busy" (spinner) on
            // purpose — running work is never killed, only NEW requests wait.
            // Log once per closed episode so the pause is observable.
            console.log('[duty-cycle] gate CLOSED — holding new model request(s); '
              + 'session stays busy but idle until the cycle/manual-hold releases it. '
              + 'Resume now via the UI button or duty_cycle_configure.')
          }
          if (options && options.signal && typeof options.signal.addEventListener === 'function') {
            options.signal.addEventListener('abort', () => {
              const i = gateWaiters.indexOf(waiter)
              if (i >= 0) gateWaiters.splice(i, 1)
              release()
            }, { once: true })
          }
        })
        // Wrapper stream: iteration waits only when the gate is closed; once
        // open → next() → the real request proceeds as usual.
        let inner: any = null
        const getInner = () => (inner !== null ? Promise.resolve(inner) : waitForOpen().then((s) => { inner = s; return inner }))
        return {
          [Symbol.asyncIterator]() {
            let it: any = null
            return {
              next() {
                return getInner().then((s: any) => {
                  if (!it) it = s[Symbol.asyncIterator]()
                  return it.next()
                })
              },
              return(value: any) {
                return getInner().then((s: any) => {
                  if (!it) it = s[Symbol.asyncIterator]()
                  return it.return ? it.return(value) : { done: true, value }
                })
              },
              throw(e: any) {
                return getInner().then((s: any) => {
                  if (!it) it = s[Symbol.asyncIterator]()
                  return it.throw ? it.throw(e) : { done: true, value: e }
                })
              },
            }
          },
        }
      }, { global: true })
      return () => {
        gateDisposed = true
        try { wakeGateWaiters() } catch (e) { /* unload must never throw */ }
        dispose()
      }
    })
  }
  return { gateInstalled, gateClosedAt, wakeGateWaiters, install }
}
