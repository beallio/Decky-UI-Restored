#!/usr/bin/env python3
"""Validate the tracked Desktop installer archive against its canonical sources."""

from __future__ import annotations

import stat
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "installer"
BUNDLE = INSTALLER / "Decky UI Restored Installer.zip"
FILES = {
    "Install Decky UI Restored.desktop": INSTALLER / "Install Decky UI Restored.desktop",
    "DeckyUIRestoredInstaller/README.txt": INSTALLER
    / "DeckyUIRestoredInstaller"
    / "README.txt",
    "DeckyUIRestoredInstaller/install_decky_plugin.py": INSTALLER
    / "DeckyUIRestoredInstaller"
    / "install_decky_plugin.py",
}
DIRECTORY = "DeckyUIRestoredInstaller/"
EXPECTED_ENTRIES = (
    "Install Decky UI Restored.desktop",
    DIRECTORY,
    "DeckyUIRestoredInstaller/README.txt",
    "DeckyUIRestoredInstaller/install_decky_plugin.py",
)


def main() -> int:
    if not BUNDLE.is_file():
        raise SystemExit(f"missing installer bundle: {BUNDLE.relative_to(ROOT)}")
    with zipfile.ZipFile(BUNDLE) as archive:
        names = archive.namelist()
        expected = list(EXPECTED_ENTRIES)
        if names != expected:
            raise SystemExit(f"installer bundle entries differ: {names!r} != {expected!r}")
        for name, source in FILES.items():
            if archive.read(name) != source.read_bytes():
                raise SystemExit(f"installer bundle byte mismatch: {name}")
            info = archive.getinfo(name)
            if stat.S_ISLNK(info.external_attr >> 16):
                raise SystemExit(f"installer bundle contains a symlink: {name}")
            if name.endswith((".desktop", ".py")):
                if not source.stat().st_mode & stat.S_IXUSR:
                    raise SystemExit(f"installer source is not executable: {name}")
                if not (info.external_attr >> 16) & stat.S_IXUSR:
                    raise SystemExit(f"installer bundle entry is not executable: {name}")

        installer = archive.read(
            "DeckyUIRestoredInstaller/install_decky_plugin.py"
        ).decode("utf-8")
        if 'DISTRIBUTION_PLUGIN_URL = "https://github.com/beallio/Decky-UI-Restored"' not in installer:
            raise SystemExit("installer repository URL differs from the canonical repository")
        if 'DISTRIBUTION_ASSET = "Decky-SteamAchievements.zip"' not in installer:
            raise SystemExit("installer asset differs from the canonical plugin ZIP")
        if "DISTRIBUTION_INCLUDE_PRERELEASE = False" not in installer:
            raise SystemExit("installer must ignore prereleases by default")
    print(
        f"installer-bundle: OK path={BUNDLE.relative_to(ROOT)} "
        f"entries={list(EXPECTED_ENTRIES)!r}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
