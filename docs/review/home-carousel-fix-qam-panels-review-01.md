# Review — home-carousel-fix-qam-panels (round 01)

Branch: `feat/home-carousel-fix-qam-panels`
Reviewed against: `docs/plans/2026-08-27_home-carousel-fix-qam-panels.md`

## Verdict

The feature is not ready to integrate. The QAM/settings/documentation work matches the plan and
the repository gates are green, but three runtime/lifecycle defects violate the approved
fail-closed contract. The required mutation control and exact-build device smoke test also have no
durable evidence.

## Gate status

- `scripts/orchestration/run-quality-gates`: passed at `0768e49`; 9 Vitest files / 136 tests,
  90 pytest tests, typecheck, build, package, archive validation, metadata agreement, backend
  parity, Python compilation, and version-drift checks all passed.
- `scripts/orchestration/check-review-notes-not-deleted`: passed.
- `git status --short`: clean before this orchestrator-authored review note.
- Required AppPortrait implementation mutation red-to-green control: not recorded.
- Required on-device exact-package QAM/runtime smoke test: not recorded.

## Required changes

### 1. Make delayed webpack-require capture recoverable

`src/homeCarouselTitleFix.ts:233-264` persists `{ chunkArray, require: undefined }` immediately
after `webpackChunksteamui.push(...)`. If the runtime callback is not invoked synchronously, later
ticks read that persisted undefined value and return without pushing again. When webpack eventually
invokes the queued callback, it updates only the dead local variable and never publishes the
captured handle.

Replace this with a persisted capture state that represents pending and resolved capture for the
current chunk-array identity. The runtime callback must publish the require handle into that state
even when it executes after `captureWebpackRequire` returns. Do not push duplicate capture entries
while the state is pending. A thrown push must clear pending state and follow the same bounded retry
policy as other transient capture failures.

Add focused tests that prove:

- a delayed callback changes pending capture into a reusable resolved handle;
- repeated lifecycle ticks do not push another entry while capture is pending;
- a thrown push retries only after backoff and can later recover;
- disabling/re-enabling and a Decky reload against the same chunk-array identity reuse the
  resolved handle.

### 2. Add bounded module-resolution backoff and deduplicated diagnostics

The runtime currently retries module resolution on every one-second lifecycle tick. It rescans
factory sources, can require the same survivor factories again, and emits unresolved,
ambiguous, or overflow warnings every tick. That does not satisfy the plan's bounded-backoff and
distinguishable-log contract.

Use the existing injected monotonic clock as the single retry clock. Track resolution attempt
state for the current webpack-require/chunk-array identity, including the next eligible retry
time and the last reported failure category. Apply a bounded backoff with a documented maximum.
Do not rescan or re-require candidates before the retry time. Log each unchanged failure category
once; log again only when the category changes or after recovery and a later new failure. Reset
resolution/backoff state when the webpack identity changes and memoize successful modules.

Add tests that prove:

- no scan, survivor execution, or duplicate warning occurs before the retry window;
- unresolved, ambiguous, and candidate-overflow states produce distinct one-time diagnostics;
- modules that appear after a failed attempt resolve after the retry window;
- a successful resolution stops all further scans.

### 3. Dispose both feature controllers even when one throws

`src/settingsCoordinator.ts:119-125` disposes the achievement controller and then the Home-carousel
controller without isolation. If the first structural controller throws, the second controller is
never disposed, which violates terminal cleanup.

Attempt both disposals independently. Preserve terminal coordinator state and listener cleanup
even when either disposer throws. Route each failure through the existing error-reporting
boundary without allowing one failure to skip the other. Add tests for a throwing first
controller, a throwing second controller, and both throwing; each test must prove both disposal
methods were called exactly once.

### 4. Run and record the required implementation mutation control

Temporarily remove the production branch that deletes the AppPortrait `ShowAsHovered` token. Run
the named Home-carousel test and require a non-zero Vitest result whose assertion identifies the
remaining library-box token. Restore the implementation, rerun the same test green, then rerun the
focused frontend command and full quality gates. Do not commit the mutation. Record the exact
commands, failing assertion, and red/green pass totals in the correction commit body so the
evidence survives the implementer session.

### 5. Complete the exact-build `steamdeck-legos` smoke test

Package the corrected committed build and deploy that exact package to `steamdeck-legos`. Exercise
the plan's complete on-device section:

- verify QAM panel order, preferred focus, D-pad reachability, descriptions, and disabled/busy
  behavior;
- verify both feature toggles and persistence, including legacy default-off migration;
- disable the CSSLoader workaround, retain Darken Unfocused Games, reproduce the three stale
  classes with the plugin option off, and verify class cleanup plus preserved
  `brightness(0.5) saturate(0.5)` with it on;
- test real D-pad focus movement, pointer-hover preservation and pointerleave cleanup, synthetic
  stale-class reintroduction, bounded observer behavior, and React-aware disable/teardown;
- restore the user's original plugin/CSSLoader/debug/focus state and remove temporary probes.

Record the exact package commit/version, observed before/after class and computed-style values,
panel/focus results, persistence results, teardown results, and restored device state in the
correction commit body. If a device prerequisite becomes unavailable, finish all code corrections
and state the exact blocker rather than substituting automated tests.

STATUS: CHANGES_REQUESTED
