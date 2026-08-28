"""Decky-SteamAchievements backend lifecycle, settings, and updater RPCs."""

from __future__ import annotations

import asyncio
import contextvars
import functools
import json
import logging
import os
import threading
from concurrent.futures import Executor
from pathlib import Path
from typing import Any, Callable, Literal, cast

import decky  # injected by decky-loader at runtime

from backend.rpc_pool import DaemonThreadPool
from backend.runtime_state import RuntimeStateStore, StateLockTimeoutError
from backend.updater.client import GitHubReleaseClient
from backend.updater.service import PluginUpdater

UpdateChannel = Literal["stable", "development"]
Settings = dict[str, object]

DEFAULT_SETTINGS: Settings = {
    "feature_enabled": True,
    "home_carousel_fix_enabled": False,
    "debug_logging": False,
    "update_channel": "stable",
    "automatic_update_checks": True,
}


def _normalize_settings(value: Any) -> Settings:
    data = value if isinstance(value, dict) else {}
    channel = data.get("update_channel")
    return {
        "feature_enabled": (
            data["feature_enabled"]
            if isinstance(data.get("feature_enabled"), bool)
            else True
        ),
        "home_carousel_fix_enabled": (
            data["home_carousel_fix_enabled"]
            if isinstance(data.get("home_carousel_fix_enabled"), bool)
            else False
        ),
        "debug_logging": (
            data["debug_logging"]
            if isinstance(data.get("debug_logging"), bool)
            else False
        ),
        "update_channel": channel if channel in ("stable", "development") else "stable",
        "automatic_update_checks": (
            data["automatic_update_checks"]
            if isinstance(data.get("automatic_update_checks"), bool)
            else True
        ),
    }


def _read_settings(path: Path) -> Settings:
    try:
        return _normalize_settings(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return dict(DEFAULT_SETTINGS)


def _write_settings(path: Path, settings: Settings) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            f"{json.dumps(_normalize_settings(settings), indent=2)}\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _read_version_file(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        value = data.get("version") if isinstance(data, dict) else None
        return value.strip() if isinstance(value, str) else ""
    except (OSError, ValueError, TypeError):
        return ""


def _resolve_plugin_version(root: Path | None = None) -> str:
    plugin_root = root or Path(__file__).resolve().parent
    for filename in ("plugin.json", "package.json"):
        version = _read_version_file(plugin_root / filename)
        if version:
            return version
    return ""


def _resolve_decky_version() -> str:
    value = getattr(decky, "DECKY_VERSION", None)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return os.environ.get("DECKY_VERSION", "").strip()


def _parse_os_release_field(text: str, key: str) -> str:
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        if name.strip() != key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value.strip()
    return ""


def _read_steamos_version(path: Path = Path("/etc/os-release")) -> str:
    try:
        return _parse_os_release_field(
            path.read_text(encoding="utf-8", errors="replace"), "VERSION_ID"
        )
    except OSError:
        return ""


async def _run_blocking(executor: Executor, callback: Callable[[], Any]) -> Any:
    loop = asyncio.get_running_loop()
    context = contextvars.copy_context()
    try:
        return await loop.run_in_executor(
            executor, functools.partial(context.run, callback)
        )
    except asyncio.CancelledError:
        decky.logger.warning(
            "Decky-SteamAchievements operation cancelled while worker may still be running"
        )
        raise


class Plugin:
    def __init__(self) -> None:
        settings_dir = Path(str(getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", ".")))
        runtime_dir_value = getattr(
            decky, "DECKY_PLUGIN_RUNTIME_DIR", settings_dir / "runtime"
        )
        runtime_dir = Path(str(runtime_dir_value))
        self._settings_path = settings_dir / "settings.json"
        self._settings_lock = threading.RLock()
        self._state_lock = threading.RLock()
        self._runtime_state = RuntimeStateStore(runtime_dir / "updater-state.json")
        self._executor = DaemonThreadPool(
            max_workers=4, thread_name_prefix="achievements-updater"
        )
        self._updater = PluginUpdater(
            state_lock=self._state_lock,
            save_callback=self._save_updater_state,
            log_callback=self._updater_log,
            release_client=GitHubReleaseClient(
                owner="beallio", repo="Deck-UI-Restored"
            ),
            version_resolver=_resolve_plugin_version,
            now=lambda: __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ),
            monotonic=__import__("time").monotonic,
        )
        self._load_updater_state()

    def _load_updater_state(self) -> None:
        settings = self._load_settings()
        try:
            runtime = self._runtime_state.load()
        except StateLockTimeoutError as exc:
            decky.logger.warning("Updater state load skipped: %s", exc)
            runtime = {"update_check_cache": {}}
        self._updater.load_state(settings, runtime)

    def _save_updater_state(self) -> None:
        # Lock order is invariant: in-process updater lock, then file lock.
        with self._state_lock:
            with self._runtime_state.locked():
                with self._settings_lock:
                    settings = _read_settings(self._settings_path)
                    settings.update(self._updater.settings_payload())
                    _write_settings(self._settings_path, settings)
                self._runtime_state._save_locked(self._updater.cache_payload())

    def _reconcile_pending_update_install(self) -> None:
        with self._state_lock:
            with self._runtime_state.locked():
                fresh = self._runtime_state._load_locked()
                self._updater.adopt_persisted_cache(fresh)
                self._updater.reconcile_pending_install(_resolve_plugin_version())

    def _updater_log(self, level: str, message: str) -> None:
        logger = decky.logger
        log_method = getattr(logger, level, logger.info)
        log_method("Decky-SteamAchievements updater: %s", message)

    async def _call(self, operation: str, callback: Callable[[], Any]) -> Any:
        try:
            return await _run_blocking(self._executor, callback)
        except asyncio.CancelledError:
            raise
        except (SystemExit, KeyboardInterrupt):
            raise
        except Exception as exc:
            decky.logger.exception("%s failed", operation)
            return {"status": "failed", "message": str(exc)}
        except BaseException as exc:
            decky.logger.exception("%s failed", operation)
            return {"status": "failed", "message": str(exc)}

    def _load_settings(self) -> Settings:
        with self._settings_lock:
            return _read_settings(self._settings_path)

    def _save_setting(self, key: str, value: object) -> Settings:
        # Keep the cross-process order aligned with _save_updater_state:
        # runtime-state file lock, then the instance-local settings lock.
        with self._runtime_state.locked():
            with self._settings_lock:
                settings = _read_settings(self._settings_path)
                settings[key] = value
                _write_settings(self._settings_path, settings)
                return settings

    @staticmethod
    def _apply_debug_logging(enabled: bool) -> None:
        decky.logger.setLevel(logging.DEBUG if enabled else logging.INFO)

    async def _main(self) -> None:
        self._load_updater_state()
        settings = self._load_settings()
        self._apply_debug_logging(cast(bool, settings["debug_logging"]))
        result = await self._call(
            "reconcile_pending_update_install",
            self._reconcile_pending_update_install,
        )
        if isinstance(result, dict) and result.get("status") == "failed":
            decky.logger.error("Updater reconciliation failed: %s", result.get("message"))
        decky.logger.info("Decky-SteamAchievements: backend started")

    async def _unload(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        decky.logger.info("Decky-SteamAchievements: backend unloaded")

    async def _uninstall(self) -> None:
        decky.logger.info("Decky-SteamAchievements: uninstalled")

    async def get_settings(self) -> Settings:
        settings = self._load_settings()
        self._apply_debug_logging(cast(bool, settings["debug_logging"]))
        return settings

    async def set_feature_enabled(self, enabled: bool) -> Settings:
        if not isinstance(enabled, bool):
            raise TypeError("feature_enabled must be a boolean")
        return self._save_setting("feature_enabled", enabled)

    async def set_home_carousel_fix_enabled(self, enabled: bool) -> Settings:
        if not isinstance(enabled, bool):
            raise TypeError("home_carousel_fix_enabled must be a boolean")
        return self._save_setting("home_carousel_fix_enabled", enabled)

    async def set_debug_logging(self, enabled: bool) -> Settings:
        if not isinstance(enabled, bool):
            raise TypeError("debug_logging must be a boolean")
        settings = self._save_setting("debug_logging", enabled)
        self._apply_debug_logging(cast(bool, settings["debug_logging"]))
        return settings

    async def set_update_channel(self, channel: str) -> Any:
        def operation() -> Settings:
            self._updater.set_channel(channel)
            return self._load_settings()

        return await self._call("set_update_channel", operation)

    async def set_automatic_update_checks(self, enabled: bool) -> Any:
        if not isinstance(enabled, bool):
            raise TypeError("automatic_update_checks must be a boolean")

        def operation() -> Settings:
            self._updater.set_automatic_checks(enabled)
            return self._load_settings()

        return await self._call("set_automatic_update_checks", operation)

    async def get_update_check_context(self) -> Any:
        return await self._call("get_update_check_context", self._updater.get_context)

    async def check_for_plugin_update(
        self, current_version: str, force: bool = False
    ) -> Any:
        return await self._call(
            "check_for_plugin_update",
            lambda: self._updater.check_for_update(current_version, force),
        )

    async def revalidate_plugin_update(self, candidate: dict[str, Any]) -> Any:
        return await self._call(
            "revalidate_plugin_update", lambda: self._updater.revalidate(candidate)
        )

    async def record_update_install_requested(
        self, candidate: dict[str, Any]
    ) -> Any:
        return await self._call(
            "record_update_install_requested",
            lambda: self._updater.record_install_requested(candidate),
        )

    async def confirm_update_install_handoff(self, version: str) -> Any:
        return await self._call(
            "confirm_update_install_handoff",
            lambda: self._updater.confirm_install_handoff(version),
        )

    async def clear_pending_update_install(self, version: str | None = None) -> Any:
        return await self._call(
            "clear_pending_update_install",
            lambda: self._updater.clear_pending_install(version),
        )

    async def mark_update_notified(self, tag: str) -> Any:
        return await self._call(
            "mark_update_notified", lambda: self._updater.mark_notified(tag)
        )

    async def get_versions(self) -> dict[str, str]:
        return {
            "plugin": _resolve_plugin_version(),
            "decky": _resolve_decky_version(),
            "steamos": _read_steamos_version(),
        }
