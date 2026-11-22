/**
 * dsh-duty-cycle — HTTP endpoints for the official bundle Client half
 * (Host side, custom fork: cycle only).
 *
 * The bundled Client half (plugin/client.js, no harness global) talks to the
 * same-origin webServer endpoints registered here (/duty-cycle/*). The
 * dynamic-plugin Client half keeps using the harness RPC and never registers
 * routes on the host's global webServer.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive; everything needed arrives through the `deps` object.
 */

/**
 * Register the /duty-cycle/* endpoints on a webServer service.
 * @param ws - the webServer service (or undefined before it exists).
 * @param deps.status - () => current status object.
 * @param deps.applyConfig - (patch) => applied config.
 * @returns the webServer disposer, or undefined when ws is unusable.
 */
export function registerHttpEndpoints(ws: any, deps: any): (() => void) | void {
  if (!ws || typeof ws.register !== 'function') return
  const sendJson = (res: any, code: number, obj: any) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  return ws.register({
    kind: 'prefix',
    path: '/duty-cycle',
    handler: async (req: any, res: any) => {
      try {
        const rawPath = String(req.url || '/').split('?')[0]
        const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath
        if (path === '/duty-cycle/status') {
          sendJson(res, 200, deps.status())
          return
        }
        if (req.method === 'POST' && path === '/duty-cycle/configure') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          let patch: any = {}
          try { patch = JSON.parse(raw || '{}') } catch (e) { patch = {} }
          sendJson(res, 200, deps.applyConfig(patch))
          return
        }
        sendJson(res, 404, { ok: false, message: 'not found: ' + path })
      } catch (e: any) {
        sendJson(res, 500, { ok: false, message: String((e && e.message) || e) })
      }
    },
  })
}
