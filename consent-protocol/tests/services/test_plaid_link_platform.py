"""Platform-aware Plaid link tokens.

Plaid's Android SDK requires `/link/token/create` to carry
`android_package_name` and rejects a `redirect_uri` beside it; web Link and
iOS LinkKit keep the redirect URI. Clients that omit `platform` must behave
exactly as before. Plaid is never called: the HTTP post is replaced.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from api.routes.kai.plaid import PlaidLinkTokenRequest
from hushh_mcp.integrations.plaid import PlaidRuntimeConfig
from hushh_mcp.services.broker_funding_service import BrokerFundingService

_REDIRECT_URI = "https://one.hushh.ai/one/kai/plaid/oauth/return"


def test_link_token_request_platform_defaults_to_web_for_old_clients():
    request = PlaidLinkTokenRequest(user_id="user-123", redirect_uri=_REDIRECT_URI)

    assert request.platform == "web"


@pytest.mark.parametrize("platform", ["web", "ios", "android"])
def test_link_token_request_accepts_known_platforms(platform):
    assert PlaidLinkTokenRequest(user_id="user-123", platform=platform).platform == platform


def test_link_token_request_rejects_unknown_platform():
    with pytest.raises(ValidationError):
        PlaidLinkTokenRequest(user_id="user-123", platform="windows")


def _funding_service(monkeypatch) -> tuple[BrokerFundingService, list[dict[str, Any]]]:
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
        environment="sandbox",
        base_url="https://sandbox.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hussh Kai",
        webhook_url=None,
        frontend_url="https://one.hushh.ai",
        redirect_path="/one/kai/plaid/oauth/return",
        redirect_uri=_REDIRECT_URI,
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )
    payloads: list[dict[str, Any]] = []

    async def _fake_plaid_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert path == "/link/token/create"
        payloads.append(payload)
        return {"link_token": "link-funding", "expiration": "2026-07-20T00:00:00Z"}

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    return service, payloads


@pytest.mark.asyncio
@pytest.mark.parametrize("platform_kwargs", [{}, {"platform": "web"}, {"platform": "ios"}])
async def test_funding_link_token_web_and_ios_keep_redirect_uri(monkeypatch, platform_kwargs):
    service, payloads = _funding_service(monkeypatch)

    result = await service.create_funding_link_token(user_id="user-123", **platform_kwargs)

    assert payloads[0]["redirect_uri"] == _REDIRECT_URI
    assert "android_package_name" not in payloads[0]
    assert result["redirect_uri"] == _REDIRECT_URI


@pytest.mark.asyncio
async def test_funding_link_token_android_sends_package_name_without_redirect_uri(monkeypatch):
    service, payloads = _funding_service(monkeypatch)

    result = await service.create_funding_link_token(
        user_id="user-123",
        redirect_uri=_REDIRECT_URI,
        platform="android",
    )

    assert payloads[0]["android_package_name"] == "com.hussh.app"
    assert "redirect_uri" not in payloads[0]
    assert result["link_token"] == "link-funding"
    assert result["redirect_uri"] is None
