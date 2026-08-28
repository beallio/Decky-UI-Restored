# Plan: Add Home Carousel Fix and Reorganize QAM Panels (home-carousel-fix-qam-panels)

## Context

`Achievements Restored` currently presents an untitled introductory description followed by one
`Settings` panel that mixes the mini-achievement feature toggle with `Debug logging`. Reorganize
the QAM content into three clear panels before the existing `Updates` and `Versions` panels:

1. `Restore Mini Achievements` contains the existing achievement description and toggle.
2. `Home Carousel Title Fix` contains a description and a new persistent toggle for the stale
   Home-carousel hover-state repair.
3. `Settings` contains the existing `Debug logging` toggle.

The string `Retore` does not exist in the repository: the current introductory
`PanelSection` is untitled. Ship the new heading as `Restore Mini Achievements`, correcting the
typo in the request text. Preserve the existing mini-achievement setting key and
enabled-by-default behavior so upgrades retain the user's current choice. Add
`home_carousel_fix_enabled` as a separate setting that defaults to `false`, including when an
existing settings file has no such key; the user explicitly chose an opt-in upgrade.

The Home carousel bug leaves Steam's React-generated `ShowAsHovered` state on the first card after
controller focus moves to another card. The existing CSSLoader theme compensates by overriding
label, glow, tile, and artwork styles with `!important`, but that cannot preserve arbitrary
third-party theme values. The new Decky runtime feature must repair the stale state at its source.
Service every mounted `BasicGameCarousel` root, but mutate a root only while that same root
contains a media card whose own element carries controller focus through `.gpfocuswithin`.
Within each eligible root remove only:

- the BasicGameCarousel module's `ShowAsHovered` class from an unfocused card's
  `CarouselGameLabelWrapper`;
- the same class from its `CarouselCapsuleBackgroundGlow`; and
- the AppPortrait module's `ShowAsHovered` class from its `LibraryItemBox`.

This mechanism was verified on the live `Steam Big Picture Mode` document on `steamdeck-legos`.
With the CSS workaround disabled, one stale card held all three classes and showed its old title,
glow, raised transform, full brightness, and hover shadow. Class removal hid the stale title and
glow, reset the transform, and preserved the active Darken Unfocused Games
`brightness(0.5) saturate(0.5)` filter. A real `ArrowRight` focus move and synthetic class
reintroduction were both cleaned continuously with bounded observer activity. React-aware teardown
restored only classes still present in each element's live React `className`.

Use stable export-key signatures to resolve Steam CSS modules at runtime. Never hardcode live
module IDs, CSS hashes, minified local names, or the values observed during verification. Work in
the Big Picture document returned through `g_PopupManager`; `webpackChunksteamui`, the captured
webpack require function, and CSS-module exports remain in SharedJSContext.

Relevant existing files are `src/achievementBar.tsx`, `src/featureController.ts`,
`src/settingsCoordinator.ts`, `src/index.tsx`, `src/backend.ts`,
`src/components/DescriptionSection.tsx`, `src/components/SettingsSection.tsx`, `main.py`, and their
focused tests. Add one focused runtime module and tests for the Home-carousel fix rather than
mixing this independent behavior into `achievementBar.tsx`.

Non-goals:

- Do not copy the CSSLoader theme's computed-style overrides into the plugin.
- Do not change Valve's Home carousel layout, focused-card behavior, mouse-hover behavior, or
  third-party theme classes and inline styles.
- Do not enable the Home-carousel fix by default.
- Do not rename the distribution identity, Decky display identity, update settings, or version
  panels.
- Do not add telemetry, new update behavior, or a general Steam DOM-patching framework.

**Slug used throughout this plan:** `home-carousel-fix-qam-panels`

---

## Orchestration Contract

**Slug:** `home-carousel-fix-qam-panels`

**Plan file:**

```text
docs/plans/2026-08-27_home-carousel-fix-qam-panels.md
```

**Implementation branch:**

```text
feat/home-carousel-fix-qam-panels
```

**Round-complete marker:**

```text
/tmp/Decky-SteamAchievements/home-carousel-fix-qam-panels_finished
```

**Finalized marker:**

```text
/tmp/Decky-SteamAchievements/home-carousel-fix-qam-panels_finalized
```

**Review notes:**

```text
docs/review/home-carousel-fix-qam-panels-review-*.md
```

Each review note ends with exactly one status trailer:

```text
STATUS: CHANGES_REQUESTED
```

or:

```text
STATUS: APPROVED
```

---

## Required Agent Protocol

1. Use the **implementer** skill.
2. Work from the repository root.
3. Branch from `dev`.
4. Commit this plan as the first commit on the implementation branch.
5. Follow TDD where behavior changes are testable.
6. Run quality gates before marking any round complete.
7. Do not write your own review.
8. Do not create files under `docs/review/`.
9. Do not delete files under `docs/review/`.
10. Review notes are durable audit records and must be committed.
11. Resolving a review note means:
    - implement the requested changes;
    - run quality gates;
    - commit the code/docs changes;
    - commit the review note itself if it is not already committed;
    - recreate the round-complete marker.
12. After finalization, stop polling and exit cleanly.

---

## Scope discipline

- Implement only the units the plan lists. Do not modify files outside the plan's scope.
- Do not change runtime behavior beyond what the plan specifies. A `refactor` or
  `cleanup` commit must preserve observable behavior.
- Never edit a test's expected value to make a behavior change pass. If a test
  legitimately must change, that change must be required by the plan or a review
  note, and you must record the rationale in the session log.
- If you spot an unrelated improvement, do not make it here — note it in the
  session log for a separate plan.

---

## Setup

Start from `dev`:

```bash
git checkout dev
# ORCH_LOCAL_ONLY: local trial branch, skipping origin pull
git checkout -b feat/home-carousel-fix-qam-panels
```

Commit this plan first:

```bash
git add docs/plans/2026-08-27_home-carousel-fix-qam-panels.md
git commit -m "docs(plan): add home-carousel-fix-qam-panels implementation plan"
```

---

## Implementation Tasks

### 1. Add failing runtime-contract tests first

Create `src/homeCarouselTitleFix.test.ts` before the runtime implementation. The repository's
Vitest suite currently uses the default Node environment and has no DOM environment package. Run
`npm install --save-dev happy-dom` so `package.json`, `package-lock.json`, and the current
`node_modules` agree. Add `vitest.config.ts` with `test.environment` explicitly kept at `"node"`
and no `include` override, and opt only the new runtime test into Happy DOM with
`// @vitest-environment happy-dom`. Build fixtures from real `document.createElement` nodes so
selectors, `classList`, `isConnected`, and `MutationObserver` are browser implementations rather
than test doubles. Keep webpack, popup/document lookup, lifecycle timers, the monotonic clock used
by the breaker, and the breaker window/limit injectable; do not require a live Steam client in the
unit suite. Cover these observable contracts:

- resolve the BasicGameCarousel CSS module only when one export object contains
  `BasicGameCarousel`, `BasicGameCarouselItemMediaContainer`,
  `CarouselCapsuleBackgroundGlow`, `CarouselGameLabelWrapper`, and `ShowAsHovered`;
- resolve the AppPortrait module only when one export object contains `LibraryItemBox` and
  `ShowAsHovered`;
- reject partial, malformed, throwing, or ambiguous module candidates without mutating the DOM;
- when a carousel has a media card whose own element carries `.gpfocuswithin`, remove exactly the
  three target class tokens from nonfocused cards during the initial pass;
- treat a media card as controller-focused only when the media-card element itself has
  `.gpfocuswithin`; the same class on a carousel or another ancestor must not satisfy the guard;
- service each mounted carousel independently and never let focus in one root authorize mutation
  in another root;
- resolve the label, glow, and library-box targets only inside their owning media card; matching
  elements belonging to another card in the same carousel must remain untouched;
- leave the focused card, other carousels, elements outside the carousel, unrelated classes,
  inline styles, and third-party filter/transform/shadow/opacity declarations unchanged;
- preserve a nonfocused card that is under real pointer hover while another card has controller
  focus, then clean its stale classes after the scoped `pointerleave` signal;
- clean class reintroduction, inserted cards, and focus reversal after observer callbacks settle;
- prove idempotent removal produces at most one empty self-mutation pass, and open a fail-closed
  circuit breaker instead of spinning when the configured per-binding pass limit is exceeded;
- rebind when the Big Picture document or mounted Home-carousel set changes;
- after disposal, stop timers/observers and perform no more cleanup;
- on disposal or rebind, add a removed class back only when that element's current React
  `__reactProps$...className` still contains the token. If React props are absent or no longer
  contain it, do not invent the class.

Tests must assert class presence/absence and preserved declarations directly. Source-text checks or
hardcoded "passed" output are not acceptance evidence.

### 2. Implement the fail-closed Home-carousel runtime

Add `src/homeCarouselTitleFix.ts` with a public
`installHomeCarouselTitleFix(): () => void` lifecycle matching the achievement patch's installer
and disposer shape.

Capture webpack require at most once for each `webpackChunksteamui` array identity through
`webpackChunksteamui.push([[CHUNK_ID], {}, require => ...])`, where `CHUNK_ID` is a fixed
plugin-namespaced string constant. Persist `{ chunkArray, require }` under a plugin-namespaced
`Symbol.for(...)` key on the SharedJSContext window so a Decky plugin reload against the same Steam
page reuses the captured handle instead of pushing another entry. Keep the same pair cached at
module scope for normal toggle cycles. If the chunk-array identity changes, capture once for the
new page and replace the persisted pair. Disabling and re-enabling must never append another
capture entry.

`AGENTS.md` records that the captured handle's `require.c` view is empty. Never discover CSS
modules by invoking every entry in `require.m`. First scan factory `toString()` values without
executing them and retain only factories whose source contains every required export-key name.
Cap survivors at 10 and treat overflow as unresolved. Require only those survivors inside
`try/catch`, then verify the complete export-key set on each returned object. Reject zero,
ambiguous, malformed, or throwing results. Treat IDs and exported class strings as volatile
runtime data and use resolved strings only as class tokens and escaped selector inputs.

If require capture, module resolution, the popup manager, or the Big Picture document is
unavailable, log at the existing safe debug/warn levels and no-op or retry with bounded backoff;
never throw into Steam UI. Use the single lifecycle tick as the retry clock; do not create an
independent module-resolution timer. Memoize successful resolution, not a transient failure.
Emit distinguishable log messages for capture failure, candidate overflow, unresolved/ambiguous
modules, missing popup/document, a focus guard that never becomes eligible during a binding, and
an opened circuit breaker.

The QAM toggle represents the persisted user preference, not runtime health; a future unmatched
Steam build may therefore show the toggle on while the fix is inert and logged. This fail-closed
state is accepted scope and does not add a status row.

Reuse the exported `steamGlobals.getPopupManager()` and `getBigPictureDocument()` boundary from
`src/achievementBar.tsx`; do not introduce a second popup-discovery convention. Keep the carousel
feature implementation otherwise independent from the MiniAchievements patch.

On installation:

1. Resolve the current Big Picture document and CSS modules immediately.
2. Use an injectable lifecycle timer at no more than 1 Hz to compare the Big Picture document and
   its mounted `BasicGameCarousel` root set. Do not scan card descendants on the timer; add or
   remove bindings only when document/carousel identity changes.
3. Attach one cleanup `MutationObserver` and one scoped `pointerleave` listener to each mounted
   carousel. Observe `subtree`, `childList`, and the `class` attribute. Use the pointer listener
   only to schedule the same coalesced cleanup after a real hover ends. Do not leave a broad
   permanent subtree observer or pointer listener on the whole Big Picture document.
4. Run one initial cleanup per binding and coalesce mutation callbacks into one scheduled cleanup
   pass. Class removal is idempotent: its observer record permits one follow-up pass that removes
   nothing and emits no further records. Track a bounded per-binding pass count using an injected
   monotonic clock and configurable breaker window/limit whose production values are one second
   and 20 passes. If repeated React rewrites exceed that limit, disconnect that binding, log once,
   and leave it inert until its carousel identity changes or the user disables and re-enables the
   feature.
5. Treat the element carrying the resolved `BasicGameCarouselItemMediaContainer` class as the
   media card. Require the current carousel root to contain a media card whose own element has
   `.gpfocuswithin`. For every sibling media card in that root without that class, remove only the
   three module-specific class tokens from the `CarouselGameLabelWrapper`,
   `CarouselCapsuleBackgroundGlow`, and `LibraryItemBox` elements found inside that media card's
   own subtree. If a role is absent, skip that role and continue; never fall back to a
   carousel-wide or document-wide target query. While a nonfocused media card matches real
   `:hover`, leave its tokens unchanged; its `pointerleave` schedules cleanup. Keep the pointer
   predicate injectable for deterministic tests. Do not use ancestor `.gpfocuswithin` as the
   focus test.
6. Record each element/token pair actually removed. Do not write `style`, replace whole
   `className` values, remove generic `ShowAsHovered` strings, or touch focused cards or another
   carousel whose own root lacks a focused media card.

On carousel/document replacement and final disposal, disconnect the affected observer and remove
its pointer listener before touching tracked elements. Prune detached elements during normal
cleanup. During teardown skip detached elements, locate the live React props key by its
`__reactProps$` prefix, and restore only recorded tokens that React's current `className` still
expects. A binding whose circuit breaker opened retains its recorded element/token pairs and must
still perform React-aware restoration during rebind or disposal; only its observer, pointer
listener, and pending scheduled work stop. Then clear the binding's strong references, tracking,
pending work, circuit-breaker counters, and lifecycle timer. Every path must be idempotent and
exception-contained.

### 3. Extend persistent settings with an opt-in carousel key

Update `main.py`, `src/backend.ts`, and `tests/test_main.py`:

- add `"home_carousel_fix_enabled": False` to the module-level `DEFAULT_SETTINGS` dictionary in
  `main.py`; `_read_settings` returns `dict(DEFAULT_SETTINGS)` verbatim when the settings file is
  missing or unreadable;
- add the key explicitly to `_normalize_settings` in `main.py`, which rebuilds a fixed key set on
  every read and write;
- add the key to `PluginSettings` in `src/backend.ts` and add
  `home_carousel_fix_enabled: false` to `DEFAULT_SETTINGS` in `src/index.tsx`;
- normalize missing, malformed, and legacy settings files to `false` for this key;
- preserve all existing defaults and stored values;
- add backend RPC `set_home_carousel_fix_enabled` with the same strict boolean validation and
  atomic settings write used by `set_feature_enabled`;
- add the typed frontend callable;
- prove round-trip persistence, legacy migration, malformed-value fallback, and rejection of
  non-boolean RPC input.

Do not rename `feature_enabled`; it is the installed user's durable mini-achievement preference.

### 4. Generalize frontend lifecycle and settings coordination

Rename `AchievementFeatureController` to the feature-neutral `FeatureController` in
`src/featureController.ts` and migrate every import/test caller. The coordinator already declares
a local structural `FeatureController` type; rename that local type to `ToggleableFeature` and
keep the coordinator dependent on the structural shape instead of importing the class. Keep the
class's idempotent installer/disposer/error contract. In `src/index.tsx`, construct independent
controllers for `installAchievementBarPatch` and `installHomeCarouselTitleFix`.

Extend `SettingsCoordinator` and `src/settingsCoordinator.test.ts` with:

- rename the existing coordinator option from `controller` to `achievementController`, add
  `homeCarouselController`, and update `src/index.tsx` plus the coordinator test harness to pass
  both explicitly;
- `homeCarouselFixBusy` in the snapshot;
- `setHomeCarouselFixEnabled(enabled)`;
- a serialized `homeCarouselFix` operation that uses the new backend callable;
- startup application of both persisted feature states;
- optimistic UI state with rollback when installation or persistence fails;
- normalization of the returned setting to the controller's actual state if installation fails;
- terminal disposal of both controllers with no late load/save effects.

Retain the single cross-setting write queue and independent busy flags. Existing debug and updater
behavior must remain unchanged.

### 5. Reorganize the QAM into the requested panels

Refactor `src/components/DescriptionSection.tsx` into
`src/components/RestoreMiniAchievementsSection.tsx`, migrating the existing scroll-reset and
preferred-focus behavior rather than duplicating it. Render:

```text
Restore Mini Achievements
  <existing focusable description>
  Enable mini achievements                    [toggle]

Home Carousel Title Fix
  Removes the stale title, glow, and raised tile after controller focus moves
  to another Home carousel card. Preserves CSSLoader theme styling.
  Fix stale Home carousel state               [toggle]

Settings
  Debug logging                               [toggle]

Updates
Versions
```

The first panel title must be exactly `Restore Mini Achievements`. Its description must remain
inside that `PanelSection`, retain `preferredFocus`, and continue to expose the ref used to reset
Decky's retained QAM scroll position without native DOM `focus()`. The mini-achievement toggle
keeps its binding to `feature_enabled`, changes its label from `Achievement bar` to
`Enable mini achievements`, and retains its current description:
`Shows achievement progress on game details pages.` Update the corresponding focused panel-test
expectation because this copy change is required by the requested UI.

Add `src/components/HomeCarouselTitleFixSection.tsx` with the exact title and concise description
shown above. Bind its toggle to `home_carousel_fix_enabled`, disable it until settings load or
while its own save is busy, and set `highlightOnFocus`. Update `SettingsSection.tsx` so it contains
only the existing `Debug logging` toggle. Keep every description/toggle row gamepad reachable.

Update `PluginPanelContent.tsx`, `src/index.tsx`, and `src/components/panel.test.tsx` for the new
props, handlers, panel order, exact headings/copy, disabled/busy states, preferred focus, and
independent toggle callbacks. Move the exported `resetDescriptionScroll` helper with the renamed
component and re-point its import in `src/index.tsx`, which currently imports it from
`./components/DescriptionSection`. Remove the obsolete `DescriptionSection` export/file after
every caller and test has migrated; `src/index.tsx`, `src/components/PluginPanelContent.tsx`, and
`src/components/panel.test.tsx` are the only callers. Do not leave a compatibility alias.

### 6. Update durable user and maintainer documentation

Update:

- `README.md` to list the optional Home Carousel Title Fix, its disabled default, its source-state
  class cleanup, and the new QAM panel organization, and to update the existing feature bullet that
  names the `Achievement bar` toggle so it matches `Enable mini achievements` under the
  `Restore Mini Achievements` panel;
- `CHANGELOG.md` in its current unreleased section with the new opt-in feature and QAM
  reorganization;
- `AGENTS.md` with terse runtime facts: signature-based module discovery, the three exact export
  roles, the `.gpfocuswithin` guard, carousel-scoped observation, no style overrides, and
  React-aware teardown. Also update the existing `Conventions` bullet that enumerates persistent
  settings defaults so it reads `achievement restoration enabled, the Home carousel title fix
  disabled, verbose diagnostics disabled, the stable update channel, and automatic update checks
  enabled`.

State that the plugin repairs the stale source state while controller focus is inside the affected
carousel, and that the separate CSSLoader Home Carousel Title Fix theme's overrides are not
required for that verified in-carousel case while the option is enabled. Do not claim broader
coverage while no media card has `.gpfocuswithin`, and do not claim the plugin modifies, disables,
reproduces, or fully replaces that CSSLoader theme.

### 7. Complete focused tests and repository gates

Keep tests behavior-focused and deterministic. Update all fixtures that construct
`PluginSettings`, `SettingsSnapshot`, coordinator options, or panel props. Add no snapshot-only or
source-text tests. Run the focused frontend and backend commands in `Verification`, then the
generated `Quality Gates`. Commit all implementation, tests, docs, and test-fixture updates before
marking the round complete.

---

## Quality Gates

Run before marking any round complete:

```bash
scripts/orchestration/run-quality-gates
scripts/orchestration/check-review-notes-not-deleted
git status --short
```

The round is not complete unless:

1. all requested implementation work is done;
2. all relevant tests pass;
3. build/typecheck gates pass;
4. review notes have not been deleted;
5. the working tree is clean;
6. all code/docs changes are committed.

---

## Verification

Apply `skill://orchestration-plan-author/references/verification-standards.md`: every check must be
able to fail, report the observed result, and reject a no-op implementation.

### Automated acceptance

Run the focused frontend contracts:

```bash
npm test -- src/homeCarouselTitleFix.test.ts src/featureController.test.ts src/settingsCoordinator.test.ts src/components/panel.test.tsx
```

Record Vitest's actual file/test pass totals. Failure is any non-zero exit, failed assertion,
unhandled exception, or missing named test file.

Run the backend settings contracts:

```bash
uv run --with pytest -- pytest -q tests/test_main.py
```

Record pytest's actual pass total. Failure includes a missing
`home_carousel_fix_enabled` key, a default other than `false`, loss of an existing setting, a
non-atomic write, or acceptance of a non-boolean setter input.

Run the complete repository gates from `Quality Gates` and record each command's exit status.

### Required negative controls and implementation mutation

After the failure-case tests exist and before trusting their green result:

1. Run the DOM tests with no media-card `.gpfocuswithin` and with `.gpfocuswithin` only on an
   ancestor, and record that all three simulated `ShowAsHovered` tokens remain. Then run the
   focused-card, cross-carousel, and outside-carousel tests and record that their tokens remain.
2. Temporarily remove the production branch that deletes the AppPortrait `ShowAsHovered` token.
   Run the named Home-carousel runtime test and require a non-zero Vitest result whose assertion
   reports that the library-box token remained. Exit `127`, a missing test, or unrelated output
   does not satisfy this control.
3. Restore the production branch. Run the same named test again and require it to pass, followed by
   the full focused frontend command above.

Do not commit the temporary mutation. Use standalone commands rather than command substitution or
unchecked pipelines.

### On-device QAM and Home-carousel smoke test

This is required for the changed UI/runtime surface when `steamdeck-legos` and user authorization
to install the exact implementation build are available. Do not silently install, navigate, or
change persistent device settings. If authorization or the device is unavailable during the
implementation round, record this section as deferred in the implementation handoff and review
note; automated tests are not a substitute for it.

Build and package the exact committed implementation, install that package through the existing
development deployment procedure, and record its commit/version identity. Then:

1. Open the plugin QAM and verify the visible order and exact headings:
   `Restore Mini Achievements`, `Home Carousel Title Fix`, `Settings`, `Updates`, `Versions`.
2. Use only gamepad input to move through both feature descriptions, both feature toggles, Debug
   logging, update controls, and version rows. Close and reopen the QAM after scrolling; verify the
   first description is visible and preferred without calling native DOM `focus()`.
3. Toggle mini achievements off and on while a game-details page with available achievement data
   is open. Record that Valve's row disappears and returns without a Steam reload.
4. Disable the separate CSSLoader Home Carousel Title Fix theme for the runtime proof. Keep Darken
   Unfocused Games active at `brightness(0.5) saturate(0.5)`.
5. With the plugin's Home-carousel option off, move controller focus away from the first recent
   game and capture the stale title/glow/raised tile plus the three stale class tokens.
6. Enable the option, then close the QAM and return controller focus to a Home carousel card. The
   fix requires a media-card `.gpfocuswithin`, and an open QAM holds gamepad focus, so cleanup is
   expected to remain inert while the panel is open. Record both states: with the QAM open the
   stale tokens may remain; after focus returns to the carousel only the focused title remains,
   all three stale tokens are absent from nonfocused cards, the tile transform is resting, and the
   third-party `brightness(0.5) saturate(0.5)` filter remains.
7. With the QAM closed, send a real D-pad focus move and require the newly nonfocused card to
   settle without any of the three stale tokens. Move a pointer over one nonfocused card while
   controller focus remains on another and verify native pointer-hover styling remains; move the
   pointer away and require stale tokens to be cleaned. Reintroduce the three tokens on a
   nonfocused fixture card through the live probe and require the observer to remove them with
   bounded callback counts.
8. Disable the option. Require the observer/timer to be absent and verify that only tokens still
   expected by live React props were restored. Re-enable it if that was the user's initial state.
9. Reload the plugin and verify mini-achievement state is retained while the Home-carousel option
   remains at the user's selected state. For a legacy settings fixture without the new key, verify
   the option starts off.
10. Restore the original CSSLoader theme state, debug setting, feature settings, focused route,
    and any other device state changed for the test. Remove temporary probes and screenshots from
    the device after recording the evidence.

### Explicitly deferred or unverified work

The implementation does not claim compatibility with future Steam builds whose CSS modules no
longer expose the required export-key signatures. That case must fail closed and log rather than
mutate an uncertain element. Any unperformed device step, unavailable route, untested theme, or
missing live stale-state reproduction must be listed explicitly in the review handoff.

---

## Mark Round Complete

When the implementation round is complete and the working tree is clean, run:

```bash
scripts/orchestration/mark-finished home-carousel-fix-qam-panels
```

This writes:

```text
/tmp/Decky-SteamAchievements/home-carousel-fix-qam-panels_finished
```

Then exit cleanly. If this process exits, the orchestrator will resume you through
`scripts/orchestration/continue-implementer home-carousel-fix-qam-panels`.

---

## Review Polling Loop

After marking the round complete, check existing review notes first, then poll for new review notes if you remain active:

```text
docs/review/home-carousel-fix-qam-panels-review-*.md
```

When a review note exists or a new review note appears:

1. Read the full review note.
2. If the note ends with:

   ```text
   STATUS: CHANGES_REQUESTED
   ```

   then resume work.

3. Clear the round-complete marker:

   ```bash
   scripts/orchestration/clear-finished home-carousel-fix-qam-panels
   ```

4. Address every requested change.
5. Run quality gates:

   ```bash
   scripts/orchestration/run-quality-gates
   scripts/orchestration/check-review-notes-not-deleted
   ```

6. Commit code/docs fixes.
7. Commit the review-note file itself if it is not already committed:

   ```bash
   git add docs/review/home-carousel-fix-qam-panels-review-*.md
   git commit -m "docs(review): record home-carousel-fix-qam-panels review notes"
   ```

8. Recreate the round-complete marker:

   ```bash
   scripts/orchestration/mark-finished home-carousel-fix-qam-panels
   ```

9. Either continue polling or exit cleanly. If you exit, the orchestrator will resume you with `scripts/orchestration/continue-implementer home-carousel-fix-qam-panels` after the next review note is created.

---

## Approval Handling

If the latest review note ends with:

```text
STATUS: APPROVED
```

then:

1. Confirm every previous review item has been addressed.
2. Confirm all review notes are committed:

   ```bash
   scripts/orchestration/check-review-notes-committed home-carousel-fix-qam-panels
   ```

3. Confirm the working tree is clean:

   ```bash
   git status --short
   ```

4. Finalize:

   ```bash
   scripts/orchestration/finalize home-carousel-fix-qam-panels
   ```

5. Confirm the finalized marker exists:

   ```text
   /tmp/Decky-SteamAchievements/home-carousel-fix-qam-panels_finalized
   ```

6. Stop polling and exit cleanly.

---

## Review Rules

Do not write your own review.

Do not create files under:

```text
docs/review/
```

Do not delete files under:

```text
docs/review/
```

Only the orchestrator writes review notes. Your job is to read them, resolve them, commit them as audit records, and continue the loop.

---

## Finalization Rules

Only finalize after a review note with:

```text
STATUS: APPROVED
```

Finalization is performed with:

```bash
scripts/orchestration/finalize home-carousel-fix-qam-panels
```

Do not manually merge into `dev` unless the finalize script fails and the user/orchestrator explicitly instructs you to recover manually.

Leave both markers in place after finalization:

```text
/tmp/Decky-SteamAchievements/home-carousel-fix-qam-panels_finished
/tmp/Decky-SteamAchievements/home-carousel-fix-qam-panels_finalized
```

Any project-specific release step runs from the project's
`scripts/orchestration-hooks/finalize-release` hook, invoked by finalize.
