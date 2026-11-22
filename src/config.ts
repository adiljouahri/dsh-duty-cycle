/**
 * dsh-duty-cycle — Config controller (custom fork: duty-cycle ONLY).
 *
 * Owns the persisted settings: defaults, validation, load/persist to the
 * workspace file (duty-cycle.config.json), the config-location resolver
 * (pointer file + candidate directories), and the applyConfig/snapshot pair.
 *
 * Kept config fields (everything else upstream offered has been removed):
 *   enabled           master switch for the save cycle
 *   timezone          anchor timezone for cycle.anchorAt = 0 (midnight anchor)
 *   reconcileOnStart  resume goals that were frozen before a crash/restart
 *   cycle             { enabled, pauseMinutes, activeMinutes, anchorAt }
 *
 * Inlined into the Host plugin body at build time (scripts/build.js).
 */

export interface SaveMoneyConfig {
  enabled: boolean
  timezone: string
  reconcileOnStart: boolean
  cycle: CycleSettings
  /** Manual hold: when true (and enabled), the gate stays closed regardless of
   * the cycle schedule — an on-demand "pause now" the user can release. */
  manualHold: boolean
  /** One-shot skip: while an active scheduled pause is in progress, ignore it
   * until this epoch-ms instant. Then the normal cycle resumes automatically. */
  skipPauseUntilMs: number
}

export const CONFIG_DEFAULTS: SaveMoneyConfig = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  reconcileOnStart: true,
  cycle: { enabled: false, pauseMinutes: 15, activeMinutes: 45, anchorAt: 0 },
  manualHold: false,
  skipPauseUntilMs: 0,
}

export const CONFIG_FILE = 'duty-cycle.config.json'
export const POINTER_FILE = 'duty-cycle-config-path.json'

// Node/browser globals used by the config resolver — declared here so this
// module type-checks standalone and the dynamic sandbox (no process globals)
// never trips over them.
declare const process: any
declare const console: any

// Pure time helpers inlined from src/core.ts at build time — the `import`
// below keeps dist/config.js a runnable ESM module for the unit tests; the
// inline pass strips the import line (scripts/build.js stripExports) so the
// same-scope core helpers resolve at runtime inside the plugin body.
import { isValidTz, validateCycle } from './core.js'
import type { CycleSettings } from './core.js'

/**
 * Deferred services (read at call time, not captured once): the official
 * bundle can activate before fs/sessions/sandboxPolicy exist, and a late fs is
 * picked up the moment it registers. The host passes getters that re-read
 * ctx.get(name) each call.
 */
export interface ConfigDeps {
  getFs(): any
  getSessions(): any
  getAgents(): any
  getSandboxPolicy(): any
  /** Called after a config change that opens the gate (wake suspended waiters). */
  onConfigOpened?: () => void
}

/** DSH user dir (~/.dsh): exists on Windows / macOS / Linux. Honors DSH_HOME
 * (used as-is); otherwise derives <USERPROFILE|HOME>/.dsh. */
export function dshHome(): string {
  try {
    if (typeof process === 'undefined' || !process || !process.env) return ''
    const env: any = process.env
    const custom = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
    if (custom) return custom.replace(/[\\/]+$/, '')
    const up = (typeof env.USERPROFILE === 'string' && env.USERPROFILE)
      || (typeof env.HOME === 'string' && env.HOME) || ''
    if (!up) return ''
    let base = String(up).replace(/[\\/]+$/, '')
    if (!/\.dsh$/i.test(base)) base += (base.indexOf('\\') >= 0 ? '\\' : '/') + '.dsh'
    return base
  } catch (e) { return '' }
}

/** Session working directory (any of the shapes DSH exposes). */
function sessionCwdOf(s: any): string {
  const c = s && (s.meta && s.meta.cwd || s.header && s.header.cwd || s.cwd)
  return typeof c === 'string' ? c : ''
}

/** Read the pointer file (best-effort; '' when absent/unreadable). */
async function readPointer(deps: ConfigDeps): Promise<string> {
  const home = dshHome()
  const fs = deps.getFs()
  if (!home || !fs) return ''
  try {
    const target = await fs.resolve(POINTER_FILE, { cwd: home })
    const text = await fs.readText(target)
    const data = JSON.parse(text)
    const p = data && typeof data.path === 'string' ? data.path : ''
    return p.replace(/[\\/]+$/, '')
  } catch (e) { return '' }
}

/** Record the last real config dir in ~/.dsh (best-effort; never throws). */
async function writePointer(deps: ConfigDeps, dir: string): Promise<void> {
  const home = dshHome()
  const fs = deps.getFs()
  if (!home || !fs || !dir) return
  try {
    const target = await fs.resolve(POINTER_FILE, { cwd: home })
    await fs.writeText(target, JSON.stringify({ path: dir }, null, 2), undefined, undefined,
      { mode: 'workspace-write', workspaceRoot: home })
  } catch (e) { /* best-effort */ }
}

/**
 * Candidate config directories, highest priority first. The pointer (the last
 * real location) is handled separately in resolveWorkspaceRoot.
 */
function candidateRoots(deps: ConfigDeps, defaultWorkspaceRoot: string): string[] {
  const out: string[] = []
  const push = (c: string) => {
    c = String(c || '').replace(/[\\/]+$/, '')
    if (c && !out.includes(c)) out.push(c)
  }
  // 1. the calling session (agents.currentInitiator): the session that
  //    actually uses the plugin, so config follows the user's workspace.
  try {
    const agentsSvc = deps.getAgents()
    const init = agentsSvc && typeof agentsSvc.currentInitiator === 'function'
      ? agentsSvc.currentInitiator()
      : undefined
    const sessionsSvc = deps.getSessions()
    if (init && sessionsSvc && typeof sessionsSvc.get === 'function') {
      push(sessionCwdOf(sessionsSvc.get(init.id) || init))
    }
  } catch (e) { /* skip */ }
  // 2. every session whose cwd matches the repo basename (last wins, so the
  //    newest checkout is preferred when several exist).
  const sessionsSvc = deps.getSessions()
  if (sessionsSvc && typeof sessionsSvc.list === 'function') {
    try {
      const matches: string[] = []
      for (const s of sessionsSvc.list()) {
        const c = sessionCwdOf(s).replace(/[\\/]+$/, '')
        if (/dsh-duty-cycle$/i.test(c)) matches.push(c)
      }
      for (const m of matches) push(m)
    } catch (e) { /* skip */ }
  }
  // 3. process.cwd() itself (official module form only; the harness may be
  //    started from the repo checkout).
  try {
    if (typeof process !== 'undefined' && process && typeof process.cwd === 'function') {
      push(String(process.cwd()))
    }
  } catch (e) { /* skip */ }
  // 4. the DSH home dir: a stable, always-writable location (also where the
  //    config-path pointer lives), so a fresh install has a sane default.
  push(dshHome())
  // 5. sandboxPolicy fallback (the harness install dir).
  push(defaultWorkspaceRoot)
  return out
}

/**
 * True for OS-managed directories (e.g. C:\Windows\System32). `dsh web` can
 * start with process.cwd() pointing there, so such dirs must never become the
 * config read/write target.
 */
function isSystemDir(dir: string): boolean {
  const d = String(dir || '').replace(/[\\/]+$/, '').toLowerCase()
  if (!d) return false
  if (/(^|\\)(windows|system32|syswow64)(\\|$)/.test(d)) return true
  const sysRoot = String(process.env.SystemRoot || process.env.Windir || '')
    .replace(/[\\/]+$/, '').toLowerCase()
  if (sysRoot && (d === sysRoot || d.startsWith(sysRoot + '\\'))) return true
  return false
}

/**
 * Create the config controller bound to one plugin instance.
 *
 * `deps` supplies the deferred service getters and an optional gate-open
 * callback. The returned controller owns the mutable config state and exposes
 * the persistence + validation surface the rest of the plugin calls.
 */
export function createConfig(deps: ConfigDeps) {
  // Mutable config state. `cfgRef` is a stable object whose `.cfg` field is
  // replaced on load/apply — callers that hold `cfgRef` always see the latest.
  const cfgRef: { cfg: SaveMoneyConfig } = { cfg: { ...CONFIG_DEFAULTS, cycle: { ...CONFIG_DEFAULTS.cycle } } }
  let configLoaded = false
  let configPath = ''
  let resolvedConfigDir = ''
  const defaultWorkspaceRoot: string = (() => {
    const sandboxPolicy = deps.getSandboxPolicy()
    return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0)
      ? sandboxPolicy.workspaceRoot
      : ''
  })()

  /** The first directory that actually contains a config file wins; see
   * candidateRoots for the priority list. */
  const resolveWorkspaceRoot = async (): Promise<string> => {
    const fs = deps.getFs()
    if (!fs) return defaultWorkspaceRoot
    const ptr = await readPointer(deps)
    if (ptr) {
      try {
        await fs.readText(await fs.resolve(CONFIG_FILE, { cwd: ptr }))
        resolvedConfigDir = ptr
        return ptr
      } catch (e) { /* pointer stale — fall through to candidates */ }
    }
    const roots = candidateRoots(deps, defaultWorkspaceRoot)
    for (const dir of roots) {
      if (!dir) continue
      try {
        await fs.readText(await fs.resolve(CONFIG_FILE, { cwd: dir }))
        resolvedConfigDir = dir
        return dir
      } catch (e) { /* no config here — try next */ }
    }
    // No config exists anywhere yet: prefer a repo-named candidate (a session
    // cwd on this checkout), so a fresh install writes next to the checkout;
    // otherwise the first non-system candidate (a session workspace); the DSH
    // home dir is the final safe default. NEVER fall back to an OS dir such as
    // C:\Windows\System32 — `dsh web` may start with process.cwd() there.
    let target = ''
    for (const dir of roots) {
      if (dir && /dsh-duty-cycle$/i.test(dir)) { target = dir; break }
    }
    if (!target) {
      for (const dir of roots) {
        if (dir && !isSystemDir(dir)) { target = dir; break }
      }
    }
    resolvedConfigDir = target || dshHome() || defaultWorkspaceRoot
    return resolvedConfigDir
  }

  const persistConfig = async (): Promise<void> => {
    const fs = deps.getFs()
    if (!fs) {
      console.error('[duty-cycle] persist skipped: fs service unavailable')
      return
    }
    try {
      const workspaceRoot = await resolveWorkspaceRoot()
      if (!workspaceRoot) return
      const target = await fs.resolve(CONFIG_FILE, { cwd: workspaceRoot })
      configPath = fs.processPath ? String(fs.processPath(target)) : String(target && (target.path || target.filePath || ''))
      await fs.writeText(target, JSON.stringify(snapshot(), null, 2), undefined, undefined,
        { mode: 'workspace-write', workspaceRoot })
      await writePointer(deps, workspaceRoot)
      console.log('[duty-cycle] config persisted to ' + workspaceRoot + '\\' + CONFIG_FILE)
    } catch (e: any) {
      console.error('[duty-cycle] persist failed: ' + String((e && e.message) || e))
    }
  }

  const loadConfig = async (): Promise<void> => {
    const fs = deps.getFs()
    if (!fs) {
      console.error('[duty-cycle] load skipped: fs service unavailable')
      return
    }
    try {
      const workspaceRoot = await resolveWorkspaceRoot()
      if (!workspaceRoot) return
      const target = await fs.resolve(CONFIG_FILE, { cwd: workspaceRoot })
      configPath = fs.processPath ? String(fs.processPath(target)) : String(target && (target.path || target.filePath || ''))
      const text = await fs.readText(target)
      const data = JSON.parse(text)
      configLoaded = true
      const next = { ...cfgRef.cfg }
      if (typeof data.enabled === 'boolean') next.enabled = data.enabled
      if (typeof data.timezone === 'string' && isValidTz(data.timezone)) next.timezone = data.timezone
      if (typeof data.reconcileOnStart === 'boolean') next.reconcileOnStart = data.reconcileOnStart
      if (typeof data.manualHold === 'boolean') next.manualHold = data.manualHold
      if (typeof data.skipPauseUntilMs === 'number' && Number.isFinite(data.skipPauseUntilMs) && data.skipPauseUntilMs >= 0) {
        next.skipPauseUntilMs = Math.floor(data.skipPauseUntilMs)
      }
      // cycle: partial patch over the current values; any invalid field keeps
      // the current value (fail-safe).
      if (data.cycle && typeof data.cycle === 'object') {
        const c = { ...next.cycle }
        if (typeof data.cycle.enabled === 'boolean') c.enabled = data.cycle.enabled
        if (Number.isInteger(data.cycle.pauseMinutes) && data.cycle.pauseMinutes >= 1 && data.cycle.pauseMinutes <= 1440) c.pauseMinutes = data.cycle.pauseMinutes
        if (Number.isInteger(data.cycle.activeMinutes) && data.cycle.activeMinutes >= 1 && data.cycle.activeMinutes <= 1440) c.activeMinutes = data.cycle.activeMinutes
        if (typeof data.cycle.anchorAt === 'number' && Number.isFinite(data.cycle.anchorAt) && data.cycle.anchorAt >= 0) c.anchorAt = Math.floor(data.cycle.anchorAt)
        else if (typeof data.cycle.anchorAt === 'string') {
          const t = Date.parse(data.cycle.anchorAt)
          if (Number.isFinite(t)) c.anchorAt = t
        }
        next.cycle = c
      }
      // In-place update keeps the `cfgRef.cfg` reference stable, so callers
      // that captured it (e.g. the host's `const cfg = cfgRef.cfg`) always see
      // the latest config without re-reading.
      Object.assign(cfgRef.cfg, next)
      console.log('[duty-cycle] config loaded from ' + workspaceRoot + '\\' + CONFIG_FILE)
    } catch (e: any) {
      console.log('[duty-cycle] no config file (fresh start): ' + String((e && e.message) || e))
    }
  }

  /**
   * Apply a partial patch with full validation. On success persists and (when
   * the gate opens) wakes waiters via deps.onConfigOpened.
   */
  function applyConfig(patch: any): any {
    // Whitelist: only known config keys are accepted, so a malformed/unknown
    // patch can never pollute the live config object.
    const p: any = (patch && typeof patch === 'object') ? patch : {}
    const next: any = { ...cfgRef.cfg }
    for (const key of ['enabled', 'timezone', 'reconcileOnStart', 'cycle', 'manualHold', 'skipPauseUntilMs'] as const) {
      if (p[key] !== undefined) next[key] = p[key]
    }
    if (next.enabled !== undefined && typeof next.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' }
    }
    if (next.manualHold !== undefined && typeof next.manualHold !== 'boolean') {
      return { ok: false, error: 'manualHold must be a boolean' }
    }
    if (next.skipPauseUntilMs !== undefined && (!Number.isFinite(next.skipPauseUntilMs) || next.skipPauseUntilMs < 0)) {
      return { ok: false, error: 'skipPauseUntilMs must be epoch ms >= 0' }
    }
    if (next.reconcileOnStart !== undefined && typeof next.reconcileOnStart !== 'boolean') {
      return { ok: false, error: 'reconcileOnStart must be a boolean' }
    }
    if (next.timezone !== undefined && !isValidTz(next.timezone)) {
      return { ok: false, error: 'invalid IANA timezone: ' + next.timezone }
    }
    // cycle per-field merge: a patch only overrides the fields it names.
    // anchorAt accepts epoch ms (number), an ISO string, or the literal
    // 'now' (anchor the cycle to this moment: pause starts immediately).
    // On cycle enabled false -> true, when the patch names no anchor, the
    // cycle re-anchors to now ("pause for N, run for M" starts on switch-on).
    if (p.cycle !== undefined) {
      if (!p.cycle || typeof p.cycle !== 'object') {
        return { ok: false, error: 'cycle must be an object' }
      }
      const mergedCycle: any = { ...cfgRef.cfg.cycle }
      for (const key of ['enabled', 'pauseMinutes', 'activeMinutes'] as const) {
        if (p.cycle[key] !== undefined) mergedCycle[key] = p.cycle[key]
      }
      if (p.cycle.anchorAt === 'now') mergedCycle.anchorAt = Date.now()
      else if (typeof p.cycle.anchorAt === 'number') mergedCycle.anchorAt = p.cycle.anchorAt
      else if (typeof p.cycle.anchorAt === 'string') {
        const t = Date.parse(p.cycle.anchorAt)
        if (!Number.isFinite(t)) return { ok: false, error: 'cycle.anchorAt invalid: ' + p.cycle.anchorAt }
        mergedCycle.anchorAt = t
      }
      if (mergedCycle.enabled && !(cfgRef.cfg.cycle && cfgRef.cfg.cycle.enabled) && p.cycle.anchorAt === undefined) {
        mergedCycle.anchorAt = Date.now()
      }
      const cv = validateCycle(mergedCycle)
      if (!cv.ok) return { ok: false, error: cv.error }
      next.cycle = mergedCycle
    }
    if (next.skipPauseUntilMs !== undefined) next.skipPauseUntilMs = Math.floor(next.skipPauseUntilMs)
    // In-place update keeps the `cfgRef.cfg` reference stable (see loadConfig).
    Object.assign(cfgRef.cfg, next)
    // Delegate the wake decision to the host: the gate is open only when the
    // new config actually releases suspended requests (disable / cycle change),
    // so the host wakes waiters only then.
    if (deps.onConfigOpened) deps.onConfigOpened()
    void persistConfig()
    return { ok: true, config: snapshot() }
  }

  function snapshot() {
    return {
      enabled: cfgRef.cfg.enabled,
      timezone: cfgRef.cfg.timezone,
      reconcileOnStart: cfgRef.cfg.reconcileOnStart,
      cycle: { ...cfgRef.cfg.cycle },
      manualHold: cfgRef.cfg.manualHold === true,
      skipPauseUntilMs: cfgRef.cfg.skipPauseUntilMs,
    }
  }

  return {
    get cfg(): SaveMoneyConfig { return cfgRef.cfg },
    get configLoaded(): boolean { return configLoaded },
    get configPath(): string { return configPath },
    get resolvedConfigDir(): string { return resolvedConfigDir },
    get defaultWorkspaceRoot(): string { return defaultWorkspaceRoot },
    load: loadConfig,
    persist: persistConfig,
    apply: applyConfig,
    snapshot,
    resolveWorkspaceRoot,
  }
}
