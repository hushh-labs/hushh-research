"""Minimal proof: OPTIMIZE_STREAM_FAILED SSE event uses an opaque message (CWE-209).

Canonical attach point: api/routes/kai/losers.py optimize stream generator,
the except Exception handler that emits the OPTIMIZE_STREAM_FAILED terminal
event consumed by POST /api/kai/analyze/losers/optimize.
"""

from __future__ import annotations

from pathlib import Path

_LOSERS_PY = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai" / "losers.py"


def test_optimize_stream_failed_message_is_static():
    """OPTIMIZE_STREAM_FAILED event must carry a static message, not str(e)."""
    source = _LOSERS_PY.read_text(encoding="utf-8")

    assert '"Optimization failed. Please try again."' in source

    idx = source.find('"OPTIMIZE_STREAM_FAILED"')
    assert idx != -1, "OPTIMIZE_STREAM_FAILED event not found in losers.py"
    snippet = source[idx : idx + 200]
    assert '"message": str(e)' not in snippet, (
        "OPTIMIZE_STREAM_FAILED event still forwards str(e) as message"
    )
