/**
 * dsh-duty-cycle — Client half (custom fork: duty-cycle UI only).
 *
 * Browser UI:
 * 1. conversation.session.header.utilities — status pill (PAUSED/RUNNING with
 *    the countdown), click popover with the settings form, and the paused
 *    banner (position:fixed). Rendered by src/ui/panel.tsx.
 * 2. settings.section — system settings page "Duty Cycle" with the same form:
 *    master switch + Pause minutes (15) / Run minutes (45) + Save.
 *
 * Key implementation notes (unchanged from upstream):
 * - React / host are Client Builtin GLOBAL symbols — use them directly, do not
 *   ctx.get('React').
 * - slots / timer are Services — go through ctx.get / inject.
 * - The dynamic Client half has no browser timer globals (no setInterval) —
 *   use the timer service, and in React effects dispose via the cleanup.
 * - The unified host call: dynamic form uses the harness RPC global
 *   (host.call); the official bundle form has no harness global and uses the
 *   same-origin HTTP endpoints (/duty-cycle/*) registered by the host half.
 *
 * i18n removed in this fork: UI strings are English.
 */

declare const React: any
declare const host: any
declare const fetch: any
// ModuleLoader-provided synchronous require: resolves client modules in the
// __DSH_BOOT__ graph, e.g. the DSH system button component
// @deepseek-ai/dsh-client-ui-primitives.
declare const require: any

// Plugin name + version shown in the settings popover footer.
// '__VERSION__' is replaced at build time (scripts/build.js) with the real
// version from package.json — never edit this literal by hand.
const PLUGIN_VERSION = '__VERSION__'

// Client UI (src/ui/panel.tsx): createUi(deps) composes the header entry and
// the settings form. Inlined at build time, so only the signature is declared.
declare function createUi(deps: any): { SettingsView: any; HeaderEntry: any }

return {
  inject: ['timer'],
  async apply(ctx: any) {
    const slots = ctx.get('slots')
    const timer = ctx.timer
    if (!React || !slots || !timer) {
      console.error('[duty-cycle] client apply aborted')
      return
    }

    // DSH system button component (ui-primitives): rounded capsule, tokens
    // adapt to light/dark themes automatically. `require` comes from
    // ModuleLoader; the synchronous require skips the async-load branch, and
    // if that module's script is not registered yet it throws — caught below,
    // falling back to hand-drawn buttons so the UI never hangs.
    let DSHButton: any = undefined
    try {
      DSHButton = (require('@deepseek-ai/dsh-client-ui-primitives') || {}).Button
    } catch (e) {
      console.error('[duty-cycle] ui-primitives unavailable, falling back to hand-drawn buttons: ' + String((e && (e as any).message) || e))
    }

    // Unified Host call: the dynamic-plugin Client half talks to the host via
    // the harness RPC global (`host.call`); the official bundled Client half
    // (plugin/client.js, no harness global) talks to the same-origin
    // webServer HTTP endpoints registered by the Host half (/duty-cycle/*).
    const callHost = async (method: string, args?: any): Promise<any> => {
      if (typeof host !== 'undefined' && host && typeof host.call === 'function') {
        return host.call(method, args)
      }
      const res = await fetch('/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: args === undefined ? undefined : JSON.stringify(args),
      })
      if (!res.ok) throw new Error('duty-cycle http ' + res.status)
      return res.json()
    }

    // Client UI bound to the shared deps.
    const ui = createUi({ DSHButton })

    let snapshot: any = { enabled: false, state: 'NORMAL', reason: null, config: null }
    const subscribers = new Set<any>()
    let pollingStop: any = null

    // Live status source: React's useSyncExternalStore hook subscribes the
    // mounted components, and every refresh notifies them. Updating the source
    // re-renders the header pill and the settings page immediately.
    const publish = (s: any) => {
      if (!s || typeof s !== 'object') return
      snapshot = s
      for (const listener of Array.from(subscribers)) {
        try { listener() } catch (e: any) {
          console.error('[duty-cycle] status listener failed: ' + String((e && e.message) || e))
        }
      }
    }

    const refresh = async () => {
      try {
        const s = await callHost('duty-cycle/status')
        publish(s)
      } catch (e: any) {
        console.error('[duty-cycle] status poll failed: ' + String((e && e.message) || e))
      }
    }
    void refresh()

    const statusSource: any = {
      getSnapshot: () => snapshot,
      subscribe: (listener: any) => {
        subscribers.add(listener)
        // Start one 30s poll for the whole plugin, not one per mounted component.
        if (!pollingStop) {
          const tick = async () => { try { await refresh() } catch (e) {} }
          void tick()
          pollingStop = timer.interval(() => { void tick() }, 30000)
        }
        return () => {
          subscribers.delete(listener)
          if (subscribers.size === 0 && pollingStop) {
            try { pollingStop() } catch (e) {}
            pollingStop = null
          }
        }
      },
    }

    // A selector hook: panel components call props.st() inside their render.
    const useSnap = () => () => React.useSyncExternalStore(
      (listener: any) => statusSource.subscribe(listener),
      () => statusSource.getSnapshot()
    )

    // Per-registration actions: doConfigure = RPC + immediate refresh. A
    // failed configure must not leave the UI frozen on stale state: refresh
    // publishes whatever the host actually persisted, so the controls re-render.
    const makeActions = () => ({
      doConfigure: async (patch: any) => {
        let res: any = null
        try {
          res = await callHost('duty-cycle/configure', patch)
        } catch (e: any) {
          console.error('[duty-cycle] configure failed: ' + String((e && e.message) || e))
        }
        try { await refresh() } catch (e) {}
        return res
      },
    })

    // ---- Main UI: session-header right-aligned area (status pill +
    //      popover + floating banner; rendered by src/ui/panel.tsx) ----
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'duty-cycle-status-text', order: 5 },
      () => {
        const st = useSnap()
        const actions = makeActions()
        return React.createElement(ui.HeaderEntry, { st, actions })
      }
    ))

    // ---- System settings page (settings.section) ----
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'duty-cycle', order: 25, label: 'Duty Cycle' },
      () => {
        const st = useSnap()
        const actions = makeActions()
        return React.createElement('div', { style: { padding: '12px' } },
          React.createElement('h3', { style: { margin: '0 0 12px', fontSize: '15px' } }, 'Duty Cycle'),
          React.createElement(ui.SettingsView, { st, ...actions }),
          React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '10px' } },
            'dsh-duty-cycle v' + PLUGIN_VERSION),
        )
      }
    ))
  },
}
