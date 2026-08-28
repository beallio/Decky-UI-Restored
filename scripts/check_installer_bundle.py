#!/usr/bin/env python3
"""Validate the tracked Desktop installer archive against its canonical sources."""

from __future__ import annotations

import stat
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "installer"
BUNDLE = INSTALLER / "Decky-SteamAchievements Installer.zip"
FILES = {
    "Install Decky-SteamAchievements.desktop": INSTALLER
    / "Install Decky-SteamAchievements.desktop",
    "Decky-SteamAchievementsInstaller/README.txt": INSTALLER
    / "Decky-SteamAchievementsInstaller"
    / "README.txt",
    "Decky-SteamAchievementsInstaller/install_decky_plugin.py": INSTALLER
    / "Decky-SteamAchievementsInstaller"
    / "install_decky_plugin.py",
}
DIRECTORY = "Decky-SteamAchievementsInstaller/"


def main() -> int:
    with zipfile.ZipFile(BUNDLE) as archive:
        names = archive.namelist()
        expected = [next(iter(FILES)), DIRECTORY, *list(FILES)[1:]]
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
            "Decky-SteamAchievementsInstaller/install_decky_plugin.py"
        ).decode("utf-8")
        if 'DISTRIBUTION_PLUGIN_URL = "https://github.com/beallio/Deck-UI-Restored"' not in installer:
            raise SystemExit("installer repository URL differs from the canonical repository")
        if 'DISTRIBUTION_ASSET = "Decky-SteamAchievements.zip"' not in installer:
            raise SystemExit("installer asset differs from the canonical plugin ZIP")
        if "DISTRIBUTION_INCLUDE_PRERELEASE = False" not in installer:
            raise SystemExit("installer must ignore prereleases by default")
    print("installer-bundle: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
