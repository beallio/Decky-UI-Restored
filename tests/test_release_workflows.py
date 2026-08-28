from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def run_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
    )


def prepare_request_helper_repo(
    tmp_path: Path,
) -> tuple[Path, dict[str, str], Path]:
    repo = tmp_path / "repo"
    remote = tmp_path / "origin.git"
    bin_dir = tmp_path / "bin"
    repo.mkdir()
    bin_dir.mkdir()
    run_git(tmp_path, "init", "--bare", str(remote))
    run_git(repo, "init", "--initial-branch=dev")
    run_git(repo, "config", "user.name", "Release Helper Test")
    run_git(repo, "config", "user.email", "release-helper@example.invalid")

    scripts = repo / "scripts"
    scripts.mkdir()
    shutil.copy2(ROOT / "scripts/request_dev_release.sh", scripts)
    shutil.copy2(ROOT / "scripts/version_guard.py", scripts)
    (repo / "package.json").write_text('{"version":"1.2.3"}\n', encoding="utf-8")
    (repo / "plugin.json").write_text('{"version":"1.2.3"}\n', encoding="utf-8")
    run_git(repo, "add", ".")
    run_git(repo, "commit", "-m", "test fixture")
    run_git(repo, "remote", "add", "origin", str(remote))
    run_git(repo, "push", "--set-upstream", "origin", "dev")

    calls = tmp_path / "gh-calls"
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$GH_CALLS"\n'
        'if [ "$1 $2" = "auth status" ]; then exit 0; fi\n'
        "exit 0\n",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    env = os.environ.copy()
    env["GH_CALLS"] = str(calls)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    return repo, env, calls


def test_stable_release_publishes_exact_updater_assets() -> None:
    content = read(".github/workflows/release.yml")
    preconditions = read("scripts/check_release_preconditions.sh")
    precondition_step = content.index("scripts/check_release_preconditions.sh")
    package_step = content.index("- name: Build stable release assets")
    publish_step = content.index("- name: Publish stable GitHub Release")
    package = content.split("- name: Build stable release assets", 1)[1].split(
        "- name: Publish stable GitHub Release", 1
    )[0]
    publish = content.split("- name: Publish stable GitHub Release", 1)[1]
    assert "Decky-SteamAchievements.zip" in publish
    assert '"Decky-SteamAchievements-$TAG.zip.sha256"' in publish
    assert '"Decky-SteamAchievements-$TAG.manifest.json"' in publish
    assert "--emit-release-metadata" in content
    assert "--channel stable" in content
    assert precondition_step < package_step < publish_step
    assert "python3 scripts/validate_plugin_zip.py" in preconditions
    assert '--expected-version "$version"' in preconditions
    assert "sha256sum -c" in package
    assert "scripts/validate_plugin_zip.py" in package
    assert "scripts/check_backend_archive_parity.py" in package
    assert 'gh release view "$TAG"' in publish
    assert 'gh release upload "$TAG"' in publish
    assert "--clobber" in publish
    assert 'gh release edit "$TAG"' in publish
    assert 'gh release create "$TAG"' in publish


def test_rolling_dev_stays_zip_only_and_stamps_commit_version() -> None:
    content = read(".github/workflows/dev-release.yml")
    validator = content.index("python3 scripts/validate_plugin_zip.py")
    publish_step = content.index("- name: Reconcile rolling tag, release, and ZIP asset")
    assert "push:" in content and "- dev" in content
    assert "dev-build" in content
    assert 'dev_version="${base_version}-dev.g${short_hash}"' in content
    assert '--release-version "$dev_version"' in content
    assert "python3 scripts/validate_plugin_zip.py" in content
    assert '--expected-version "$dev_version"' in content
    assert validator < publish_step
    assert "--emit-release-metadata" not in content
    publish = content.split("- name: Reconcile rolling tag, release, and ZIP asset", 1)[1]
    assert "Decky-SteamAchievements.zip" in publish
    assert ".manifest.json" not in publish
    assert ".zip.sha256" not in publish


def test_immutable_dev_workflow_enforces_semver_identity_and_three_assets() -> None:
    content = read(".github/workflows/immutable-dev-release.yml")
    validator = content.index("python3 scripts/validate_plugin_zip.py")
    publish_step = content.index("- name: Create immutable tag and prerelease")
    assert "workflow_dispatch:" in content
    assert "base_version:" in content
    assert 'DEV_VERSION="$BASE_VERSION-dev.g$SHORT_SHA"' in content
    assert 'DEV_TAG="v$DEV_VERSION"' in content
    assert "scripts/version_guard.py check-base" in content
    assert "package.json" in content and "plugin.json" in content
    assert "--emit-release-metadata" in content
    assert "--channel dev" in content
    assert "scripts/orchestration-hooks/quality-gates" in content
    assert "python3 scripts/validate_plugin_zip.py" in content
    assert '--expected-version "$DEV_VERSION"' in content
    assert validator < publish_step
    assert "Decky-SteamAchievements.zip" in content
    assert 'Decky-SteamAchievements-$DEV_TAG.zip.sha256' in content
    assert 'Decky-SteamAchievements-$DEV_TAG.manifest.json' in content
    assert "--prerelease" in content
    assert 'git rev-parse "refs/tags/$DEV_TAG"' in content


def test_display_rename_keeps_bridge_manifest_identity() -> None:
    plugin = json.loads(read("plugin.json"))
    package_script = read("scripts/package.mjs")
    rolling = read(".github/workflows/dev-release.yml")
    immutable = read(".github/workflows/immutable-dev-release.yml")
    stable = read(".github/workflows/release.yml")

    assert plugin["name"] == "Deck UI Restored"
    assert 'const UPDATE_MANIFEST_PLUGIN_NAME = "Achievements Restored";' in package_script
    assert "pluginName: UPDATE_MANIFEST_PLUGIN_NAME" in package_script
    for workflow in (rolling, immutable, stable):
        assert '--expected-name "Deck UI Restored"' in workflow
    assert 'm.pluginName!=="Achievements Restored"' in immutable
    assert '--title "Deck UI Restored v$DEV_VERSION (Development)"' in immutable


def test_request_helper_validates_before_dispatch() -> None:
    content = read("scripts/request_dev_release.sh")
    dispatch = content.index("gh workflow run immutable-dev-release.yml")
    for required in [
        "git status --porcelain --untracked-files=normal",
        "gh auth status",
        'git fetch --quiet --prune --tags "$remote_name"',
        "git rev-parse --verify",
        "git for-each-ref",
        "scripts/version_guard.py check-base",
        "package.json",
        "plugin.json",
    ]:
        assert required in content
        assert content.index(required) < dispatch


def test_request_helper_rejects_nonstable_version_without_dispatch(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "gh-calls"
    gh = bin_dir / "gh"
    gh.write_text(f"#!/bin/sh\necho \"$@\" >> {calls}\nexit 0\n", encoding="utf-8")
    gh.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    result = subprocess.run(
        ["bash", "scripts/request_dev_release.sh", "v1.2.3"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
    )
    assert result.returncode != 0
    assert not calls.exists()


def test_request_helper_rejects_untracked_tree_without_dispatch(tmp_path: Path) -> None:
    repo, env, calls = prepare_request_helper_repo(tmp_path)
    (repo / "untracked.txt").write_text("dirty\n", encoding="utf-8")

    result = subprocess.run(
        ["bash", "scripts/request_dev_release.sh", "1.2.3"],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "working tree must be clean" in result.stderr
    assert not calls.exists()


def test_request_helper_rejects_commit_not_reachable_from_remote(tmp_path: Path) -> None:
    repo, env, calls = prepare_request_helper_repo(tmp_path)
    (repo / "local-only.txt").write_text("not pushed\n", encoding="utf-8")
    run_git(repo, "add", "local-only.txt")
    run_git(repo, "commit", "-m", "local only")

    result = subprocess.run(
        ["bash", "scripts/request_dev_release.sh", "1.2.3", "HEAD"],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "not reachable from origin" in result.stderr
    assert "workflow run" not in calls.read_text(encoding="utf-8")


def test_version_guard_ignores_development_tags() -> None:
    spec = importlib.util.spec_from_file_location(
        "version_guard", ROOT / "scripts/version_guard.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.highest_stable_version(
        ["v0.1.0", "v99.0.0-dev.gabc", "dev-build", "v0.2.0"]
    ) == (0, 2, 0)
