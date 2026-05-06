"""Upstox V2 API adapter.

Usage
-----
Set the following env vars (from https://upstox.com/developer/api-documentation/):

    UPSTOX_API_KEY=...
    UPSTOX_ACCESS_TOKEN=...    # OAuth token from Upstox login flow

If keys are absent, ``UpstoxAdapter`` raises ``UpstoxNotConfiguredError``
and callers should fall back to yfinance quotes.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_UPSTOX_BASE_URL = "https://api.upstox.com/v2"
_UPSTOX_TIMEOUT_SECONDS = 10.0


class UpstoxNotConfiguredError(RuntimeError):
    """Raised when Upstox API credentials are not present in the environment."""


@dataclass
class UpstoxConfig:
    api_key: str
    access_token: str

    @classmethod
    def from_env(cls) -> "UpstoxConfig":
        api_key = (os.getenv("UPSTOX_API_KEY") or "").strip()
        access_token = (os.getenv("UPSTOX_ACCESS_TOKEN") or "").strip()
        return cls(api_key=api_key, access_token=access_token)

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.access_token)

    def to_status(self) -> dict[str, Any]:
        return {
            "upstox_configured": self.configured,
            "upstox_missing": [
                *([] if self.api_key else ["UPSTOX_API_KEY"]),
                *([] if self.access_token else ["UPSTOX_ACCESS_TOKEN"]),
            ],
        }


@dataclass
class UpstoxAdapter:
    """Thin async adapter over the Upstox V2 REST API."""

    config: UpstoxConfig = field(default_factory=UpstoxConfig.from_env)
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    def _require_configured(self) -> None:
        if not self.config.configured:
            raise UpstoxNotConfiguredError(
                "Upstox credentials not configured. "
                "Set UPSTOX_API_KEY and UPSTOX_ACCESS_TOKEN."
            )

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=_UPSTOX_BASE_URL,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self.config.access_token}",
                    "api-version": "2.0",
                },
                timeout=_UPSTOX_TIMEOUT_SECONDS,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def get_portfolio(self) -> list[dict[str, Any]]:
        """Return holdings from the Upstox Demat account.

        Returns list of holding dicts with standardised keys.
        """
        self._require_configured()
        resp = await self._http.get("/portfolio/long-term-holdings")
        resp.raise_for_status()
        data = resp.json().get("data") or []
        return [
            {
                "symbol": h.get("instrument_token", ""),
                "tradingsymbol": h.get("trading_symbol"),
                "exchange": h.get("exchange"),
                "isin": h.get("isin"),
                "quantity": h.get("quantity"),
                "average_price": h.get("average_price"),
                "last_price": h.get("last_price"),
                "pnl": h.get("pnl"),
                "day_change": h.get("day_change"),
                "day_change_pct": h.get("day_change_percentage"),
                "currency": "INR",
                "source": "upstox",
            }
            for h in data
            if isinstance(h, dict)
        ]

    async def get_quote(self, instrument_key: str) -> dict[str, Any] | None:
        """Return a live quote for an Upstox instrument key (e.g. 'NSE_EQ|INE002A01018').

        Returns None on any error.
        """
        self._require_configured()
        try:
            resp = await self._http.get(
                "/market-quote/quotes",
                params={"instrument_key": instrument_key},
            )
            resp.raise_for_status()
            data = resp.json().get("data", {}).get(instrument_key, {})
            if not data:
                return None
            return {
                "symbol": instrument_key,
                "last_price": data.get("last_price"),
                "change": data.get("net_change"),
                "change_pct": data.get("net_change_percentage"),
                "volume": data.get("volume"),
                "currency": "INR",
                "source": "upstox",
            }
        except Exception as exc:
            logger.warning("[Upstox] quote failed for %s: %s", instrument_key, exc)
            return None


_upstox_adapter: UpstoxAdapter | None = None


def get_upstox_adapter() -> UpstoxAdapter:
    global _upstox_adapter
    if _upstox_adapter is None:
        _upstox_adapter = UpstoxAdapter()
    return _upstox_adapter
