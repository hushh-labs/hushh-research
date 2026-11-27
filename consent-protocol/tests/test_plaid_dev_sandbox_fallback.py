# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Dev-only Plaid Sandbox credential fallback when runtime config names production."""

from __future__ import annotations

import httpx
import pytest

from hushh_mcp.integrations.plaid import client as plaid_client
from hushh_mcp.integrations.plaid.config import PlaidRuntimeConfig


def _config(*, environment: str = "production") -> PlaidRuntimeConfig:
    return PlaidRuntimeConfig(
        client_id="diag_client_id",
        secret="-".join(("sandbox", "diag", "credential")),
        environment=environment,
        base_url=(
            "https://production.plaid.com"
            if environment == "production"
            else "https://sandbox.plaid.com"
        ),
        language="en",
        client_name="Hussh",
        country_codes=("US",),
        webhook_url=None,
        frontend_url="https://dev.one.hussh.ai",
        redirect_path="/kai/plaid/oauth/return",
        redirect_uri="https://dev.one.hussh.ai/kai/plaid/oauth/return",
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )


async def test_dev_retries_against_sandbox_when_production_reports_invalid_api_keys(monkeypatch):
    plaid_client._DEV_SANDBOX_CREDENTIAL_FINGERPRINTS.clear()
    monkeypatch.setenv("ENVIRONMENT", "dev")
    seen_hosts: list[str] = []

    class FakeAsyncClient:
        def __init__(self, *, base_url: str, timeout: httpx.Timeout):
            self._base_url = base_url

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, path: str, *, json: dict):
            seen_hosts.append(self._base_url)
            if self._base_url == "https://production.plaid.com":
                return httpx.Response(
                    400,
                    json={
                        "error_code": "INVALID_API_KEYS",
                        "error_type": "INVALID_INPUT",
                        "error_message": "invalid client_id or secret provided",
                    },
                )
            return httpx.Response(
                200,
                json={"link_token": "link-sandbox-ok", "expiration": "2026-11-24T08:00:00Z"},
            )

    monkeypatch.setattr(plaid_client.httpx, "AsyncClient", FakeAsyncClient)
    transport = plaid_client.PlaidHttpClient(_config(environment="production"))

    first = await transport.post("/link/token/create", {"user": {"client_user_id": "u1"}})
    assert first["link_token"] == "link-sandbox-ok"
    assert seen_hosts == ["https://production.plaid.com", "https://sandbox.plaid.com"]

    # Second call uses cached Sandbox resolution directly with zero production round trip.
    second = await transport.post("/link/token/create", {"user": {"client_user_id": "u1"}})
    assert second["link_token"] == "link-sandbox-ok"
    assert seen_hosts == [
        "https://production.plaid.com",
        "https://sandbox.plaid.com",
        "https://sandbox.plaid.com",
    ]


@pytest.mark.parametrize("strict_env", ["uat", "production"])
async def test_uat_and_production_never_fallback_to_sandbox_on_invalid_keys(
    monkeypatch, strict_env: str
):
    plaid_client._DEV_SANDBOX_CREDENTIAL_FINGERPRINTS.clear()
    monkeypatch.setenv("ENVIRONMENT", strict_env)
    seen_hosts: list[str] = []

    class FakeAsyncClient:
        def __init__(self, *, base_url: str, timeout: httpx.Timeout):
            self._base_url = base_url

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, path: str, *, json: dict):
            seen_hosts.append(self._base_url)
            return httpx.Response(
                400,
                json={
                    "error_code": "INVALID_API_KEYS",
                    "error_type": "INVALID_INPUT",
                    "error_message": "invalid client_id or secret provided",
                },
            )

    monkeypatch.setattr(plaid_client.httpx, "AsyncClient", FakeAsyncClient)
    transport = plaid_client.PlaidHttpClient(_config(environment="production"))

    with pytest.raises(plaid_client.PlaidApiError) as exc_info:
        await transport.post("/link/token/create", {"user": {"client_user_id": "u1"}})
    assert exc_info.value.error_code == "INVALID_API_KEYS"
    assert seen_hosts == ["https://production.plaid.com"]
