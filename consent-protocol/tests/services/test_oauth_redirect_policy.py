"""Exact deployment-owned OAuth callback and origin construction contracts."""

import pytest

from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.oauth_redirect_policy import (
    google_compatibility_callback,
    validated_frontend_callback,
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


def test_google_callback_alias_is_exact_and_environment_scoped(monkeypatch):
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://uat.one.hushh.ai")
    callback = "https://uat.one.hushh.ai/one/profile/google/oauth/return"
    monkeypatch.setenv("GOOGLE_OAUTH_REDIRECT_URI", callback)
    monkeypatch.setenv(
        "CORS_ALLOWED_ORIGINS",
        "https://uat.one.hushh.ai,https://uat.one.hussh.ai,https://one.hussh.ai",
    )
    service = GoogleConnectionService()
    assert service._redirect_uri(callback.replace("hushh.ai", "hussh.ai")) == (
        "https://uat.one.hussh.ai/one/profile/google/oauth/return"
    )
    for invalid in (
        "https://one.hussh.ai/one/profile/google/oauth/return",
        "https://uat.one.hussh.ai/other",
        "https://uat.one.hussh.ai/one/profile/google/oauth/return?extra=1",
    ):
        with pytest.raises(GoogleConnectionError):
            service._redirect_uri(invalid)


def test_custom_callback_does_not_gain_a_spelling_alias_from_cors(monkeypatch):
    from hushh_mcp.services.oauth_redirect_policy import allowed_oauth_callback_uris

    callback = "https://custom.hushh.ai/one/profile/google/oauth/return"
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://custom.hushh.ai,https://custom.hussh.ai")
    assert allowed_oauth_callback_uris(callback) == frozenset({callback})
