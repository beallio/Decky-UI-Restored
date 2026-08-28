from __future__ import annotations

import urllib.request
from urllib.error import URLError

from backend.updater.client import GitHubReleaseClient


def test_github_release_client(monkeypatch) -> None:
    client = GitHubReleaseClient()

    class MockResponse:
        status = 200
        headers = {"x-test": "123"}

        def read(self):
            return b'{"hello": "world"}'

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    def mock_urlopen(*args, **kwargs):
        req = args[0]
        assert req.full_url == "https://api.github.com/repos/beallio/Decky-UI-Restored/releases"
        assert req.headers["Accept"] == "application/vnd.github+json"
        return MockResponse()

    monkeypatch.setattr(urllib.request, "urlopen", mock_urlopen)

    res = client.list_releases()
    assert res.status == 200
    assert res.headers["x-test"] == "123"
    assert res.body == {"hello": "world"}


def test_github_release_client_network_error(monkeypatch) -> None:
    client = GitHubReleaseClient()

    def mock_urlopen_error(*args, **kwargs):
        raise URLError("Network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", mock_urlopen_error)

    res = client.list_releases()
    assert res.status == 500
    assert isinstance(res.body, dict)
    assert "Network unreachable" in res.body.get("error", "")
