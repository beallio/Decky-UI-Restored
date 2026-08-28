#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


PLUGIN_DISPLAY_NAME = "Decky UI Restored"
PACKAGE_NAME = "decky-steamachievements"


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing required file: {path.name}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"malformed JSON in {path.name}: line {exc.lineno} column {exc.colno}"
        ) from exc
    except OSError as exc:
        raise ValueError(f"cannot read {path.name}: {exc}") from exc

    if not isinstance(value, dict):
        raise ValueError(f"{path.name} root must be a JSON object")
    return value


def _string_field(data: dict[str, Any], path: str, *keys: str) -> str:
    value: Any = data
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            raise ValueError(f"{path} is missing required field {'.'.join(keys)}")
        value = value[key]
    if not isinstance(value, str) or not value:
        raise ValueError(f"{path} field {'.'.join(keys)} must be a non-empty string")
    return value


def check_source_metadata(project_root: Path) -> None:
    plugin = _load_json(project_root / "plugin.json")
    package = _load_json(project_root / "package.json")
    lockfile = _load_json(project_root / "package-lock.json")

    plugin_name = _string_field(plugin, "plugin.json", "name")
    package_name = _string_field(package, "package.json", "name")
    lock_name = _string_field(lockfile, "package-lock.json", "name")
    lock_root_name = _string_field(
        lockfile, "package-lock.json", "packages", "", "name"
    )

    if plugin_name != PLUGIN_DISPLAY_NAME:
        raise ValueError(
            f"plugin.json name {plugin_name!r} does not match display name "
            f"{PLUGIN_DISPLAY_NAME!r}"
        )
    for label, actual in (
        ("package.json name", package_name),
        ("package-lock.json name", lock_name),
        ('package-lock.json packages[""] name', lock_root_name),
    ):
        if actual != PACKAGE_NAME:
            raise ValueError(f"{label} {actual!r} does not match package name {PACKAGE_NAME!r}")

    versions = (
        ("plugin.json version", _string_field(plugin, "plugin.json", "version")),
        ("package.json version", _string_field(package, "package.json", "version")),
        ("package-lock.json version", _string_field(lockfile, "package-lock.json", "version")),
        (
            'package-lock.json packages[""] version',
            _string_field(lockfile, "package-lock.json", "packages", "", "version"),
        ),
    )
    expected_version = versions[0][1]
    disagreements = [
        f"{label}={value!r}" for label, value in versions if value != expected_version
    ]
    if disagreements:
        details = ", ".join(f"{label}={value!r}" for label, value in versions)
        raise ValueError(f"version disagreement: {details}")


def main() -> int:
    project_root = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else Path.cwd()
    if len(sys.argv) > 2:
        print("Usage: scripts/check_source_metadata.py [PROJECT_ROOT]", file=sys.stderr)
        return 2
    try:
        check_source_metadata(project_root)
    except ValueError as exc:
        print(f"source-metadata: {exc}", file=sys.stderr)
        return 1
    print("source-metadata: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
