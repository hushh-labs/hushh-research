"""Exact deployment-owned OAuth callback and origin construction contracts."""

import pytest

from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.oauth_redirect_policy import (
    google_compatibility_callback,
    mcp_oauth_callback,
    validated_frontend_callback,
)


@pytest.mark.parametrize(
    "origin,allowed",
    [
        ("https://dev.one.hussh.ai/", True),
        ("http://dev.one.hussh.ai", False),
        ("https://owner@dev.one.hussh.ai", False),
        ("https://dev.one.hussh.ai/other", False),
        ("https://dev.one.hussh.ai?return=other", False),
        ("https://dev.one.hussh.ai#other", False),
    ],
)
def test_private_mcp_callback_requires_the_exact_configured_https_origin(origin, allowed):
    if allowed:
        assert mcp_oauth_callback(origin, environment="dev") == (
            "https://dev.one.hussh.ai/one/profile/connectors/oauth/return"
        )
    else:
        with pytest.raises(ValueError):
            mcp_oauth_callback(origin, environment="dev")
    assert mcp_oauth_callback("http://localhost:3000", environment="test") == (
        "http://localhost:3000/one/profile/connectors/oauth/return"
    )


@pytest.mark.parametrize(
    "origin",
    (
        "",
        "https:///one.hushh.ai",
        "ftp://one.hushh.ai",
        "https://owner@one.hushh.ai",
        "https://owner:password@one.hushh.ai",
        "https://one.hushh.ai/other",
        "https://one.hushh.ai?extra=1",
        "https://one.hushh.ai#fragment",
    ),
)
def test_gmail_callback_refuses_non_origin_values(origin):
    assert validated_frontend_callback(origin, "/one/profile/gmail/oauth/return") == ""


def test_gmail_callback_preserves_local_and_custom_origins():
    path = "/one/profile/gmail/oauth/return"
    assert validated_frontend_callback("http://localhost:3000/", path) == (
        "http://localhost:3000" + path
    )
    assert validated_frontend_callback("https://custom.example/", path) == (
        "https://custom.example" + path
    )


def test_google_compatibility_callback_preserves_calendar_path_and_gmail_fallback():
    origin = "https://uat.one.hushh.ai"
    calendar_path = "/one/profile/google/oauth/return"
    gmail_callback = origin + "/one/profile/gmail/oauth/return"
    assert google_compatibility_callback(origin, calendar_path, gmail_callback) == (
        origin + calendar_path
    )
    assert google_compatibility_callback("", calendar_path, gmail_callback) == gmail_callback


@pytest.mark.parametrize("domain", ["hushh.ai", "hussh.ai", "hussh.si"])
def test_google_callback_alias_is_exact_and_environment_scoped(monkeypatch, domain):
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", f"https://uat.one.{domain}")
    callback = f"https://uat.one.{domain}/one/profile/google/oauth/return"
    monkeypatch.setenv("GOOGLE_OAUTH_REDIRECT_URI", callback)
    monkeypatch.setenv(
        "CORS_ALLOWED_ORIGINS",
        "https://uat.one.hushh.ai,https://uat.one.hussh.ai,https://uat.one.hussh.si,https://one.hussh.si",
    )
    service = GoogleConnectionService()
    for alias in ("hushh.ai", "hussh.ai", "hussh.si"):
        expected = f"https://uat.one.{alias}/one/profile/google/oauth/return"
        assert service._redirect_uri(expected) == expected
    for invalid in (
        "https://one.hussh.si/one/profile/google/oauth/return",
        "https://uat.one.hussh.si/other",
        "https://uat.one.hussh.si/one/profile/google/oauth/return?extra=1",
        "https://evil.uat.one.hussh.si/one/profile/google/oauth/return",
    ):
        with pytest.raises(GoogleConnectionError):
            service._redirect_uri(invalid)

    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://uat.one.hussh.si")
    other_domain = "hushh.ai" if domain == "hussh.si" else "hussh.si"
    with pytest.raises(GoogleConnectionError):
        service._redirect_uri(f"https://uat.one.{other_domain}/one/profile/google/oauth/return")


def test_custom_callback_does_not_gain_a_spelling_alias_from_cors(monkeypatch):
    from hushh_mcp.services.oauth_redirect_policy import allowed_oauth_callback_uris

    callback = "https://custom.hushh.ai/one/profile/google/oauth/return"
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://custom.hushh.ai,https://custom.hussh.ai")
    assert allowed_oauth_callback_uris(callback) == frozenset({callback})
