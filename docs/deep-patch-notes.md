# Achievement-bar handoff and deep-patch notes

This tracked document is the authoritative handoff for the achievement-bar root
cause, live runtime constraints, failed approaches, and shipped fix. Scratch
research under `research/` is intentionally gitignored and is not required in a
clean checkout.

## Current behavior (November 2026 client)

### Root cause

Valve's `MiniAchievements` component still exists on the 2026-11-11 client.
The Gaming Mode game page renders its stats section with `onSeek: undefined`,
and Valve's row renders nothing without `onSeek`
(ValveSoftware/steam-for-linux#13540). The 0.2.4–0.2.5 builds assumed the
component was gone and drew a plugin-owned copy from
`appAchievementProgressCache`; that assumption was wrong.

### Current mechanism

The plugin supplies a no-op `onSeek` and lets Steam draw, style, fill, gate, and
navigate its own row. This matches Decky Metadata v0.6.2 (commit `bc3e34b`),
which replaced its own drawn row the same way.

- **Document discovery.** Resolve the Big Picture document through
  `g_PopupManager` using the shared `getBigPictureDocument` helper.
- **Section lookup.** Resolve the PlayBar CSS module by export-key signature
  (`GameStat` plus `Playtime`) and query every `GameStatsSection` element.
- **Instance capture.** Walk at most 12 parent fibers from each section to the
  class instance whose `stateNode` has `BUserHasContentToClaim` and
  `forceUpdate` functions. It passes `onSeek` to its `MiniAchievements` child.
- **Props accessor.** Replace that instance's configurable `props` data property
  with an accessor. The getter returns a cached `{...raw, onSeek: noop}` clone so
  React sees stable prop identity; the setter stores the props React assigns
  next. Then `forceUpdate()` once. Raw props that already carry `onSeek` (older
  clients) and non-Steam shortcuts (fail closed on a throwing probe) pass through
  unchanged. A non-configurable `props` is skipped.
- **Render trigger.** Patch `/library/app/:appid`, `/library/details/:appid`,
  and `/library/:collection/app/:appid`. Each route's `children.props.renderFunc`
  after-patch is only a signal for a bounded capture burst (0, 50, 250, 1000 ms)
  that stops once a section is patched. A `MutationObserver` on the PlayBar
  subtree restarts the burst when Steam replaces the section.
- **Visibility.** Steam's own guards decide whether the row shows (no
  achievements, uninstalled with nothing earned, Family View, layout width).
- **Cleanup.** Disabling the feature or unloading the plugin writes the latest
  real props back as a plain data property and calls `forceUpdate()`, so the
  row hides without a reload. It also disconnects the observer, clears the
  timer, and removes route and render patches. A sync that no longer finds a
  patched section restores that instance the same way before dropping it, so a
  reinserted section is patched again and no accessor outlives teardown. Every
  path fails closed.

### Verification status

Verified on `steamdeck-vm` (SteamOS VM) on 2026-11-13 with the local
`0.2.6+567b2e7` package, with Decky Metadata disabled so only this plugin could
supply `onSeek`: Brotato showed Steam's native `ACHIEVEMENTS 80/179` row and
progress bar directly after Play Time, and no plugin-drawn row.

## Historical notes (pre-November 2026)

Everything below describes the earlier Steam client, where the guard lived in
`MiniAchievements` itself and a prototype `render` capture supplied `onSeek`.
It is retained for context and must not be read as the current mechanism.

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
