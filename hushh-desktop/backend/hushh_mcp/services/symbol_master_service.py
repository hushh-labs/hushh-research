"""Symbol master utilities for tradability, trust tiers, and metadata enrichment."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.services.ticker_cache import ticker_cache

_TRADE_ACTION_SYMBOLS = {
    "BUY",
    "SELL",
    "REINVEST",
    "DIVIDEND",
    "INTEREST",
    "TRANSFER",
    "WITHDRAWAL",
    "DEPOSIT",
}

_CASH_EQUIVALENT_SYMBOLS = {"CASH", "MMF", "SWEEP", "QACDS"}
_CASH_HINTS = ("cash", "sweep", "money market", "core position", "deposit")
_TICKER_PATTERN_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")


@dataclass
class SymbolClassification:
    symbol: str
    trust_tier: str
    tradable: bool
    reason: str


class SymbolMasterService:
    """Centralized symbol normalization + metadata lookup."""

    def normalize(self, raw_symbol: Any) -> str:
        text = str(raw_symbol or "").strip().upper()
        out = []
        for ch in text:
            if ch.isalnum() or ch in ".-":
                out.append(ch)
        return "".join(out)[:12]

    def get_ticker_metadata(self, symbol: str) -> dict[str, Any] | None:
        normalized = self.normalize(symbol)
        if not normalized:
            return None
        if not ticker_cache.loaded:
            try:
                ticker_cache.load_from_db()
            except Exception:
                return None
        return ticker_cache.get_by_ticker(normalized)

    def is_trade_action_symbol(self, symbol: str) -> bool:
        return self.normalize(symbol) in _TRADE_ACTION_SYMBOLS

    def is_cash_equivalent(
        self,
        symbol: str,
        *,
        name: str = "",
        asset_type: str = "",
    ) -> bool:
        normalized = self.normalize(symbol)
        if normalized in _CASH_EQUIVALENT_SYMBOLS:
            return True
        name_l = str(name or "").strip().lower()
        asset_l = str(asset_type or "").strip().lower()
        if any(h in name_l for h in _CASH_HINTS):
            return True
        if any(h in asset_l for h in _CASH_HINTS):
            return True
        return False

    def classify(
        self,
        symbol: Any,
        *,
        name: str = "",
        asset_type: str = "",
    ) -> SymbolClassification:
        normalized = self.normalize(symbol)
        if not normalized:
            return SymbolClassification(
                symbol="",
                trust_tier="unknown",
                tradable=False,
                reason="missing_symbol",
            )

        if self.is_trade_action_symbol(normalized):
            return SymbolClassification(
                symbol=normalized,
                trust_tier="action_token",
                tradable=False,
                reason="trade_action_token",
            )

        if self.is_cash_equivalent(normalized, name=name, asset_type=asset_type):
            return SymbolClassification(
                symbol="CASH",
                trust_tier="cash_equivalent",
                tradable=False,
                reason="cash_equivalent",
            )

        if not ticker_cache.loaded:
            try:
                ticker_cache.load_from_db()
            except Exception:
                # Cache miss should not break request path.
                pass

        meta = ticker_cache.get_by_ticker(normalized)
        if meta:
            tradable = bool(meta.get("tradable", True))
            return SymbolClassification(
                symbol=normalized,
                trust_tier="tradable_ticker" if tradable else "non_tradable_identifier",
                tradable=tradable,
                reason="symbol_master_match",
            )

        # Fallback: when the ticker master is stale/incomplete, treat valid ticker-like
        # symbols as tradable candidates so downstream optimize/debate flows stay usable.
        if _TICKER_PATTERN_RE.match(normalized):
            return SymbolClassification(
                symbol=normalized,
                trust_tier="tradable_ticker",
                tradable=True,
                reason="ticker_pattern_fallback",
            )

        return SymbolClassification(
            symbol=normalized,
            trust_tier="unknown",
            tradable=False,
            reason="not_in_symbol_master",
        )

    def enrich_holding(
        self,
        *,
        symbol: str,
        sector: Optional[str],
        industry: Optional[str],
    ) -> tuple[Optional[str], Optional[str], list[str], float]:
        meta = self.get_ticker_metadata(symbol)
        if not meta:
            return sector, industry, [], 0.0

        merged_sector = (sector or "").strip() or (meta.get("sector_primary") or "").strip() or None
        merged_industry = (
            (industry or "").strip() or (meta.get("industry_primary") or "").strip() or None
        )
        sector_tags_raw = meta.get("sector_tags") or []
        sector_tags: list[str] = []
        if isinstance(sector_tags_raw, list):
            for item in sector_tags_raw:
                text = str(item or "").strip()
                if text and text not in sector_tags:
                    sector_tags.append(text)
        confidence_raw = meta.get("metadata_confidence")
        try:
            confidence = float(confidence_raw or 0.0)
        except Exception:
            confidence = 0.0
        return merged_sector, merged_industry, sector_tags, confidence


_symbol_master_service: Optional[SymbolMasterService] = None


def get_symbol_master_service() -> SymbolMasterService:
    global _symbol_master_service
    if _symbol_master_service is None:
        _symbol_master_service = SymbolMasterService()
    return _symbol_master_service
