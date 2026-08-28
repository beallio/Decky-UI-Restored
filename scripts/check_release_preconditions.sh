#!/usr/bin/env bash
# Validate a stable release candidate without publishing or changing refs.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

usage() {
  cat <<'EOF'
Usage: scripts/check_release_preconditions.sh \
  --tag vX.Y.Z --sha COMMIT --archive PATH \
  [--remote REMOTE] [--main-ref REF] [--quality-gate PATH]

The current checkout must be COMMIT. REMOTE defaults to origin and REF defaults
to origin/main. The script reads remote tags, runs all release gates, and changes
no local or remote ref. PATH defaults to the repository's project quality-gate
hook. The script never invokes gh.
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

tag=""
candidate_sha=""
archive=""
remote="origin"
main_ref="origin/main"
quality_gate="scripts/orchestration-hooks/quality-gates"
while (($#)); do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      tag="$2"
      shift 2
      ;;
    --sha)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      candidate_sha="$2"
      shift 2
      ;;
    --archive)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      archive="$2"
      shift 2
      ;;
    --remote)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      remote="$2"
      shift 2
      ;;
    --main-ref)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      main_ref="$2"
      shift 2
      ;;
    --quality-gate)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      quality_gate="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      echo "release-preconditions: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ || -z "$candidate_sha" || -z "$archive" ]]; then
  usage >&2
  echo "release-preconditions: --tag, --sha, and --archive are required" >&2
  exit 2
fi
version="${tag#v}"

set +e
resolved_tag="$(git rev-parse --verify "$tag^{commit}" 2>&1)"
tag_status=$?
set -e
if ((tag_status != 0)); then
  echo "release-preconditions: cannot resolve candidate tag $tag: $resolved_tag" >&2
  exit 1
fi
set +e
resolved_candidate="$(git rev-parse --verify "$candidate_sha^{commit}" 2>&1)"
candidate_status=$?
set -e
if ((candidate_status != 0)); then
  echo "release-preconditions: cannot resolve candidate commit $candidate_sha: $resolved_candidate" >&2
  exit 1
fi
if [[ "$resolved_tag" != "$resolved_candidate" ]]; then
  echo "release-preconditions: tag $tag does not point to candidate $candidate_sha" >&2
  exit 1
fi

head_sha="$(git rev-parse HEAD)"
if [[ "$head_sha" != "$resolved_candidate" ]]; then
  echo "release-preconditions: current checkout is $head_sha, expected $resolved_candidate" >&2
  exit 1
fi

set +e
git merge-base --is-ancestor "$resolved_candidate" "$main_ref" >/dev/null 2>&1
ancestry_status=$?
set -e
case "$ancestry_status" in
  0) ;;
  1)
    echo "release-preconditions: tagged commit is not an ancestor of $main_ref" >&2
    exit 1
    ;;
  *)
    echo "release-preconditions: failed to verify ancestry against $main_ref" >&2
    exit 1
    ;;
esac

python3 scripts/check_source_metadata.py
metadata_version="$(python3 -c 'import json; print(json.load(open("plugin.json", encoding="utf-8"))["version"])')"
if [[ "$metadata_version" != "$version" ]]; then
  echo "release-preconditions: tag $tag does not match source metadata version $metadata_version" >&2
  exit 1
fi

if ! "$quality_gate"; then
  echo "release-preconditions: full quality gates failed" >&2
  exit 1
fi
if ! python3 scripts/changelog.py check "$version"; then
  echo "release-preconditions: changelog validation failed for $version" >&2
  exit 1
fi

set +e
remote_tags="$(git ls-remote --tags "$remote" 2>&1)"
remote_status=$?
set -e
if ((remote_status != 0)); then
  echo "release-preconditions: failed to query remote tags from $remote: $remote_tags" >&2
  exit 1
fi
remote_highest="$(highest_remote_stable "$remote_tags")"
if [[ -n "$remote_highest" ]] && version_is_greater "$remote_highest" "$version"; then
  echo "release-preconditions: version $version is behind remote stable tag v$remote_highest" >&2
  exit 1
fi
if ! python3 scripts/version_guard.py check-drift "$version"; then
  echo "release-preconditions: version $version is behind local stable tags" >&2
  exit 1
fi

if ! python3 scripts/validate_plugin_zip.py \
  "$archive" \
  --expected-root Decky-SteamAchievements \
  --expected-name "Deck UI Restored" \
  --expected-version "$version"; then
  echo "release-preconditions: package validation failed" >&2
  exit 1
fi

echo "release-preconditions: OK for $tag at $resolved_candidate"
