#!/usr/bin/env bash
# Prepare a stable GitHub Release locally; never pushes.
#
# Expected stable flow:
#   1. Merge dev into main with --no-ff and check out the clean main branch.
#   2. Run: scripts/release.sh X.Y.Z
#   3. Review the annotated tag, hash-free package, and any version commit.
#   4. Run the printed main/tag pushes when ready.
#   5. Run scripts/bump_next_patch.sh on dev and commit the next development base.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

usage() {
  cat <<'EOF'
Usage: scripts/release.sh X.Y.Z

Prepare an annotated vX.Y.Z tag and hash-free Decky-SteamAchievements.zip on
clean main. The script creates a version commit only when package metadata
changes; otherwise it tags the current HEAD. It never pushes and never invokes
GitHub. Review the result, then run the two printed push commands yourself.
EOF
}

version_is_greater() {
  local candidate="$1" current="$2"
  local candidate_major candidate_minor candidate_patch
  local current_major current_minor current_patch
  IFS=. read -r candidate_major candidate_minor candidate_patch <<< "$candidate"
  IFS=. read -r current_major current_minor current_patch <<< "$current"
  ((10#$candidate_major > 10#$current_major)) ||
    ((10#$candidate_major == 10#$current_major && 10#$candidate_minor > 10#$current_minor)) ||
    ((10#$candidate_major == 10#$current_major && 10#$candidate_minor == 10#$current_minor && 10#$candidate_patch > 10#$current_patch))
}

highest_remote_stable() {
  local listing="$1" oid ref peeled version highest=""
  while read -r oid ref peeled; do
    [[ ${ref:-} =~ ^refs/tags/v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || continue
    version="${BASH_REMATCH[1]}"
    if [[ -z "$highest" ]] || version_is_greater "$version" "$highest"; then
      highest="$version"
    fi
  done <<< "$listing"
  printf '%s\n' "$highest"
}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  usage >&2
  echo "release: version must match X.Y.Z" >&2
  exit 2
fi

version="$1"
tag="v$version"

set +e
status_output="$(git status --porcelain 2>&1)"
status_code=$?
set -e
if ((status_code != 0)); then
  echo "release: failed to inspect git status: $status_output" >&2
  exit 1
fi
if [[ -n "$status_output" ]]; then
  echo "release: working tree must be clean" >&2
  exit 1
fi

set +e
git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null 2>&1
tag_status=$?
set -e
case "$tag_status" in
  0)
    echo "release: tag $tag already exists" >&2
    exit 1
    ;;
  1) ;;
  *)
    echo "release: failed to check whether tag $tag exists" >&2
    exit 1
    ;;
esac

set +e
branch="$(git branch --show-current 2>&1)"
branch_status=$?
set -e
if ((branch_status != 0)); then
  echo "release: failed to determine the current branch: $branch" >&2
  exit 1
fi
if [[ "$branch" != "main" ]]; then
  echo "release: expected clean main after the dev -> main --no-ff merge" >&2
  exit 1
fi

set +e
remote_tags="$(git ls-remote --tags origin 2>&1)"
remote_status=$?
set -e
if ((remote_status != 0)); then
  echo "release: failed to refresh remote tag state: $remote_tags" >&2
  exit 1
fi
remote_highest="$(highest_remote_stable "$remote_tags")"
if [[ -n "$remote_highest" ]] && ! version_is_greater "$version" "$remote_highest"; then
  echo "release: version $version is not ahead of remote stable tag v$remote_highest" >&2
  exit 1
fi
if ! python3 scripts/version_guard.py check-base "$version"; then
  echo "release: version $version is not ahead of local stable tags" >&2
  exit 1
fi

python3 scripts/changelog.py check "$version"
scripts/orchestration/run-quality-gates
python3 scripts/set_release_version.py "$version"
git add plugin.json package.json package-lock.json
if ! git diff --cached --quiet; then
  git -c core.hooksPath=/dev/null commit -m "release: $tag"
else
  echo "release: package metadata already at $version; tagging current HEAD"
fi

node scripts/package.mjs \
  --release \
  --release-version "$version" \
  --release-tag "$tag" \
  --channel stable
python3 scripts/validate_plugin_zip.py \
  Decky-SteamAchievements.zip \
  --expected-root Decky-SteamAchievements \
  --expected-name "Deck UI Restored" \
  --expected-version "$version"
git tag -a "$tag" -m "Release $tag"

cat <<EOF

Prepared $tag locally on main and built Decky-SteamAchievements.zip.
Review the tag, package, and any version commit. When ready, publish with:

  git push origin main
  git push origin $tag

Afterward, return to dev, run scripts/bump_next_patch.sh, commit plugin.json,
package.json, and package-lock.json together, then push dev to refresh dev-build.
EOF
