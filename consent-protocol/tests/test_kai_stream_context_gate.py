"""Kai stream context gate source-level contract tests."""

from __future__ import annotations

from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_STREAM_SOURCE = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")


def test_stream_defines_context_validation_helpers():
    assert "def _validate_pkm_context_requirements" in _STREAM_SOURCE
    assert "pkm_holdings" in _STREAM_SOURCE
    assert "pkm_portfolio_snapshot" in _STREAM_SOURCE
    assert "pkm_coverage" in _STREAM_SOURCE
    assert 'full_user_context.get("holdings_summary")' in _STREAM_SOURCE
    assert 'full_user_context.get("debate_context")' in _STREAM_SOURCE
    assert "def _validate_renaissance_context_requirements" in _STREAM_SOURCE
    assert "renaissance_context_lookup" in _STREAM_SOURCE


def test_stream_fail_closed_error_contract_is_present():
    assert '"code": "ANALYZE_CONTEXT_REQUIRED"' in _STREAM_SOURCE
    assert '"missing_requirements": missing_requirements' in _STREAM_SOURCE
    assert '"context_integrity": context_integrity' in _STREAM_SOURCE
    assert "terminal=True" in _STREAM_SOURCE


def test_decision_payload_contains_context_traceability_fields():
    assert '"context_integrity": context_integrity' in _STREAM_SOURCE
    assert '"renaissance_comparison": renaissance_comparison' in _STREAM_SOURCE
    assert "def _build_renaissance_comparison" in _STREAM_SOURCE
