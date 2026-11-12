# Achievement-bar handoff and deep-patch notes

This tracked document is the authoritative handoff for the achievement-bar root
cause, live runtime constraints, failed approaches, and shipped fix. Scratch
research under `research/` is intentionally gitignored and is not required in a
clean checkout.

## Current behavior (November 2026 client)

### Root cause

Steam's 2026-11-11 client removed the PlayBar `MiniAchievements` component that
earlier releases patched. Its replacement is behind a client feature flag, so
the old capture cannot match on current clients and there is no native bar left
to supply `onSeek` to. The achievement data still exists in Steam's progress
cache; only the UI component is gone.

The plugin therefore owns the small achievement stat row. It draws that row in
Steam's native PlayBar layout and fills it from Steam's live achievement
progress, rather than restoring a Valve component.

### Current mechanism

- **Document discovery.** Resolve the Big Picture document through
  `g_PopupManager` using the shared `getBigPictureDocument` helper. The PlayBar
  DOM and its React fibers live in that document, while webpack modules and
  stores live in `SharedJSContext`.
- **Native layout.** Resolve the PlayBar CSS module by export-key signature
  (`GameStat` plus `Playtime`), never by module ID or hashed classname. The
  plugin row copies Steam's `GameStat` layout classes and is inserted after the
  PlayBar `.Playtime` node so it sits beside Play Time.
- **App identity.** Find the mounted stats section through the resolved PlayBar
  class, then walk a bounded number of parent React fibers for props carrying
  `overview.appid` or `details.unAppID`. Ignore non-Steam shortcuts.
- **Real progress data.** Read Steam's global
  `appAchievementProgressCache`: `BGameHasAchievements(appid)` and
  `m_achievementProgress.mapCache.get(appid)` returning
  `{unlocked, total, percentage}`. Validate that the totals are finite, sane
  integers and that `total > 0`; clamp the percentage to 0–100. Never fabricate
  progress or log raw cache payloads.
- **Cold cache handling.** Call `QueueCacheUpdate(appid)` at most once per app.
  Steam fills the cache from an RPC that can answer later, so reread the cache
  on a bounded retry schedule while the row is still missing. Do not poll
  forever and do not queue the same app repeatedly.
- **Live refresh.** Subscribe through
  `SteamClient.Apps.RegisterForAchievementChanges` so an unlock refreshes the
  row. Observe the PlayBar subtree with a `MutationObserver` so Steam replacing
  the stats section or the PlayBar reattaches the row.
- **Render trigger.** `routerHook.addPatch` on the app-details route transforms
  the route table; its callback is not a navigation event. Use `afterPatch` on
  the route's `children.props.renderFunc` only as a per-render signal that
  schedules a short, deferred capture burst. A route render replaces the page,
  so its retry budget starts over.
- **Duplicate guard.** If Steam's native `.MiniAchievements` row is present
  (older or flag-enabled clients), remove the plugin row and leave Steam's UI
  alone. Never render both.
- **Guards.** Hide the row when achievement totals are unavailable, and when
  `!overview.installed && unlocked === 0`. Uninstalled games that already have
  unlocked achievements may render once totals are available.
- **Cleanup.** Disabling the feature or unloading the plugin removes the row,
  disconnects the observer, clears retry timers, unsubscribes the achievement
  listener, and unpatches the route/render hooks. Navigation can remove the
  whole PlayBar, which does not notify an observer inside it, so a one-second
  connectivity check releases the detached page. Every path is wrapped so a
  missing Steam internal fails closed instead of breaking the Steam UI.

This row-and-cache mechanism is ported from Decky Metadata's November 2026 fix
(commits `fab5c51` and `6e4d8ac`), which independently confirmed the native
component is gone and that the progress cache is the supported data source.

### Verification status

Verified on the `steamdeck-vm` SteamOS 3.9.5 VM (Steam client build
1794424036) with the local `0.2.4+a0d688a` package:

- Brotato showed one `ACHIEVEMENTS 80 / 179` row after Play Time, matching the
  native achievements page.
- Uninstalled Hades showed its earned `12 / 49`; Assassin's Creed II had no
  cached totals and showed no row. Non-Steam shortcuts showed no row.
- Disable removed the row on the mounted page, re-enable restored it, and
  disabling/re-enabling the plugin and a full Steam restart both returned
  exactly one row.
- With Decky UI Restored enabled, Metadata's own row stayed paused and its
  plugin-level conflict notice remained visible.

The uninstalled zero-progress branch is covered by unit tests only; the VM had
no cached uninstalled game with zero unlocked achievements at test time.

## Historical notes (pre-November 2026)

Everything below describes the earlier Steam client and the approaches used
before the native component was removed. It is retained for context and must
not be read as the current mechanism.

### Historical root cause and guard

Valve's `MiniAchievements` component was not deleted at that time. Steam
changelist 10546225 (SteamTracking commit `29f8d5c9a5c3`, around 2026-03-24)
added this render guard:

```js
if (!this.props.onSeek) return null;
```

The Steam Deck game-details header rendered its PlayBar with `onSeek: undefined`,
so the guard hid the component. Supplying `onSeek` to the live instance and
forcing a re-render restored Valve's own bar with correct achievement totals on
Steam Deck build CL 10840511. The then-shipped plugin preserved Valve's earlier
native guards for missing totals and zero-progress uninstalled games.

Steam's execution contexts are split: webpack modules and stores live in
`SharedJSContext`, while the Big Picture window contains the app-details DOM and
React fibers. Capture webpack require through `webpackChunksteamui.push`, inspect
the factory map (`R.m`), and instantiate matching modules with `R(id)`; the
captured handle's cache (`R.c`) reads empty. Resolve components and stores by
stable source signatures, never by the historical module IDs or hashed CSS
classes recorded during the investigation.

On-device findings (Steam Deck, Gaming Mode / gamescope, CL 10840511) from the
device smoke test of the first `feat/achievement-bar-patch` build superseded the
single-level route-patch assumption in the plan.

### Historical: why the single-level route patch didn't work

The plugin's `routerHook.addPatch("/library/app/:appid")` fired and its
`afterPatch` on `children.props.renderFunc` ran — but `renderFunc`'s output was
**too shallow**. A strict element search of that output found **0** elements
carrying `{onSeek, details, overview}`. The PlayBar / `MiniAchievements`
elements were created by components **several mobx-observer boundaries below**
the route render, so a single-level route patch could never reach them.
(Confirmed live: injected into the one loose match → bar still absent; strict
search → 0 matches.)

### Historical: the live component chain (fiber walk, GameStatsSection → up/down)

```
route renderFunc
  → … wrappers …
  → le   [class, has SeekToSection]        // app-details content/header; owns the seek handler
  → (focus/flow wrappers: FocusableBy, g "flow-children", …)
  → Qe   [class] GameStatsSection          // the PlayBar stat row; renders MiniAchievements unconditionally
       → We [PlayBar/GameStat]  (playtime)
       → Ie [class] MiniAchievements       // render: GetAchievements(appid); guard `if(!this.props.onSeek) return null`
       → je [PlayBar/GameStat]
```

`Ie` (MiniAchievements) received `onSeek` from `Qe` (`onSeek={this.props.onSeek}`);
`Qe` got it from the PlayBar, which the Deck header rendered with
`onSeek: void 0`. All of `le/Qe/Ie` were **mobx `observer`** classes — their
`render` could not be reliably reassigned (mobx held the original), so prototype
patching was ruled out at the time.

### Historical: proven mechanism

Injecting `onSeek` into the live `Ie` instance's `props` (+ forceUpdate) made the
bar render with live data. The fix was purely "supply `onSeek`"; the challenge
was doing it durably at render time across mobx boundaries.

### Historical: rejected render-tree descent

`window.DFL` (@decky/ui) exposed `createReactTreePatcher`, `wrapReactType`,
`afterPatch`, `beforePatch`, `findInReactTree`, `findModuleChild`,
`findModuleExport`, `wrapReactClass`, and `replacePatch`. `wrapReactType` clones
an element's `type` (`{...type, __DECKY_WRAPPED:true}`) so wrapping is
instance-local and mobx-safe.

The tree-descent / `createReactTreePatcher` approach was rejected after live
testing: wrapping any component in the app-details subtree remounted Steam's
content components, exposed the store-tabs variant, and broke the play-row
gradient.

### Historical final mechanism (pre-November 2026)

The then-shipped fix captured `MiniAchievements` read-only through
`g_PopupManager` → Big Picture document → fiber DFS, then `afterPatch`es its
prototype `render`. On the first intercepted render it installed a persistent
`props` getter that supplied `onSeek` and scheduled an out-of-band
`forceUpdate()`. This restored Valve's component without a remount or CSS
changes; [`assets/achievement-bar-restored.png`](../assets/achievement-bar-restored.png)
was the target appearance.

### Historical trigger lifecycle

The first capture-timing implementation still failed when the plugin loaded away
from app details. It treated the callback passed to `routerHook.addPatch()` as a
per-navigation callback, but Decky invokes it while transforming the route table.
Its single deferred capture could miss `MiniAchievements` and then remain idle
when a game was opened later.

The route's `children.props.renderFunc` after-patch was retained only as a
signal: it returned the rendered tree untouched and scheduled a short, bounded
capture burst after the render. The output remained too shallow for component
searching. Future app-details renders could start a new burst, while successful
prototype capture stopped all further scans. There was no tree descent,
component wrapping, remount, or permanent background poll.
