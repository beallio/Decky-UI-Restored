# AGENTS.md — Decky-SteamAchievements

Guidance for coding agents working in this repo. Keep it current.

## What this is

Decky UI Restored is a Decky Loader plugin for independent, reversible Steam UI
regression fixes. It currently restores Valve's native `MiniAchievements`
component and removes stale Home carousel hover state without overriding theme
styles. Do not reimplement Valve UI when a stable native component or state
repair is available.

Authoritative mini-achievement background: `docs/deep-patch-notes.md` (root
cause, one-line guard diff, live runtime constraints, failed approaches, and the
shipped mechanism).

## Environment & scratch

- `direnv allow` loads `.envrc`, which points all caches/scratch at
  `/tmp/Decky-SteamAchievements` (`TMPDIR`, `XDG_CACHE_HOME`, `npm_config_cache`,
  `PYTHONPYCACHEPREFIX`). Keep exploratory/large files there, never in the repo.
- `research/` is gitignored scratch. Put durable, clean-checkout guidance under
  tracked `docs/` paths.

## Build / test

- `npm ci` then `npm run build` (rollup via `@decky/rollup`).
- `npm run package` builds `Decky-SteamAchievements.zip` via `scripts/package.mjs`.
- `npm test` runs vitest; `uv run --with pytest -- pytest -q` runs backend tests.
- `scripts/orchestration/run-quality-gates` runs metadata agreement, typecheck,
  build, frontend tests, Python compilation/tests, package validation, and
  version drift checks.
- `scripts/check_tdd.sh` enforces a matching test for new `src/*.py` (backend).

## Decky runtime facts (for the patch)

- Steam contexts are split: DOM/React fibers live in the **Big Picture** window;
  `webpackChunksteamui` / `SP_REACT` / stores live in **SharedJSContext**.
- Require capture: `webpackChunksteamui.push([[k],{},r=>R=r])`; use `R.m` +
  `R(id)` (the `R.c` cache reads empty via that handle).
- Achievements store: `R(78057).H.GetAchievements(appid)` → `{nTotal,nAchieved,…}`
  (id is build-specific — resolve by signature, not hardcode).
- Uninstalled-game achievement data is usually absent from that store. A live
  2026-07-26 probe found cached totals for only 4 of 58 uninstalled Steam games;
  keep Valve's `!nTotal` guard and never fabricate progress when data is missing.
- Preserve Valve's intended install guard:
  `!overview.installed && nAchieved == 0` hides zero-progress uninstalled games,
  while uninstalled games with earned progress may render when data is available.
  The plugin remedies only the later `!onSeek` guard.
- `afterPatch(MiniAchievements.prototype, "render", …)` works on the current
  build. Supply `onSeek` through a persistent instance `props` getter, then
  schedule `forceUpdate()` out of band so React commits Valve's component.
- Capture the class read-only from SharedJSContext through `g_PopupManager` →
  Big Picture document → React fiber DFS, matching the whole class source by
  `onSeek("achievements")`.
- Defer capture until after the app-details route commits, then refresh captured
  `MiniAchievements` instances; synchronous route-render capture sees the old tree.
- `routerHook.addPatch()` transforms the route table; its callback is not a
  navigation/render event and cannot drive later capture retries by itself.
- Use an untouched `children.props.renderFunc` after-patch only as the per-render
  signal, then defer capture and retry briefly until the Big Picture commit is visible.
- Never tree-descend or use `wrapReactClass` for this patch: wrapping remounts
  app-details components, exposes the store-tabs variant, and breaks the play-row
  gradient.
- Match components by stable signatures, not minified locals or hashed
  classnames — those churn every Steam update.
- The optional Home-carousel fix resolves CSS modules by export-key signatures,
  never by module ID or CSS hash. Its three target roles are
  `CarouselGameLabelWrapper`, `CarouselCapsuleBackgroundGlow`, and AppPortrait
  `LibraryItemBox`; it also requires the BasicGameCarousel media-card and each
  module's `ShowAsHovered` export.
- Service only a carousel containing a media card whose own element has
  `.gpfocuswithin`. Observe and mutate only that carousel; remove no styles or
  unrelated classes. React-aware teardown restores only tokens still expected
  by the element's live React `className`.

- The optional on-screen keyboard chord fix (`src/keyboardChordFix.ts`) repairs
  STEAM + X. Steam's `OnModalKeyboardMessage` drops the chord via
  `if (e.nAppID != Pe.sc && t.MainRunningAppID != e.nAppID) return;`: on the Home
  screen the client sends appid 769 while `MainRunningAppID` is correctly
  `undefined`, so the keyboard never mounts. That handler is a non-writable,
  non-configurable own property and cannot be patched; register a second
  `SteamClient.Input.RegisterForUserKeyboardMessages` callback (they are
  multicast) and re-dispatch with `nAppID: 0`.
- Steam's own chord handler runs about 100ms *after* the message. Re-dispatch on a
  ~300ms delay so Steam goes first; dispatching immediately opens the keyboard and
  Steam's late handler then closes it again via its toggle branch, which sits
  before the faulty appid check. Only opening needs repair — sample the keyboard
  state when the message arrives and leave an already-open keyboard to Steam.

## Orchestration

- `scripts/orchestration` symlinks the shared engine (`../../agent-orchestration`).
- `orchestration.conf` is committed; `orchestration.conf.local` is gitignored and
  wins (local `dev` base branch, `ORCH_LOCAL_ONLY=1`).

## Conventions

- TypeScript/TSX for frontend under `src/`; Python backend in `main.py`/`backend/`.
- Keep repository Python modules under `backend/`, but map them to
  `<plugin>/py_modules/backend/` in packages and manual device deployments;
  Decky does not add the installed plugin root to Python's import path.
- Terse, factual commit messages; do not add Claude/AI trailers.
- Prefer resilient lookups and graceful failure — a broken patch must never crash
  the Steam UI (wrap in try/catch, log, no-op on failure).
- Persistent settings live in Decky's plugin settings directory and default to
  achievement restoration enabled, the Home carousel title fix disabled, the
  on-screen keyboard chord fix disabled, verbose diagnostics disabled, the stable
  update channel, and automatic update checks enabled.
- Disabling restoration must clean injected props from mounted instances, not
  only remove route/prototype patches.
- Report the installed plugin version from the packaged manifest; resolve Decky
  and SteamOS versions from the runtime and `/etc/os-release`.
- Keep every setting and each version row independently gamepad-focusable.
- Reset Decky's retained QAM scroll position without calling native DOM
  `focus()`; let `preferredFocus` and Steam's gamepad navigation own focus so
  users can return to the description with the D-pad.
- `installer/Decky UI Restored Installer.zip` is built from the adjacent
  specialized installer sources with `bash installer/build_bundle.sh`; its
  launcher is `Install Decky UI Restored.desktop` and helper directory is
  `DeckyUIRestoredInstaller/`. Keep its GitHub repository URL and exact
  `Decky-SteamAchievements.zip` distribution asset aligned with the release
  workflow. The Desktop installer brand deliberately differs from the canonical
  plugin ZIP.
- Updater discovery and integrity logic lives under `backend/updater/`; runtime
  cache and pending-install state live separately in
  `DECKY_PLUGIN_RUNTIME_DIR/updater-state.json` behind bounded `fcntl.flock` and
  atomic replace writes.
- Frontend updater state lives in `src/controllers/pluginUpdate*`, Decky handoff
  in `src/utils/deckyInstaller.ts`, and plugin-scope polling in
  `src/runtime/updatePoller.ts`. The installer argument is the Decky display
  name `Decky UI Restored`, even though the ZIP/root/folder remain
  `Decky-SteamAchievements`.
- Record pending installs before Decky handoff, confirm accepted handoffs, clear
  failures, and reread locked runtime state before startup reconciliation so
  concurrent reload instances cannot resurrect or double-promote stale state.

## Plugin identity — distribution vs Decky display

Two names, deliberately different. Do not "unify" them.

- **Distribution: `Decky-SteamAchievements`** — matches the plugin ZIP filename, ZIP root,
  installed directory, settings/runtime/log directory, backend log namespace, and release asset.
  Its npm spelling remains `decky-steamachievements`. These paths are load-bearing for in-place
  updates and must stay stable.
- **Decky display: `Decky UI Restored`** — lives in `plugin.json` `name` and the frontend
  registration/title constants. Decky Loader overwrites `definePlugin().name` with the manifest
  name and renders that value in its plugin list; `titleView` uses the same display text for the
  opened QAM panel. It also brands the Desktop installer bundle `Decky UI Restored Installer.zip`,
  launcher `Install Decky UI Restored.desktop`, helper `DeckyUIRestoredInstaller/`, KDialog title
  `Decky UI Restored Installer`, and GUI log `Decky UI Restored Installer.log`; that installer
  still downloads the compatibility-named `Decky-SteamAchievements.zip` plugin asset.
- **GitHub repository: `beallio/Decky-UI-Restored`** — repository, badges, updater, store image,
  and Desktop installer URLs use this slug. GitHub redirects the former `Deck-UI-Restored` and
  `Decky-SteamAchievements` repository slugs for older clients; never reuse either slug.

Decky derives `DECKY_PLUGIN_SETTINGS_DIR`, runtime data, and logs from the archive/install folder,
not `plugin.json.name`. `scripts/package.mjs` therefore fixes the archive root and asset name to
`Decky-SteamAchievements` instead of deriving them from the display manifest. The Desktop
installer recognizes `Achievements Restored`, `Deck UI Restored`, and the former canonical
manifest name as migration aliases and replaces any of those installations in place.

Version 0.2.1 is the display-name bridge. Release manifests retain
`pluginName: "Achievements Restored"` so older clients can discover it. Updater discovery accepts
that identity, `Deck UI Restored`, and `Decky UI Restored`. Do not change the manifest identity or
remove either display alias until the supported installed-version floor is newer than the bridge.

The installed `Storage Cleaner` plugin is the reference for this supported split: its folder is
`decky-storage-cleaner` while its manifest/list name is `Storage Cleaner`.

## Release channels

- Pushes to `dev` run CI and refresh the replaceable `dev-build` prerelease with
  exactly one `Decky-SteamAchievements.zip` asset. It is stamped
  `X.Y.Z-dev.g<sha>` but has no manifest and remains undiscoverable.
- Manual immutable development publication uses
  `scripts/request_dev_release.sh` and `.github/workflows/immutable-dev-release.yml`
  to create `vX.Y.Z-dev.g<sha>` with exactly the ZIP, checksum, and manifest.
- Permanent `vX.Y.Z` tags trigger stable publication of the ZIP, checksum, and
  release manifest only after the fail-closed prepublication checks pass.
- `scripts/release.sh X.Y.Z` prepares a stable release locally and never pushes.
  Stable `dev` → `main` promotion and tag publication remain human actions; follow
  `docs/runbooks/release.md`.
