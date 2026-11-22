/**
 * dsh-duty-cycle — Dynamic tools registration (Host side, custom fork).
 *
 * The two duty-cycle tools (status / configure), registered through the
 * harness in the dynamic-plugin sandbox and through the ctx.tools service in
 * the official module (plugin/index.js) form.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive; everything needed arrives through the `deps` object.
 */

/**
 * Register every duty-cycle tool for one plugin instance.
 * @param deps.harnessApi - harness global in the dynamic sandbox (or null).
 * @param deps.ctx - plugin context (ctx.get for the tools service).
 * @param deps.status - () => current status object.
 * @param deps.configure - (args) => applyConfig(unwrap(args) || {}).
 */
export function createToolRegistrar(deps: any): void {
  const harnessApi = deps.harnessApi
  const ctx = deps.ctx
  const TOOL_DEFS: any[] = [
    {
      name: 'duty_cycle_status',
      description: 'Query the duty-cycle plugin state: enabled, gate state (NORMAL/PAUSED, reason manual-hold when manually held), current cycle phase with exact end/next-pause instants (ISO + minutes remaining), cycle progress timeline (cycleStart/pauseEnd/nextPause + position ms), PauseRecord summary, and full config (pauseMinutes / activeMinutes / anchorAt / manualHold).',
      parameters: { type: 'object', properties: {} },
      execute: async () => deps.status(),
    },
    {
      name: 'duty_cycle_configure',
      description: 'Set the duty-cycle configuration. Partial patch: enabled (bool master switch), manualHold (bool — true = manual "pause now": the gate stays closed until you set it false, overriding the cycle schedule; held requests are released within seconds when you resume), timezone (IANA name, anchor timezone when cycle.anchorAt=0), reconcileOnStart (bool), cycle ({enabled, pauseMinutes 1-1440, activeMinutes 1-1440, anchorAt epoch-ms|ISO|string now|number 0=midnight anchor} — pause pauseMinutes then run activeMinutes, repeating forever; switching cycle on re-anchors to the current moment unless anchorAt is given). Validates, stores in memory, and persists to the workspace config file. Returns the applied config.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          manualHold: { type: 'boolean' },
          timezone: { type: 'string' },
          reconcileOnStart: { type: 'boolean' },
          cycle: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              pauseMinutes: { type: 'number' },
              activeMinutes: { type: 'number' },
              anchorAt: { type: ['number', 'string'] },
            },
          },
        },
      },
      execute: async (args: any) => deps.configure(args),
    },
  ]
  for (const def of TOOL_DEFS) {
    const tool = {
      ...def,
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args: any, result: any) => [{ type: 'text', text: JSON.stringify(result) }],
      },
    }
    if (harnessApi) {
      ctx.effect(() => harnessApi.registerTool(ctx, harnessApi.defineTool(tool)))
    } else {
      const tools = ctx.get('tools')
      if (tools && typeof tools.register === 'function') ctx.effect(() => tools.register(tool))
    }
  }
}
