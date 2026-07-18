"""Minimal proof: ANALYZE_STREAM_FAILED SSE event uses an opaque message (CWE-209).

Canonical attach point: api/routes/kai/stream.py analyze_stream_generator,
the except Exception handler that emits the ANALYZE_STREAM_FAILED terminal
event consumed by GET /api/kai/analyze/stream.
"""

from __future__ import annotations

from pathlib import Path

_STREAM_PY = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai" / "stream.py"


def test_analyze_stream_failed_message_is_static():
    """ANALYZE_STREAM_FAILED event must carry a static message, not str(e)."""
    source = _STREAM_PY.read_text(encoding="utf-8")

    assert '"Analysis failed. Please try again."' in source

    idx = source.find('"ANALYZE_STREAM_FAILED"')
    assert idx != -1, "ANALYZE_STREAM_FAILED event not found in stream.py"
    snippet = source[idx : idx + 200]
    assert '"message": str(e)' not in snippet, (
        "ANALYZE_STREAM_FAILED event still forwards str(e) as message"
    )
