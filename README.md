# Achievements Restored — Decky QAM plugin restoring SteamOS's missing mini achievement bar

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that
**brings back the achievement progress bar Valve removed** from the Steam Deck
game-details page; the compact stat next to Play Time, with the blue completion ribbon at 100%:
```
ACHIEVEMENTS
n/tot  ███▒▒▒
```

![Restored achievement bar](assets/achievement-bar-restored.png)

## What actually happened

The bar was **not deleted**. Valve's own `MiniAchievements` component (in the
app-details PlayBar / `GameStatsSection`) still ships, with working CSS and the
live `GetAchievements(appid)` data. In Steam changelist **10546225 (~2026-03-24)**
Valve added a single guard to its `render()`:

```js
if (!this.props.onSeek) return null;
```

The Steam Deck game-details header renders its PlayBar with `onSeek: undefined`,
so the guard now returns `null` and the bar disappears. Supplying a real `onSeek`
makes Valve's own component render again — confirmed by injecting `onSeek` into
the live instance on-device (see the screenshot above).

This plugin patches `MiniAchievements`' own `render` to supply the withheld
`onSeek` prop, then schedules a re-render so React commits Valve's component.
**It does not reimplement the bar.**

The plugin also preserves Valve's native installed-game behavior. Valve
intentionally hides the compact bar for an uninstalled game with zero earned
achievements, permits it for an uninstalled game with earned progress when that
data is available, and hides it whenever Steam supplies no achievement total.

## What the plugin includes

- A persistent **Enable mini achievements** toggle in the **Restore Mini
  Achievements** panel that can remove or restore the bar on the currently open
  game page without reloading Steam.
- An optional **Home Carousel Title Fix** toggle, disabled by default. While
  controller focus is inside an affected Home carousel, it removes only the
  stale source-state classes from nonfocused cards. This hides the stale title,
  glow, and raised tile without style overrides and preserves third-party theme
  values.
- A persistent **Debug logging** toggle for verbose troubleshooting output.
- Clear gamepad-focusable QAM panels: **Restore Mini Achievements**, **Home
  Carousel Title Fix**, **Settings**, **Updates**, and **Versions**.
- A gamepad-focusable **Updates** panel for manual checks, automatic background
  checks, stable or development release selection, and Decky's native install
  confirmation flow.
- A gamepad-focusable **Versions** panel showing the installed plugin, Decky
  Loader, and SteamOS versions.
- Valve's own achievement rendering and native installed/data guards; the plugin
  does not fabricate achievement data or replace Valve's bar.

The separate CSSLoader Home Carousel Title Fix theme is not required for the
verified in-carousel case while this option is enabled. The plugin does not
claim coverage when no carousel media card has controller focus, and it does not
modify, disable, reproduce, or replace that theme.

## In-plugin updates

The Updates section defaults to the stable channel and automatic checks. It can
check immediately on demand, or check in the background while the plugin is
loaded and show one toast per newly discovered release. Development releases
are opt-in behind a warning and use immutable `vX.Y.Z-dev.g<sha>` prerelease
tags; the mutable `dev-build` convenience release is intentionally ignored by
update discovery.

Before offering an update, the backend validates the release manifest, plugin
identity, channel, exact ZIP asset, and whole-archive SHA-256. It repeats that
validation immediately before installation. The plugin never overwrites itself
or stages the ZIP: accepting the action hands the validated URL, version, and
hash to Decky Loader's supported confirmation prompt. If that private Decky API
is unavailable, the panel links to the release notes for manual ZIP installation
or the Desktop installer fallback described below.

## Install on Steam Deck

Decky Loader must already be installed. In SteamOS Desktop Mode:

1. Download [`Decky-SteamAchievements Installer.zip`](installer/Decky-SteamAchievements%20Installer.zip).
2. Extract the ZIP directly onto the Desktop. Keep the extracted
   `Decky-SteamAchievementsInstaller` folder beside `Install Decky-SteamAchievements`.
3. Double-click **Install Decky-SteamAchievements**. If KDE marks the downloaded
   launcher as untrusted, review it and choose **Trust and Launch**.
4. Confirm the plugin details and approve the administrator-authentication
   prompt. Return to Gaming Mode when installation finishes.

`Decky-SteamAchievements Installer.zip` is the user-facing desktop bundle. Its
installer downloads the canonical `Decky-SteamAchievements.zip` asset from the
latest stable, non-prerelease GitHub release, validates the archive, backs up an
existing plugin copy, installs the replacement, and restarts Decky Loader. It
intentionally ignores the rolling `dev-build` prerelease. Until the first stable
release is published, the installer will report that no stable release is
available. Run the launcher as the normal `deck` user; do not run the whole
installer with `sudo`.

### Install the plugin ZIP through Decky

Decky can also install the `Decky-SteamAchievements.zip` plugin package directly:

1. Download `Decky-SteamAchievements.zip` from the desired release and place it
   in the Steam Deck's `Downloads` folder. Stable builds use a permanent `vX.Y.Z`
   tag; current development builds are available from the rolling
   [`dev-build` prerelease](https://github.com/beallio/Decky-SteamAchievements/releases/tag/dev-build).
2. In Gaming Mode, open **QAM → Decky → Settings → General**.
3. Under **Other**, enable **Developer mode**. This adds the **Developer** page
   to Decky's settings sidebar.
4. Open **Developer → Third-Party Plugins**.
5. Beside **Install Plugin from ZIP File**, choose **Browse**, select
   `Decky-SteamAchievements.zip` from `Downloads`, and approve Decky's
   installation confirmation.

Use the plugin ZIP for Decky's built-in installation flow. Do not select
`Decky-SteamAchievements Installer.zip` there; that bundle is intended to be
extracted and launched from SteamOS Desktop Mode as described above.

## Development

See [`DEVELOPER.md`](DEVELOPER.md) for setup, build, test, packaging, deployment,
release tooling, installer-bundle maintenance, and repository layout information.

## License

GPL-3.0-or-later.
