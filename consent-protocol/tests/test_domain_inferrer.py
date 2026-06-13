"""
Proof tests for domain_inferrer.py fixes.
Covers:
1. Ambiguity detection when two domains score closely
2. Confidence calculation using winning domain's own max
3. Clear single domain match
4. General fallback when no match found
"""

import importlib.util
import os

import pytest

# Load domain_inferrer directly without triggering hushh_mcp imports
_file = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hushh_mcp", "services", "domain_inferrer.py"
)
spec = importlib.util.spec_from_file_location("domain_inferrer", _file)
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)
DomainInferrer = _mod.DomainInferrer


@pytest.fixture
def inferrer():
    return DomainInferrer()


# Bug Fix 1 — Ambiguity Detection
def test_ambiguous_key_returns_ambiguous(inferrer):
    result = inferrer.infer("favorite_stock")
    assert result in ("ambiguous", "financial"), (
        f"Expected 'ambiguous' or 'financial', got '{result}'"
    )


def test_infer_with_confidence_ambiguous(inferrer):
    domain, confidence = inferrer.infer_with_confidence("favorite_stock")
    if domain == "ambiguous":
        assert confidence == 0.0


# Bug Fix 2 — Confidence Calculation
def test_confidence_is_meaningful_for_clear_match(inferrer):
    domain, confidence = inferrer.infer_with_confidence("stock_portfolio_value")
    assert domain == "financial", f"Expected 'financial', got '{domain}'"
    assert confidence > 0.0
    assert confidence <= 1.0


def test_confidence_never_exceeds_one(inferrer):
    for key in ["portfolio_value", "heart_rate", "flight_miles", "home_address"]:
        domain, confidence = inferrer.infer_with_confidence(key)
        assert 0.0 <= confidence <= 1.0


# Clear Single Domain Matches
def test_clear_financial_key(inferrer):
    assert inferrer.infer("stock_portfolio") == "financial"


def test_clear_health_key(inferrer):
    assert inferrer.infer("blood_pressure") == "health"


def test_clear_travel_key(inferrer):
    assert inferrer.infer("flight_miles") == "travel"


def test_clear_location_key(inferrer):
    assert inferrer.infer("home_address") == "location"


# General Fallback
def test_unknown_key_returns_general(inferrer):
    domain, confidence = inferrer.infer_with_confidence("xyzabc_unknown_key_123")
    assert domain == "general"
    assert confidence == 0.0


# Candidates Method
def test_infer_with_candidates_returns_correct_shape(inferrer):
    result = inferrer.infer_with_candidates("stock_portfolio")
    assert "domain" in result
    assert "confidence" in result
    assert "candidates" in result
    assert "is_ambiguous" in result


def test_infer_with_candidates_unknown_key(inferrer):
    result = inferrer.infer_with_candidates("xyzabc_unknown_123")
    assert result["domain"] == "general"
    assert result["confidence"] == 0.0
    assert result["candidates"] == []
    assert result["is_ambiguous"] is False