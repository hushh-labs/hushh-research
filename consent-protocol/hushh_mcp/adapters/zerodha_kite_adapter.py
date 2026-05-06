"""Zerodha Kite Connect adapter.

Usage
-----
Set the following env vars (obtainable from https://kite.zerodha.com/):

    ZERODHA_API_KEY=...
    ZERODHA_API_SECRET=...
    ZERODHA_ACCESS_TOKEN=...   # refreshed daily via Kite login flow

If keys are absent, ``ZerodhaKiteAdapter`` raises ``ZerodhaNotConfiguredError``
and callers should fall back to yfinance quotes.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_KITE_BASE_URL = "https://api.kite.trade"
_KITE_TIMEOUT_SECONDS = 10.0


class ZerodhaNotConfiguredError(RuntimeError):
    """Raised when Zerodha API credentials are not present in the environment."""


@dataclass
class ZerodhaKiteConfig:
    api_key: str
    api_secret: str
    access_token: str

    @classmethod
    def from_env(cls) -> "ZerodhaKiteConfig":
        api_key = (os.getenv("ZERODHA_API_KEY") or "").strip()
        api_secret = (os.getenv("ZERODHA_API_SECRET") or "").strip()
        access_token = (os.getenv("ZERODHA_ACCESS_TOKEN") or "").strip()
        return cls(api_key=api_key, api_secret=api_secret, access_token=access_token)

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.access_token)

    def to_status(self) -> dict[str, Any]:
        return {
            "zerodha_configured": self.configured,
            "zerodha_missing": [
                *([] if self.api_key else ["ZERODHA_API_KEY"]),
                *([] if self.access_token else ["ZERODHA_ACCESS_TOKEN"]),
            ],
        }


@dataclass
class ZerodhaKiteAdapter:
    """Thin async adapter over the Kite Connect REST API v3."""

    config: ZerodhaKiteConfig = field(default_factory=ZerodhaKiteConfig.from_env)
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    def _require_configured(self) -> None:
        if not self.config.configured:
            raise ZerodhaNotConfiguredError(
                "Zerodha Kite credentials not configured. "
                "Set ZERODHA_API_KEY and ZERODHA_ACCESS_TOKEN."
            )

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=_KITE_BASE_URL,
                headers={
                    "X-Kite-Version": "3",
                    "Authorization": f"token {self.config.api_key}:{self.config.access_token}",
                },
                timeout=_KITE_TIMEOUT_SECONDS,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def get_portfolio(self) -> list[dict[str, Any]]:
        """Return holdings from the connected Zerodha Demat account.

        Returns a list of holding dicts with keys:
        tradingsymbol, exchange, isin, quantity, average_price, last_price,
        pnl, day_change, day_change_percentage.
        """
        self._require_configured()
        resp = await self._http.get("/portfolio/holdings")
        resp.raise_for_status()
        data = resp.json()
        holdings = data.get("data") or []
        return [
            {
                "symbol": f"{h.get('tradingsymbol')}.{h.get('exchange', 'NSE')}",
                "tradingsymbol": h.get("tradingsymbol"),
                "exchange": h.get("exchange"),
                "isin": h.get("isin"),
                "quantity": h.get("quantity"),
                "average_price": h.get("average_price"),
                "last_price": h.get("last_price"),
                "pnl": h.get("pnl"),
                "day_change": h.get("day_change"),
                "day_change_pct": h.get("day_change_percentage"),
                "currency": "INR",
                "source": "zerodha_kite",
            }
            for h in holdings
            if isinstance(h, dict)
        ]

    async def get_quote(self, symbol: str) -> dict[str, Any] | None:
        """Return a live quote for an NSE/BSE symbol (e.g. 'NSE:RELIANCE').

        ``symbol`` should be in Kite's exchange:tradingsymbol format.
        Returns None on any error.
        """
        self._require_configured()
        try:
            resp = await self._http.get("/quote", params={"i": symbol})
            resp.raise_for_status()
            data = resp.json().get("data", {}).get(symbol, {})
            if not data:
                return None
            return {
                "symbol": symbol,
                "last_price": data.get("last_price"),
                "change": data.get("change"),
                "change_pct": data.get("change_percent"),
                "volume": data.get("volume"),
                "currency": "INR",
                "source": "zerodha_kite",
            }
        except Exception as exc:
            logger.warning("[ZerodhaKite] quote failed for %s: %s", symbol, exc)
            return None


_zerodha_adapter: ZerodhaKiteAdapter | None = None


def get_zerodha_adapter() -> ZerodhaKiteAdapter:
    global _zerodha_adapter
    if _zerodha_adapter is None:
        _zerodha_adapter = ZerodhaKiteAdapter()
    return _zerodha_adapter
