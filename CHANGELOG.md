# Changelog

All notable changes to **dsh-duty-cycle** are documented here. The project is a custom fork derived from the upstream **dsh-save-money** plugin; upstream history is not part of this repository.

## [1.6.0] — 2026-11-13

### Added

- Custom duty-cycle fork: pause 15 minutes, run 45 minutes, repeat.
- Session-header pill, pause banner, settings popover, and cycle progress bar.
- Live client state via a React `useSyncExternalStore` hook and one 30-second timer-service poll.
- `Pause now` manual hold and `Resume now` one-shot skip of the current pause.
- Host tools `duty_cycle_status` and `duty_cycle_configure`.
- HTTP endpoints `/duty-cycle/status` and `/duty-cycle/configure` for the official bundle form.
- Pure schedule, state, and config modules with unit tests.
- Build, bundle-generation, type-check, and release scripts.
- Startup reconciliation of paused goals.

### Removed

- Upstream clock pause-windows and weekday filters.
- Balance tracking and balance display.
- i18n text switching.
- Model-tier exemptions.
- “End this window” feature.
- Stale upstream screenshots and Chinese README/changelog.

### Changed

- Settings page no longer exposes balance; it exposes one master Enabled switch, Pause minutes, Run minutes, Pause now, Resume now, and Save.
- Config file is now `duty-cycle.config.json` (upstream used `save-money.config.json`).
- Official bundle is `plugin/` with `cordis.patch.yml`, `index.js`, and `client.js`; the `.tgz` artifact is generated, not committed.
- Package metadata and LICENSE target `adiljouahri/dsh-duty-cycle`.

## Notes

- The plugin does not interrupt running commands or in-flight requests.
- Goals freeze only at turn boundaries; `reconcileOnStart` can restore paused goals at startup.
- `duty-cycle.config.json` is runtime state and is gitignored.
