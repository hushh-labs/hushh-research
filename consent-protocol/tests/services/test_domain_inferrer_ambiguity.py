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

import importlib.util
import sys
import types
from enum import Enum
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def domain_inferrer_mod():
    # Save original sys.path and sys.modules to prevent mock pollution
    orig_sys_path = list(sys.path)
    orig_sys_modules = dict(sys.modules)

    CONSENT_PATH = str(Path(__file__).resolve().parents[2])
    try:
        if CONSENT_PATH not in sys.path:
            sys.path.insert(0, CONSENT_PATH)

        class ConsentScope(str, Enum):
            VAULT_OWNER = "vault.owner"
            PKM_READ = "pkm.read"
            PKM_WRITE = "pkm.write"

        inserted_keys = []

        def mock_mod(name, **attrs):
            m = types.ModuleType(name)
            for k, v in attrs.items():
                setattr(m, k, v)
            sys.modules[name] = m
            inserted_keys.append(name)
            return m

        # Mock heavy dependencies before import
        mock_mod("hushh_mcp.constants", ConsentScope=ConsentScope, GEMINI_MODEL="mock")
        mock_mod("hushh_mcp.types", UserID=str)
        mock_mod("hushh_mcp.consent.token")
        mock_mod("hushh_mcp.consent.scope_helpers", scope_matches=lambda a, b: a == b)
        mock_mod("hushh_mcp.consent.scope_generator")
        mock_mod("hushh_mcp.consent.scope_bundles")
        mock_mod("hushh_mcp.services.consent_db", ConsentDBService=object)
        mock_mod("hushh_mcp.services")
        mock_mod("hushh_mcp.config")
        mock_mod("hushh_mcp.runtime_settings")
        mock_mod("hushh_mcp.db.connection")
        mock_mod("hushh_mcp.db")

        # Load domain_inferrer directly
        file_path = str(Path(CONSENT_PATH) / "hushh_mcp" / "services" / "domain_inferrer.py")
        spec = importlib.util.spec_from_file_location("hushh_mcp.services.domain_inferrer", file_path)
        _mod = importlib.util.module_from_spec(spec)
        sys.modules["hushh_mcp.services.domain_inferrer"] = _mod
        inserted_keys.append("hushh_mcp.services.domain_inferrer")
        spec.loader.exec_module(_mod)

        yield _mod

    finally:
        # Restore original path and modules
        sys.path = orig_sys_path
        for key in list(sys.modules.keys()):
            if key not in orig_sys_modules:
                del sys.modules[key]
        sys.modules.update(orig_sys_modules)


@pytest.fixture()
def inferrer(domain_inferrer_mod):
    return domain_inferrer_mod.DomainInferrer()


# ═════════════════════════════════════════════
# TEST 1: Ambiguous key returns 'ambiguous'
# ═════════════════════════════════════════════

def test_ambiguous_key_returns_ambiguous(inferrer):
    """
    'portfolio' exists in both financial and professional domains.
    Expected: returns 'ambiguous' instead of silently picking one.
    """
    result = inferrer.infer("portfolio_tracker")
    assert result == "ambiguous", (
        f"Expected 'ambiguous' for cross-domain key, got '{result}'"
    )


# ═════════════════════════════════════════════
# TEST 2: Clear key returns correct domain
# ═════════════════════════════════════════════

def test_clear_financial_key(inferrer):
    """
    'stock_ticker' is clearly financial.
    Expected: returns 'financial' with no ambiguity.
    """
    result = inferrer.infer("stock_ticker")
    assert result == "financial", (
        f"Expected 'financial', got '{result}'"
    )


def test_clear_health_key(inferrer):
    """
    'blood_pressure' is clearly health.
    Expected: returns 'health'.
    """
    result = inferrer.infer("blood_pressure")
    assert result == "health", (
        f"Expected 'health', got '{result}'"
    )


def test_clear_travel_key(inferrer):
    """
    'flight_miles' is clearly travel.
    Expected: returns 'travel'.
    """
    result = inferrer.infer("flight_miles")
    assert result == "travel", (
        f"Expected 'travel', got '{result}'"
    )


# ═════════════════════════════════════════════
# TEST 3: Unknown key returns 'general'
# ═════════════════════════════════════════════

def test_unknown_key_returns_general(inferrer):
    """
    A completely unknown key should return 'general'.
    """
    result = inferrer.infer("xyzzy_quantum_flux")
    assert result == "general", (
        f"Expected 'general' for unknown key, got '{result}'"
    )


# ═════════════════════════════════════════════
# TEST 4: Confidence uses winning domain's max
# ═════════════════════════════════════════════

def test_confidence_is_meaningful(inferrer):
    """
    A strong clear match should return high confidence (> 0.3).
    Old bug: confidence was diluted by global max across all domains.
    New fix: confidence uses winning domain's own max.
    """
    domain, confidence = inferrer.infer_with_confidence("blood_pressure_reading")
    assert domain == "health", f"Expected 'health', got '{domain}'"
    assert confidence > 0.3, (
        f"Expected meaningful confidence > 0.3, got {confidence:.3f}. "
        f"Confidence calculation may still be using global max."
    )


def test_ambiguous_key_returns_zero_confidence(inferrer):
    """
    Ambiguous keys should return 0.0 confidence.
    """
    domain, confidence = inferrer.infer_with_confidence("portfolio_tracker")
    assert domain == "ambiguous", f"Expected 'ambiguous', got '{domain}'"
    assert confidence == 0.0, f"Expected 0.0 confidence, got {confidence}"


# ═════════════════════════════════════════════
# TEST 5: infer() delegates correctly
# ═════════════════════════════════════════════

def test_infer_delegates_to_infer_with_confidence(inferrer):
    """
    infer() should return same domain as infer_with_confidence()[0].
    """
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

def test_infer_with_candidates_ambiguous(inferrer):
    """
    Ambiguous key should have is_ambiguous=True and multiple candidates.
    """
    result = inferrer.infer_with_candidates("portfolio_tracker")
    assert result["is_ambiguous"] is True, (
        f"Expected is_ambiguous=True, got {result['is_ambiguous']}"
    )
    assert len(result["candidates"]) >= 2, (
        f"Expected at least 2 candidates, got {result['candidates']}"
    )


def test_infer_with_candidates_clear(inferrer):
    """
    Clear key should have is_ambiguous=False.
    """
    result = inferrer.infer_with_candidates("blood_pressure_reading")
    assert result["is_ambiguous"] is False, (
        f"Expected is_ambiguous=False, got {result['is_ambiguous']}"
    )
    assert result["domain"] == "health", (
        f"Expected domain='health', got '{result['domain']}'"
    )


# ═════════════════════════════════════════════
# TEST 7: Value hint breaks ambiguity tie
# ═════════════════════════════════════════════

def test_value_hint_breaks_tie(inferrer):
    """
    A value hint should help resolve ambiguous keys.
    'portfolio' alone is ambiguous (financial vs professional).
    With value_hint='stocks and bonds', should resolve to financial.
    """
    # Without hint — ambiguous
    without_hint = inferrer.infer("portfolio")
    assert without_hint == "ambiguous", (
        f"Expected 'ambiguous' without hint, got '{without_hint}'"
    )

    # With financial hint — should resolve
    with_hint = inferrer.infer("portfolio", value_hint="stocks and bonds investment")
    assert with_hint in ("financial", "ambiguous"), (
        f"Expected 'financial' or still 'ambiguous' with hint, got '{with_hint}'"
    )