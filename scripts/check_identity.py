#!/usr/bin/env python3
"""Enforce stable distribution identity and Decky's user-facing display identity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

CANONICAL = "Decky-SteamAchievements"
PACKAGE_NAME = "decky-steamachievements"
DISPLAY_NAME = "Deck UI Restored"
GITHUB_REPOSITORY = "beallio/Deck-UI-Restored"




def check(root: Path) -> list[str]:
    errors: list[str] = []
    plugin = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    if plugin.get("name") != DISPLAY_NAME:
        errors.append(f"plugin.json name must be {DISPLAY_NAME!r}")
    expected_image = (
        f"https://raw.githubusercontent.com/{GITHUB_REPOSITORY}/"
        "main/assets/achievement-bar-restored.png"
    )
    if plugin.get("publish", {}).get("image") != expected_image:
        errors.append("plugin.json image must use the canonical GitHub repository")
    if package.get("name") != PACKAGE_NAME:
        errors.append(f"package.json name must be {PACKAGE_NAME!r}")
    if lock.get("name") != PACKAGE_NAME or lock.get("packages", {}).get("", {}).get("name") != PACKAGE_NAME:
        errors.append("package-lock.json root package names must match package.json")

    index = (root / "src" / "index.tsx").read_text(encoding="utf-8")
    if index.count(f'const PLUGIN_NAME = "{DISPLAY_NAME}";') != 1:
        errors.append("definePlugin registration constant must use the display name")
    if index.count(f'const QAM_TITLE = "{DISPLAY_NAME}";') != 1:
        errors.append("src/index.tsx must declare exactly one QAM title constant")
    if "name: PLUGIN_NAME" not in index or "{QAM_TITLE}</div>" not in index:
        errors.append("definePlugin name and titleView must use their distinct constants")

    dev_release = (root / ".github" / "workflows" / "dev-release.yml").read_text(
        encoding="utf-8"
    )
    workflow_expectations = (
        "--expected-root Decky-SteamAchievements",
        '--expected-name "Deck UI Restored"',
    )
    for expected in workflow_expectations:
        if expected not in dev_release:
            errors.append(f"dev-release package validation must include {expected!r}")
    if "--expected-name Decky-SteamAchievements" in dev_release:
        errors.append(
            "dev-release package validation still expects the distribution name "
            "as plugin.json name"
        )

    package_script = (root / "scripts" / "package.mjs").read_text(encoding="utf-8")
    if 'const UPDATE_MANIFEST_PLUGIN_NAME = "Achievements Restored";' not in package_script:
        errors.append(
            "release manifests must retain the former display name for bridge updates"
        )

    repository_expectations = (
        (
            root / "backend" / "updater" / "client.py",
            'repo: str = "Deck-UI-Restored"',
        ),
        (
            root / "main.py",
            'owner="beallio", repo="Deck-UI-Restored"',
        ),
        (
            root / "installer" / "Decky-SteamAchievementsInstaller"
            / "install_decky_plugin.py",
            f'DISTRIBUTION_PLUGIN_URL = "https://github.com/{GITHUB_REPOSITORY}"',
        ),
    )
    for path, expected_repository in repository_expectations:
        if expected_repository not in path.read_text(encoding="utf-8"):
            errors.append(
                f"{path.relative_to(root)} must use GitHub repository "
                f"{GITHUB_REPOSITORY}"
            )

    readme = (root / "README.md").read_text(encoding="utf-8")
    if not readme.startswith("# Deck UI Restored\n"):
        errors.append("README title must use the Decky display name")
    developer = (root / "DEVELOPER.md").read_text(encoding="utf-8")
    if (
        'pluginName: \\"Achievements Restored\\"' not in developer
        or "Version 0.2.1 is the update bridge" not in developer
    ):
        errors.append("DEVELOPER.md must document the legacy update bridge identity")


    expected = [
        root / "installer" / "Decky-SteamAchievements Installer.zip",
        root / "installer" / "Install Decky-SteamAchievements.desktop",
        root / "installer" / "Decky-SteamAchievementsInstaller" / "install_decky_plugin.py",
    ]
    for path in expected:
        if not path.is_file():
            errors.append(f"missing canonical installer artifact: {path.relative_to(root)}")
    for path in (root / "installer").iterdir():
        if DISPLAY_NAME in path.name or "DeckyPluginInstaller" in path.name:
            errors.append(f"obsolete installer path remains: {path.relative_to(root)}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    errors = check(args.root.resolve())
    if errors:
        for error in errors:
            print(f"identity error: {error}")
        return 1
    print("identity: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
