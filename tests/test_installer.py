from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.fixture(scope="module")
def installer_module():
    path = (
        Path(__file__).parents[1]
        / "installer"
        / "Decky-SteamAchievementsInstaller"
        / "install_decky_plugin.py"
    )
    spec = importlib.util.spec_from_file_location("decky_steamachievements_installer", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_distribution_contract_is_canonical_and_stable(installer_module):
    assert installer_module.DISTRIBUTION_PLUGIN_URL == (
        "https://github.com/beallio/Decky-SteamAchievements"
    )
    assert installer_module.DISTRIBUTION_ASSET == "Decky-SteamAchievements.zip"
    assert installer_module.DISTRIBUTION_FOLDER == "Decky-SteamAchievements"
    assert installer_module.DISTRIBUTION_PLUGIN_NAME == "Deck UI Restored"
    assert installer_module.DISTRIBUTION_LEGACY_PLUGIN_NAMES == (
        "Achievements Restored",
        "Decky-SteamAchievements",
    )
    assert installer_module.DISTRIBUTION_RELEASE_TAG == ""
    assert installer_module.DISTRIBUTION_INCLUDE_PRERELEASE is False


def test_default_github_resolution_uses_latest_stable_endpoint(
    installer_module, monkeypatch: pytest.MonkeyPatch
):
    seen: list[str] = []

    def fetch(url, **_kwargs):
        seen.append(url)
        return {
            "tag_name": "v1.2.3",
            "assets": [
                {
                    "name": "Decky-SteamAchievements.zip",
                    "state": "uploaded",
                    "digest": f"sha256:{'a' * 64}",
                    "url": "https://api.github.com/assets/1",
                    "browser_download_url": "https://github.com/download/plugin.zip",
                }
            ],
        }

    monkeypatch.setattr(installer_module, "fetch_json", fetch)
    resolved = installer_module.resolve_github_source(
        installer_module.DISTRIBUTION_PLUGIN_URL,
        explicit_asset=installer_module.DISTRIBUTION_ASSET,
        release_tag=None,
        include_prerelease=False,
        supplied_sha256=None,
        allow_http=False,
    )

    assert seen == [
        "https://api.github.com/repos/beallio/Decky-SteamAchievements/releases/latest"
    ]
    assert resolved.release_tag == "v1.2.3"
    assert resolved.expected_sha256 == "a" * 64


def test_existing_plugin_is_selected_by_current_or_legacy_manifest_identity(
    installer_module, tmp_path: Path
):
    old_directory = tmp_path / "old-display-directory"
    old_directory.mkdir()
    (old_directory / "plugin.json").write_text(
        json.dumps({"name": "Achievements Restored"}), encoding="utf-8"
    )
    unrelated = tmp_path / "Decky-SteamAchievements"
    unrelated.mkdir()
    (unrelated / "plugin.json").write_text(
        json.dumps({"name": "DifferentPlugin"}), encoding="utf-8"
    )

    package = installer_module.PluginPackage(
        folder="Decky-SteamAchievements",
        name="Deck UI Restored",
        root_plugin=False,
        staged_path=tmp_path / "stage",
        remote_binaries=(),
    )
    aliases = installer_module.identity_aliases(package)

    assert aliases == ("Achievements Restored", "Decky-SteamAchievements")
    assert installer_module.find_existing_plugin(
        tmp_path, package.name, aliases
    ) == old_directory


def test_plugin_order_migrates_legacy_name_without_duplicate(
    installer_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    settings_file = tmp_path / "loader.json"
    settings_file.write_text(
        json.dumps(
            {
                "pluginOrder": [
                    "CheatDeck",
                    "Decky-SteamAchievements",
                    "Achievements Restored",
                    "Deck UI Restored",
                    "Storage Cleaner",
                ]
            }
        ),
        encoding="utf-8",
    )
    written: dict[str, object] = {}
    monkeypatch.setattr(
        installer_module,
        "stat_maybe_sudo",
        lambda _path: (0o600, 1000, 1000),
    )

    def capture(source, _destination, **_kwargs):
        written.update(json.loads(source.read_text(encoding="utf-8")))

    monkeypatch.setattr(installer_module, "atomic_privileged_replace", capture)

    installer_module.update_plugin_order(
        settings_file,
        "Deck UI Restored",
        tmp_path,
        ("Achievements Restored", "Decky-SteamAchievements"),
    )

    assert written["pluginOrder"] == [
        "CheatDeck",
        "Deck UI Restored",
        "Storage Cleaner",
    ]


def test_rollback_restores_plugin_settings_and_service(
    installer_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        installer_module,
        "run_command",
        lambda command, **_kwargs: calls.append(tuple(map(str, command))),
    )
    monkeypatch.setattr(installer_module, "command_succeeds", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(installer_module, "warn", lambda _message: None)
    transaction = installer_module.InstallTransaction(
        plugin_root=tmp_path / "plugins",
        settings_file=tmp_path / "settings" / "loader.json",
        service_was_active=True,
        existing_path=tmp_path / "plugins" / "old",
        backup_path=tmp_path / "backups" / "old",
        target_path=tmp_path / "plugins" / "Decky-SteamAchievements",
        target_stage=tmp_path / "plugins" / ".stage",
        settings_backup=tmp_path / "work" / "loader.json.before",
        settings_existed=True,
        filesystem_changed=True,
        service_stopped=True,
    )

    installer_module.rollback(transaction)

    assert ("mv", "--", str(transaction.backup_path), str(transaction.existing_path)) in calls
    assert (
        "cp",
        "-a",
        "--",
        str(transaction.settings_backup),
        str(transaction.settings_file),
    ) in calls
    assert ("systemctl", "start", installer_module.SERVICE_NAME) in calls


def test_privileged_helper_rejects_writable_plan_before_install(
    installer_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    plan = tmp_path / "plan.json"
    plan.write_text("{}", encoding="utf-8")
    plan.chmod(0o666)
    monkeypatch.setattr(installer_module.os, "geteuid", lambda: 0)
    install = Mock()
    monkeypatch.setattr(installer_module, "perform_install", install)

    assert installer_module.privileged_helper(plan) == 1
    install.assert_not_called()
