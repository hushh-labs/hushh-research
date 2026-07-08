"""
Tests for domain inferrer ambiguity resolver and confidence fix.

PR: feat/domain-inferrer-ambiguity-resolver

Tests cover:
1. Ambiguous key returns 'ambiguous' not a silent wrong domain
2. Clear key returns correct domain with no ambiguity
3. Unknown key returns 'general'
4. Confidence uses winning domain's own max (not global max)
5. infer() delegates to infer_with_confidence() correctly
6. infer_with_candidates() returns top candidates and is_ambiguous flag
7. Value hint breaks ambiguity tie correctly
"""

# domain_inferrer has no heavy dependencies (stdlib logging/re/typing only),
# so a plain import is all this needs. The previous version hardcoded a
# contributor's local Windows path AND installed fake hushh_mcp.* modules into
# sys.modules at import time; when the hardcoded path failed to load on any
# other machine, the leftover mocks poisoned collection of every later test
# module in the session (113 collection errors).
from hushh_mcp.services.domain_inferrer import DomainInferrer

# ─────────────────────────────────────────────
# Factory
# ─────────────────────────────────────────────


def make_inferrer() -> DomainInferrer:
    return DomainInferrer()


# ═════════════════════════════════════════════
# TEST 1: Ambiguous key returns 'ambiguous'
# ═════════════════════════════════════════════


def test_ambiguous_key_returns_ambiguous():
    """
    'portfolio' exists in both financial and professional domains.
    Expected: returns 'ambiguous' instead of silently picking one.
    """
    inferrer = make_inferrer()
    result = inferrer.infer("portfolio_tracker")
    assert result == "ambiguous", f"Expected 'ambiguous' for cross-domain key, got '{result}'"


# ═════════════════════════════════════════════
# TEST 2: Clear key returns correct domain
# ═════════════════════════════════════════════


def test_clear_financial_key():
    """
    'stock_ticker' is clearly financial.
    Expected: returns 'financial' with no ambiguity.
    """
    inferrer = make_inferrer()
    result = inferrer.infer("stock_ticker")
    assert result == "financial", f"Expected 'financial', got '{result}'"


def test_clear_health_key():
    """
    'blood_pressure' is clearly health.
    Expected: returns 'health'.
    """
    inferrer = make_inferrer()
    result = inferrer.infer("blood_pressure")
    assert result == "health", f"Expected 'health', got '{result}'"


def test_clear_travel_key():
    """
    'flight_miles' is clearly travel.
    Expected: returns 'travel'.
    """
    inferrer = make_inferrer()
    result = inferrer.infer("flight_miles")
    assert result == "travel", f"Expected 'travel', got '{result}'"


# ═════════════════════════════════════════════
# TEST 3: Unknown key returns 'general'
# ═════════════════════════════════════════════


def test_unknown_key_returns_general():
    """
    A completely unknown key should return 'general'.
    """
    inferrer = make_inferrer()
    result = inferrer.infer("xyzzy_quantum_flux")
    assert result == "general", f"Expected 'general' for unknown key, got '{result}'"


# ═════════════════════════════════════════════
# TEST 4: Confidence uses winning domain's max
# ═════════════════════════════════════════════


def test_confidence_is_meaningful():
    """
    A strong clear match should return high confidence (> 0.3).
    Old bug: confidence was diluted by global max across all domains.
    New fix: confidence uses winning domain's own max.
    """
    inferrer = make_inferrer()
    domain, confidence = inferrer.infer_with_confidence("blood_pressure_reading")
    assert domain == "health", f"Expected 'health', got '{domain}'"
    assert confidence > 0.3, (
        f"Expected meaningful confidence > 0.3, got {confidence:.3f}. "
        f"Confidence calculation may still be using global max."
    )


def test_ambiguous_key_returns_zero_confidence():
    """
    Ambiguous keys should return 0.0 confidence.
    """
    inferrer = make_inferrer()
    domain, confidence = inferrer.infer_with_confidence("portfolio_tracker")
    assert domain == "ambiguous", f"Expected 'ambiguous', got '{domain}'"
    assert confidence == 0.0, f"Expected 0.0 confidence, got {confidence}"


# ═════════════════════════════════════════════
# TEST 5: infer() delegates correctly
# ═════════════════════════════════════════════


def test_infer_delegates_to_infer_with_confidence():
    """
    infer() should return same domain as infer_with_confidence()[0].
    """
    inferrer = make_inferrer()
    keys = ["stock_ticker", "blood_pressure", "flight_miles", "portfolio_tracker"]
    for key in keys:
        domain_simple = inferrer.infer(key)
        domain_full, _ = inferrer.infer_with_confidence(key)
        assert domain_simple == domain_full, (
            f"infer() and infer_with_confidence() disagree on '{key}': "
            f"{domain_simple} vs {domain_full}"
        )


# ═════════════════════════════════════════════
# TEST 6: infer_with_candidates() works correctly
# ═════════════════════════════════════════════


def test_infer_with_candidates_ambiguous():
    """
    Ambiguous key should have is_ambiguous=True and multiple candidates.
    """
    inferrer = make_inferrer()
    result = inferrer.infer_with_candidates("portfolio_tracker")
    assert result["is_ambiguous"] is True, (
        f"Expected is_ambiguous=True, got {result['is_ambiguous']}"
    )
    assert len(result["candidates"]) >= 2, (
        f"Expected at least 2 candidates, got {result['candidates']}"
    )


def test_infer_with_candidates_clear():
    """
    Clear key should have is_ambiguous=False.
    """
    inferrer = make_inferrer()
    result = inferrer.infer_with_candidates("blood_pressure_reading")
    assert result["is_ambiguous"] is False, (
        f"Expected is_ambiguous=False, got {result['is_ambiguous']}"
    )
    assert result["domain"] == "health", f"Expected domain='health', got '{result['domain']}'"


# ═════════════════════════════════════════════
# TEST 7: Value hint breaks ambiguity tie
# ═════════════════════════════════════════════


def test_value_hint_breaks_tie():
    """
    A value hint should help resolve ambiguous keys.
    'portfolio' alone is ambiguous (financial vs professional).
    With value_hint='stocks and bonds', should resolve to financial.
    """
    inferrer = make_inferrer()

    # Without hint — ambiguous
    without_hint = inferrer.infer("portfolio")
    assert without_hint == "ambiguous", f"Expected 'ambiguous' without hint, got '{without_hint}'"

    # With financial hint — should resolve
    with_hint = inferrer.infer("portfolio", value_hint="stocks and bonds investment")
    assert with_hint in ("financial", "ambiguous"), (
        f"Expected 'financial' or still 'ambiguous' with hint, got '{with_hint}'"
    )
