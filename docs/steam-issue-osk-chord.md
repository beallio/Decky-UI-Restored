---
name: Issue Report
about: File an issue report.

---

#### Your system information

* Steam client version (build number or date): 1788291500 (client binary dated 2026-09-01)
* Distribution (e.g. Ubuntu): SteamOS 3.8.16 (BUILD_ID 20260716.1), Steam Deck OLED ("Galileo"), kernel 6.16.12-valve24.5-1-neptune-616
* Opted into Steam client beta?: No (update channel `steam_client_steamdeck_stable_ubuntu`)
* Have you checked for system updates?: Yes — reproduced on the current stable client after applying all available updates
* Steam Logs: available on request (not attached; the failure produces no log output — see below)
* GPU: AMD (Custom GPU 0405, Van Gogh)

#### Please describe your issue in as much detail as possible:

**Expected:** In Game Mode with no game running, pressing STEAM + X opens the on-screen keyboard.

**Actual:** Nothing happens. No keyboard appears and nothing is logged, in Game Mode or Desktop Mode.

The chord itself is fine. `logs/controller_ui.txt` shows the chord layer activating and
suppressing the Steam menu, so the input side works end to end:

```
Loaded Config for Last Resort Path for App ID 443510, Controller 15: controller_base/chord_neptune.vdf
Guide button skipped due to chording
```

`controller_base/chord_neptune.vdf` still binds `button_x` to `controller_action SHOW_KEYBOARD`,
and the client does send the keyboard message to the UI. Registering an additional
`SteamClient.Input.RegisterForUserKeyboardMessages` observer shows exactly one message per press:

```json
{"nControllerIndex":15,"bEnterDismissesKeyboard":true,"bChordInvoked":true,
 "nXPosition":0,"nYPosition":0,"nAppID":769}
```

The message is then discarded by `SteamUIStore.OnModalKeyboardMessage` in
`steamui/chunk~2dcc5aaf7.js`, at this guard:

```js
if (e.nAppID != Pe.sc && t.MainRunningAppID != e.nAppID) return;
```

`Pe.sc` is the "no app running" sentinel, `0`. With no game running the client sends `nAppID: 769`
(the Steam UI's own appid), while `MainRunningAppID` is correctly `undefined`:

```js
get MainRunningAppID(){ return this.m_runningAppIDs.length > 0 ? this.m_runningAppIDs[0] : void 0 }
```

Both clauses are therefore true, the handler returns, and the keyboard never mounts. Because this is
an early return rather than an error, nothing is written to any log, which is why the failure is
silent.

This was confirmed by replaying the captured message through the real handler and changing only
`nAppID`:

| `nAppID` | Result |
| --- | --- |
| `769` (what the client sends) | no keyboard |
| `0` (the sentinel the guard expects) | keyboard opens normally |

Two details that may help isolate the regression:

* **Only the chord path is affected.** Focusing a text field still opens the keyboard correctly,
  because that path does not go through `OnModalKeyboardMessage`.
* **Closing still works.** The toggle-close branch sits *before* this guard, so an already-open
  keyboard is dismissed correctly by the same chord.

This suggests either the client should send the sentinel appid when no game is running, or the
guard should also accept the Steam UI's own appid.

**When this started.** The last native success on this device was 2026-08-28 17:33, in Desktop
Mode, logged in `logs/controller_ui.previous.txt` as a chord-driven open:

```
[2026-08-28 17:33:41] Loaded Config for Last Resort Path for App ID 443510 ... chord_neptune.vdf
[2026-08-28 17:33:42] Set OSK active 1 and appid 413080
[2026-08-28 17:33:42] OnFocusWindowChanged On Screen Keyboard Forcing to window type: KB ActionSet, AppID 769
[2026-08-28 17:33:42] Guide button skipped due to chording
```

The only client or UI change between that success and the failure is the 2026-09-01 update:

* client 1785799196 -> **1788291500** (`logs/steamui_update.txt`, 2026-09-01 17:07)
* UI bundle rewritten: `steamui/chunk~2dcc5aaf7.js` mtime 2026-09-01 13:10:36, directory
  updated 17:06:58, `steamui/changelist.txt` = **10956954** (10 files replaced)

**The UI side did not change — this is a client-side regression.** Diffing the shipped
`steamui/chunk~2dcc5aaf7.js` across published builds (via SteamTracking) shows the guard is
unchanged from changelist **10375301** (2026-01-20) through **10956954** (2026-09-01, the build
installed here), and present as far back as I sampled (2025-11-21). Only the minified module alias
churns (`Me.` / `Ie.` / `Fe.` / `Ne.` / `Le.` / `Pe.`); the expression is the same:

```js
if (e.nAppID != Pe.sc && t.MainRunningAppID != e.nAppID) return;
```

The sentinel's value is also unchanged — the same app-id module exports `sc` as `0` in the
2025-11-21, 2026-07-10 and 2026-09-01 bundles. The only difference in that whole handler over those two months is an
unrelated refactor of the first check, from
`if (!t.IsGamepadUIOverlayWindow() && !t.IsMainGamepadUIWindow()) return;` to
`if (!this.BWindowInstanceSupportsKeyboard(t)) return;`, which widens it to include VR.

So the guard and its expected value are long-standing, and what changed is the `nAppID` the client
sends with a chord-invoked keyboard request when no game is running.

#### Steps for reproducing this issue:

1. On a Steam Deck in Game Mode, go to the Home or Library screen and make sure no game is running.
2. Press STEAM + X.
3. Observe that no on-screen keyboard appears, and that no error is logged. For contrast, open
   Library → Search and focus the search field: the keyboard appears there as expected.
