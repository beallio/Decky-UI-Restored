#!/usr/bin/env python3
"""Install or update a Decky Loader plugin on SteamOS.

This is a direct filesystem installer. It does not call Decky's WebSocket
installer, display Decky's in-game confirmation prompt, or increment Decky
store installation statistics.

Run this program as the normal SteamOS desktop user. In command-line mode it
uses ``sudo`` only for privileged operations. In GUI mode it invokes one
``pkexec`` helper process so KDE/Polkit can display a graphical authentication
dialog without opening a terminal.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import pwd
import grp
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Mapping, NoReturn, Sequence

# ---------------------------------------------------------------------------
# Distribution configuration
# ---------------------------------------------------------------------------
# Set this to a GitHub repository URL to let users install the selected plugin
# simply by running:
#
#     python3 install_decky_plugin.py
#
# A command-line source, when provided, overrides this value.
DISTRIBUTION_PLUGIN_URL = "https://github.com/beallio/Decky-SteamAchievements"

# Optional distribution defaults. Leave these empty/False to use the latest
# stable release and require the normal confirmation prompt.
DISTRIBUTION_ASSET = "Decky-SteamAchievements.zip"
DISTRIBUTION_FOLDER = "Decky-SteamAchievements"
DISTRIBUTION_PLUGIN_NAME = "Deck UI Restored"
DISTRIBUTION_LEGACY_PLUGIN_NAMES = (
    "Achievements Restored",
    "Decky-SteamAchievements",
)
DISTRIBUTION_RELEASE_TAG = ""
DISTRIBUTION_INCLUDE_PRERELEASE = False
DISTRIBUTION_EXPECTED_SHA256 = ""
DISTRIBUTION_ASSUME_YES = False

# ---------------------------------------------------------------------------
# Installer constants
# ---------------------------------------------------------------------------
SERVICE_NAME = "plugin_loader.service"
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10_000
MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 60
DOWNLOAD_RETRIES = 3
HEALTH_CHECK_DELAY_SECONDS = 4
GITHUB_API_ROOT = "https://api.github.com"
USER_AGENT = "decky-plugin-direct-installer/1.0"
SAFE_PLUGIN_FOLDER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GITHUB_DIGEST_RE = re.compile(r"^sha256:([0-9a-fA-F]{64})$")

GUI_ENABLED = False
GUI_LOG_PATH: Path | None = None


class InstallerError(RuntimeError):
    """Expected installer failure with a user-facing message."""


class InstallerCancelled(InstallerError):
    """The user cancelled installation or authorization."""


@dataclass(frozen=True)
class RemoteBinary:
    name: str
    url: str
    sha256: str


@dataclass(frozen=True)
class PluginPackage:
    folder: str
    name: str
    root_plugin: bool
    staged_path: Path
    remote_binaries: tuple[RemoteBinary, ...]


@dataclass(frozen=True)
class ResolvedSource:
    package_url: str
    expected_sha256: str | None
    source_label: str
    release_tag: str | None = None
    asset_name: str | None = None
    request_headers: Mapping[str, str] = field(default_factory=dict)


@dataclass
class InstallTransaction:
    plugin_root: Path
    settings_file: Path
    service_was_active: bool
    existing_path: Path | None = None
    backup_path: Path | None = None
    target_path: Path | None = None
    target_stage: Path | None = None
    settings_backup: Path | None = None
    settings_existed: bool = False
    filesystem_changed: bool = False
    service_stopped: bool = False
    committed: bool = False


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject redirects to unsupported or downgraded URL schemes."""

    def __init__(self, allow_http: bool) -> None:
        super().__init__()
        self.allow_http = allow_http

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: BinaryIO,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> urllib.request.Request | None:
        validate_url(newurl, self.allow_http)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            old_host = urllib.parse.urlparse(req.full_url).hostname
            new_host = urllib.parse.urlparse(newurl).hostname
            if old_host != new_host:
                # Do not leak a GitHub token to the signed asset-download host.
                redirected.remove_header("Authorization")
        return redirected


def _write_log(level: str, message: str) -> None:
    if GUI_LOG_PATH is None:
        return
    try:
        GUI_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        timestamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        with GUI_LOG_PATH.open("a", encoding="utf-8") as log:
            log.write(f"{timestamp} [{level}] {message}\n")
    except OSError:
        pass


def info(message: str = "") -> None:
    print(message)
    _write_log("INFO", message)


def warn(message: str) -> None:
    print(f"Warning: {message}", file=sys.stderr)
    _write_log("WARNING", message)


def fail(message: str) -> NoReturn:
    raise InstallerError(message)


def run_kdialog(
    option: str, message: str, *, title: str = "Decky-SteamAchievements Installer"
) -> int:
    command = ["kdialog", option, message, "--title", title]
    try:
        return subprocess.run(command, check=False).returncode
    except FileNotFoundError:
        return 127


def gui_notice(message: str) -> None:
    if GUI_ENABLED:
        run_kdialog("--msgbox", message)


def gui_error(message: str) -> None:
    if GUI_ENABLED:
        run_kdialog("--error", message)


def gui_confirm(message: str) -> bool:
    if not GUI_ENABLED:
        return False
    return run_kdialog("--yesno", message) == 0


def gui_status(message: str, seconds: int = 4) -> None:
    if not GUI_ENABLED:
        return
    try:
        subprocess.Popen(
            [
                "kdialog",
                "--passivepopup",
                message,
                str(seconds),
                "--title",
                "Decky-SteamAchievements Installer",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        pass


def normalize_sha256(value: str, label: str = "SHA-256") -> str:
    digest = value.strip().lower()
    if not SHA256_RE.fullmatch(digest):
        fail(f"Invalid {label}: {value}")
    return digest


def require_executable(name: str) -> str:
    result = shutil.which(name)
    if result is None:
        fail(f"Required command not found: {name}")
    return result


def run_command(
    args: Sequence[str | os.PathLike[str]],
    *,
    sudo: bool = False,
    check: bool = True,
    capture: bool = False,
    quiet: bool = False,
) -> subprocess.CompletedProcess[str]:
    command = [os.fspath(item) for item in args]
    if sudo and os.geteuid() != 0:
        command = ["sudo", "--", *command]

    stdout: int | None = subprocess.PIPE if capture else None
    stderr: int | None = subprocess.PIPE if capture else None
    if quiet:
        stdout = subprocess.DEVNULL
        stderr = subprocess.DEVNULL

    try:
        return subprocess.run(
            command,
            check=check,
            text=True,
            stdout=stdout,
            stderr=stderr,
        )
    except FileNotFoundError as exc:
        fail(f"Required command not found: {command[0]}")
    except subprocess.CalledProcessError as exc:
        detail = ""
        if capture:
            combined = "\n".join(
                part.strip() for part in (exc.stdout or "", exc.stderr or "") if part.strip()
            )
            if combined:
                detail = f": {combined}"
        fail(f"Command failed ({exc.returncode}): {' '.join(command)}{detail}")


def command_succeeds(
    args: Sequence[str | os.PathLike[str]], *, sudo: bool = False
) -> bool:
    result = run_command(args, sudo=sudo, check=False, quiet=True)
    return result.returncode == 0


def validate_url(url: str, allow_http: bool) -> None:
    parsed = urllib.parse.urlparse(url)
    allowed = {"https"}
    if allow_http:
        allowed.add("http")
    if parsed.scheme.lower() not in allowed or not parsed.netloc:
        if allow_http:
            fail(f"Only HTTP(S) URLs are supported: {url}")
        fail(f"HTTPS is required. Use --allow-http only if you accept the risk: {url}")


def build_opener(allow_http: bool) -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(SafeRedirectHandler(allow_http))


def request_headers(
    *, token: str | None = None, accept: str = "application/vnd.github+json"
) -> dict[str, str]:
    headers = {
        "Accept": accept,
        "User-Agent": USER_AGENT,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def urlopen_checked(
    url: str,
    *,
    allow_http: bool,
    headers: Mapping[str, str] | None = None,
    timeout: int = DOWNLOAD_TIMEOUT_SECONDS,
) -> Any:
    validate_url(url, allow_http)
    request = urllib.request.Request(url, headers=dict(headers or {}))
    opener = build_opener(allow_http)
    try:
        return opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        message = f"HTTP {exc.code} while requesting {url}"
        if exc.code == 403 and "api.github.com" in url:
            remaining = exc.headers.get("X-RateLimit-Remaining")
            if remaining == "0":
                message += "; GitHub API rate limit exhausted. Set GITHUB_TOKEN and retry"
        with contextlib.suppress(Exception):
            payload = exc.read(4096).decode("utf-8", "replace").strip()
            if payload:
                message += f": {payload}"
        fail(message)
    except urllib.error.URLError as exc:
        fail(f"Network error while requesting {url}: {exc.reason}")
    except TimeoutError:
        fail(f"Request timed out: {url}")


def fetch_json(
    url: str,
    *,
    allow_http: bool,
    token: str | None,
) -> Any:
    with urlopen_checked(
        url,
        allow_http=allow_http,
        headers=request_headers(token=token),
    ) as response:
        try:
            return json.load(response)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            fail(f"Invalid JSON response from {url}: {exc}")


def download_file(
    url: str,
    destination: Path,
    *,
    allow_http: bool,
    headers: Mapping[str, str] | None = None,
    expected_sha256: str | None = None,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
) -> tuple[str, int]:
    """Download a file with retries, size enforcement, and streaming hashing."""

    last_error: InstallerError | None = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        temporary = destination.with_name(f".{destination.name}.part-{os.getpid()}")
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()

        digest = hashlib.sha256()
        total = 0
        try:
            with urlopen_checked(
                url,
                allow_http=allow_http,
                headers=headers,
            ) as response:
                length_header = response.headers.get("Content-Length")
                if length_header:
                    with contextlib.suppress(ValueError):
                        declared_size = int(length_header)
                        if declared_size > max_bytes:
                            fail(
                                f"Download is too large ({declared_size} > {max_bytes} bytes): {url}"
                            )

                with temporary.open("xb") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_bytes:
                            fail(f"Download exceeded {max_bytes} bytes: {url}")
                        output.write(chunk)
                        digest.update(chunk)
                    output.flush()
                    os.fsync(output.fileno())

            actual = digest.hexdigest()
            if expected_sha256 and actual != expected_sha256:
                fail(
                    f"SHA-256 mismatch for {url}. Expected {expected_sha256}, received {actual}"
                )
            temporary.replace(destination)
            return actual, total
        except InstallerError as exc:
            last_error = exc
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
            # Integrity and policy failures should not be retried.
            if "SHA-256 mismatch" in str(exc) or "too large" in str(exc) or "exceeded" in str(exc):
                raise
            if attempt == DOWNLOAD_RETRIES:
                raise
            warn(f"Download attempt {attempt} failed; retrying: {exc}")
            time.sleep(attempt)

    assert last_error is not None
    raise last_error


def parse_github_repository_url(url: str) -> tuple[str, str] | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme.lower() != "https" or parsed.hostname not in {
        "github.com",
        "www.github.com",
    }:
        return None

    parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if len(parts) != 2 or parsed.query or parsed.fragment:
        return None

    owner, repository = parts
    if repository.endswith(".git"):
        repository = repository[:-4]
    safe_component = re.compile(r"^[A-Za-z0-9_.-]+$")
    if not safe_component.fullmatch(owner) or not safe_component.fullmatch(repository):
        fail("Unsafe GitHub owner or repository name")
    return owner, repository


def release_sort_key(release: Mapping[str, Any]) -> tuple[str, str]:
    return (
        str(release.get("published_at") or ""),
        str(release.get("created_at") or ""),
    )


def choose_release_asset(
    release: Mapping[str, Any], *, explicit_asset: str | None
) -> Mapping[str, Any]:
    raw_assets = release.get("assets", [])
    if not isinstance(raw_assets, list):
        fail("GitHub release response has an invalid assets field")

    uploaded = [
        asset
        for asset in raw_assets
        if isinstance(asset, dict)
        and asset.get("state") == "uploaded"
        and isinstance(asset.get("name"), str)
    ]

    if explicit_asset:
        matches = [asset for asset in uploaded if asset["name"] == explicit_asset]
        if not matches:
            names = ", ".join(sorted(asset["name"] for asset in uploaded)) or "none"
            fail(
                f"Release asset {explicit_asset!r} was not found. Uploaded assets: {names}"
            )
        if len(matches) != 1:
            fail(f"Release contains duplicate assets named {explicit_asset!r}")
        return matches[0]

    candidates = [asset for asset in uploaded if asset["name"].lower().endswith(".zip")]
    preferred = [
        asset
        for asset in candidates
        if not any(
            marker in asset["name"].lower()
            for marker in ("source", "debug", "symbols", "symbol")
        )
    ]
    if preferred:
        candidates = preferred

    if not candidates:
        fail("The selected GitHub release has no uploaded ZIP asset")
    if len(candidates) != 1:
        names = ", ".join(sorted(asset["name"] for asset in candidates))
        fail(
            f"Multiple possible ZIP assets were found: {names}. Select one with --asset"
        )
    return candidates[0]


def parse_github_asset_digest(asset: Mapping[str, Any]) -> str | None:
    value = asset.get("digest")
    if value is None:
        return None
    if not isinstance(value, str):
        fail("GitHub returned a non-string asset digest")
    match = GITHUB_DIGEST_RE.fullmatch(value)
    if not match:
        fail(f"Unsupported GitHub asset digest: {value!r}")
    return match.group(1).lower()


def resolve_github_source(
    source_url: str,
    *,
    explicit_asset: str | None,
    release_tag: str | None,
    include_prerelease: bool,
    supplied_sha256: str | None,
    allow_http: bool,
) -> ResolvedSource:
    repository = parse_github_repository_url(source_url)
    if repository is None:
        fail(f"Not a supported GitHub repository URL: {source_url}")
    owner, repo = repository
    token = os.environ.get("GITHUB_TOKEN") or None
    encoded_owner = urllib.parse.quote(owner, safe="")
    encoded_repo = urllib.parse.quote(repo, safe="")
    base = f"{GITHUB_API_ROOT}/repos/{encoded_owner}/{encoded_repo}/releases"

    if release_tag:
        encoded_tag = urllib.parse.quote(release_tag, safe="")
        release = fetch_json(
            f"{base}/tags/{encoded_tag}", allow_http=allow_http, token=token
        )
    elif include_prerelease:
        releases = fetch_json(
            f"{base}?per_page=100", allow_http=allow_http, token=token
        )
        if not isinstance(releases, list):
            fail("GitHub releases response was not a list")
        eligible = [
            item
            for item in releases
            if isinstance(item, dict)
            and not item.get("draft", False)
            and item.get("published_at")
        ]
        if not eligible:
            fail("The GitHub repository has no published releases")
        release = max(eligible, key=release_sort_key)
    else:
        release = fetch_json(f"{base}/latest", allow_http=allow_http, token=token)

    if not isinstance(release, dict):
        fail("GitHub release response was not an object")

    asset = choose_release_asset(release, explicit_asset=explicit_asset)
    asset_name = str(asset["name"])
    tag = str(release.get("tag_name") or "")
    asset_digest = parse_github_asset_digest(asset)

    if supplied_sha256 and asset_digest and supplied_sha256 != asset_digest:
        fail(
            "The supplied SHA-256 does not match GitHub's release-asset digest: "
            f"{supplied_sha256} != {asset_digest}"
        )
    expected = supplied_sha256 or asset_digest

    api_asset_url = asset.get("url")
    browser_url = asset.get("browser_download_url")
    if not isinstance(api_asset_url, str) or not api_asset_url:
        fail("GitHub release asset is missing its API download URL")
    if not isinstance(browser_url, str) or not browser_url:
        fail("GitHub release asset is missing its browser download URL")

    # The API asset URL supports authenticated private-repository downloads.
    headers = request_headers(token=token, accept="application/octet-stream")
    return ResolvedSource(
        package_url=api_asset_url,
        expected_sha256=expected,
        source_label=browser_url,
        release_tag=tag or None,
        asset_name=asset_name,
        request_headers=headers,
    )


def resolve_source(args: argparse.Namespace) -> ResolvedSource:
    supplied_hash = normalize_sha256(args.sha256) if args.sha256 else None
    repository = parse_github_repository_url(args.source)

    github_options_used = bool(args.asset or args.release_tag or args.prerelease)
    if repository:
        return resolve_github_source(
            args.source,
            explicit_asset=args.asset,
            release_tag=args.release_tag,
            include_prerelease=args.prerelease,
            supplied_sha256=supplied_hash,
            allow_http=args.allow_http,
        )

    if github_options_used:
        fail("--asset, --release-tag and --prerelease require a GitHub repository URL")
    validate_url(args.source, args.allow_http)
    return ResolvedSource(
        package_url=args.source,
        expected_sha256=supplied_hash,
        source_label=args.source,
    )


def zip_entry_mode(info: zipfile.ZipInfo) -> int:
    return (info.external_attr >> 16) & 0xFFFF


def validate_and_extract_package(archive: Path, extract_root: Path) -> PluginPackage:
    try:
        archive_zip = zipfile.ZipFile(archive)
    except (OSError, zipfile.BadZipFile) as exc:
        fail(f"Invalid plugin package: not a readable ZIP archive ({exc})")

    with archive_zip:
        infos = archive_zip.infolist()
        if not infos:
            fail("Invalid plugin package: archive is empty")
        if len(infos) > MAX_ARCHIVE_ENTRIES:
            fail(
                "Invalid plugin package: archive has too many entries "
                f"({len(infos)} > {MAX_ARCHIVE_ENTRIES})"
            )

        total_uncompressed = sum(item.file_size for item in infos)
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
            fail(
                "Invalid plugin package: expanded archive is too large "
                f"({total_uncompressed} > {MAX_UNCOMPRESSED_BYTES} bytes)"
            )

        normalized: list[tuple[zipfile.ZipInfo, tuple[str, ...], int]] = []
        seen: set[str] = set()
        top_levels: set[str] = set()
        plugin_json_candidates: list[tuple[str, ...]] = []

        for item in infos:
            raw_name = item.filename
            if "\x00" in raw_name:
                fail("Invalid plugin package: ZIP entry contains a NUL byte")
            if "\\" in raw_name:
                fail(f"Invalid plugin package: ZIP entry uses backslashes: {raw_name!r}")
            if raw_name.startswith("/"):
                fail(f"Invalid plugin package: absolute ZIP path: {raw_name!r}")

            pure_path = PurePosixPath(raw_name)
            parts = tuple(part for part in pure_path.parts if part not in ("", "."))
            if not parts:
                continue
            if any(part == ".." for part in parts):
                fail(f"Invalid plugin package: path traversal entry: {raw_name!r}")
            if ":" in parts[0]:
                fail(f"Invalid plugin package: drive-like ZIP path: {raw_name!r}")

            mode = zip_entry_mode(item)
            file_type = stat.S_IFMT(mode)
            if file_type == stat.S_IFLNK:
                fail(f"Invalid plugin package: symbolic-link entry: {raw_name!r}")
            if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                fail(f"Invalid plugin package: special-file entry: {raw_name!r}")

            canonical = "/".join(parts)
            if canonical in seen:
                fail(f"Invalid plugin package: duplicate ZIP entry: {canonical!r}")
            seen.add(canonical)
            top_levels.add(parts[0])
            if len(parts) == 2 and parts[1] == "plugin.json":
                plugin_json_candidates.append(parts)
            normalized.append((item, parts, mode))

        if len(top_levels) != 1:
            fail(
                "Invalid plugin package: all files must be inside exactly one top-level folder"
            )
        if len(plugin_json_candidates) != 1:
            fail(
                "Invalid plugin package: expected exactly one top-level "
                "PluginFolder/plugin.json"
            )

        plugin_folder = plugin_json_candidates[0][0]
        if not SAFE_PLUGIN_FOLDER.fullmatch(plugin_folder):
            fail(
                "Invalid plugin package: unsafe top-level plugin folder. Use letters, "
                "numbers, spaces, '.', '_' or '-', and do not start with punctuation"
            )

        extract_root.mkdir(parents=True, exist_ok=True)
        for item, parts, archived_mode in normalized:
            destination = extract_root.joinpath(*parts)
            try:
                if item.is_dir() or stat.S_IFMT(archived_mode) == stat.S_IFDIR:
                    destination.mkdir(parents=True, exist_ok=True)
                    destination.chmod(0o755)
                    continue

                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive_zip.open(item, "r") as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                destination.chmod(0o755 if archived_mode & 0o111 else 0o644)
            except (FileExistsError, NotADirectoryError, IsADirectoryError) as exc:
                fail(f"Invalid plugin package: conflicting ZIP paths near {item.filename!r}: {exc}")

    staged_path = extract_root / plugin_folder
    manifest_path = staged_path / "plugin.json"
    required = [manifest_path, staged_path / "main.py", staged_path / "dist" / "index.js"]
    for required_path in required:
        if not required_path.is_file():
            fail(
                "Invalid plugin package: required file is missing: "
                f"{required_path.relative_to(extract_root)}"
            )

    manifest = read_json_object(manifest_path, "plugin.json")
    plugin_name = manifest.get("name")
    if not isinstance(plugin_name, str) or not plugin_name.strip():
        fail("Invalid plugin package: plugin.json requires a non-empty string 'name'")
    plugin_name = plugin_name.strip()
    if len(plugin_name) > 200 or any(ord(char) < 32 for char in plugin_name):
        fail("Invalid plugin package: plugin name contains control characters or is too long")

    flags = manifest.get("flags", [])
    if flags is None:
        flags = []
    if not isinstance(flags, list) or not all(isinstance(flag, str) for flag in flags):
        fail("Invalid plugin package: plugin.json 'flags' must be an array of strings")

    remote_binaries = parse_remote_binaries(staged_path / "package.json")
    return PluginPackage(
        folder=plugin_folder,
        name=plugin_name,
        root_plugin="root" in flags,
        staged_path=staged_path,
        remote_binaries=tuple(remote_binaries),
    )


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"Invalid plugin package: {label} is invalid ({exc})")
    if not isinstance(value, dict):
        fail(f"Invalid plugin package: {label} must contain a JSON object")
    return value


def parse_remote_binaries(package_path: Path) -> list[RemoteBinary]:
    if not package_path.exists():
        return []
    package = read_json_object(package_path, "package.json")
    declared = package.get("remote_binary", [])
    if declared is None:
        declared = []
    if not isinstance(declared, list):
        fail("Invalid plugin package: package.json 'remote_binary' must be an array")

    binaries: list[RemoteBinary] = []
    seen_names: set[str] = set()
    for index, item in enumerate(declared):
        if not isinstance(item, dict):
            fail(f"Invalid plugin package: remote_binary[{index}] must be an object")
        name = item.get("name")
        url = item.get("url")
        digest = item.get("sha256hash")
        if not all(isinstance(value, str) for value in (name, url, digest)):
            fail(
                f"Invalid plugin package: remote_binary[{index}] requires string "
                "name, url and sha256hash"
            )
        assert isinstance(name, str) and isinstance(url, str) and isinstance(digest, str)
        if (
            not name
            or name in {".", ".."}
            or "/" in name
            or "\\" in name
            or any(ord(char) < 32 for char in name)
        ):
            fail(f"Invalid plugin package: remote_binary[{index}] has an unsafe name")
        if name in seen_names:
            fail(f"Invalid plugin package: duplicate remote binary name: {name!r}")
        seen_names.add(name)
        validate_url(url, allow_http=True)  # Actual HTTP policy is enforced at download time.
        binaries.append(
            RemoteBinary(name=name, url=url, sha256=normalize_sha256(digest, "remote binary SHA-256"))
        )
    return binaries


def install_remote_binaries(
    package: PluginPackage,
    *,
    allow_http: bool,
) -> None:
    if not package.remote_binaries:
        return

    info(f"Downloading {len(package.remote_binaries)} declared remote binary/binaries...")
    binary_directory = package.staged_path / "bin"
    binary_directory.mkdir(parents=True, exist_ok=True)

    for binary in package.remote_binaries:
        info(f"  - {binary.name}")
        destination = binary_directory / binary.name
        download_file(
            binary.url,
            destination,
            allow_http=allow_http,
            expected_sha256=binary.sha256,
        )
        destination.chmod(0o755)


def identity_aliases(package: PluginPackage) -> tuple[str, ...]:
    if package.folder == DISTRIBUTION_FOLDER and package.name == DISTRIBUTION_PLUGIN_NAME:
        return DISTRIBUTION_LEGACY_PLUGIN_NAMES
    return ()


def find_existing_plugin(
    plugin_root: Path,
    plugin_name: str,
    aliases: Sequence[str] = (),
) -> Path | None:
    matches: list[Path] = []
    accepted_names = {plugin_name, *aliases}
    try:
        children = list(plugin_root.iterdir())
    except OSError as exc:
        fail(f"Cannot scan Decky plugin directory {plugin_root}: {exc}")

    for child in children:
        manifest = child / "plugin.json"
        if not child.is_dir() or not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("name") in accepted_names:
            matches.append(child)

    if len(matches) > 1:
        fail(
            "Multiple installed plugin directories use the same manifest name: "
            + ", ".join(str(path) for path in matches)
        )
    return matches[0] if matches else None


def read_file_maybe_sudo(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except PermissionError:
        result = run_command(["cat", path], sudo=True, capture=True)
        return result.stdout.encode("utf-8")


def stat_maybe_sudo(path: Path) -> tuple[int, int, int]:
    try:
        value = path.stat()
        return stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid
    except PermissionError:
        result = run_command(
            ["stat", "-c", "%a:%u:%g", path], sudo=True, capture=True
        )
        try:
            mode_text, uid_text, gid_text = result.stdout.strip().split(":", 2)
            return int(mode_text, 8), int(uid_text), int(gid_text)
        except (ValueError, TypeError) as exc:
            fail(f"Could not parse metadata for {path}: {exc}")


def atomic_privileged_replace(
    source: Path,
    destination: Path,
    *,
    mode: int,
    uid: int,
    gid: int,
) -> None:
    temporary = destination.with_name(f".{destination.name}.new-{os.getpid()}")
    run_command(["rm", "-f", temporary], sudo=True)
    run_command(["cp", "--", source, temporary], sudo=True)
    run_command(["chown", f"{uid}:{gid}", temporary], sudo=True)
    run_command(["chmod", f"{mode:o}", temporary], sudo=True)
    run_command(["mv", "-f", "--", temporary, destination], sudo=True)


def update_plugin_order(
    settings_file: Path,
    plugin_name: str,
    work_dir: Path,
    aliases: Sequence[str] = (),
) -> None:
    if not settings_file.exists():
        return

    raw = read_file_maybe_sudo(settings_file)
    try:
        settings = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"Cannot update Decky settings: {exc}")
    if not isinstance(settings, dict):
        fail("Cannot update Decky settings: root JSON value is not an object")

    order = settings.get("pluginOrder", [])
    if order is None:
        order = []
    if not isinstance(order, list) or not all(isinstance(item, str) for item in order):
        fail("Cannot update Decky settings: pluginOrder is not a string array")
    accepted_names = {plugin_name, *aliases}
    migrated_order: list[str] = []
    inserted = False
    for item in order:
        if item in accepted_names:
            if not inserted:
                migrated_order.append(plugin_name)
                inserted = True
        else:
            migrated_order.append(item)
    if not inserted:
        migrated_order.append(plugin_name)
    settings["pluginOrder"] = migrated_order

    mode, uid, gid = stat_maybe_sudo(settings_file)
    generated = work_dir / "loader.json.updated"
    generated.write_text(
        json.dumps(settings, indent=4, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    atomic_privileged_replace(
        generated,
        settings_file,
        mode=mode,
        uid=uid,
        gid=gid,
    )


def copy_settings_backup(settings_file: Path, backup: Path) -> bool:
    if not settings_file.exists():
        return False
    run_command(["cp", "-a", "--", settings_file, backup], sudo=True)
    return True


def rollback(transaction: InstallTransaction) -> None:
    warn("Installation failed; attempting rollback.")

    with contextlib.suppress(Exception):
        run_command(["systemctl", "stop", SERVICE_NAME], sudo=True, quiet=True)

    if transaction.target_stage is not None:
        with contextlib.suppress(Exception):
            run_command(["rm", "-rf", "--", transaction.target_stage], sudo=True, quiet=True)
    if transaction.target_path is not None:
        with contextlib.suppress(Exception):
            run_command(["rm", "-rf", "--", transaction.target_path], sudo=True, quiet=True)

    if transaction.backup_path and transaction.existing_path:
        if command_succeeds(["test", "-e", transaction.backup_path], sudo=True):
            with contextlib.suppress(Exception):
                run_command(
                    ["mkdir", "-p", "--", transaction.existing_path.parent],
                    sudo=True,
                    quiet=True,
                )
                run_command(
                    ["mv", "--", transaction.backup_path, transaction.existing_path],
                    sudo=True,
                    quiet=True,
                )

    if transaction.settings_existed and transaction.settings_backup:
        if command_succeeds(["test", "-e", transaction.settings_backup], sudo=True):
            with contextlib.suppress(Exception):
                run_command(
                    ["cp", "-a", "--", transaction.settings_backup, transaction.settings_file],
                    sudo=True,
                    quiet=True,
                )

    if transaction.service_was_active:
        with contextlib.suppress(Exception):
            run_command(["systemctl", "start", SERVICE_NAME], sudo=True, quiet=True)

    warn("Rollback attempt finished.")


def apply_permissions(
    target_stage: Path,
    root_plugin: bool,
    *,
    owner_uid: int | None = None,
    owner_gid: int | None = None,
) -> None:
    uid = os.getuid() if owner_uid is None else owner_uid
    gid = os.getgid() if owner_gid is None else owner_gid

    # Normalize permission bits while preserving executable files through X.
    run_command(["chmod", "-R", "u=rwX,go=rX", "--", target_stage], sudo=True)

    if root_plugin:
        run_command(["chown", "-R", "0:0", "--", target_stage], sudo=True)
    else:
        run_command(["chown", "-R", f"{uid}:{gid}", "--", target_stage], sudo=True)
        run_command(
            ["chown", "0:0", "--", target_stage, target_stage / "plugin.json"],
            sudo=True,
        )

    run_command(
        ["chmod", "0755", "--", target_stage, target_stage / "plugin.json"],
        sudo=True,
    )


def perform_install(
    package: PluginPackage,
    *,
    plugin_root: Path,
    settings_file: Path,
    backup_root: Path,
    delete_backup: bool,
    work_dir: Path,
    owner_uid: int | None = None,
    owner_gid: int | None = None,
) -> Path | None:
    aliases = identity_aliases(package)
    existing = find_existing_plugin(plugin_root, package.name, aliases)
    target_path = plugin_root / package.folder
    if target_path.exists() and target_path != existing:
        fail(f"Target folder already exists but belongs to another plugin: {target_path}")

    service_was_active = command_succeeds(["systemctl", "is-active", "--quiet", SERVICE_NAME])
    transaction = InstallTransaction(
        plugin_root=plugin_root,
        settings_file=settings_file,
        service_was_active=service_was_active,
        existing_path=existing,
        target_path=target_path,
        target_stage=plugin_root / f".decky-install-{package.folder}-{os.getpid()}",
        settings_backup=work_dir / "loader.json.before",
    )

    # Authenticate before stopping Decky or changing any filesystem state.
    if os.geteuid() != 0:
        run_command(["sudo", "-v"])

    try:
        transaction.settings_existed = copy_settings_backup(
            settings_file, transaction.settings_backup
        )

        info("Stopping Decky Loader...")
        run_command(["systemctl", "stop", SERVICE_NAME], sudo=True)
        transaction.service_stopped = True

        run_command(["mkdir", "-p", "--", backup_root], sudo=True)
        run_command(["chmod", "0700", "--", backup_root], sudo=True)

        if existing is not None:
            timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_path = backup_root / f"{existing.name}-{timestamp}"
            if command_succeeds(["test", "-e", backup_path], sudo=True):
                fail(f"Backup path already exists: {backup_path}")
            transaction.backup_path = backup_path
            info("Backing up existing plugin to:")
            info(f"  {backup_path}")
            run_command(["mv", "--", existing, backup_path], sudo=True)
            transaction.filesystem_changed = True

        assert transaction.target_stage is not None
        run_command(["rm", "-rf", "--", transaction.target_stage], sudo=True)
        run_command(["mkdir", "--", transaction.target_stage], sudo=True)
        transaction.filesystem_changed = True
        run_command(
            ["cp", "-a", "--", f"{package.staged_path}/.", transaction.target_stage],
            sudo=True,
        )
        apply_permissions(
            transaction.target_stage,
            package.root_plugin,
            owner_uid=owner_uid,
            owner_gid=owner_gid,
        )
        run_command(["mv", "--", transaction.target_stage, target_path], sudo=True)
        transaction.target_stage = None

        update_plugin_order(settings_file, package.name, work_dir, aliases)

        info("Starting Decky Loader...")
        run_command(["systemctl", "start", SERVICE_NAME], sudo=True)
        transaction.service_stopped = False

        time.sleep(HEALTH_CHECK_DELAY_SECONDS)
        if not command_succeeds(["systemctl", "is-active", "--quiet", SERVICE_NAME]):
            run_command(
                ["systemctl", "status", "--no-pager", SERVICE_NAME],
                check=False,
            )
            fail("Decky Loader did not remain active after installation")

        transaction.committed = True
        transaction.filesystem_changed = False

        if transaction.backup_path and delete_backup:
            run_command(["rm", "-rf", "--", transaction.backup_path], sudo=True)
            info("Previous plugin backup deleted.")
            return None
        return transaction.backup_path
    except Exception:
        if transaction.filesystem_changed or transaction.service_stopped:
            rollback(transaction)
        raise


def resolve_identity() -> tuple[str, str]:
    try:
        username = pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        username = str(os.getuid())
    try:
        groupname = grp.getgrgid(os.getgid()).gr_name
    except KeyError:
        groupname = str(os.getgid())
    return username, groupname


def _path_from_plan(plan: Mapping[str, Any], key: str) -> Path:
    value = plan.get(key)
    if not isinstance(value, str) or not value:
        fail(f"Privileged installation plan is missing {key}")
    return Path(value)


def _int_from_plan(plan: Mapping[str, Any], key: str) -> int:
    value = plan.get(key)
    if not isinstance(value, int):
        fail(f"Privileged installation plan has an invalid {key}")
    return value


def validate_staged_tree(staged_path: Path, expected_folder: str) -> None:
    if staged_path.name != expected_folder:
        fail("Privileged package folder does not match the installation plan")
    if not staged_path.is_dir() or staged_path.is_symlink():
        fail("Privileged staged plugin path is not a normal directory")

    for root, directories, files in os.walk(staged_path, followlinks=False):
        root_path = Path(root)
        for name in [*directories, *files]:
            entry = root_path / name
            metadata = entry.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                fail(f"Staged package contains a symbolic link: {entry}")
            if not (stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)):
                fail(f"Staged package contains a special file: {entry}")


def write_helper_result(path: Path, payload: Mapping[str, Any], uid: int, gid: int) -> None:
    temporary = path.with_name(f".{path.name}.new-{os.getpid()}")
    temporary.write_text(json.dumps(dict(payload), ensure_ascii=False), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.chown(temporary, uid, gid)
    os.replace(temporary, path)


def privileged_helper(plan_path: Path) -> int:
    """Execute the complete privileged transaction after one Polkit prompt."""

    if os.geteuid() != 0:
        fail("The privileged helper must be launched through pkexec")

    plan: Mapping[str, Any] | None = None
    result_path: Path | None = None
    owner_uid = -1
    owner_gid = -1
    try:
        plan_stat = plan_path.stat()
        if not stat.S_ISREG(plan_stat.st_mode):
            fail("Privileged installation plan is not a regular file")
        if plan_stat.st_mode & 0o022:
            fail("Privileged installation plan is group- or world-writable")

        loaded = json.loads(plan_path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            fail("Privileged installation plan is not a JSON object")
        plan = loaded

        owner_uid = _int_from_plan(plan, "owner_uid")
        owner_gid = _int_from_plan(plan, "owner_gid")
        if owner_uid <= 0 or owner_gid < 0:
            fail("Privileged installation plan contains an invalid desktop identity")
        if plan_stat.st_uid != owner_uid:
            fail("Privileged installation plan is not owned by the desktop user")

        work_dir = _path_from_plan(plan, "work_dir").resolve(strict=True)
        result_path = _path_from_plan(plan, "result_path")
        if result_path.parent.resolve(strict=True) != work_dir:
            fail("Privileged helper result path is outside the work directory")
        if plan_path.parent.resolve(strict=True) != work_dir:
            fail("Privileged installation plan is outside the work directory")

        decky_home = _path_from_plan(plan, "decky_home").resolve(strict=True)
        plugin_root = _path_from_plan(plan, "plugin_root").resolve(strict=True)
        settings_file = _path_from_plan(plan, "settings_file")
        backup_root = _path_from_plan(plan, "backup_root")
        staged_path = _path_from_plan(plan, "staged_path").resolve(strict=True)

        if plugin_root != decky_home / "plugins":
            fail("Privileged plugin directory is inconsistent with Decky home")
        if settings_file != decky_home / "settings" / "loader.json":
            fail("Privileged settings path is inconsistent with Decky home")
        if backup_root != decky_home / "plugin-backups":
            fail("Privileged backup path is inconsistent with Decky home")
        if not staged_path.is_relative_to(work_dir):
            fail("Privileged staged package is outside the work directory")

        folder = plan.get("plugin_folder")
        name = plan.get("plugin_name")
        root_plugin = plan.get("root_plugin")
        delete_backup = plan.get("delete_backup")
        if not isinstance(folder, str) or not SAFE_PLUGIN_FOLDER.fullmatch(folder):
            fail("Privileged installation plan has an invalid plugin folder")
        if not isinstance(name, str) or not name.strip():
            fail("Privileged installation plan has an invalid plugin name")
        if not isinstance(root_plugin, bool) or not isinstance(delete_backup, bool):
            fail("Privileged installation plan has invalid boolean fields")

        validate_staged_tree(staged_path, folder)
        manifest_path = staged_path / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("name") != name:
            fail("Staged plugin manifest does not match the installation plan")
        flags = manifest.get("flags", []) or []
        manifest_root = isinstance(flags, list) and "root" in flags
        if manifest_root != root_plugin:
            fail("Staged plugin root flag does not match the installation plan")
        for required in (staged_path / "main.py", staged_path / "dist" / "index.js"):
            if not required.is_file() or required.is_symlink():
                fail(f"Staged package is missing required file: {required}")

        for command in ("systemctl", "cp", "mv", "rm", "mkdir", "chmod", "chown", "cat", "stat"):
            require_executable(command)
        if not command_succeeds(["systemctl", "cat", SERVICE_NAME]):
            fail(f"{SERVICE_NAME} was not found")

        package = PluginPackage(
            folder=folder,
            name=name,
            root_plugin=root_plugin,
            staged_path=staged_path,
            remote_binaries=(),
        )
        backup = perform_install(
            package,
            plugin_root=plugin_root,
            settings_file=settings_file,
            backup_root=backup_root,
            delete_backup=delete_backup,
            work_dir=work_dir,
            owner_uid=owner_uid,
            owner_gid=owner_gid,
        )
        write_helper_result(
            result_path,
            {"ok": True, "backup": str(backup) if backup else None},
            owner_uid,
            owner_gid,
        )
        return 0
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        if result_path is not None and owner_uid > 0 and owner_gid >= 0:
            with contextlib.suppress(Exception):
                write_helper_result(
                    result_path,
                    {"ok": False, "error": message},
                    owner_uid,
                    owner_gid,
                )
        print(f"Privileged helper error: {message}", file=sys.stderr)
        return 1


def perform_install_via_pkexec(
    package: PluginPackage,
    *,
    decky_home: Path,
    plugin_root: Path,
    settings_file: Path,
    backup_root: Path,
    delete_backup: bool,
    work_dir: Path,
) -> Path | None:
    plan_path = work_dir / "privileged-install-plan.json"
    result_path = work_dir / "privileged-install-result.json"
    plan = {
        "owner_uid": os.getuid(),
        "owner_gid": os.getgid(),
        "work_dir": str(work_dir.resolve()),
        "result_path": str(result_path),
        "decky_home": str(decky_home),
        "plugin_root": str(plugin_root),
        "settings_file": str(settings_file),
        "backup_root": str(backup_root),
        "staged_path": str(package.staged_path.resolve()),
        "plugin_folder": package.folder,
        "plugin_name": package.name,
        "root_plugin": package.root_plugin,
        "delete_backup": delete_backup,
    }
    plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    plan_path.chmod(0o600)

    python_executable = require_executable("python3")
    script_path = Path(__file__).resolve()
    command = [
        require_executable("pkexec"),
        python_executable,
        str(script_path),
        "--privileged-helper",
        str(plan_path),
    ]
    info("Requesting administrator authorization through Polkit...")
    completed = subprocess.run(command, check=False, text=True, capture_output=True)

    if completed.returncode == 126:
        raise InstallerCancelled("Administrator authorization was cancelled")
    if completed.returncode == 127 and not result_path.exists():
        fail(
            "Administrator authorization could not be obtained. Confirm that "
            "Desktop Mode has an active Polkit authentication agent"
        )

    result: Mapping[str, Any] | None = None
    if result_path.exists():
        try:
            loaded = json.loads(result_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                result = loaded
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            result = None

    if completed.returncode != 0 or not result or result.get("ok") is not True:
        detail = ""
        if result and isinstance(result.get("error"), str):
            detail = result["error"]
        elif completed.stderr.strip():
            detail = completed.stderr.strip().splitlines()[-1]
        else:
            detail = f"privileged helper exited with status {completed.returncode}"
        fail(f"Privileged installation failed: {detail}")

    backup = result.get("backup")
    return Path(backup) if isinstance(backup, str) and backup else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Install or update a Decky Loader plugin from a ZIP URL or GitHub "
            "repository release. Run as the normal desktop user. Command-line "
            "mode uses sudo; --gui uses KDE dialogs and one Polkit authorization."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  %(prog)s https://github.com/OWNER/REPOSITORY
  %(prog)s --asset Plugin.zip https://github.com/OWNER/REPOSITORY
  %(prog)s --release-tag v1.2.3 https://github.com/OWNER/REPOSITORY
  %(prog)s --prerelease https://github.com/OWNER/REPOSITORY
  %(prog)s --sha256 HASH https://example.com/Plugin.zip

For private GitHub repositories, set GITHUB_TOKEN in the environment.
When DISTRIBUTION_PLUGIN_URL is populated, the source argument is optional.
""",
    )
    parser.add_argument(
        "source",
        nargs="?",
        help="ZIP URL or GitHub repository URL; overrides DISTRIBUTION_PLUGIN_URL",
    )
    parser.add_argument(
        "--gui",
        action="store_true",
        help="use KDE dialogs and Polkit so no terminal window is required",
    )
    parser.add_argument(
        "--privileged-helper",
        type=Path,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--sha256", help="expected SHA-256 of the package ZIP")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="skip confirmation; requires a supplied or GitHub-provided SHA-256",
    )
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="permit plain HTTP for package and remote-binary downloads",
    )
    parser.add_argument(
        "--decky-home",
        type=Path,
        default=Path(os.environ.get("DECKY_HOME", Path.home() / "homebrew")),
        help="Decky homebrew directory (default: %(default)s)",
    )
    parser.add_argument(
        "--asset",
        help="exact GitHub release asset filename; useful when multiple ZIP assets exist",
    )
    parser.add_argument(
        "--release-tag",
        help="install an exact GitHub release tag instead of the latest release",
    )
    parser.add_argument(
        "--prerelease",
        action="store_true",
        help="allow the newest published prerelease to be selected",
    )
    backup_group = parser.add_mutually_exclusive_group()
    backup_group.add_argument(
        "--keep-backup",
        dest="delete_backup",
        action="store_false",
        default=False,
        help="retain the previous plugin backup after success (default)",
    )
    backup_group.add_argument(
        "--delete-backup",
        dest="delete_backup",
        action="store_true",
        help="delete the previous plugin backup after success",
    )
    return parser


def apply_distribution_defaults(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if args.source is None:
        args.source = DISTRIBUTION_PLUGIN_URL.strip()
        if not args.source:
            parser.error(
                "a source URL is required because DISTRIBUTION_PLUGIN_URL is empty"
            )

        if args.asset is None and DISTRIBUTION_ASSET:
            args.asset = DISTRIBUTION_ASSET
        if args.release_tag is None and DISTRIBUTION_RELEASE_TAG:
            args.release_tag = DISTRIBUTION_RELEASE_TAG
        if not args.prerelease and DISTRIBUTION_INCLUDE_PRERELEASE:
            args.prerelease = True
        if args.sha256 is None and DISTRIBUTION_EXPECTED_SHA256:
            args.sha256 = DISTRIBUTION_EXPECTED_SHA256
        if not args.yes and DISTRIBUTION_ASSUME_YES:
            args.yes = True


def validate_arguments(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if args.prerelease and args.release_tag:
        parser.error("--prerelease cannot be combined with --release-tag")
    if args.sha256:
        args.sha256 = normalize_sha256(args.sha256)


def format_plan(
    source: ResolvedSource,
    package: PluginPackage,
    actual_sha256: str,
    existing_path: Path | None,
) -> str:
    lines = [
        f"Plugin: {package.name}",
        f"Package folder: {package.folder}",
    ]
    if source.release_tag:
        lines.append(f"Release: {source.release_tag}")
    if source.asset_name:
        lines.append(f"Asset: {source.asset_name}")
    lines.extend(
        [
            f"Package source: {source.source_label}",
            f"ZIP SHA-256: {actual_sha256}",
            f"Root access requested by plugin: {'yes' if package.root_plugin else 'no'}",
            f"Remote binaries: {len(package.remote_binaries)}",
            (
                f"Action: update/reinstall {existing_path}"
                if existing_path
                else "Action: new installation"
            ),
        ]
    )
    return "\n".join(lines)


def display_plan(
    source: ResolvedSource,
    package: PluginPackage,
    actual_sha256: str,
    existing_path: Path | None,
) -> None:
    info()
    for line in format_plan(source, package, actual_sha256, existing_path).splitlines():
        info(line)
    info()


def main(argv: Sequence[str] | None = None) -> int:
    global GUI_ENABLED, GUI_LOG_PATH

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.privileged_helper is not None:
        return privileged_helper(args.privileged_helper)

    GUI_ENABLED = bool(args.gui)
    if GUI_ENABLED:
        desktop = Path.home() / "Desktop"
        GUI_LOG_PATH = (
            desktop if desktop.is_dir() else Path.home()
        ) / "Decky-SteamAchievements Installer.log"
        require_executable("kdialog")
        require_executable("pkexec")
        _write_log("INFO", "Started graphical installer")
        gui_status("Preparing Decky plugin installation…", 5)

    apply_distribution_defaults(args, parser)
    validate_arguments(args, parser)

    if os.geteuid() == 0:
        fail(
            "Run this program as the desktop user, not as root. It elevates only "
            "the filesystem and service transaction"
        )

    base_commands = ("systemctl", "cp", "mv", "rm", "mkdir", "chmod", "chown", "cat", "stat")
    for command in base_commands:
        require_executable(command)
    if not GUI_ENABLED:
        require_executable("sudo")

    decky_home = args.decky_home.expanduser().resolve()
    plugin_root = decky_home / "plugins"
    settings_file = decky_home / "settings" / "loader.json"
    backup_root = decky_home / "plugin-backups"

    if not decky_home.is_dir():
        fail(f"Decky home does not exist: {decky_home}")
    if not plugin_root.is_dir():
        fail(f"Decky plugin directory does not exist: {plugin_root}")
    if not command_succeeds(["systemctl", "cat", SERVICE_NAME]):
        fail(
            f"{SERVICE_NAME} was not found. Install Decky Loader first, or pass "
            "the correct --decky-home path"
        )

    resolved = resolve_source(args)
    if args.yes and not resolved.expected_sha256:
        fail(
            "--yes requires a supplied SHA-256 or a GitHub release asset with a "
            "valid SHA-256 digest"
        )

    with tempfile.TemporaryDirectory(prefix="decky-plugin-install.") as temporary_name:
        work_dir = Path(temporary_name)
        archive_path = work_dir / "plugin.zip"
        extract_root = work_dir / "extracted"

        info("Downloading package...")
        gui_status("Downloading and checking the plugin package…", 6)
        actual_sha256, _ = download_file(
            resolved.package_url,
            archive_path,
            allow_http=args.allow_http,
            headers=resolved.request_headers,
            expected_sha256=resolved.expected_sha256,
        )

        info("Validating package contents...")
        package = validate_and_extract_package(archive_path, extract_root)
        install_remote_binaries(package, allow_http=args.allow_http)
        existing = find_existing_plugin(
            plugin_root,
            package.name,
            identity_aliases(package),
        )
        display_plan(resolved, package, actual_sha256, existing)

        hash_warning = ""
        if not resolved.expected_sha256:
            hash_warning = (
                "\n\nWarning: no independent expected hash was available. "
                "The displayed hash does not authenticate the source."
            )
            warn(
                "No independent expected hash was available. The displayed hash "
                "detects later changes but does not authenticate the source"
            )

        if not args.yes:
            if GUI_ENABLED:
                prompt = (
                    "Review the installation details:\n\n"
                    + format_plan(resolved, package, actual_sha256, existing)
                    + hash_warning
                    + "\n\nContinue with installation?"
                )
                if not gui_confirm(prompt):
                    raise InstallerCancelled("Installation cancelled")
            else:
                confirmation = input("Type INSTALL to continue: ").strip()
                if confirmation != "INSTALL":
                    raise InstallerCancelled("Installation cancelled")

        username, groupname = resolve_identity()
        if GUI_ENABLED:
            info(
                "The privileged filesystem and service transaction will be "
                f"authorized through Polkit for desktop user {username}:{groupname}."
            )
            gui_status("Waiting for administrator authorization…", 8)
            backup = perform_install_via_pkexec(
                package,
                decky_home=decky_home,
                plugin_root=plugin_root,
                settings_file=settings_file,
                backup_root=backup_root,
                delete_backup=args.delete_backup,
                work_dir=work_dir,
            )
        else:
            info(
                "Privileged filesystem and service operations will be run through "
                f"sudo for desktop user {username}:{groupname}."
            )
            backup = perform_install(
                package,
                plugin_root=plugin_root,
                settings_file=settings_file,
                backup_root=backup_root,
                delete_backup=args.delete_backup,
                work_dir=work_dir,
                owner_uid=os.getuid(),
                owner_gid=os.getgid(),
            )

        if backup:
            info("Previous plugin backup retained at:")
            info(f"  {backup}")

        info()
        info(f"Installed {package.name} successfully.")
        info("Decky Loader is active.")
        info()
        info("Useful diagnostics:")
        info(f"  sudo journalctl -u {SERVICE_NAME} -n 100 --no-pager")
        info(f"  systemctl status {SERVICE_NAME} --no-pager")

        if GUI_ENABLED:
            message = f"{package.name} was installed successfully.\n\nDecky Loader is active."
            if backup:
                message += f"\n\nThe previous version was backed up to:\n{backup}"
            if GUI_LOG_PATH:
                message += f"\n\nInstaller log:\n{GUI_LOG_PATH}"
            gui_notice(message)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InstallerCancelled as exc:
        info(str(exc))
        if GUI_ENABLED:
            gui_notice(str(exc))
        raise SystemExit(0)
    except KeyboardInterrupt:
        print("\nCancelled", file=sys.stderr)
        if GUI_ENABLED:
            gui_notice("Installation cancelled")
        raise SystemExit(130)
    except InstallerError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        _write_log("ERROR", str(exc))
        if GUI_ENABLED:
            suffix = f"\n\nLog: {GUI_LOG_PATH}" if GUI_LOG_PATH else ""
            gui_error(f"{exc}{suffix}")
        raise SystemExit(1)
