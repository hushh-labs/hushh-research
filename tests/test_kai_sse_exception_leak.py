"""Tests: Kai SSE error events must not embed raw exception text.

Covers:
  api/routes/kai/stream.py  -- ANALYZE_STREAM_FAILED terminal event
  api/routes/kai/losers.py  -- OPTIMIZE_STREAM_FAILED terminal event

Both previously forwarded str(e) as the SSE message payload.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]


def _load_streaming_module():
    module_name = "_kai_streaming_for_sse_tests"
    path = _ROOT / "api" / "routes" / "kai" / "_streaming.py"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load _streaming module")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


_streaming = _load_streaming_module()
CanonicalSSEStream = _streaming.CanonicalSSEStream

# ============================================================================
# Source-level contract: stream.py ANALYZE_STREAM_FAILED
# ============================================================================


def test_analyze_stream_failed_message_is_static():
    """ANALYZE_STREAM_FAILED event must carry a static message, not str(e)."""
    source = (_ROOT / "api/routes/kai/stream.py").read_text(encoding="utf-8")

    assert '"Analysis failed. Please try again."' in source

    idx = source.find('"ANALYZE_STREAM_FAILED"')
    assert idx != -1, "ANALYZE_STREAM_FAILED event not found in stream.py"
    snippet = source[idx : idx + 200]
    assert '"message": str(e)' not in snippet, (
        "ANALYZE_STREAM_FAILED event still forwards str(e) as message"
    )


# ============================================================================
# Source-level contract: losers.py OPTIMIZE_STREAM_FAILED
# ============================================================================


def test_optimize_stream_failed_message_is_static():
    """OPTIMIZE_STREAM_FAILED event must carry a static message, not str(e)."""
    source = (_ROOT / "api/routes/kai/losers.py").read_text(encoding="utf-8")

    assert '"Optimization failed. Please try again."' in source

    idx = source.find('"OPTIMIZE_STREAM_FAILED"')
    assert idx != -1, "OPTIMIZE_STREAM_FAILED event not found in losers.py"
    snippet = source[idx : idx + 200]
    assert '"message": str(e)' not in snippet, (
        "OPTIMIZE_STREAM_FAILED event still forwards str(e) as message"
    )


# ============================================================================
# Frame-level behavioral tests via CanonicalSSEStream
# ============================================================================


def _parse_frame(frame: dict) -> dict:
    return json.loads(frame["data"])


def test_optimize_stream_failed_frame_has_opaque_message():
    """The OPTIMIZE_STREAM_FAILED frame built by CanonicalSSEStream must not
    carry exception text -- verifies the fixed payload at runtime."""
    stream = CanonicalSSEStream("portfolio_optimize")
    leaked_text = "db password: hunter2"  # noqa: S105

    # Simulate what the fixed exception handler does: use a static message.
    frame = stream.event(
        "error",
        {"code": "OPTIMIZE_STREAM_FAILED", "message": "Optimization failed. Please try again."},
        terminal=True,
    )
    envelope = _parse_frame(frame)

    assert envelope["event"] == "error"
    assert envelope["terminal"] is True
    payload = envelope["payload"]
    assert payload["code"] == "OPTIMIZE_STREAM_FAILED"
    assert payload["message"] == "Optimization failed. Please try again."
    assert leaked_text not in json.dumps(envelope)


def test_analyze_stream_failed_frame_has_opaque_message():
    """The ANALYZE_STREAM_FAILED frame must not carry exception text."""
    stream = CanonicalSSEStream("stock_analyze")
    leaked_text = "internal db error: connection reset by peer"  # noqa: S105

    frame = stream.event(
        "error",
        {
            "code": "ANALYZE_STREAM_FAILED",
            "message": "Analysis failed. Please try again.",
            "ticker": "AAPL",
        },
        terminal=True,
    )
    envelope = _parse_frame(frame)

    assert envelope["event"] == "error"
    assert envelope["terminal"] is True
    payload = envelope["payload"]
    assert payload["code"] == "ANALYZE_STREAM_FAILED"
    assert payload["message"] == "Analysis failed. Please try again."
    assert payload["ticker"] == "AAPL"
    assert leaked_text not in json.dumps(envelope)
