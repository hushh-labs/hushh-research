from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from hushh_mcp.integrations.alpaca import AlpacaBrokerHttpClient, AlpacaBrokerRuntimeConfig


def _clear_alpaca_env(monkeypatch) -> None:
    keys = [
        "ALPACA_ENV",
        "ALPACA_BROKER_ENV",
        "ALPACA_BROKER_BASE_URL",
        "BROKER_API_BASE",
        "ALPACA_BROKER_AUTH_TOKEN",
        "BROKER_TOKEN",
        "ALPACA_AUTH_TOKEN",
        "ALPACA_BROKER_CLIENT_ID",
        "ALPACA_BROKER_CLIENT_SECRET",
        "ALPACA_BROKER_KEY_ID",
        "APCA_API_KEY_ID",
        "ALPACA_API_KEY",
        "ALPACA_KEY_ID",
        "ALPACA_BROKER_SECRET",
        "APCA_API_SECRET_KEY",
        "ALPACA_API_SECRET",
        "ALPACA_SECRET_KEY",
        "ALPACA_API_SECRET_KEY",
        "ALPACA_DEFAULT_ACCOUNT_ID",
    ]
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def _request_value(record: dict[str, Any], key: str) -> Any:
    for container_name in ("data", "json", "params"):
        container = record.get(container_name)
        if isinstance(container, dict) and key in container:
            return container[key]
    return None


def _resolved_url(base_url: str | httpx.URL | None, url: str | httpx.URL) -> str:
    raw_url = str(url)
    if raw_url.startswith("http://") or raw_url.startswith("https://"):
        return raw_url
    base = str(base_url or "").rstrip("/")
    path = raw_url if raw_url.startswith("/") else f"/{raw_url}"
    return f"{base}{path}"


def _json_response(record: dict[str, Any], *, status_code: int, payload: Any) -> httpx.Response:
    return httpx.Response(
        status_code=status_code,
        json=payload,
        request=httpx.Request(record["method"], record["url"]),
    )


class _ScriptedAsyncClient:
    handler: Callable[[dict[str, Any]], Any] | None = None
    requests: list[dict[str, Any]] = []

    def __init__(self, *args, **kwargs) -> None:
        self._base_url = kwargs.get("base_url")

    async def __aenter__(self) -> "_ScriptedAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def request(self, method: str, url: str | httpx.URL, **kwargs) -> httpx.Response:
        return await self._dispatch(method, url, **kwargs)

    async def get(self, url: str | httpx.URL, **kwargs) -> httpx.Response:
        return await self._dispatch("GET", url, **kwargs)

    async def post(self, url: str | httpx.URL, **kwargs) -> httpx.Response:
        return await self._dispatch("POST", url, **kwargs)

    async def _dispatch(self, method: str, url: str | httpx.URL, **kwargs) -> httpx.Response:
        record = {
            "method": method,
            "url": _resolved_url(self._base_url, url),
            "headers": dict(kwargs.get("headers") or {}),
            "params": kwargs.get("params"),
            "json": kwargs.get("json"),
            "data": kwargs.get("data"),
        }
        type(self).requests.append(record)

        if type(self).handler is None:
            raise AssertionError("Scripted Alpaca AsyncClient handler was not installed.")

        response = type(self).handler(record)
        if inspect.isawaitable(response):
            response = await response

        if isinstance(response, httpx.Response):
            return response

        status_code, payload = response
        return _json_response(record, status_code=status_code, payload=payload)


def _install_async_client_stub(monkeypatch, handler: Callable[[dict[str, Any]], Any]) -> None:
    _ScriptedAsyncClient.handler = handler
    _ScriptedAsyncClient.requests = []
    monkeypatch.setattr(
        "hushh_mcp.integrations.alpaca.client.httpx.AsyncClient",
        _ScriptedAsyncClient,
    )


def _authx_config_or_xfail(monkeypatch, *, include_legacy_basic: bool = False):
    _clear_alpaca_env(monkeypatch)
    monkeypatch.setenv("ALPACA_ENV", "production")
    monkeypatch.setenv("ALPACA_BROKER_CLIENT_ID", "authx-client-id")
    monkeypatch.setenv("ALPACA_BROKER_CLIENT_SECRET", "authx-client-secret")
    if include_legacy_basic:
        monkeypatch.setenv("ALPACA_BROKER_KEY_ID", "legacy-basic-key")
        monkeypatch.setenv("ALPACA_BROKER_SECRET", "legacy-basic-secret")

    config = AlpacaBrokerRuntimeConfig.from_env()
    auth_header = getattr(config, "auth_header", "")
    if not config.configured or auth_header.startswith("Basic "):
        pytest.xfail("AuthX client-credentials support has not landed in the Alpaca runtime yet.")
    return config


@pytest.mark.asyncio
async def test_broker_client_prefers_explicit_auth_token_over_authx_and_legacy_basic(monkeypatch):
    _clear_alpaca_env(monkeypatch)
    monkeypatch.setenv("ALPACA_ENV", "production")
    monkeypatch.setenv("ALPACA_BROKER_AUTH_TOKEN", "Bearer static-broker-token")
    monkeypatch.setenv("ALPACA_BROKER_CLIENT_ID", "authx-client-id")
    monkeypatch.setenv("ALPACA_BROKER_CLIENT_SECRET", "authx-client-secret")
    monkeypatch.setenv("ALPACA_BROKER_KEY_ID", "legacy-basic-key")
    monkeypatch.setenv("ALPACA_BROKER_SECRET", "legacy-basic-secret")

    config = AlpacaBrokerRuntimeConfig.from_env()

    assert config.configured is True

    def _handler(record: dict[str, Any]):
        assert "authx." not in record["url"]
        assert record["headers"]["Authorization"] == "Bearer static-broker-token"
        return 200, [{"id": "acct_1"}]

    _install_async_client_stub(monkeypatch, _handler)

    client = AlpacaBrokerHttpClient(config)
    response = await client.get("/v1/accounts", params={"limit": "1"})

    assert response == [{"id": "acct_1"}]
    assert len(_ScriptedAsyncClient.requests) == 1


@pytest.mark.asyncio
async def test_broker_client_prefers_authx_client_credentials_over_legacy_basic(monkeypatch):
    config = _authx_config_or_xfail(monkeypatch, include_legacy_basic=True)

    def _handler(record: dict[str, Any]):
        if "authx." in record["url"]:
            assert _request_value(record, "grant_type") == "client_credentials"
            return 200, {
                "access_token": "authx-issued-token",
                "token_type": "Bearer",
                "expires_in": 3600,
            }

        assert record["headers"]["Authorization"] == "Bearer authx-issued-token"
        return 200, [{"id": "acct_1"}]

    _install_async_client_stub(monkeypatch, _handler)

    client = AlpacaBrokerHttpClient(config)
    response = await client.get("/v1/accounts", params={"limit": "1"})

    assert response == [{"id": "acct_1"}]
    authx_calls = [record for record in _ScriptedAsyncClient.requests if "authx." in record["url"]]
    broker_calls = [record for record in _ScriptedAsyncClient.requests if "/v1/accounts" in record["url"]]
    assert len(authx_calls) == 1
    assert len(broker_calls) == 1


@pytest.mark.asyncio
async def test_broker_client_reuses_authx_token_until_expiry(monkeypatch):
    config = _authx_config_or_xfail(monkeypatch)

    def _handler(record: dict[str, Any]):
        if "authx." in record["url"]:
            return 200, {
                "access_token": "cached-authx-token",
                "token_type": "Bearer",
                "expires_in": 3600,
            }

        assert record["headers"]["Authorization"] == "Bearer cached-authx-token"
        return 200, [{"id": "acct_1"}]

    _install_async_client_stub(monkeypatch, _handler)

    client = AlpacaBrokerHttpClient(config)
    first = await client.get("/v1/accounts", params={"limit": "1"})
    second = await client.get("/v1/accounts", params={"limit": "1"})

    assert first == [{"id": "acct_1"}]
    assert second == [{"id": "acct_1"}]
    authx_calls = [record for record in _ScriptedAsyncClient.requests if "authx." in record["url"]]
    broker_calls = [record for record in _ScriptedAsyncClient.requests if "/v1/accounts" in record["url"]]
    assert len(authx_calls) == 1
    assert len(broker_calls) == 2


@pytest.mark.asyncio
async def test_broker_client_refreshes_authx_token_when_expired(monkeypatch):
    config = _authx_config_or_xfail(monkeypatch)
    token_responses = iter(
        [
            {
                "access_token": "short-lived-authx-token",
                "token_type": "Bearer",
                "expires_in": 31,
            },
            {
                "access_token": "fresh-authx-token",
                "token_type": "Bearer",
                "expires_in": 3600,
            },
        ]
    )

    def _handler(record: dict[str, Any]):
        if "authx." in record["url"]:
            return 200, next(token_responses)

        authorization = record["headers"]["Authorization"]
        assert authorization in {
            "Bearer short-lived-authx-token",
            "Bearer fresh-authx-token",
        }
        return 200, [{"id": authorization.rsplit(' ', 1)[-1]}]

    _install_async_client_stub(monkeypatch, _handler)

    client = AlpacaBrokerHttpClient(config)
    first = await client.get("/v1/accounts", params={"limit": "1"})
    client._cached_auth_expires_at_monotonic = 0.0
    second = await client.get("/v1/accounts", params={"limit": "1"})

    assert isinstance(first, list)
    assert isinstance(second, list)
    authx_calls = [record for record in _ScriptedAsyncClient.requests if "authx." in record["url"]]
    broker_calls = [record for record in _ScriptedAsyncClient.requests if "/v1/accounts" in record["url"]]
    assert len(authx_calls) >= 2
    assert len(broker_calls) == 2
    assert broker_calls[-1]["headers"]["Authorization"] == "Bearer fresh-authx-token"


@pytest.mark.asyncio
async def test_broker_client_retries_once_on_401_with_fresh_authx_token(monkeypatch):
    config = _authx_config_or_xfail(monkeypatch)
    authx_calls = 0
    broker_calls = 0

    def _handler(record: dict[str, Any]):
        nonlocal authx_calls, broker_calls
        if "authx." in record["url"]:
            authx_calls += 1
            token = "stale-authx-token" if authx_calls == 1 else "fresh-authx-token"
            return 200, {
                "access_token": token,
                "token_type": "Bearer",
                "expires_in": 3600,
            }

        broker_calls += 1
        if broker_calls == 1:
            assert record["headers"]["Authorization"] == "Bearer stale-authx-token"
            return _json_response(
                record,
                status_code=401,
                payload={"message": "unauthorized", "code": "40110000"},
            )

        assert record["headers"]["Authorization"] == "Bearer fresh-authx-token"
        return 200, [{"id": "acct_1"}]

    _install_async_client_stub(monkeypatch, _handler)

    client = AlpacaBrokerHttpClient(config)
    response = await client.get("/v1/accounts", params={"limit": "1"})

    assert response == [{"id": "acct_1"}]
    assert authx_calls >= 2
    assert broker_calls == 2
