"""Strategy library smoke + property tests."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hushh_mcp.operons.kai.trading.data import StubBarFetcher, fetch_panel
from hushh_mcp.operons.kai.trading.strategies import (
    CrossSectionalMomentum,
    DonchianBreakout,
    InverseVolAllocator,
    RenaissanceOverlay,
    ZScoreReversion,
)
from hushh_mcp.operons.kai.trading.strategies.base import StrategyContext


@pytest.fixture(scope="module")
def panel() -> dict:
    fetcher = StubBarFetcher()
    return fetch_panel(
        fetcher,
        ["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA"],
        datetime(2020, 1, 1, tzinfo=timezone.utc),
        datetime(2023, 12, 31, tzinfo=timezone.utc),
    )


def test_momentum_produces_long_only_weights(panel) -> None:
    strat = CrossSectionalMomentum(long_only=True)
    sig = strat.signals(StrategyContext(panel=panel))
    assert (sig.weights >= -1e-9).all().all()
    # On rebalance dates with enough history, weights sum to ~1.0 (long-only).
    nonzero_rows = sig.weights[(sig.weights.abs().sum(axis=1) > 0)]
    if not nonzero_rows.empty:
        sums = nonzero_rows.sum(axis=1)
        assert ((sums - 1.0).abs() < 1e-6).all()


def test_zscore_reversion_signals(panel) -> None:
    strat = ZScoreReversion(long_only=True)
    sig = strat.signals(StrategyContext(panel=panel))
    # Long-only -> no negative weights
    assert (sig.weights >= -1e-9).all().all()


def test_donchian_breakout_signals(panel) -> None:
    strat = DonchianBreakout(long_only=True)
    sig = strat.signals(StrategyContext(panel=panel))
    assert (sig.weights >= -1e-9).all().all()


def test_inverse_vol_allocator_combines_children(panel) -> None:
    children = [
        CrossSectionalMomentum(long_only=True),
        DonchianBreakout(long_only=True),
    ]
    allocator = InverseVolAllocator(name="combo", children=children)
    sig = allocator.signals(StrategyContext(panel=panel))
    assert sig.weights.shape[0] > 0


def test_renaissance_overlay_zeroes_unknown_tickers(panel) -> None:
    base = CrossSectionalMomentum(long_only=True)
    tier_weights = {"AAPL": 1.0, "MSFT": 0.8}  # GOOG/AMZN/META/NVDA absent
    overlay = RenaissanceOverlay(
        name="ren_momentum",
        base=base,
        tier_weights=tier_weights,
    )
    sig = overlay.signals(StrategyContext(panel=panel))
    # Unknown tickers always zero.
    for absent in ("GOOG", "AMZN", "META", "NVDA"):
        assert (sig.weights[absent].abs() < 1e-9).all()
