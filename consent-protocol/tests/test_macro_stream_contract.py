"""Macro agent stream contract stability tests."""

from __future__ import annotations

from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]


def test_analyze_stream_contract_is_stable():
    """Verify that adding the macro agent contract did not change stream.py yet."""
    analyze_source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    # Verify NO macro agent initialization in stream.py yet (Narrow Contract PR goal)
    assert "MacroAgent" not in analyze_source
    assert '"agent": "macro"' not in analyze_source

    # Verify legacy 3-agent gather
    assert (
        "fundamental_first_res, sentiment_first_res, valuation_first_res = concurrent_results"
        in analyze_source
    )
