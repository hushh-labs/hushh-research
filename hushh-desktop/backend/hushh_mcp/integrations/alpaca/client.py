"""Thin HTTP client for Alpaca Broker API calls."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .config import AlpacaBrokerRuntimeConfig

logger = logging.getLogger(__name__)

_ALPACA_TIMEOUT = httpx.Timeout(30.0, connect=6.0)
_ALPACA_NETWORK_RETRY_ATTEMPTS = 2
_ALPACA_ATTEMPT_DEADLINE_SECONDS = 10.0


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
        headers = {
            "Authorization": self._config.auth_header,
            "Accept": "application/json",
        }
        if method in {"POST", "PUT", "PATCH"}:
            headers["Content-Type"] = "application/json"

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
                            headers=headers,
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
