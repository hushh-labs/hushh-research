"""Thin HTTP client for Alpaca Broker API calls."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from .config import AlpacaBrokerRuntimeConfig

logger = logging.getLogger(__name__)

_ALPACA_TIMEOUT = httpx.Timeout(30.0, connect=6.0)
_ALPACA_NETWORK_RETRY_ATTEMPTS = 2
_ALPACA_ATTEMPT_DEADLINE_SECONDS = 10.0
_ALPACA_TOKEN_REFRESH_SKEW_SECONDS = 30.0


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


class AlpacaApiError(RuntimeError):
    """Raised when Alpaca returns a structured API error."""

    def __init__(
        self,
        *,
        message: str,
        status_code: int,
        error_code: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.error_code = error_code
        self.payload = payload or {}
        super().__init__(message)


class AlpacaBrokerHttpClient:
    """Provider-specific transport for Kai's Alpaca broker service layer."""

    def __init__(self, config: AlpacaBrokerRuntimeConfig) -> None:
        self._config = config
        self._cached_auth_header = ""
        self._cached_auth_expires_at_monotonic = 0.0
        self._auth_lock = asyncio.Lock()

    async def get(
        self, path: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | list[Any]:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any] | list[Any]:
        return await self._request("POST", path, json=payload)

    async def delete(self, path: str) -> dict[str, Any] | list[Any]:
        return await self._request("DELETE", path)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any] | list[Any]:
        if not self._config.configured:
            raise RuntimeError("Alpaca Broker API is not configured on this backend.")

        response: httpx.Response | None = None
        for auth_attempt in range(2):
            headers = await self._request_headers(force_refresh=auth_attempt == 1)
            response = await self._send_request(
                method=method,
                path=path,
                params=params,
                json=json,
                headers=headers,
            )
            if not (
                response.status_code == 401
                and self._config.auth_strategy == "authx_client_credentials"
                and auth_attempt == 0
            ):
                break
            logger.warning("alpaca.authx_retry_on_401 method=%s path=%s", method, path)

        if response is None:
            raise AlpacaApiError(
                message="Could not reach Alpaca Broker API right now. Please retry in a moment.",
                status_code=504,
                error_code="ALPACA_NETWORK_TIMEOUT",
                payload={
                    "path": path,
                    "method": method,
                    "base_url": self._config.base_url,
                },
            )

        try:
            data = response.json()
        except Exception:
            data = {}

        if response.is_error:
            message = "Alpaca API error"
            error_code = None
            if isinstance(data, dict):
                message = _clean_text(
                    data.get("message"),
                    default=_clean_text(
                        data.get("error"),
                        default=response.text or message,
                    ),
                )
                error_code = _clean_text(data.get("code")) or None
            elif response.text:
                message = response.text
            raise AlpacaApiError(
                message=message,
                status_code=response.status_code,
                error_code=error_code,
                payload=data,
            )

        if not isinstance(data, (dict, list)):
            raise AlpacaApiError(
                message="Alpaca returned an invalid response payload.",
                status_code=response.status_code,
                payload={},
            )

        return data

    async def _request_headers(self, *, force_refresh: bool) -> dict[str, str]:
        auth_header = await self._authorization_header(force_refresh=force_refresh)
        headers = {
            "Authorization": auth_header,
            "Accept": "application/json",
        }
        return headers

    async def _authorization_header(self, *, force_refresh: bool = False) -> str:
        if self._config.auth_strategy != "authx_client_credentials":
            return self._config.auth_header

        now = time.monotonic()
        if (
            not force_refresh
            and self._cached_auth_header
            and now < self._cached_auth_expires_at_monotonic
        ):
            return self._cached_auth_header

        async with self._auth_lock:
            now = time.monotonic()
            if (
                not force_refresh
                and self._cached_auth_header
                and now < self._cached_auth_expires_at_monotonic
            ):
                return self._cached_auth_header

            auth_header, expires_in = await self._exchange_authx_token()
            cache_ttl = max(1.0, float(expires_in) - _ALPACA_TOKEN_REFRESH_SKEW_SECONDS)
            self._cached_auth_header = auth_header
            self._cached_auth_expires_at_monotonic = time.monotonic() + cache_ttl
            return self._cached_auth_header

    async def _exchange_authx_token(self) -> tuple[str, int]:
        token_url = _clean_text(self._config.authx_token_url)
        client_id = _clean_text(self._config.authx_client_id)
        client_secret = _clean_text(self._config.authx_client_secret)
        if not token_url or not client_id or not client_secret:
            raise AlpacaApiError(
                message="Alpaca Broker client credentials are incomplete.",
                status_code=503,
                error_code="ALPACA_AUTHX_NOT_CONFIGURED",
                payload={},
            )

        response: httpx.Response | None = None
        async with httpx.AsyncClient(timeout=_ALPACA_TIMEOUT) as client:
            for attempt in range(1, _ALPACA_NETWORK_RETRY_ATTEMPTS + 1):
                try:
                    response = await asyncio.wait_for(
                        client.post(
                            token_url,
                            data={
                                "grant_type": "client_credentials",
                                "client_id": client_id,
                                "client_secret": client_secret,
                            },
                            headers={"Content-Type": "application/x-www-form-urlencoded"},
                        ),
                        timeout=_ALPACA_ATTEMPT_DEADLINE_SECONDS,
                    )
                    break
                except (httpx.TimeoutException, httpx.NetworkError, asyncio.TimeoutError) as exc:
                    if attempt >= _ALPACA_NETWORK_RETRY_ATTEMPTS:
                        raise AlpacaApiError(
                            message="Could not reach Alpaca AuthX right now. Please retry in a moment.",
                            status_code=504,
                            error_code="ALPACA_AUTHX_NETWORK_TIMEOUT",
                            payload={"token_url": token_url, "attempts": attempt},
                        ) from exc

                    logger.warning(
                        "alpaca.authx_network_retry attempt=%s/%s error=%s",
                        attempt,
                        _ALPACA_NETWORK_RETRY_ATTEMPTS,
                        exc.__class__.__name__,
                    )
                    await asyncio.sleep(0.25 * attempt)

        if response is None:
            raise AlpacaApiError(
                message="Could not reach Alpaca AuthX right now. Please retry in a moment.",
                status_code=504,
                error_code="ALPACA_AUTHX_NETWORK_TIMEOUT",
                payload={"token_url": token_url},
            )

        try:
            data = response.json()
        except Exception:
            data = {}

        if response.is_error:
            message = "Alpaca AuthX token exchange failed."
            error_code = None
            if isinstance(data, dict):
                message = _clean_text(
                    data.get("message"),
                    default=_clean_text(data.get("error"), default=message),
                )
                error_code = _clean_text(data.get("code")) or None
            raise AlpacaApiError(
                message=message,
                status_code=response.status_code,
                error_code=error_code or "ALPACA_AUTHX_TOKEN_EXCHANGE_FAILED",
                payload=data if isinstance(data, dict) else {},
            )

        if not isinstance(data, dict):
            raise AlpacaApiError(
                message="Alpaca AuthX returned an invalid token payload.",
                status_code=response.status_code,
                error_code="ALPACA_AUTHX_INVALID_RESPONSE",
                payload={},
            )

        access_token = _clean_text(data.get("access_token"))
        token_type = _clean_text(data.get("token_type"), default="Bearer")
        expires_in_raw = data.get("expires_in")
        try:
            expires_in = int(str(expires_in_raw or "0").strip())
        except Exception:
            expires_in = 0
        if not access_token or expires_in <= 0:
            raise AlpacaApiError(
                message="Alpaca AuthX returned an incomplete token payload.",
                status_code=response.status_code,
                error_code="ALPACA_AUTHX_INVALID_RESPONSE",
                payload=data,
            )
        return f"{token_type} {access_token}", expires_in

    async def _send_request(
        self,
        *,
        method: str,
        path: str,
        params: dict[str, Any] | None,
        json: dict[str, Any] | None,
        headers: dict[str, str],
    ) -> httpx.Response:
        request_headers = dict(headers)
        if method in {"POST", "PUT", "PATCH"}:
            request_headers["Content-Type"] = "application/json"

        response: httpx.Response | None = None
        async with httpx.AsyncClient(
            base_url=self._config.base_url,
            timeout=_ALPACA_TIMEOUT,
        ) as client:
            for attempt in range(1, _ALPACA_NETWORK_RETRY_ATTEMPTS + 1):
                try:
                    response = await asyncio.wait_for(
                        client.request(
                            method=method,
                            url=path,
                            params=params,
                            json=json,
                            headers=request_headers,
                        ),
                        timeout=_ALPACA_ATTEMPT_DEADLINE_SECONDS,
                    )
                    break
                except (httpx.TimeoutException, httpx.NetworkError, asyncio.TimeoutError) as exc:
                    if attempt >= _ALPACA_NETWORK_RETRY_ATTEMPTS:
                        raise AlpacaApiError(
                            message="Could not reach Alpaca Broker API right now. Please retry in a moment.",
                            status_code=504,
                            error_code="ALPACA_NETWORK_TIMEOUT",
                            payload={
                                "path": path,
                                "method": method,
                                "attempts": attempt,
                                "base_url": self._config.base_url,
                            },
                        ) from exc

                    logger.warning(
                        "alpaca.network_retry method=%s path=%s attempt=%s/%s error=%s",
                        method,
                        path,
                        attempt,
                        _ALPACA_NETWORK_RETRY_ATTEMPTS,
                        exc.__class__.__name__,
                    )
                    await asyncio.sleep(0.25 * attempt)

        if response is None:
            raise AlpacaApiError(
                message="Could not reach Alpaca Broker API right now. Please retry in a moment.",
                status_code=504,
                error_code="ALPACA_NETWORK_TIMEOUT",
                payload={
                    "path": path,
                    "method": method,
                    "base_url": self._config.base_url,
                },
            )
        return response
