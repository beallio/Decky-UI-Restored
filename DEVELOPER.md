# Development

## Technical background

Decky UI Restored is a collection of independent, reversible Steam UI regression
fixes. Each feature has its own persisted setting and lifecycle controller. A
failed patch must log and stop without crashing Steam UI.

### Mini achievements

Valve's `MiniAchievements` component still ships with its native CSS and live
`GetAchievements(appid)` data. Steam changelist 10546225 added this render guard:

```js
if (!this.props.onSeek) return null;
```

The Steam Deck game-details `PlayBar` supplies `onSeek: undefined`, so the
component remains mounted but emits no DOM. `src/achievementBar.tsx` captures the
class read-only from the Big Picture React fiber tree, patches its own `render`
method, supplies a real section-seek handler, and refreshes mounted instances.
It does not remount the app-details tree or reimplement the progress bar.

Keep Valve's guards for missing achievement totals and zero-progress
uninstalled games. The live-verified root cause, Steam build constraints, and
failed approaches are documented in
[`docs/deep-patch-notes.md`](docs/deep-patch-notes.md).

### Home carousel title

Steam can leave three React-generated hover classes on the first Home carousel
card after controller focus moves:

- BasicGameCarousel `ShowAsHovered` on `CarouselGameLabelWrapper`;
- BasicGameCarousel `ShowAsHovered` on `CarouselCapsuleBackgroundGlow`;
- AppPortrait `ShowAsHovered` on `LibraryItemBox`.

`src/homeCarouselTitleFix.ts` captures webpack require from SharedJSContext,
resolves CSS modules by complete export-key signatures, and observes only
mounted `BasicGameCarousel` roots in the Big Picture document. While a media
card itself has `.gpfocuswithin`, it removes those three tokens from sibling
cards. It never writes styles or replaces whole class names, so Steam and
CSSLoader themes keep control of filters, transforms, shadows, and opacity.

Module IDs and CSS hashes are build-specific and must never be hardcoded.
Resolution retries with bounded backoff. Observer work is coalesced and guarded
by a circuit breaker. Teardown restores only tracked tokens still present in
the DOM element's live React `className`.

### Settings and QAM

Settings default to mini-achievement restoration enabled, the Home carousel fix
disabled, debug logging disabled, the stable update channel, and automatic
update checks enabled. `SettingsCoordinator` serializes writes, applies
optimistic state with rollback, and disposes both feature controllers
independently. QAM descriptions, toggles, updater controls, and version rows
must remain gamepad-focusable.

## Environment

Allow the repository's direnv configuration before development:

```bash
direnv allow
```

This redirects caches and scratch data to `/tmp/Decky-SteamAchievements`.

Install the exact JavaScript dependency set from `package-lock.json`:

```bash
npm ci
```

Use `npm install --package-lock-only` only when intentionally updating package
metadata or dependency resolution.

## Build and test

```bash
npm test
npx tsc --noEmit
npm run build
uv run --with pytest -- pytest -q
scripts/orchestration/run-quality-gates
```

The frontend build is written to `dist/index.js`. The orchestration gate also
checks source-metadata identity/version agreement, compiles and tests the Python
backend, then builds and validates the canonical plugin ZIP.

`rollup.config.js` carries the small Decky-compatible build configuration directly. Keep the
React/Decky globals, manifest substitution, asset URL, sourcemap transform, and narrowly scoped
`dist/` cleanup aligned when changing it. The repository intentionally does not depend on
`@decky/rollup`: its unused CommonJS transform and legacy delete chain introduced high-severity
build-only audit findings. Run `npm audit --audit-level=high` after dependency changes.

## Package the plugin

```bash
npm run package
```

This builds the frontend and creates `Decky-SteamAchievements.zip` in the
repository root. Local builds include the current short Git commit as version
metadata.

Python source stays under `backend/` in the repository, but Decky adds only the
installed plugin's `py_modules/` directory to Python's import path. Packaging
therefore maps every repository `backend/<path>.py` file to
`Decky-SteamAchievements/py_modules/backend/<path>.py` in the ZIP. A package or
manual device deployment must never place first-party modules in a root-level
`backend/` directory.

Install the package with Decky's developer ZIP flow. For a manual local-testing
deployment, place `main.py` at
`~/homebrew/plugins/Decky-SteamAchievements/main.py`, the frontend bundle under
`~/homebrew/plugins/Decky-SteamAchievements/dist/`, and repository backend
sources under
`~/homebrew/plugins/Decky-SteamAchievements/py_modules/backend/`.
To build, validate, and copy the canonical ZIP to the Deck's Downloads directory
in one step, run `scripts/decky package-push`.

## Build the Desktop installer bundle

The specialized installer sources are under `installer/`. Rebuild the tracked
installer archive after changing any of those files:

```bash
bash installer/build_bundle.sh
```

The command creates `installer/Decky UI Restored Installer.zip`. Keep the
configured GitHub repository URL and exact `Decky-SteamAchievements.zip`
distribution asset aligned with the release workflow. The Desktop installer
bundle, launcher, helper directory, GUI title, and GUI log use `Decky UI
Restored`; the plugin ZIP, archive root, and installed directory retain
`Decky-SteamAchievements` for updater compatibility.

## Display-name migration

The GitHub repository is `beallio/Decky-UI-Restored`. The distribution identity
remains `Decky-SteamAchievements` for the ZIP filename, ZIP root, installed
folder, settings, logs, and release assets. The Decky list/QAM display identity
changed from `Achievements Restored` to `Deck UI Restored`, then to
`Decky UI Restored`.

Version 0.2.1 is the update bridge. Release manifests deliberately retain
`pluginName: \"Achievements Restored\"` so clients installed before either rename
can discover the bridge release. Updater discovery accepts all three display
names. The frontend installer handoff uses the current display name, and the
Desktop installer treats both former display names plus the distribution name
as migration aliases. Do not remove those identities until the supported
installed-version floor has moved past the bridge.

GitHub redirects the former `beallio/Deck-UI-Restored` and
`beallio/Decky-SteamAchievements` repository URLs. Do not reuse either slug;
installed clients depend on those redirects until they update to code that
targets the current repository.

## Updater integrity contract

Immutable releases include the canonical ZIP, a whole-archive SHA-256 sidecar,
and a schema-1 release manifest. Discovery validates the update identity,
channel, version/tag agreement, exact asset name, and digest before offering an
update. The backend repeats validation immediately before handoff. The plugin
does not overwrite itself; it passes the validated URL, version, digest, and
current Decky display name to Decky Loader's supported confirmation flow.

Pending installs are recorded before handoff and reconciled after Decky reloads.
Runtime updater state is separate from user settings and is protected by a
bounded `fcntl.flock` plus atomic replace writes.

## Release channels

- Every push to `dev` refreshes the replaceable `dev-build` prerelease with one
  `Decky-SteamAchievements.zip` asset. Its packaged version is
  `X.Y.Z-dev.g<sha>`, but the mutable tag has no manifest and is intentionally
  undiscoverable by the in-plugin updater.
- `scripts/request_dev_release.sh X.Y.Z [commit]` validates and dispatches the
  separate manual immutable-development workflow. It publishes a permanent
  `vX.Y.Z-dev.g<sha>` prerelease with the canonical ZIP, checksum, and schema-1
  manifest. Running or publishing it is a deliberate human action, never an
  implementation side effect.
- Stable releases use permanent `vX.Y.Z` tags and add the checksum and release
  manifest alongside the canonical ZIP.
- Stable promotion remains a human gate. Follow
  [`docs/runbooks/release.md`](docs/runbooks/release.md); do not create or push a
  stable tag as an implementation side effect.

## Repository layout

- `src/index.tsx` — plugin entry and QAM content.
- `src/achievementBar.tsx` — achievement restoration and cleanup lifecycle.
- `src/homeCarouselTitleFix.ts` — Home carousel module discovery, cleanup,
  observer lifecycle, and React-aware teardown.
- `src/components/` — focusable QAM presentation components.
- `src/controllers/pluginUpdate*` — updater UI state machine and handoff lifecycle.
- `src/runtime/updatePoller.ts` — plugin-scope six-hour background polling.
- `backend/updater/` — pure release discovery, integrity, cache, and pending-install logic.
- `backend/runtime_state.py` — atomic flock-protected updater runtime state.
- `main.py` — settings, updater RPC offload/reconciliation, runtime versions, and lifecycle.
- `installer/` — specialized Desktop installer sources and bundle.
- `.github/workflows/` — CI, rolling and immutable development release, and stable release jobs.
- `scripts/` — build/package/release helpers and the orchestration symlink.
- `docs/` — plans, specifications, reviews, and runbooks.
- `research/` — ignored reverse-engineering scratch; only curated reports and
  diffs are intended to persist.
