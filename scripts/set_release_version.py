#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SEMVER_RE = re.compile(r"\d+\.\d+\.\d+")
PLUGIN_DISPLAY_NAME = "Decky UI Restored"
PACKAGE_NAME = "decky-steamachievements"


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} root must be a JSON object")
    return value


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _metadata_paths(project_root: Path) -> tuple[Path, Path, Path]:
    return (
        project_root / "plugin.json",
        project_root / "package.json",
        project_root / "package-lock.json",
    )


def _require_identity(
    plugin_data: dict[str, Any],
    package_data: dict[str, Any],
    lock_data: dict[str, Any],
) -> dict[str, Any]:
    if plugin_data.get("name") != PLUGIN_DISPLAY_NAME:
        raise ValueError(f"plugin.json name must remain {PLUGIN_DISPLAY_NAME!r}")
    if package_data.get("name") != PACKAGE_NAME:
        raise ValueError(f"package.json name must remain {PACKAGE_NAME!r}")
    if lock_data.get("name") != PACKAGE_NAME:
        raise ValueError(f"package-lock.json name must remain {PACKAGE_NAME!r}")
    packages = lock_data.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        raise ValueError('package-lock.json is missing object packages[""]')
    lock_root = packages[""]
    if lock_root.get("name") != PACKAGE_NAME:
        raise ValueError(f'package-lock.json packages[""] name must remain {PACKAGE_NAME!r}')
    return lock_root


def set_release_version(version: str, project_root: Path) -> None:
    if not SEMVER_RE.fullmatch(version):
        raise ValueError(f"Version {version!r} is not a stable semantic version. Must match X.Y.Z.")

    plugin_path, package_path, lock_path = _metadata_paths(project_root)
    for path in (plugin_path, package_path, lock_path):
        if not path.is_file():
            raise FileNotFoundError(f"{path.name} not found at: {path}")

    # Read and validate every input before any file is modified.
    plugin_data = _read_json(plugin_path)
    package_data = _read_json(package_path)
    lock_data = _read_json(lock_path)
    lock_root = _require_identity(plugin_data, package_data, lock_data)

    plugin_data["version"] = version
    package_data["version"] = version
    lock_data["version"] = version
    lock_root["version"] = version

    _write_json(plugin_path, plugin_data)
    _write_json(package_path, package_data)
    _write_json(lock_path, lock_data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Set the release version in package metadata.")
    parser.add_argument("version", help="Stable semver version, for example 0.2.1.")
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path.cwd(),
        help="Project root containing plugin.json, package.json, and package-lock.json.",
    )
    args = parser.parse_args()
    try:
        set_release_version(args.version, args.project_root.resolve())
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Updated plugin.json, package.json, and package-lock.json version to {args.version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
