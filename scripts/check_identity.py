#!/usr/bin/env python3
"""Enforce stable distribution identity and Decky's user-facing display identity."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

CANONICAL = "Decky-SteamAchievements"
PACKAGE_NAME = "decky-steamachievements"
DISPLAY_NAME = "Deck UI Restored"


def tracked_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        check=False,
        capture_output=True,
    )
    if result.returncode == 0:
        return [root / item.decode() for item in result.stdout.split(b"\0") if item]
    return [
        path
        for path in root.rglob("*")
        if path.is_file() and not {".git", "node_modules"}.intersection(path.parts)
    ]


def check(root: Path) -> list[str]:
    errors: list[str] = []
    plugin = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    if plugin.get("name") != DISPLAY_NAME:
        errors.append(f"plugin.json name must be {DISPLAY_NAME!r}")
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

    for path in tracked_files(root):
        relative = path.relative_to(root)
        if relative.suffix.lower() != ".md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        lines = text.splitlines()
        for number, line in enumerate(lines, 1):
            if DISPLAY_NAME not in line:
                continue
            context = " ".join(lines[max(0, number - 2) : min(len(lines), number + 1)]).lower()
            if (
                "qam" in context
                or "list" in context
                or "plugin.json" in context
                or "display" in context
                or "title" in context
                or "--expected-name" in line
            ):
                continue
            errors.append(
                f"{relative}:{number}: display name must explicitly describe a "
                "Decky list/QAM/title/display surface"
            )

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
