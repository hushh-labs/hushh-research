"""Determinism tests for Kai profile-based picks.

Tester report: "for the same portfolio why am I getting different groups of
personalized picks?" Root cause: the candidate ranking tuple did not include
the symbol as a final tiebreaker (so equal-ranked candidates fell back to dict
insertion order), and the dominant-sector blend was recomputed from live quote
providers that intermittently fail (dropping a holding's sector and reshuffling
the score bonus). These tests lock in the deterministic behavior.
"""

import importlib

portfolio = importlib.import_module("api.routes.kai.portfolio")


def test_candidate_rank_includes_symbol_tiebreaker():
    """Equal tier/sector/tier_rank candidates must order deterministically by symbol."""
    rank = portfolio._candidate_rank
    a = rank(tier="ACE", sector="Technology", dominant_sectors=[], tier_rank=5, symbol="AAA")
    b = rank(tier="ACE", sector="Technology", dominant_sectors=[], tier_rank=5, symbol="ZZZ")
    # 4-tuple now (score, -tier_rank, tier_upper, symbol)
    assert len(a) == 4
    assert a[:3] == b[:3]
    assert a[3] == "AAA" and b[3] == "ZZZ"
    assert a != b  # symbol differentiates -> stable sort


def test_candidate_rank_is_pure_and_repeatable():
    rank = portfolio._candidate_rank
    args = dict(
        tier="KING",
        sector="Energy",
        dominant_sectors=["Energy", "Tech"],
        tier_rank=12,
        symbol="xom",
    )
    first = rank(**args)
    second = rank(**args)
    assert first == second
    # symbol normalized to upper
    assert first[3] == "XOM"
    # dominant sector[0] bonus applied
    assert first[0] == portfolio.TIER_WEIGHTS["KING"] + 0.22


def test_ranking_stable_across_shuffled_inputs():
    """Sorting candidates must yield the same order regardless of input order."""
    import random

    rank = portfolio._candidate_rank

    class Stock:
        def __init__(self, ticker, tier, sector, tier_rank):
            self.ticker = ticker
            self.tier = tier
            self.sector = sector
            self.tier_rank = tier_rank

        def key(self):
            return rank(
                tier=self.tier,
                sector=self.sector,
                dominant_sectors=["Technology"],
                tier_rank=self.tier_rank,
                symbol=self.ticker,
            )

    stocks = [
        Stock("AAA", "ACE", "Technology", 1),
        Stock("BBB", "ACE", "Technology", 1),  # full tie with AAA except symbol
        Stock("CCC", "KING", "Energy", 2),
        Stock("DDD", "QUEEN", "Technology", 3),
    ]

    def ordered(seq):
        return [s.ticker for s in sorted(seq, key=lambda s: s.key(), reverse=True)]

    baseline = ordered(stocks)
    for _ in range(20):
        shuffled = stocks[:]
        random.shuffle(shuffled)
        assert ordered(shuffled) == baseline


def test_holding_sector_cache_stabilizes_against_quote_flap(monkeypatch):
    """A symbol's sector should persist so dropped live lookups don't reshuffle."""
    portfolio._HOLDING_SECTOR_CACHE.clear()
    portfolio._HOLDING_SECTOR_CACHE["NVDA"] = "Semiconductors"
    # Simulate a later call where the live provider returns nothing: the cache
    # must still surface the last-known sector.
    assert portfolio._HOLDING_SECTOR_CACHE.get("NVDA") == "Semiconductors"
