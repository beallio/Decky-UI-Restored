from __future__ import annotations

import importlib.util
import asyncio
import json
import logging
import sys
import threading
import types
from pathlib import Path

import pytest


@pytest.fixture()
def plugin_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    logger = logging.getLogger(f"decky-steamachievements-test-{id(tmp_path)}")
    logger.setLevel(logging.INFO)
    decky = types.SimpleNamespace(
        logger=logger,
        DECKY_PLUGIN_SETTINGS_DIR=str(tmp_path / "settings"),
        DECKY_PLUGIN_RUNTIME_DIR=str(tmp_path / "runtime"),
        DECKY_VERSION="v3.2.6",
    )
    monkeypatch.setitem(sys.modules, "decky", decky)
    spec = importlib.util.spec_from_file_location(
        f"decky_steamachievements_main_{id(tmp_path)}",
        Path(__file__).parents[1] / "main.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, decky


def test_settings_defaults_and_persistence(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    plugin = module.Plugin()

    assert asyncio.run(plugin.get_settings()) == {
        "feature_enabled": True,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": False,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }

    assert asyncio.run(plugin.set_feature_enabled(False)) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": False,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }
    assert asyncio.run(plugin.set_home_carousel_fix_enabled(True)) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": True,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": False,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }
    assert asyncio.run(plugin.set_debug_logging(True)) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": True,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": True,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }

    path = tmp_path / "settings" / "settings.json"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": True,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": True,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }
    assert list(path.parent.glob("*.tmp")) == []


def test_settings_recover_from_malformed_and_invalid_values(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    path = tmp_path / "settings" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text('{"feature_enabled": "yes", "debug_logging": 1}', encoding="utf-8")

    assert asyncio.run(module.Plugin().get_settings()) == {
        "feature_enabled": True,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": False,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }
    path.write_text("not json", encoding="utf-8")
    assert asyncio.run(module.Plugin().get_settings()) == {
        "feature_enabled": True,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": False,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }


def test_old_settings_migrate_on_next_mutation_without_reset(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    path = tmp_path / "settings" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        '{"feature_enabled": false, "debug_logging": true}', encoding="utf-8"
    )

    plugin = module.Plugin()
    assert asyncio.run(plugin.get_settings()) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": True,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "feature_enabled": False,
        "debug_logging": True,
    }

    asyncio.run(plugin.set_update_channel("development"))
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": True,
        "update_channel": "development",
        "automatic_update_checks": True,
    }


def test_independent_settings_holders_preserve_overlapping_mutations(
    plugin_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module, _decky = plugin_module
    first = module.Plugin()
    second = module.Plugin()
    first_has_read = threading.Event()
    release_first = threading.Event()
    second_has_read = threading.Event()
    failures: list[BaseException] = []
    real_read_settings = module._read_settings

    def controlled_read(path: Path):
        settings = real_read_settings(path)
        if threading.current_thread().name == "first-settings-holder":
            first_has_read.set()
            if not release_first.wait(timeout=1):
                raise TimeoutError("first settings holder was not released")
        elif threading.current_thread().name == "second-settings-holder":
            second_has_read.set()
        return settings

    monkeypatch.setattr(module, "_read_settings", controlled_read)

    def mutate(plugin, key: str, value: object) -> None:
        try:
            plugin._save_setting(key, value)
        except BaseException as exc:
            failures.append(exc)

    first_thread = threading.Thread(
        name="first-settings-holder",
        target=mutate,
        args=(first, "feature_enabled", False),
    )
    second_thread = threading.Thread(
        name="second-settings-holder",
        target=mutate,
        args=(second, "update_channel", "development"),
    )
    first_thread.start()
    assert first_has_read.wait(timeout=1)
    second_thread.start()

    assert not second_has_read.wait(timeout=0.1)
    release_first.set()
    first_thread.join(timeout=1)
    second_thread.join(timeout=1)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert failures == []
    assert second_has_read.is_set()
    assert json.loads(
        (tmp_path / "settings" / "settings.json").read_text(encoding="utf-8")
    ) == {
        "feature_enabled": False,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": False,
        "debug_logging": False,
        "update_channel": "development",
        "automatic_update_checks": True,
    }


def test_invalid_updater_settings_normalize_to_defaults(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    path = tmp_path / "settings" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        '{"update_channel": "nightly", "automatic_update_checks": 1}',
        encoding="utf-8",
    )
    settings = asyncio.run(module.Plugin().get_settings())
    assert settings["update_channel"] == "stable"
    assert settings["automatic_update_checks"] is True


def test_home_carousel_fix_rejects_non_boolean_values(plugin_module):
    module, _decky = plugin_module
    plugin = module.Plugin()

    with pytest.raises(TypeError, match="home_carousel_fix_enabled must be a boolean"):
        asyncio.run(plugin.set_home_carousel_fix_enabled("true"))


def test_keyboard_chord_fix_persists_and_rejects_non_boolean_values(
    plugin_module, tmp_path: Path
):
    module, _decky = plugin_module
    plugin = module.Plugin()

    assert asyncio.run(plugin.set_keyboard_chord_fix_enabled(True)) == {
        "feature_enabled": True,
        "home_carousel_fix_enabled": False,
        "keyboard_chord_fix_enabled": True,
        "debug_logging": False,
        "update_channel": "stable",
        "automatic_update_checks": True,
    }
    path = tmp_path / "settings" / "settings.json"
    assert (
        json.loads(path.read_text(encoding="utf-8"))["keyboard_chord_fix_enabled"]
        is True
    )

    with pytest.raises(
        TypeError, match="keyboard_chord_fix_enabled must be a boolean"
    ):
        asyncio.run(plugin.set_keyboard_chord_fix_enabled("true"))


def test_update_rpcs_persist_separate_runtime_state(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    plugin = module.Plugin()
    asyncio.run(plugin._main())

    assert asyncio.run(plugin.set_automatic_update_checks(False))[
        "automatic_update_checks"
    ] is False
    context = asyncio.run(plugin.record_update_install_requested({
        "version": "0.2.0",
        "tag": "v0.2.0",
        "channel": "stable",
        "published_at": "2026-07-28T00:00:00+00:00",
    }))
    assert context["pending_update_install"]["version"] == "0.2.0"

    settings = json.loads((tmp_path / "settings" / "settings.json").read_text())
    runtime = json.loads((tmp_path / "runtime" / "updater-state.json").read_text())
    assert "update_check_cache" not in settings
    assert runtime["update_check_cache"]["pending_update_install"]["tag"] == "v0.2.0"
    assert list((tmp_path / "runtime").glob("*.tmp")) == []
    asyncio.run(plugin._unload())


def test_update_rpc_failure_is_structured_and_offloaded(plugin_module, monkeypatch):
    module, _decky = plugin_module
    plugin = module.Plugin()
    caller_thread = __import__("threading").get_ident()
    worker_threads: list[int] = []

    def fail(*_args):
        worker_threads.append(__import__("threading").get_ident())
        raise RuntimeError("boom")

    monkeypatch.setattr(plugin._updater, "check_for_update", fail)
    result = asyncio.run(plugin.check_for_plugin_update("0.1.0", True))
    assert result == {"status": "failed", "message": "boom"}
    assert worker_threads and worker_threads[0] != caller_thread
    asyncio.run(plugin._unload())


def test_startup_reconciles_matching_pending_once(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    installed_version = module._resolve_plugin_version()
    runtime_path = tmp_path / "runtime" / "updater-state.json"
    runtime_path.parent.mkdir(parents=True)
    runtime_path.write_text(json.dumps({
        "update_check_cache": {
            "pending_update_install": {
                "version": installed_version,
                "tag": f"v{installed_version}",
                "channel": "stable",
                "published_at": "2026-07-28T00:00:00+00:00",
                "requested_at": "2026-07-28T00:00:00+00:00",
            }
        }
    }))

    first = module.Plugin()
    asyncio.run(first._main())
    asyncio.run(first._unload())
    second = module.Plugin()
    asyncio.run(second._main())
    asyncio.run(second._unload())

    state = json.loads(runtime_path.read_text())
    cache = state["update_check_cache"]
    assert "pending_update_install" not in cache
    assert cache["installed_release_tag"] == f"v{installed_version}"


def test_unload_shuts_down_executor_without_waiting(plugin_module, monkeypatch):
    module, _decky = plugin_module
    plugin = module.Plugin()
    calls = []
    monkeypatch.setattr(
        plugin._executor,
        "shutdown",
        lambda *, wait, cancel_futures: calls.append((wait, cancel_futures)),
    )
    asyncio.run(plugin._unload())
    assert calls == [(False, True)]


def test_debug_setting_applies_backend_log_level(plugin_module):
    module, decky = plugin_module
    plugin = module.Plugin()

    asyncio.run(plugin.set_debug_logging(True))
    assert decky.logger.level == logging.DEBUG
    asyncio.run(plugin.set_debug_logging(False))
    assert decky.logger.level == logging.INFO


def test_os_release_parsing(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    release = tmp_path / "os-release"
    release.write_text('NAME="SteamOS"\nVERSION_ID="3.8.1"\n', encoding="utf-8")
    assert module._read_steamos_version(release) == "3.8.1"
    release.write_text("VERSION_ID=3.9\n", encoding="utf-8")
    assert module._read_steamos_version(release) == "3.9"
    release.write_text("NAME=SteamOS\n", encoding="utf-8")
    assert module._read_steamos_version(release) == ""


def test_decky_version_precedence(plugin_module, monkeypatch: pytest.MonkeyPatch):
    module, decky = plugin_module
    monkeypatch.setenv("DECKY_VERSION", "env-version")
    assert module._resolve_decky_version() == "v3.2.6"
    decky.DECKY_VERSION = ""
    assert module._resolve_decky_version() == "env-version"


def test_manifest_version_precedence_and_fallback(plugin_module, tmp_path: Path):
    module, _decky = plugin_module
    root = tmp_path / "plugin"
    root.mkdir()
    (root / "plugin.json").write_text('{"version":"1.2.3+abc"}', encoding="utf-8")
    (root / "package.json").write_text('{"version":"9.9.9"}', encoding="utf-8")
    assert module._resolve_plugin_version(root) == "1.2.3+abc"
    (root / "plugin.json").write_text("{}", encoding="utf-8")
    assert module._resolve_plugin_version(root) == "9.9.9"


def test_get_versions_is_total(plugin_module, monkeypatch: pytest.MonkeyPatch):
    module, _decky = plugin_module
    monkeypatch.setattr(module, "_resolve_plugin_version", lambda: "0.1.0+abc")
    monkeypatch.setattr(module, "_resolve_decky_version", lambda: "v3.2.6")
    monkeypatch.setattr(module, "_read_steamos_version", lambda: "3.8.1")
    assert asyncio.run(module.Plugin().get_versions()) == {
        "plugin": "0.1.0+abc",
        "decky": "v3.2.6",
        "steamos": "3.8.1",
    }
