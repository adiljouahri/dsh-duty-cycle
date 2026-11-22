# dsh-duty-cycle

A DSH plugin that implements one repeating duty cycle: **pause 15 min → run 45 min → repeat**, with both values editable from the UI.

> **Custom fork (v1.6.0) — duty-cycle only.** The upstream `dsh-save-money` features (clock pause-windows, weekday filters, balance tracking/display, i18n, model-tier exemptions) are intentionally removed. This fork keeps one function: a repeating duty cycle.

While paused, **new model requests are suspended**. In-flight requests, running tool commands, and the session UI are **not interrupted**. Goals freeze only at turn boundaries; startup reconciliation can restore paused goals.

## UI

- **Session-header pill**: `Cycle · OFF`, `Cycle · HOLD`, `Cycle · PAUSED (resumes in N min)`, or `Cycle · RUNNING (pause in N min)`. Clicking it opens the settings popover; clicking again closes it.
- **Floating banner** while paused, with a **Resume now** action.
- **Settings popover / system settings page**:
  - master **Enabled** checkbox;
  - **Pause minutes** and **Run minutes** inputs;
  - **Pause now** (manual hold) and **Resume now** (one-shot skip of the current pause);
  - **Save** button;
  - a cycle progress bar showing the pause/run segments and the countdown.
- Status is live: the client uses a React `useSyncExternalStore` hook and a single 30-second poll, so the pill, banner, countdown, and settings update together instead of showing a frozen snapshot.

`Resume now` releases manual hold and skips only the pause currently in progress. The next scheduled pause still runs. It does not turn the plugin off.

## Configuration

The plugin persists settings to `duty-cycle.config.json` in the resolved workspace:

```json
{
  "enabled": true,
  "timezone": "Asia/Shanghai",
  "reconcileOnStart": true,
  "cycle": {
    "enabled": true,
    "pauseMinutes": 15,
    "activeMinutes": 45,
    "anchorAt": 0
  }
}
```

`anchorAt: 0` means the cycle is anchored to local midnight in the configured timezone. `manualHold` and `skipPauseUntilMs` are optional runtime fields. Configuration survives refresh, disable/re-enable, and restarts.

Host-side tools: `duty_cycle_status` and `duty_cycle_configure`. HTTP endpoints: `/duty-cycle/status` and `/duty-cycle/configure`.

## Install

The plugin is distributed as a DSH plugin bundle, not an app. This repository ships source and build scripts; the `.tgz` artifact is generated locally.

### Build the bundle from this repo

```sh
npm install          # installs the TypeScript dev dependency
npm run prepare      # build + generate plugin/index.js and plugin/client.js
cd plugin && npm pack
# produces plugin/dsh-duty-cycle-1.6.0.tgz
```

Then install:

```sh
# remove the old bundle first if it is already installed
npx.cmd @deepseek-ai/dsh plugin --profile web remove dsh-duty-cycle

npx.cmd @deepseek-ai/dsh plugin --profile web add "<REPO_ROOT>/plugin/dsh-duty-cycle-1.6.0.tgz"
```

Replace `<REPO_ROOT>` with the absolute path of your checkout. On another machine, copy the generated `.tgz` there and use the same `plugin --profile web add` command. If `npx.ps1` is blocked on Windows, use `npx.cmd`; from a source checkout use `pnpm dsh plugin ...`.

After installing, **fully restart DSH** and **hard-refresh the browser** (Ctrl+Shift+R). The profile install alone does not replace code already loaded by the running session.

### Source / development forms

Quick overlay:

```sh
cd dsh-duty-cycle
npm install
npm run prepare
# edit cordis.patch.yml to use this repository's absolute plugin/index.js path
npx.cmd @deepseek-ai/dsh web --patch ./cordis.patch.yml
```

Link install (hot reload):

```sh
npx.cmd @deepseek-ai/dsh plugin --profile web add "link:<REPO_ROOT>/plugin"
```

`link:` and bundle form are mutually exclusive; remove the bundle before switching to `link:`.

## Verify

```sh
curl http://127.0.0.1:3080/duty-cycle/status
```

A healthy response includes `gate: "open"` or `"closed"`, the cycle timeline, and the persisted config. If the running page still shows the old UI, restart DSH and hard-refresh the browser.

## Repository layout

- `src/core.ts` — pure duty-cycle scheduling logic; unit-tested
- `src/state.ts` — pure state machine
- `src/config.ts` — defaults, validation, persistence
- `src/host.ts` + `src/host-*.ts` — Host half: goal freeze, request gate, tools, HTTP
- `src/client.ts` + `src/ui/panel.tsx` — Client half / UI
- `tests/cycle.test.js`, `tests/official.test.js` — unit tests
- `scripts/build.js`, `scripts/make-plugin.js`, `scripts/typecheck.js`, `scripts/release.js`
- `plugin/` — generated official bundle (`index.js`, `client.js`, `package.json`, `cordis.patch.yml`)
- `dist/` — build output, gitignored
- `duty-cycle.config.json` — runtime config, gitignored

## Development commands

```sh
npm install
npm run prepare      # build + generate plugin bundle
npm run typecheck
npm test             # build + run cycle and bundle-consistency tests
```

## License

MIT — see [`LICENSE`](./LICENSE).
