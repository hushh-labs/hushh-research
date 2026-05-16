"""Canonical Kai stream contract tests."""

from __future__ import annotations

import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_STREAMING_SPEC = importlib.util.spec_from_file_location(
    "kai_streaming_contract_module",
    _ROOT / "api/routes/kai/_streaming.py",
)
if _STREAMING_SPEC is None or _STREAMING_SPEC.loader is None:
    raise RuntimeError("Unable to load _streaming module for tests")
_STREAMING_MODULE = importlib.util.module_from_spec(_STREAMING_SPEC)
sys.modules[_STREAMING_SPEC.name] = _STREAMING_MODULE
_STREAMING_SPEC.loader.exec_module(_STREAMING_MODULE)

CanonicalSSEStream = _STREAMING_MODULE.CanonicalSSEStream
parse_json_with_single_repair = _STREAMING_MODULE.parse_json_with_single_repair


def _parse_frame_data(frame: dict[str, str]) -> dict:
    assert "event" in frame
    assert "id" in frame
    assert "data" in frame
    return json.loads(frame["data"])


def test_canonical_stream_event_envelope_shape():
    stream = CanonicalSSEStream("portfolio_import")
    frame = stream.event("stage", {"stage": "uploading"})
    envelope = _parse_frame_data(frame)

    assert frame["event"] == "stage"
    assert frame["id"] == "1"
    assert envelope["schema_version"] == "1.0"
    assert envelope["stream_kind"] == "portfolio_import"
    assert envelope["seq"] == 1
    assert envelope["event"] == "stage"
    assert envelope["terminal"] is False
    assert envelope["payload"]["stage"] == "uploading"
    assert envelope["payload"]["stream_id"] == envelope["stream_id"]
    assert envelope["payload"]["request_id"].startswith("req_")
    assert envelope["payload"]["phase"] == "uploading"
    assert envelope["payload"]["progress_pct"] >= 0


def test_canonical_stream_sequence_and_terminal_flags():
    stream = CanonicalSSEStream("stock_analyze")

    first = _parse_frame_data(stream.event("agent_start", {"agent": "fundamental"}))
    second = _parse_frame_data(stream.event("agent_token", {"agent": "fundamental", "text": "a"}))
    terminal = _parse_frame_data(stream.event("decision", {"decision": "buy"}, terminal=True))

    assert first["stream_id"] == second["stream_id"] == terminal["stream_id"]
    assert [first["seq"], second["seq"], terminal["seq"]] == [1, 2, 3]
    assert first["terminal"] is False
    assert second["terminal"] is False
    assert terminal["terminal"] is True
    assert terminal["event"] == "decision"


def test_all_stream_kinds_emit_valid_envelopes():
    for stream_kind in ("portfolio_import", "portfolio_optimize", "stock_analyze"):
        stream = CanonicalSSEStream(stream_kind)  # type: ignore[arg-type]
        envelope = _parse_frame_data(stream.event("stage", {"status": "ok"}))
        assert envelope["stream_kind"] == stream_kind
        assert isinstance(envelope["payload"], dict)


def test_canonical_stream_progress_is_monotonic_and_terminal_complete_is_100():
    stream = CanonicalSSEStream("portfolio_import")
    first = _parse_frame_data(stream.event("stage", {"stage": "uploading"}))
    second = _parse_frame_data(stream.event("stage", {"stage": "indexing"}))
    third = _parse_frame_data(stream.event("stage", {"stage": "scanning"}))
    fourth = _parse_frame_data(stream.event("stage", {"stage": "thinking"}))
    fifth = _parse_frame_data(stream.event("stage", {"stage": "extracting"}))
    sixth = _parse_frame_data(stream.event("stage", {"stage": "parsing"}))
    terminal = _parse_frame_data(stream.event("complete", {"message": "done"}, terminal=True))

    assert first["payload"]["progress_pct"] == 0.0
    assert second["payload"]["progress_pct"] == 0.0
    assert third["payload"]["progress_pct"] == 0.0
    assert fourth["payload"]["progress_pct"] == 0.0
    assert fifth["payload"]["progress_pct"] == 0.0
    assert sixth["payload"]["progress_pct"] == 0.0
    assert terminal["payload"]["progress_pct"] == 100.0
    assert terminal["payload"]["phase"] == "complete"


def test_canonical_stream_serializes_decimal_payload_values():
    stream = CanonicalSSEStream("stock_analyze")
    frame = stream.event(
        "decision",
        {
            "raw_card": {
                "price_targets": {"base_case": Decimal("123.45"), "ceiling": Decimal("150")},
                "conviction": Decimal("0.82"),
            }
        },
        terminal=True,
    )
    envelope = _parse_frame_data(frame)
    targets = envelope["payload"]["raw_card"]["price_targets"]

    assert isinstance(targets["base_case"], float)
    assert targets["base_case"] == 123.45
    assert isinstance(targets["ceiling"], int)
    assert targets["ceiling"] == 150
    assert envelope["payload"]["raw_card"]["conviction"] == 0.82


def test_stream_routes_use_canonical_stream_builder():
    portfolio_source = (_ROOT / "api/routes/kai/portfolio.py").read_text(encoding="utf-8")
    losers_source = (_ROOT / "api/routes/kai/losers.py").read_text(encoding="utf-8")
    analyze_source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    assert 'CanonicalSSEStream("portfolio_import")' in portfolio_source
    assert 'CanonicalSSEStream("portfolio_optimize")' in losers_source
    assert 'CanonicalSSEStream("stock_analyze")' in analyze_source


def test_stream_routes_emit_terminal_events():
    portfolio_source = (_ROOT / "api/routes/kai/portfolio.py").read_text(encoding="utf-8")
    losers_source = (_ROOT / "api/routes/kai/losers.py").read_text(encoding="utf-8")
    analyze_source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    assert "stream.event(\n" in portfolio_source
    assert '"complete",' in portfolio_source
    assert "terminal=True" in portfolio_source
    assert 'stream.event("complete", payload, terminal=True)' in losers_source
    assert 'create_event(\n            "decision",' in analyze_source
    assert '"ANALYZE_STREAM_FAILED"' in analyze_source


def test_analyze_stream_requires_explicit_round_phase_metadata():
    analyze_source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    assert "def _normalize_analyze_event_payload" in analyze_source
    assert '"round": 1' in analyze_source
    assert '"phase": "analysis"' in analyze_source


def test_analyze_stream_handles_round_start_and_starts_round_one():
    analyze_source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    assert '{"debate_round", "round_start"}' in analyze_source
    assert "current_round = 1" in analyze_source


def test_analyze_stream_emits_agent_start_before_parallel_analysis_calls():
    analyze_source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    gather_index = analyze_source.index("concurrent_results = await asyncio.gather")
    fundamental_start_index = analyze_source.index('"agent": "fundamental"')
    sentiment_start_index = analyze_source.index('"agent": "sentiment"')
    valuation_start_index = analyze_source.index('"agent": "valuation"')

    assert fundamental_start_index < gather_index
    assert sentiment_start_index < gather_index
    assert valuation_start_index < gather_index


def test_single_repair_pass_inserts_missing_commas_and_balances_braces():
    raw = '{"account_metadata":{"account_holder":"Ada"} "detailed_holdings":[{"symbol":"AAPL"}]'
    parsed, diagnostics = parse_json_with_single_repair(raw, required_keys={"detailed_holdings"})

    assert parsed["account_metadata"]["account_holder"] == "Ada"
    assert parsed["detailed_holdings"][0]["symbol"] == "AAPL"
    assert "inserted_missing_commas" in diagnostics["repair_actions"]
    assert "balanced_delimiters" in diagnostics["repair_actions"]
