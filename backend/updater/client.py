from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Protocol

from pathlib import Path


def resolve_version() -> str:
    try:
        payload = json.loads((Path(__file__).resolve().parents[2] / "plugin.json").read_text(encoding="utf-8"))
        version = payload.get("version")
        if isinstance(version, str) and version:
            return version
    except Exception:
        pass
    return "0.1.0"
from backend.updater.models import JsonResponse


def _get_user_agent() -> str:
    try:
        ver = resolve_version()
    # Intentionally broad
    except Exception:
        ver = "0.1.0"
    return f"Decky-SteamAchievements/{ver}"


def _get_ssl_context() -> ssl.SSLContext:
    from pathlib import Path

    context = ssl.create_default_context()
    standard_paths = [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
        "/etc/pki/tls/cacert.pem",
        "/etc/ssl/certs/ca-bundle.crt",
    ]
    for path_str in standard_paths:
        path = Path(path_str)
        if path.exists():
            try:
                context.load_verify_locations(cafile=str(path))
                break
            # Intentionally broad
            except Exception:
                pass
    return context


class ReleaseClient(Protocol):
    def list_releases(self) -> JsonResponse: ...
    def get_release(self, tag: str) -> JsonResponse: ...
    def get_manifest(self, url: str) -> JsonResponse: ...


class GitHubReleaseClient:
    def __init__(self, owner: str = "beallio", repo: str = "Deck-UI-Restored") -> None:
        self.owner = owner
        self.repo = repo
        self._user_agent = _get_user_agent()
        self._ssl_context = _get_ssl_context()

    def _fetch_json(self, url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2026-03-10",
                "User-Agent": self._user_agent,
            },
        )
        try:
            with urllib.request.urlopen(
                req, timeout=timeout_seconds, context=self._ssl_context
            ) as response:
                status = response.status
                resp_headers = {k.lower(): v for k, v in response.headers.items()}
                body_bytes = response.read()
                body = json.loads(body_bytes.decode("utf-8"))
                return JsonResponse(status=status, headers=resp_headers, body=body)
        except urllib.error.HTTPError as e:
            resp_headers = {k.lower(): v for k, v in e.headers.items()}
            try:
                body = json.loads(e.read().decode("utf-8"))
            # Intentionally broad
            except Exception:
                body = {}
            return JsonResponse(status=e.code, headers=resp_headers, body=body)
        # Intentionally broad
        except Exception as e:
            return JsonResponse(status=500, headers={}, body={"error": str(e)})

    def list_releases(self) -> JsonResponse:
        url = f"https://api.github.com/repos/{self.owner}/{self.repo}/releases"
        return self._fetch_json(url)

    def get_release(self, tag: str) -> JsonResponse:
        url = f"https://api.github.com/repos/{self.owner}/{self.repo}/releases/tags/{tag}"
        return self._fetch_json(url)

    def get_manifest(self, url: str) -> JsonResponse:
        return self._fetch_json(url)
