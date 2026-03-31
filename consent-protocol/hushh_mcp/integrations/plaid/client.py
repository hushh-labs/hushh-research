"""Thin HTTP client for Plaid API calls."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .config import PlaidRuntimeConfig

logger = logging.getLogger(__name__)

_PLAID_TIMEOUT = httpx.Timeout(30.0, connect=6.0)
_PLAID_NETWORK_RETRY_ATTEMPTS = 2
_PLAID_ATTEMPT_DEADLINE_SECONDS = 10.0


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


class PlaidApiError(RuntimeError):
    """Raised when Plaid returns a structured API error."""

    def __init__(
        self,
        *,
        message: str,
        status_code: int,
        error_code: str | None = None,
        error_type: str | None = None,
        display_message: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.error_code = error_code
        self.error_type = error_type
        self.display_message = display_message
        self.payload = payload or {}
        super().__init__(message)


class PlaidHttpClient:
    """Provider-specific transport for Kai's Plaid service layer."""

    def __init__(self, config: PlaidRuntimeConfig) -> None:
        self._config = config

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._config.configured:
            raise RuntimeError("Plaid is not configured on this backend.")

        request_payload = {
            "client_id": self._config.client_id,
            "secret": self._config.secret,
            **payload,
        }
        response: httpx.Response | None = None
        async with httpx.AsyncClient(
            base_url=self._config.base_url,
            timeout=_PLAID_TIMEOUT,
        ) as client:
            for attempt in range(1, _PLAID_NETWORK_RETRY_ATTEMPTS + 1):
                try:
                    response = await asyncio.wait_for(
                        client.post(path, json=request_payload),
                        timeout=_PLAID_ATTEMPT_DEADLINE_SECONDS,
                    )
                    break
                except (httpx.TimeoutException, httpx.NetworkError, asyncio.TimeoutError) as exc:
                    if attempt >= _PLAID_NETWORK_RETRY_ATTEMPTS:
                        raise PlaidApiError(
                            message=("Could not reach Plaid right now. Please retry in a moment."),
                            status_code=504,
                            error_code="PLAID_NETWORK_TIMEOUT",
                            error_type="NETWORK_ERROR",
                            payload={
                                "path": path,
                                "attempts": attempt,
                                "base_url": self._config.base_url,
                            },
                        ) from exc

                    logger.warning(
                        "plaid.network_retry path=%s attempt=%s/%s error=%s",
                        path,
                        attempt,
                        _PLAID_NETWORK_RETRY_ATTEMPTS,
                        exc.__class__.__name__,
                    )
                    await asyncio.sleep(0.25 * attempt)

        if response is None:
            raise PlaidApiError(
                message="Could not reach Plaid right now. Please retry in a moment.",
                status_code=504,
                error_code="PLAID_NETWORK_TIMEOUT",
                error_type="NETWORK_ERROR",
                payload={"path": path, "base_url": self._config.base_url},
            )

        try:
            data = response.json()
        except Exception:
            data = {}

        if response.is_error:
            raise PlaidApiError(
                message=_clean_text(
                    data.get("error_message"),
                    default=response.text or "Plaid API error",
                ),
                status_code=response.status_code,
                error_code=_clean_text(data.get("error_code")) or None,
                error_type=_clean_text(data.get("error_type")) or None,
                display_message=_clean_text(data.get("display_message")) or None,
                payload=data if isinstance(data, dict) else {},
            )

        if not isinstance(data, dict):
            raise PlaidApiError(
                message="Plaid returned an invalid response payload.",
                status_code=response.status_code,
            )
        return data
