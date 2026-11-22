/**
 * build.js — Compile the TypeScript plugin sources into plain-JS plugin bodies.
 *
 * Custom fork: duty-cycle ONLY (windows / balance / i18n removed upstream).
 * Dynamic Cordis plugins only accept plain JavaScript function bodies
 * (no TypeScript, no imports, no bundling). Sources:
 *   - src/core.ts         → dist/core.js         (ESM module; unit-tested)
 *   - src/state.ts        → dist/state.js        (ESM module; unit-tested)
 *   - src/config.ts       → dist/config.js       (ESM module)
 *   - src/host.ts         → dist/host.js   (plugin body; core + config + state + sub-modules inlined)
 *   - src/client.ts       → dist/client.js (plugin body; ui/panel inlined)
 *
 * Inlining: the helper modules are transpiled first, their `export` statements
 * are stripped, and the resulting declarations are injected into the plugin
 * body before the top-level `return {` — so the dynamic plugin stays a single
 * import-free file while the logic lives in testable modules.
 *
 * Usage: node scripts/build.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const distDir = join(root, 'dist')
// Client UI modules (single panel component file), inlined into the client
// body before the plugin glue.
const UI_FILES = ['ui/panel.tsx']

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
}

/** Transpile one TS/TSX source; exit(1) on any error-level diagnostic. */
function transpile(name) {
  const file = /\.(ts|tsx)$/.test(name) ? name : name + '.ts'
  const source = readFileSync(join(srcDir, file), 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions,
    fileName: file,
    reportDiagnostics: true,
  })
  let failed = false
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics) {
      if (d.category === ts.DiagnosticCategory.Error) {
        failed = true
        console.error('[build] ' + file + ': ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      }
    }
  }
  if (failed) {
    console.error('[build] ' + file + ': transpile failed, aborting')
    process.exit(1)
  }
  return result.outputText
}

/** Strip ESM export syntax from a transpiled helper body. */
function stripExports(js) {
  return js
    .replace(/^import\s+[^\n]*from\s+['"][^'"]+['"]\s*;\s*$/gm, '') // import lines (type-only imports are erased types)
    .replace(/^export \{\s*[\s\S]*?\}\s*;\s*$/m, '') // trailing `export { ... };`
    .replace(/^export function /gm, 'function ')
    .replace(/^export const /gm, 'const ')
    .replace(/^export /gm, '')
}

mkdirSync(distDir, { recursive: true })

// Plugin version for the client footer (replaces the '__VERSION__' placeholder
// in src/client.ts). Read from the root package.json so the displayed version
// always matches the shipped manifest.
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PLUGIN_VERSION = String(rootPkg.version || '0.0.0')
const injectVersion = (js) => js.split('__VERSION__').join(PLUGIN_VERSION)

// dist/*.js — ESM modules used by the unit tests (transpile once, reuse below)
const core = transpile('core')
const config = transpile('config')
const state = transpile('state')
writeFileSync(join(distDir, 'core.js'), core, 'utf8')
writeFileSync(join(distDir, 'config.js'), config, 'utf8')
writeFileSync(join(distDir, 'state.js'), state, 'utf8')
console.log('[build] core.ts -> dist/core.js (' + core.length + ' bytes)')
console.log('[build] config.ts -> dist/config.js (' + config.length + ' bytes)')
console.log('[build] state.ts -> dist/state.js (' + state.length + ' bytes)')

// dist/host.js — plugin body with core + config + state + host sub-modules
// inlined (order matters: helpers before the factories that use them; the
// factory modules have no cross-references between each other).
const hostJs = transpile('host')
const inlineMarker = '\nreturn {'
const idx = hostJs.indexOf(inlineMarker)
if (idx < 0) {
  console.error('[build] host.ts: no top-level "return {" found')
  process.exit(1)
}
const hostWithCore = hostJs.slice(0, idx)
  + '\n' + stripExports(core)
  + stripExports(config)
  + stripExports(state)
  // Host sub-modules: goal manager, request gate, HTTP endpoints and tool
  // registrar (factories; host.ts wires them).
  + '\n' + stripExports(transpile('host-goals'))
  + '\n' + stripExports(transpile('gate'))
  + '\n' + stripExports(transpile('host-http'))
  + '\n' + stripExports(transpile('host-tools'))
  + hostJs.slice(idx)
writeFileSync(join(distDir, 'host.js'), hostWithCore, 'utf8')
console.log('[build] host.ts -> dist/host.js (core + config + state + sub-modules inlined, ' + hostWithCore.length + ' bytes)')

// dist/client.js — plugin body with the client UI inlined
const clientJs = injectVersion(transpile('client'))
const clientIdx = clientJs.indexOf(inlineMarker)
if (clientIdx < 0) {
  console.error('[build] client.ts: no top-level "return {" found')
  process.exit(1)
}
const clientWithUi = clientJs.slice(0, clientIdx)
  // Client UI: single panel factory.
  + UI_FILES.map((f) => '\n' + stripExports(transpile(f))).join('')
  + clientJs.slice(clientIdx)
writeFileSync(join(distDir, 'client.js'), clientWithUi, 'utf8')
console.log('[build] client.ts -> dist/client.js (ui inlined, ' + clientWithUi.length + ' bytes)')
