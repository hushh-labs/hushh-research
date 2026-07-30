"""In-memory OAuth client-credentials coverage for the local stdio bridge."""

from __future__ import annotations

import time

from mcp_modules import developer_context


class _Response:
    status_code = 200

    def __init__(self, payload: dict):
        self._payload = payload

    def json(self) -> dict:
        return self._payload


def _reset_oauth_cache() -> None:
    developer_context._oauth_access_token = None  # type: ignore[attr-defined]


def test_client_credentials_exchange_uses_post_basic_auth_and_reuses_memory_token(monkeypatch):
    _reset_oauth_cache()
    monkeypatch.delenv("HUSHH_DEVELOPER_TOKEN", raising=False)
    monkeypatch.setenv("HUSHH_OAUTH_CLIENT_ID", "hco_test_client")
    monkeypatch.setenv("HUSHH_OAUTH_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("CONSENT_API_URL", "https://api.example.test")
    calls: list[dict] = []

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return _Response(
            {"access_token": "hdo_at_test", "token_type": "Bearer", "expires_in": 3600}
        )

    monkeypatch.setattr(developer_context.httpx, "post", fake_post)

    assert developer_context.get_developer_api_headers() == {"Authorization": "Bearer hdo_at_test"}
    assert developer_context.get_developer_api_headers() == {"Authorization": "Bearer hdo_at_test"}
    assert len(calls) == 1
    assert calls[0]["url"] == "https://api.example.test/oauth/token"
    assert calls[0]["data"] == {"grant_type": "client_credentials", "scope": "mcp:tools"}
    assert calls[0]["auth"] == ("hco_test_client", "test-secret")


def test_client_credentials_renews_before_expiry_without_persisting_token(monkeypatch):
    _reset_oauth_cache()
    monkeypatch.delenv("HUSHH_DEVELOPER_TOKEN", raising=False)
    monkeypatch.setenv("HUSHH_OAUTH_CLIENT_ID", "hco_test_client")
    monkeypatch.setenv("HUSHH_OAUTH_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("HUSHH_OAUTH_TOKEN_URL", "https://oauth.example.test/token")
    developer_context._oauth_access_token = ("expired", time.monotonic() - 1)  # type: ignore[attr-defined]

    def fake_post(_url, **_kwargs):
        return _Response(
            {"access_token": "hdo_at_renewed", "token_type": "Bearer", "expires_in": 3600}
        )

    monkeypatch.setattr(developer_context.httpx, "post", fake_post)

    assert developer_context.get_developer_api_headers() == {
        "Authorization": "Bearer hdo_at_renewed"
    }


def test_developer_token_remains_the_preferred_compatibility_credential(monkeypatch):
    _reset_oauth_cache()
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "hdt_compatibility")
    monkeypatch.setenv("HUSHH_OAUTH_CLIENT_ID", "hco_test_client")
    monkeypatch.setenv("HUSHH_OAUTH_CLIENT_SECRET", "test-secret")

    def unexpected_post(*_args, **_kwargs):
        raise AssertionError("OAuth exchange should not run when a bearer token is configured.")

    monkeypatch.setattr(developer_context.httpx, "post", unexpected_post)
    assert developer_context.get_developer_api_headers() == {
        "Authorization": "Bearer hdt_compatibility"
    }
