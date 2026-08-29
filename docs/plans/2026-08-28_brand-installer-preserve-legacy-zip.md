# Plan: Brand Desktop Installer While Preserving Legacy Plugin ZIP (brand-installer-preserve-legacy-zip)

## Context

`Decky UI Restored` is the current product, repository, Decky list, and QAM panel name, but the
tracked Desktop installer still exposes the former distribution identity in its bundle filename,
launcher filename, extracted helper directory, KDialog title, log filename, and instructions. Make
those Desktop-install surfaces read `Decky UI Restored` while preserving the compatibility contract
that existing Decky installations need.

The user explicitly chose to keep the plugin release asset
`Decky-SteamAchievements.zip`. This is required for direct updates from existing releases.
`backend/updater/discovery.py` rejects a release unless it contains exactly one `.zip` asset and
that asset is `Decky-SteamAchievements.zip`; therefore, do not publish a second plugin ZIP and do
not rename the existing plugin ZIP. Keep the archive root, installed directory, settings/runtime
directories, package name, release-manifest identity, updater aliases, and installer aliases
unchanged.

Use these current user-facing Desktop installer names:

- bundle: `installer/Decky UI Restored Installer.zip`;
- launcher: `installer/Install Decky UI Restored.desktop`;
- extracted helper directory: `installer/DeckyUIRestoredInstaller/`;
- KDialog title: `Decky UI Restored Installer`;
- GUI log: `~/Desktop/Decky UI Restored Installer.log`.

The launcher `Exec` path must continue to work after users extract the bundle directly onto the
SteamOS Desktop. Keep the helper directory free of spaces so the desktop entry does not depend on
fragile command quoting. Preserve executable modes on the launcher and Python installer.

Relevant implementation and contract files include:

- `installer/build_bundle.sh`;
- `installer/Install Decky-SteamAchievements.desktop`;
- `installer/Decky-SteamAchievementsInstaller/README.txt`;
- `installer/Decky-SteamAchievementsInstaller/install_decky_plugin.py`;
- `scripts/check_installer_bundle.py`;
- `scripts/check_identity.py`;
- `tests/test_installer.py`;
- `README.md`, `DEVELOPER.md`, `AGENTS.md`, and `CHANGELOG.md`.

Non-goals:

- Do not change `Decky-SteamAchievements.zip`, its `Decky-SteamAchievements/` archive root, the
  installed folder, settings/runtime/log directories, or backend log namespace.
- Do not change `package.json.name`, the release-manifest `pluginName`, manifest/checksum filenames,
  updater discovery, GitHub release workflows, or accepted legacy display aliases.
- Do not create a second repository, a second plugin package, a second `.zip` release asset, or a
  side-by-side plugin installation.
- Do not rewrite historical changelog entries, plans, reviews, or live-validation records. They
  must keep the names that were true when they were written.
- Do not alter installer privilege, download, validation, rollback, or Decky service behavior.

**Slug used throughout this plan:** `brand-installer-preserve-legacy-zip`

---

## Orchestration Contract

**Slug:** `brand-installer-preserve-legacy-zip`

**Plan file:**

```text
docs/plans/2026-08-28_brand-installer-preserve-legacy-zip.md
```

**Implementation branch:**

```text
feat/brand-installer-preserve-legacy-zip
```

**Round-complete marker:**

```text
/tmp/Decky-SteamAchievements/brand-installer-preserve-legacy-zip_finished
```

**Finalized marker:**

```text
/tmp/Decky-SteamAchievements/brand-installer-preserve-legacy-zip_finalized
```

**Review notes:**

```text
docs/review/brand-installer-preserve-legacy-zip-review-*.md
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
git checkout -b feat/brand-installer-preserve-legacy-zip
```

Commit this plan first:

```bash
git add docs/plans/2026-08-28_brand-installer-preserve-legacy-zip.md
git commit -m "docs(plan): add brand-installer-preserve-legacy-zip implementation plan"
```

---

## Implementation Tasks

1. **Add failing contract tests before renaming files.**
   - Update `tests/test_installer.py` so its fixture loads the installer from
     `installer/DeckyUIRestoredInstaller/install_decky_plugin.py`.
   - Add focused assertions for a single installer display constant whose value is
     `Decky UI Restored Installer`, the KDialog title used by notice/error/confirmation/status
     helpers, and the GUI log basename `Decky UI Restored Installer.log`.
   - Update `scripts/check_installer_bundle.py` tests or direct checks to require exactly these
     archive entries, in deterministic order:
     `Install Decky UI Restored.desktop`, `DeckyUIRestoredInstaller/`,
     `DeckyUIRestoredInstaller/README.txt`, and
     `DeckyUIRestoredInstaller/install_decky_plugin.py`. On success, make the checker report the
     bundle path and ordered entry list so verification records observed data rather than only an
     `OK` conclusion.
   - Preserve assertions that the embedded installer still downloads
     `Decky-SteamAchievements.zip`, installs `Decky-SteamAchievements/`, recognizes every legacy
     display alias, and targets `beallio/Decky-UI-Restored`.
   - Update `scripts/check_identity.py` so the new Desktop installer artifacts are required, the
     removed legacy installer paths are rejected, and the moved installer is checked for
     `DISTRIBUTION_ASSET = "Decky-SteamAchievements.zip"`. Do not weaken its package, manifest,
     repository, or other distribution-identity assertions.
   - Run the focused tests and contract checks before implementation. Record the non-zero exits
     and the exact missing-path or old-brand assertion messages. A failure caused only by a
     missing command is not acceptable.

2. **Rename the Desktop installer sources as one clean cutover.**
   - Move `installer/Install Decky-SteamAchievements.desktop` to
     `installer/Install Decky UI Restored.desktop`.
   - Move `installer/Decky-SteamAchievementsInstaller/` to
     `installer/DeckyUIRestoredInstaller/`.
   - Remove the generated `installer/Decky-SteamAchievements Installer.zip`; do not retain a
     duplicate or compatibility copy because downloaded Desktop bundles do not participate in
     plugin update discovery.
   - In the desktop entry, use `Name=Install Decky UI Restored`, describe the current product in
     `Comment`, and point `Exec` at
     `/home/deck/Desktop/DeckyUIRestoredInstaller/install_decky_plugin.py --gui`.
   - Keep the source launcher and Python installer executable. Preserve the archive entry modes
     when rebuilding the bundle.

3. **Apply current branding to the installer UI without changing distribution behavior.**
   - In the moved Python installer, define one installer display-name constant:
     `Decky UI Restored Installer`.
   - Use that constant for every KDialog title and derive the GUI log basename from it. Do not
     duplicate the display string in separate GUI helpers.
   - Keep `DISTRIBUTION_ASSET = "Decky-SteamAchievements.zip"`,
     `DISTRIBUTION_FOLDER = "Decky-SteamAchievements"`,
     `DISTRIBUTION_PLUGIN_NAME = "Decky UI Restored"`, and all existing
     `DISTRIBUTION_LEGACY_PLUGIN_NAMES`.
   - Update the bundled `README.txt` so extraction, launcher, log, repository, and displayed
     product instructions use the new installer names. State factually that the installer
     downloads the compatibility-named `Decky-SteamAchievements.zip`.
   - Update `installer/build_bundle.sh` to create
     `installer/Decky UI Restored Installer.zip` with only the renamed launcher and helper
     directory, then rebuild and commit the generated archive.

4. **Update active documentation and identity gates.**
   - Update the root `README.md` Desktop-installer procedure to name the new bundle, launcher, and
     helper directory. Keep the direct Decky ZIP procedure on `Decky-SteamAchievements.zip` and
     explain that this filename is retained for existing updater compatibility.
   - Update `DEVELOPER.md` and the current identity/installer sections of `AGENTS.md` with the same
     public-installer versus internal-distribution contract.
   - Add an `[Unreleased]` changelog entry for the Desktop installer branding cutover. Do not edit
     prior version entries.
   - Keep current public prose on `Decky UI Restored`. Allow old display names only where the text
     documents migration aliases, historical behavior, or the stable internal distribution
     contract.

5. **Prove that the plugin release contract did not change.**
   - Build the plugin with release version `0.2.2` and run `scripts/validate_plugin_zip.py` against
     `Decky-SteamAchievements.zip` with expected root `Decky-SteamAchievements`, expected display
     name `Decky UI Restored`, and expected version `0.2.2`.
   - Record the archive root, packaged `plugin.json.name`, packaged `package.json.name`, and ZIP
     filename. Fail if a `Decky-UI-Restored.zip` plugin package is produced.
   - Do not modify `scripts/package.mjs`, `backend/updater/discovery.py`, release workflows, or
     release metadata naming unless a review note demonstrates that a listed invariant cannot be
     preserved without such a change.

6. **Keep commits atomic and reviewable.**
   - Commit the failing tests before the implementation when the orchestration workflow permits a
     red test commit.
   - Commit source renames with their reference updates so no committed revision claims a working
     bundle with missing sources.
   - Commit the rebuilt installer ZIP with its source changes or in an immediately following
     generated-artifact commit.
   - Do not include unrelated formatting, dependency updates, generated plugin ZIPs, runtime logs,
     screenshots, or scratch files.

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

1. Run the focused installer tests:

   ```bash
   uv run --with pytest -- pytest -q tests/test_installer.py
   ```

   Record the test count and pass/fail result. Failure includes any old source path, old KDialog
   title, changed distribution asset/folder, missing alias, or incorrect repository URL.

2. Rebuild and validate the Desktop installer bundle:

   ```bash
   bash installer/build_bundle.sh
   python3 scripts/check_installer_bundle.py
   python3 scripts/check_identity.py
   ```

   Record the generated bundle path and the exact archive-entry list reported by the checker.
   Failure includes an extra legacy bundle, launcher, helper directory, wrong entry order,
   byte mismatch, lost executable mode, changed plugin ZIP asset, or stale repository URL.

3. Build the unchanged plugin distribution contract:

   ```bash
   npm run build
   node scripts/package.mjs --release
   python3 scripts/validate_plugin_zip.py Decky-SteamAchievements.zip \
     --expected-root Decky-SteamAchievements \
     --expected-name "Decky UI Restored" \
     --expected-version 0.2.2
   if [[ -e Decky-UI-Restored.zip ]]; then
     printf '%s\n' "unexpected renamed plugin ZIP: Decky-UI-Restored.zip" >&2
     exit 1
   fi
   ```

   Record the packaged filename, root, version, display name, and package name. The explicit
   absence check must fail if a `Decky-UI-Restored.zip` plugin package was created.

4. Run the repository quality gates from the generated orchestration contract:

   ```bash
   scripts/orchestration/run-quality-gates
   scripts/orchestration/check-review-notes-not-deleted
   git status --short
   ```

   Record each command's exit status and the quality-gate pass/fail tallies. The final status must
   be clean after all intended changes are committed.

### Mutation controls

After the implementation first passes the focused checks:

1. Temporarily change the implemented installer display-name constant back to
   `Decky-SteamAchievements Installer`. Run the focused installer test and require a non-zero exit
   with the assertion that identifies the wrong KDialog title or log basename. Restore the
   implementation.
2. Temporarily change `DISTRIBUTION_ASSET` to `Decky-UI-Restored.zip`. Run the focused installer
   test and `scripts/check_identity.py`; require non-zero exits that identify the broken legacy ZIP
   contract. Restore the implementation.
3. Rerun all focused automated acceptance steps after both failure cases. This final positive
   control must pass; do not infer success from the mutation failures.

### Live SteamOS Desktop smoke

When `steamdeck-legos` is reachable:

1. Copy `Decky UI Restored Installer.zip` to the SteamOS Desktop and extract it there.
2. Confirm the extracted launcher is `Install Decky UI Restored` and the helper directory is
   `DeckyUIRestoredInstaller`.
3. Launch the actual desktop entry. Verify that the preparation and installation-confirmation
   dialogs use the title `Decky UI Restored Installer`.
4. At the final installation confirmation, cancel instead of authorizing installation. Verify that
   cancellation leaves the installed plugin and its settings unchanged.
5. Confirm `~/Desktop/Decky UI Restored Installer.log` exists and that the new extraction did not
   create a legacy-named installer bundle, launcher, helper directory, or log.

Record the observed dialog title, extracted filenames, cancellation result, and log path. Remove
only the smoke-test extraction and copied bundle after recording the result.

If `steamdeck-legos` is unavailable, state that the Desktop visual smoke is deferred and do not
claim that the renamed launcher or KDialog surface was visually verified. Automated checks do not
replace this manual surface verification.

---

## Mark Round Complete

When the implementation round is complete and the working tree is clean, run:

```bash
scripts/orchestration/mark-finished brand-installer-preserve-legacy-zip
```

This writes:

```text
/tmp/Decky-SteamAchievements/brand-installer-preserve-legacy-zip_finished
```

Then exit cleanly. If this process exits, the orchestrator will resume you through
`scripts/orchestration/continue-implementer brand-installer-preserve-legacy-zip`.

---

## Review Polling Loop

After marking the round complete, check existing review notes first, then poll for new review notes if you remain active:

```text
docs/review/brand-installer-preserve-legacy-zip-review-*.md
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
   scripts/orchestration/clear-finished brand-installer-preserve-legacy-zip
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
   git add docs/review/brand-installer-preserve-legacy-zip-review-*.md
   git commit -m "docs(review): record brand-installer-preserve-legacy-zip review notes"
   ```

8. Recreate the round-complete marker:

   ```bash
   scripts/orchestration/mark-finished brand-installer-preserve-legacy-zip
   ```

9. Either continue polling or exit cleanly. If you exit, the orchestrator will resume you with `scripts/orchestration/continue-implementer brand-installer-preserve-legacy-zip` after the next review note is created.

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
   scripts/orchestration/check-review-notes-committed brand-installer-preserve-legacy-zip
   ```

3. Confirm the working tree is clean:

   ```bash
   git status --short
   ```

4. Finalize:

   ```bash
   scripts/orchestration/finalize brand-installer-preserve-legacy-zip
   ```

5. Confirm the finalized marker exists:

   ```text
   /tmp/Decky-SteamAchievements/brand-installer-preserve-legacy-zip_finalized
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
scripts/orchestration/finalize brand-installer-preserve-legacy-zip
```

Do not manually merge into `dev` unless the finalize script fails and the user/orchestrator explicitly instructs you to recover manually.

Leave both markers in place after finalization:

```text
/tmp/Decky-SteamAchievements/brand-installer-preserve-legacy-zip_finished
/tmp/Decky-SteamAchievements/brand-installer-preserve-legacy-zip_finalized
```

Any project-specific release step runs from the project's
`scripts/orchestration-hooks/finalize-release` hook, invoked by finalize.
