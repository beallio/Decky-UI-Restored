from __future__ import annotations

from backend.updater.models import parse_plugin_version


def test_parse_plugin_version_stable() -> None:
    parsed = parse_plugin_version("0.2.1")
    assert parsed is not None
    assert parsed.major == 0
    assert parsed.minor == 2
    assert parsed.patch == 1
    assert not parsed.is_dev
    assert parsed.dev_suffix is None
    assert parsed.build_metadata is None


def test_parse_plugin_version_dev_gsha() -> None:
    parsed = parse_plugin_version("0.2.1-dev.g55d87c")
    assert parsed is not None
    assert parsed.major == 0
    assert parsed.minor == 2
    assert parsed.patch == 1
    assert parsed.is_dev
    assert parsed.dev_suffix == "g55d87c"
    assert parsed.build_metadata is None


def test_parse_plugin_version_dev_legacy() -> None:
    parsed = parse_plugin_version("0.2.1-dev.55d87c")
    assert parsed is not None
    assert parsed.major == 0
    assert parsed.minor == 2
    assert parsed.patch == 1
    assert parsed.is_dev
    assert parsed.dev_suffix == "55d87c"
    assert parsed.build_metadata is None


def test_parse_plugin_version_local_build() -> None:
    parsed = parse_plugin_version("0.2.1+g55d87c")
    assert parsed is not None
    assert parsed.major == 0
    assert parsed.minor == 2
    assert parsed.patch == 1
    assert not parsed.is_dev
    assert parsed.dev_suffix is None
    assert parsed.build_metadata == "g55d87c"


def test_parse_plugin_version_invalid() -> None:
    assert parse_plugin_version("invalid") is None
    assert parse_plugin_version("1.2") is None
    assert parse_plugin_version("1.2.3.4") is None


def test_version_comparison() -> None:
    v_0_2_0 = parse_plugin_version("0.2.0")
    v_0_2_1 = parse_plugin_version("0.2.1")
    v_0_2_1_local = parse_plugin_version("0.2.1+g123")
    v_0_2_1_dev1 = parse_plugin_version("0.2.1-dev.g123")
    v_0_2_1_dev2 = parse_plugin_version("0.2.1-dev.g456")
    v_0_2_2_dev = parse_plugin_version("0.2.2-dev.g123")

    assert v_0_2_0 is not None
    assert v_0_2_1 is not None
    assert v_0_2_1_local is not None
    assert v_0_2_1_dev1 is not None
    assert v_0_2_1_dev2 is not None
    assert v_0_2_2_dev is not None

    # Higher stable is greater
    assert v_0_2_1 > v_0_2_0
    assert v_0_2_1 >= v_0_2_0
    assert v_0_2_0 < v_0_2_1
    assert v_0_2_0 <= v_0_2_1

    # Local builds are stable-equivalent
    assert v_0_2_1 == v_0_2_1_local
    assert not (v_0_2_1 < v_0_2_1_local)
    assert not (v_0_2_1 > v_0_2_1_local)

    # Stable wins over same-base dev
    assert v_0_2_1 > v_0_2_1_dev1
    assert v_0_2_1_local > v_0_2_1_dev1

    # Higher base dev is greater than lower stable
    assert v_0_2_2_dev > v_0_2_1
    assert v_0_2_2_dev > v_0_2_1_local
    assert v_0_2_1 < v_0_2_2_dev

    # Same-base dev builds are equal in version comparison (ordering relies on published_at)
    assert v_0_2_1_dev1 == v_0_2_1_dev2
    assert not (v_0_2_1_dev1 < v_0_2_1_dev2)
    assert not (v_0_2_1_dev1 > v_0_2_1_dev2)


def test_validate_release_candidate(monkeypatch) -> None:
    from backend.updater.discovery import validate_release_candidate
    from backend.updater.models import JsonResponse

    release = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v0.2.1",
        "html_url": "https://github.com/beallio/Decky-SteamAchievements/releases/tag/v0.2.1",
        "published_at": "2026-05-30T12:00:00Z",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v0.2.1.manifest.json",
                "browser_download_url": "https://github.com/manifest",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://github.com/zip",
            },
        ],
    }

    manifest = {
        "schemaVersion": 1,
        "pluginName": "Achievements Restored",
        "packageName": "decky-steamachievements",
        "version": "0.2.1",
        "sourceVersion": "0.2.1",
        "tag": "v0.2.1",
        "channel": "stable",
        "assetName": "Decky-SteamAchievements.zip",
        "sha256": "a" * 64,
        "generatedAt": "2026-05-30T12:00:00Z",
    }

    # Mock fetch_json to return manifest

    def mock_fetch_json(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        return JsonResponse(status=200, headers={}, body=manifest)

    class MockClient:
        def list_releases(self):
            return mock_fetch_json("releases")

        def get_release(self, tag):
            return mock_fetch_json(tag)

        def get_manifest(self, url):
            return mock_fetch_json(url)

    # Valid candidate
    candidate = validate_release_candidate(release, MockClient())
    assert candidate is not None
    assert candidate.version == "0.2.1"
    assert candidate.tag == "v0.2.1"
    assert candidate.channel == "stable"
    assert candidate.artifact_url == "https://github.com/zip"
    assert candidate.sha256 == "a" * 64
    assert candidate.release_url == release["html_url"]

    # Existing clients emit the former display name while renamed clients use the new one.
    renamed_manifest = dict(manifest, pluginName="Deck UI Restored")

    class RenamedClient:
        def get_manifest(self, url):
            return JsonResponse(status=200, headers={}, body=renamed_manifest)

    assert validate_release_candidate(release, RenamedClient()) is not None

    # Draft releases are ignored
    draft_release = dict(release, draft=True)
    assert validate_release_candidate(draft_release, MockClient()) is None

    # Mismatched plugin name in manifest
    bad_manifest = dict(manifest, pluginName="WrongName")

    class MockClient2:
        def get_manifest(self, url):
            return JsonResponse(status=200, headers={}, body=bad_manifest)

    assert validate_release_candidate(release, MockClient2()) is None


def test_select_candidate() -> None:
    from backend.updater.discovery import select_candidate
    from backend.updater.models import UpdateCandidate

    # Setup list of validated candidates
    c_stable_1 = UpdateCandidate(
        version="0.2.0",
        tag="v0.2.0",
        channel="stable",
        artifact_url="https://zip1",
        sha256="a" * 64,
        release_url="https://release1",
        published_at="2026-05-20T12:00:00Z",
        action="update",
    )
    c_stable_2 = UpdateCandidate(
        version="0.2.1",
        tag="v0.2.1",
        channel="stable",
        artifact_url="https://zip2",
        sha256="a" * 64,
        release_url="https://release2",
        published_at="2026-05-25T12:00:00Z",
        action="update",
    )
    c_dev_2_1 = UpdateCandidate(
        version="0.2.1-dev.g123",
        tag="v0.2.1-dev.g123",
        channel="development",
        artifact_url="https://zip_dev1",
        sha256="a" * 64,
        release_url="https://release_dev1",
        published_at="2026-05-23T12:00:00Z",
        action="update",
    )
    c_dev_2_2 = UpdateCandidate(
        version="0.2.2-dev.g456",
        tag="v0.2.2-dev.g456",
        channel="development",
        artifact_url="https://zip_dev2",
        sha256="a" * 64,
        release_url="https://release_dev2",
        published_at="2026-05-28T12:00:00Z",
        action="update",
    )

    candidates = [c_stable_1, c_stable_2, c_dev_2_1, c_dev_2_2]

    # Installed: 0.2.0, Channel: stable
    # Should choose latest stable 0.2.1
    sel = select_candidate(candidates, "0.2.0", "stable")
    assert sel is not None
    assert sel.version == "0.2.1"
    assert sel.action == "update"

    # Installed: 0.2.1, Channel: stable
    # Should not offer anything (up to date)
    assert select_candidate(candidates, "0.2.1", "stable") is None

    # Installed: 0.2.1+g999, Channel: stable
    # Local build 0.2.1+g999 is stable-equivalent to 0.2.1. Should not offer stable 0.2.1.
    assert select_candidate(candidates, "0.2.1+g999", "stable") is None

    # Installed: 0.2.1-dev.g123, Channel: stable
    # Latest stable is 0.2.1, same base version as installed dev. Action: move_to_stable.
    sel = select_candidate(candidates, "0.2.1-dev.g123", "stable")
    assert sel is not None
    assert sel.version == "0.2.1"
    assert sel.action == "move_to_stable"

    # Installed: 0.2.2-dev.g456, Channel: stable
    # Latest stable is 0.2.1, which is below the installed dev base 0.2.2. Action: downgrade_to_stable.
    sel = select_candidate(candidates, "0.2.2-dev.g456", "stable")
    assert sel is not None
    assert sel.version == "0.2.1"
    assert sel.action == "downgrade_to_stable"

    # Installed: 0.2.0, Channel: development
    # Should offer stable over dev of same base (0.2.1 wins over 0.2.1-dev.g123).
    # But 0.2.2-dev.g456 is higher base than 0.2.1. So 0.2.2-dev.g456 wins!
    sel = select_candidate(candidates, "0.2.0", "development")
    assert sel is not None
    assert sel.version == "0.2.2-dev.g456"
    assert sel.action == "update"

    # Test same-base dev ordering by published_at
    c_dev_2_2_earlier = UpdateCandidate(
        version="0.2.2-dev.g456",
        tag="v0.2.2-dev.g456",
        channel="development",
        artifact_url="https://zip_dev2_earlier",
        sha256="a" * 64,
        release_url="https://release_dev2_earlier",
        published_at="2026-05-28T12:00:00Z",
        action="update",
    )
    c_dev_2_2_later = UpdateCandidate(
        version="0.2.2-dev.g789",
        tag="v0.2.2-dev.g789",
        channel="development",
        artifact_url="https://zip_dev2_later",
        sha256="a" * 64,
        release_url="https://release_dev2_later",
        published_at="2026-05-29T12:00:00Z",
        action="update",
    )
    sel_same_base = select_candidate([c_dev_2_2_earlier, c_dev_2_2_later], "0.2.1", "development")
    assert sel_same_base is not None
    assert sel_same_base.version == "0.2.2-dev.g789"


def test_check_for_update() -> None:
    from backend.updater.service import PluginUpdater
    from backend.updater.models import JsonResponse
    import datetime
    import time

    # Mock list of releases
    releases = [
        {
            "draft": False,
            "prerelease": False,
            "tag_name": "v0.2.1",
            "html_url": "https://release-url",
            "published_at": "2026-05-30T12:00:00Z",
            "assets": [
                {
                    "name": "Decky-SteamAchievements-v0.2.1.manifest.json",
                    "browser_download_url": "https://manifest-url",
                },
                {
                    "name": "Decky-SteamAchievements.zip",
                    "browser_download_url": "https://zip-url",
                },
            ],
        }
    ]

    manifest = {
        "schemaVersion": 1,
        "pluginName": "Achievements Restored",
        "packageName": "decky-steamachievements",
        "version": "0.2.1",
        "sourceVersion": "0.2.1",
        "tag": "v0.2.1",
        "channel": "stable",
        "assetName": "Decky-SteamAchievements.zip",
        "sha256": "a" * 64,
        "generatedAt": "2026-05-30T12:00:00Z",
    }

    # Mock fetch_json to return releases, then manifest
    call_count = 0

    def mock_fetch_json(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        nonlocal call_count
        call_count += 1
        if "releases/tags" in url or "manifest" in url:
            return JsonResponse(status=200, headers={}, body=manifest)
        return JsonResponse(status=200, headers={}, body=releases)

    class MockClient:
        def list_releases(self):
            return mock_fetch_json("releases")

        def get_release(self, tag):
            return mock_fetch_json(tag)

        def get_manifest(self, url):
            return mock_fetch_json(url)

    # Setup PluginUpdater with mock client
    updater_instance = PluginUpdater(
        state_lock=__import__("contextlib").nullcontext(),
        save_callback=lambda: None,
        log_callback=lambda lvl, msg: None,
        release_client=MockClient(),
        version_resolver=lambda: "0.2.0",
        now=lambda: datetime.datetime.now(datetime.timezone.utc),
        monotonic=time.monotonic,
    )

    # Available update
    res = updater_instance.check_for_update("0.2.0")
    assert res["status"] == "available"
    assert res["candidate"]["version"] == "0.2.1"
    assert res["candidate"]["action"] == "update"

    # Up to date
    res = updater_instance.check_for_update("0.2.1")
    assert res["status"] == "current"

    # Rate limiting mock
    def mock_fetch_rate_limit(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        return JsonResponse(
            status=403,
            headers={
                "retry-after": "60",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1770000000",
            },
            body={"message": "API rate limit exceeded"},
        )

    class MockClientRateLimit:
        def list_releases(self):
            return mock_fetch_rate_limit("releases")

        def get_release(self, tag):
            return mock_fetch_rate_limit(tag)

        def get_manifest(self, url):
            return mock_fetch_rate_limit(url)

    updater_rate = PluginUpdater(
        state_lock=__import__("contextlib").nullcontext(),
        save_callback=lambda: None,
        log_callback=lambda lvl, msg: None,
        release_client=MockClientRateLimit(),
        version_resolver=lambda: "0.2.0",
        now=lambda: datetime.datetime.now(datetime.timezone.utc),
        monotonic=time.monotonic,
    )
    res = updater_rate.check_for_update("0.2.0")
    assert res["status"] == "failed"
    assert "rate limit" in str(res.get("message", "")).lower()
    assert res.get("retry_after") is not None


def test_revalidate_install_candidate() -> None:
    from backend.updater.service import PluginUpdater
    from backend.updater.models import JsonResponse
    import datetime
    import time

    release = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v0.2.1",
        "html_url": "https://release-url",
        "published_at": "2026-05-30T12:00:00Z",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v0.2.1.manifest.json",
                "browser_download_url": "https://manifest-url",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://zip-url",
            },
        ],
    }

    manifest = {
        "schemaVersion": 1,
        "pluginName": "Achievements Restored",
        "packageName": "decky-steamachievements",
        "version": "0.2.1",
        "sourceVersion": "0.2.1",
        "tag": "v0.2.1",
        "channel": "stable",
        "assetName": "Decky-SteamAchievements.zip",
        "sha256": "a" * 64,
        "generatedAt": "2026-05-30T12:00:00Z",
    }

    # Mock fetch_json to return release, then manifest
    def mock_fetch_json(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        if "manifest" in url or "manifest.json" in url:
            return JsonResponse(status=200, headers={}, body=manifest)
        return JsonResponse(status=200, headers={}, body=release)

    class MockClient:
        def list_releases(self):
            return mock_fetch_json("releases")

        def get_release(self, tag):
            return mock_fetch_json(tag)

        def get_manifest(self, url):
            return mock_fetch_json(url)

    updater_instance = PluginUpdater(
        state_lock=__import__("contextlib").nullcontext(),
        save_callback=lambda: None,
        log_callback=lambda lvl, msg: None,
        release_client=MockClient(),
        version_resolver=lambda: "0.2.0",
        now=lambda: datetime.datetime.now(datetime.timezone.utc),
        monotonic=time.monotonic,
    )

    candidate = {
        "version": "0.2.1",
        "tag": "v0.2.1",
        "channel": "stable",
        "artifact_url": "https://zip-url",
        "sha256": "a" * 64,
        "release_url": "https://release-url",
        "published_at": "2026-05-30T12:00:00Z",
        "action": "update",
    }

    # Valid revalidation
    validated = updater_instance.revalidate(candidate)
    assert validated.get("version") == "0.2.1"
    assert validated.get("sha256") == "a" * 64

    # Invalid - sha mismatch
    bad_candidate = dict(candidate, sha256="wrong_sha")
    res_bad = updater_instance.revalidate(bad_candidate)
    assert res_bad.get("status") == "failed"
    assert "SHA-256 mismatch" in str(res_bad.get("message", ""))


def test_validate_release_candidate_manifest_name_strict(monkeypatch) -> None:
    from backend.updater.discovery import validate_release_candidate
    from backend.updater.models import JsonResponse

    # 1. Stable release with correct manifest name
    release_stable = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v0.2.1",
        "html_url": "https://github.com/beallio/Decky-SteamAchievements/releases/tag/v0.2.1",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v0.2.1.manifest.json",
                "browser_download_url": "https://github.com/manifest",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://github.com/zip",
            },
        ],
    }

    manifest_stable = {
        "schemaVersion": 1,
        "pluginName": "Achievements Restored",
        "packageName": "decky-steamachievements",
        "version": "0.2.1",
        "sourceVersion": "0.2.1",
        "tag": "v0.2.1",
        "channel": "stable",
        "assetName": "Decky-SteamAchievements.zip",
        "sha256": "a" * 64,
        "generatedAt": "2026-05-30T12:00:00Z",
    }

    # 2. Stable release with WRONG manifest name
    release_wrong_name = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v0.2.1",
        "assets": [
            {
                "name": "wrong.manifest.json",
                "browser_download_url": "https://github.com/manifest",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://github.com/zip",
            },
        ],
    }

    # 3. Dev release with correct preferred dev manifest name
    release_dev_gsha = {
        "draft": False,
        "prerelease": True,
        "tag_name": "v0.2.1-dev.g55d87c",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v0.2.1-dev.g55d87c.manifest.json",
                "browser_download_url": "https://github.com/manifest",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://github.com/zip",
            },
        ],
    }

    manifest_dev_gsha = {
        "schemaVersion": 1,
        "pluginName": "Achievements Restored",
        "packageName": "decky-steamachievements",
        "version": "0.2.1-dev.g55d87c",
        "sourceVersion": "0.2.1-dev.g55d87c",
        "tag": "v0.2.1-dev.g55d87c",
        "channel": "dev",
        "assetName": "Decky-SteamAchievements.zip",
        "sha256": "a" * 64,
        "generatedAt": "2026-05-30T12:00:00Z",
    }

    # 4. Dev release with correct legacy dev manifest name
    release_dev_legacy = {
        "draft": False,
        "prerelease": True,
        "tag_name": "v0.2.1-dev.55d87c",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v0.2.1-dev.55d87c.manifest.json",
                "browser_download_url": "https://github.com/manifest",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://github.com/zip",
            },
        ],
    }

    manifest_dev_legacy = {
        "schemaVersion": 1,
        "pluginName": "Achievements Restored",
        "packageName": "decky-steamachievements",
        "version": "0.2.1-dev.55d87c",
        "sourceVersion": "0.2.1-dev.55d87c",
        "tag": "v0.2.1-dev.55d87c",
        "channel": "dev",
        "assetName": "Decky-SteamAchievements.zip",
        "sha256": "a" * 64,
        "generatedAt": "2026-05-30T12:00:00Z",
    }

    current_manifest = manifest_stable

    def mock_fetch_json(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        return JsonResponse(status=200, headers={}, body=current_manifest)

    class MockClient:
        def list_releases(self):
            return mock_fetch_json("releases")

        def get_release(self, tag):
            return mock_fetch_json(tag)

        def get_manifest(self, url):
            return mock_fetch_json(url)

    # Verify correct stable matches
    current_manifest = manifest_stable
    assert validate_release_candidate(release_stable, MockClient()) is not None

    # Verify wrong manifest name is rejected
    assert validate_release_candidate(release_wrong_name, MockClient()) is None

    # Verify dev gsha matches
    current_manifest = manifest_dev_gsha
    assert validate_release_candidate(release_dev_gsha, MockClient()) is not None

    # Verify dev legacy matches
    current_manifest = manifest_dev_legacy
    assert validate_release_candidate(release_dev_legacy, MockClient()) is not None


def test_malformed_github_payloads(monkeypatch) -> None:
    from backend.updater.discovery import validate_release_candidate
    from backend.updater.models import JsonResponse

    # Manifest fetch returns 500
    def mock_fetch_json(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        return JsonResponse(status=500, headers={}, body={})

    class MockClient:
        def list_releases(self):
            return mock_fetch_json("releases")

        def get_release(self, tag):
            return mock_fetch_json(tag)

        def get_manifest(self, url):
            return mock_fetch_json(url)

    release_no_assets = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v0.2.1",
        "assets": [],
    }
    assert validate_release_candidate(release_no_assets, MockClient()) is None

    release_with_assets = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v0.2.1",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v0.2.1.manifest.json",
                "browser_download_url": "https://manifest",
            },
            {"name": "Decky-SteamAchievements.zip", "browser_download_url": "https://zip"},
        ],
    }
    # fetch_json returns 500, so validate fails
    assert validate_release_candidate(release_with_assets, MockClient()) is None

    # Manifest fetch returns valid but missing fields
    def mock_fetch_json_bad_manifest(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        return JsonResponse(status=200, headers={}, body={"schemaVersion": 1})

    class MockClientBadManifest:
        def list_releases(self):
            return mock_fetch_json_bad_manifest("releases")

        def get_release(self, tag):
            return mock_fetch_json_bad_manifest(tag)

        def get_manifest(self, url):
            return mock_fetch_json_bad_manifest(url)

    assert validate_release_candidate(release_with_assets, MockClient()) is None


def test_rate_limit_header_precedence() -> None:
    from backend.updater.service import PluginUpdater
    from backend.updater.models import JsonResponse
    import datetime
    import time

    # Mock 403 with both retry-after and x-ratelimit-reset
    def mock_fetch_json(url: str, *, timeout_seconds: float = 15.0) -> JsonResponse:
        return JsonResponse(
            status=403,
            headers={
                "retry-after": "120",
                "x-ratelimit-reset": "2000000000",
            },
            body={"message": "rate limit"},
        )

    class MockClient:
        def list_releases(self):
            return mock_fetch_json("releases")

        def get_release(self, tag):
            return mock_fetch_json(tag)

        def get_manifest(self, url):
            return mock_fetch_json(url)

    updater_instance = PluginUpdater(
        state_lock=__import__("contextlib").nullcontext(),
        save_callback=lambda: None,
        log_callback=lambda lvl, msg: None,
        release_client=MockClient(),
        version_resolver=lambda: "0.2.0",
        now=lambda: datetime.datetime.now(datetime.timezone.utc),
        monotonic=time.monotonic,
    )

    res = updater_instance.check_for_update("0.2.0")
    assert res["status"] == "failed"
    # The retry_after should be based on retry-after (120s from now) not the far-future x-ratelimit-reset
    now = datetime.datetime.now(datetime.timezone.utc)
    expected_approx = now + datetime.timedelta(seconds=120)
    retry_after_str = str(res.get("retry_after"))
    retry_after = datetime.datetime.fromisoformat(retry_after_str)
    # Should be close to expected_approx
    assert abs((retry_after - expected_approx).total_seconds()) < 5


def test_prohibition_on_logging_full_sha256() -> None:
    from backend.updater.discovery import format_candidate_log
    from types import SimpleNamespace

    full_sha = "a" * 64

    # Dict candidate
    cand_dict = {"version": "1.0", "tag": "v1.0", "channel": "stable", "sha256": full_sha}
    log_str = format_candidate_log(cand_dict)
    assert "aaaaaaaa" in log_str
    assert full_sha not in log_str

    # Object candidate
    cand_obj = SimpleNamespace(version="1.0", tag="v1.0", channel="stable", sha256=full_sha)
    log_str2 = format_candidate_log(cand_obj)
    assert "aaaaaaaa" in log_str2
    assert full_sha not in log_str2


def test_mark_notified_persists_tag_and_returns_updated_context() -> None:
    import datetime
    import threading
    import time

    from backend.updater.service import PluginUpdater
    from backend.updater.models import JsonResponse

    class MockClient:
        def list_releases(self):
            return JsonResponse(status=200, headers={}, body=[])

        def get_release(self, tag):
            return JsonResponse(status=200, headers={}, body={})

        def get_manifest(self, url):
            return JsonResponse(status=200, headers={}, body={})

    save_calls = 0

    def save() -> None:
        nonlocal save_calls
        save_calls += 1

    updater = PluginUpdater(
        state_lock=threading.RLock(),
        save_callback=save,
        log_callback=lambda _level, _message: None,
        release_client=MockClient(),
        version_resolver=lambda: "1.2.2",
        now=lambda: datetime.datetime.now(datetime.timezone.utc),
        monotonic=time.monotonic,
    )

    context = updater.mark_notified("v1.2.3")

    assert context["last_notified_tag"] == "v1.2.3"
    assert updater.get_context()["last_notified_tag"] == "v1.2.3"
    assert save_calls == 1


def test_clear_stale_cache_drops_last_notified_tag() -> None:
    import datetime
    import threading
    import time

    from backend.updater.service import PluginUpdater
    from backend.updater.models import JsonResponse

    class MockClient:
        def list_releases(self):
            return JsonResponse(status=200, headers={}, body=[])

        def get_release(self, tag):
            return JsonResponse(status=200, headers={}, body={})

        def get_manifest(self, url):
            return JsonResponse(status=200, headers={}, body={})

    updater = PluginUpdater(
        state_lock=threading.RLock(),
        save_callback=lambda: None,
        log_callback=lambda _level, _message: None,
        release_client=MockClient(),
        version_resolver=lambda: "1.2.2",
        now=lambda: datetime.datetime.now(datetime.timezone.utc),
        monotonic=time.monotonic,
    )
    updater.load_state(
        {},
        {"update_check_cache": {"last_notified_tag": "v1.2.3"}},
    )

    updater._clear_stale_cache()

    assert updater.get_context()["last_notified_tag"] is None


def test_prevalidation_rejects_an_extra_zip_asset() -> None:
    from backend.updater.discovery import prevalidate_release_candidate

    release = {
        "draft": False,
        "prerelease": False,
        "tag_name": "v1.2.3",
        "published_at": "2026-07-28T00:00:00Z",
        "assets": [
            {
                "name": "Decky-SteamAchievements-v1.2.3.manifest.json",
                "browser_download_url": "https://example.invalid/manifest",
            },
            {
                "name": "Decky-SteamAchievements.zip",
                "browser_download_url": "https://example.invalid/plugin",
            },
            {
                "name": "unexpected.zip",
                "browser_download_url": "https://example.invalid/unexpected",
            },
        ],
    }

    assert prevalidate_release_candidate(release) is None
