# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release entries are curated by hand and dated. A release must not be cut against an
`[Unreleased]` heading — roll it over to the version being released first.

## [Unreleased]

### Added

- Add an opt-in On-Screen Keyboard Shortcut fix that restores STEAM + X when no game is
  running. Steam's `OnModalKeyboardMessage` discards the chord because the client sends the
  Steam UI's own app id where the handler expects its empty-app sentinel, so the keyboard
  never mounts. The fix observes the same multicast keyboard message and re-dispatches it
  with the expected app id. Closing is left to Steam, whose toggle-close branch runs before
  the faulty check and already works.

## [0.2.2] - 2026-08-28

Refreshes the Desktop installer branding and plugin icon while preserving update compatibility.

### Changed

- Brand the Desktop installer bundle, launcher, helper directory, dialogs, and log as Decky UI
  Restored while retaining the compatibility-named `Decky-SteamAchievements.zip` plugin asset.
- Replace the trophy plugin icon with a magic-wand icon that represents the broader
  collection of reversible Steam UI fixes.

## [0.2.1] - 2026-08-28

Expands the plugin into Decky UI Restored, a collection of reversible Steam Deck interface fixes.

### Added

- Add an opt-in Home Carousel Title Fix that removes stale source-state classes
  from nonfocused cards while controller focus remains in that carousel.

### Changed

- Rename the Decky plugin-list and QAM title from Achievements Restored through
  Deck UI Restored to Decky UI Restored while keeping the existing ZIP, folder,
  settings, and release asset names.
- Preserve updates from older installations through legacy release-manifest and
  installer display-name aliases.
- Rename the GitHub repository to `beallio/Decky-UI-Restored` while preserving
  redirects from both former repository slugs.
- Reorganize the QAM into Restore Mini Achievements, Home Carousel Title Fix,
  Settings, Updates, and Versions panels. The mini-achievement toggle is now
  named Enable mini achievements.

### Fixed

- Build stable ZIP, checksum, and manifest assets only after every mutating quality gate so
  their hashes cannot drift before upload.
- Allow the immutable-tag recovery workflow to replace an existing release's assets and notes
  without moving or deleting the permanent tag.

## [0.2.0] - 2026-07-28

Adds a complete, gamepad-first self-updater and hardened Decky Python packaging.

The updater, release discovery, installer handoff, and runtime-state contracts now follow the
live-validated SDH-ludusavi design while preserving this plugin's identity and UI behavior.

### Added

- An SDH-ludusavi-style **Updates** section in the Decky QAM panel with independently
  focusable installed-version, update-channel, automatic-check, status, and **Check now**
  rows.
- Stable and immutable-development release discovery with signed metadata checks, whole-ZIP
  SHA-256 validation, rate-limit handling, cached results, and Decky's native confirmed
  installation flow.
- Plugin-scope background update polling with deduplicated notifications and startup
  reconciliation for pending installer handoffs.
- Automated one-to-one validation that every repository `backend/**/*.py` source is packaged
  exactly once beneath `py_modules/backend/`.

### Fixed

- Package first-party Python modules under Decky's supported `py_modules` import root,
  eliminating the on-device `ModuleNotFoundError: No module named 'backend'` startup failure.
- Serialize settings and updater-runtime mutations across threads and processes without
  losing overlapping changes.
- Preserve pending update state across Decky's unload/reload window and reject ambiguous
  release assets before installation.
- Fail closed when development-release dispatch, packaged module layout, release provenance,
  or archive validation does not match the expected plugin identity and version.

### Changed

- Development delivery now distinguishes the replaceable ZIP-only `dev-build` from permanent,
  manifest-backed development releases that the in-plugin updater can discover.
- Developer guidance now documents the repository `backend/` source layout versus the
  installed `py_modules/backend/` runtime layout and the validated updater lifecycle.

## [0.1.0] - 2026-07-27

Initial development release.

### Fixed

- Returning controller focus from the bottom of the QAM panel now restores the outer scroll
  position after Steam's delayed focus scroll, keeping the title and full description visible.

### Added

- Restores the achievement progress bar Valve removed from the Steam Deck
  game-details PlayBar by supplying the `onSeek` prop its `MiniAchievements`
  component requires, without remounting Steam's content components.
- Persistent, gamepad-focusable toggles for achievement restoration and debug
  logging, including reversible cleanup of the currently mounted bar.
- Independently focusable plugin, Decky Loader, and SteamOS version rows.
- A SteamOS desktop installer bundle that validates and installs the canonical
  stable plugin ZIP with backup and rollback handling.
- CI, a rolling `dev-build` prerelease, fail-closed package validation, and a
  human-gated stable release workflow.

### Changed

- Canonical plugin identity pinned to `Decky-SteamAchievements` (the repository name) in
  `package.json` and the distribution archive/install path, while `plugin.json` uses
  `Achievements Restored` for Decky's plugin list and QAM title.
  The contract is documented in `AGENTS.md`.
- On-device install directory is now `~/homebrew/plugins/Decky-SteamAchievements/`, and the
  packaged release asset is `Decky-SteamAchievements.zip`. `scripts/package.mjs` fixes both to
  the distribution identity independently of the display name in `plugin.json`.
- Replaced the vulnerable `@decky/rollup` build preset with an equivalent direct Rollup
  configuration; production bundle and sourcemap output remain byte-for-byte identical.
