#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACKAGE_NAME = "decky-steamachievements"
DEFAULT_ARCHIVE_ROOT = "Decky-SteamAchievements"
DEFAULT_PLUGIN_NAME = "Decky UI Restored"
REQUIRED_FILES = (
    "LICENSE",
    "main.py",
    "package.json",
    "plugin.json",
    "dist/index.js",
    "py_modules/backend/__init__.py",
)
REQUIRED_DIRECTORIES = ("dist/", "py_modules/backend/")
FORBIDDEN_PREFIXES = (
    "node_modules/",
    "src/",
    "tests/",
    "docs/",
    ".git/",
    "__pycache__/",
    ".cache/",
    ".pytest_cache/",
    ".ruff_cache/",
    ".venv/",
    "research/",
)


class ValidationError(ValueError):
    pass


def _read_object(archive: zipfile.ZipFile, path: str) -> dict[str, Any]:
    try:
        value = json.loads(archive.read(path).decode("utf-8"))
    except KeyError as exc:
        raise ValidationError(f"Missing required metadata file: {path}") from exc
    except UnicodeDecodeError as exc:
        raise ValidationError(f"Metadata file is not UTF-8: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValidationError(
            f"Malformed JSON in {path}: line {exc.lineno} column {exc.colno}"
        ) from exc
    if not isinstance(value, dict):
        raise ValidationError(f"Metadata root must be a JSON object: {path}")
    return value


def validate_archive(
    zip_path: Path,
    *,
    expected_root: str,
    expected_name: str,
    expected_version: str | None,
) -> None:
    if not zip_path.is_file():
        raise ValidationError(f"ZIP file does not exist: {zip_path}")

    prefix = f"{expected_root}/"
    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            names = archive.namelist()
            if not names:
                raise ValidationError("ZIP file is empty")

            non_conforming = [name for name in names if not name.startswith(prefix)]
            if non_conforming:
                raise ValidationError(
                    f"ZIP contains paths not starting with root directory {prefix!r}: "
                    f"{non_conforming[:5]}"
                )

            for name in names:
                rel_path = name[len(prefix) :]
                parts = PurePosixPath(rel_path).parts
                if rel_path.startswith("/") or ".." in parts:
                    raise ValidationError(f"ZIP contains unsafe path: {name}")
                if any(rel_path.startswith(item) for item in FORBIDDEN_PREFIXES):
                    raise ValidationError(f"ZIP contains forbidden path: {name}")
                if rel_path == "backend" or rel_path.startswith("backend/"):
                    raise ValidationError(
                        f"ZIP contains forbidden root backend path; "
                        f"package first-party modules under py_modules/backend/: {name}"
                    )
                if rel_path == "py_modules/backend" or rel_path.startswith(
                    "py_modules/backend/"
                ):
                    if "__pycache__" in parts:
                        raise ValidationError(
                            f"ZIP contains forbidden backend cache path: {name}"
                        )
                    if not name.endswith("/") and not rel_path.endswith(".py"):
                        raise ValidationError(
                            f"ZIP contains forbidden non-Python backend payload: {name}"
                        )
                if rel_path.endswith((".pyc", ".pyo")):
                    raise ValidationError(f"ZIP contains forbidden file: {name}")

            for file_name in REQUIRED_FILES:
                archive_path = f"{prefix}{file_name}"
                if archive_path not in names:
                    raise ValidationError(f"Missing required file in ZIP: {archive_path}")
            for directory in REQUIRED_DIRECTORIES:
                archive_prefix = f"{prefix}{directory}"
                if not any(name.startswith(archive_prefix) for name in names):
                    raise ValidationError(f"Missing required directory in ZIP: {archive_prefix}")

            plugin_path = f"{prefix}plugin.json"
            package_path = f"{prefix}package.json"
            plugin = _read_object(archive, plugin_path)
            package = _read_object(archive, package_path)

            plugin_name = plugin.get("name")
            if plugin_name != expected_name:
                raise ValidationError(
                    f"plugin.json name {plugin_name!r} does not match expected {expected_name!r}"
                )
            package_name = package.get("name")
            if package_name != PACKAGE_NAME:
                raise ValidationError(
                    f"package.json name {package_name!r} does not match expected {PACKAGE_NAME!r}"
                )

            plugin_version = plugin.get("version")
            package_version = package.get("version")
            if not isinstance(plugin_version, str) or not plugin_version:
                raise ValidationError("plugin.json version must be a non-empty string")
            if plugin_version != package_version:
                raise ValidationError(
                    "Version mismatch in ZIP: "
                    f"plugin.json={plugin_version!r}, package.json={package_version!r}"
                )
            if expected_version is not None and plugin_version != expected_version:
                raise ValidationError(
                    f"ZIP version {plugin_version!r} does not match expected {expected_version!r}"
                )

            publish = plugin.get("publish", {})
            if not isinstance(publish, dict):
                raise ValidationError("plugin.json publish must be a JSON object")
            image_url = publish.get("image", "")
            if not isinstance(image_url, str):
                raise ValidationError("plugin.json publish.image must be a string")
            if "SteamDeckHomebrew/PluginLoader" in image_url:
                raise ValidationError(
                    "plugin.json publish image still references SteamDeckHomebrew/PluginLoader"
                )

            flags = plugin.get("flags", [])
            if not isinstance(flags, list):
                raise ValidationError("plugin.json flags must be a JSON array")
            if "_root" in flags:
                raise ValidationError("plugin.json flags contains forbidden '_root'")
    except zipfile.BadZipFile as exc:
        raise ValidationError(f"Bad ZIP file: {zip_path}") from exc
    except OSError as exc:
        raise ValidationError(f"Cannot read ZIP file {zip_path}: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Decky-SteamAchievements plugin ZIP.")
    parser.add_argument("zip_path", type=Path, help="Path to the ZIP file to validate.")
    parser.add_argument("--expected-version", help="Expected version of the plugin.")
    parser.add_argument(
        "--expected-root",
        default=DEFAULT_ARCHIVE_ROOT,
        help="Expected canonical archive root / installed directory.",
    )
    parser.add_argument(
        "--expected-name",
        default=DEFAULT_PLUGIN_NAME,
        help="Expected user-facing plugin.json name.",
    )
    args = parser.parse_args()
    try:
        validate_archive(
            args.zip_path,
            expected_root=args.expected_root,
            expected_name=args.expected_name,
            expected_version=args.expected_version,
        )
    except ValidationError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print("Success: ZIP is valid and compliant!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
