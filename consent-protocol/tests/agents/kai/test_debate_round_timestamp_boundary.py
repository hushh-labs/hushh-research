"""Runtime enforcement tests for DebateRound timestamp timezone boundary.

Verifies that DebateRound rejects naive datetimes at construction time,
independently strengthening the trust boundary rather than merely preserving
the call-site change from datetime.utcnow() to datetime.now(UTC).
"""

from datetime import UTC, datetime

import pytest

from hushh_mcp.agents.kai.debate_engine import DebateRound

_STATEMENTS = {"fundamental": "bullish", "sentiment": "neutral", "valuation": "hold"}


def test_debate_round_rejects_naive_timestamp():
    naive = datetime(2024, 1, 15, 12, 0, 0)
    assert naive.tzinfo is None
    with pytest.raises(ValueError, match="timezone-aware"):  # noqa: PT011
        DebateRound(round_number=1, agent_statements=_STATEMENTS, timestamp=naive)


def test_debate_round_accepts_utc_aware_timestamp():
    aware = datetime.now(UTC)
    round_ = DebateRound(round_number=1, agent_statements=_STATEMENTS, timestamp=aware)
    assert round_.timestamp.tzinfo is not None


def test_debate_round_timestamp_carries_utc_offset():
    aware = datetime.now(UTC)
    round_ = DebateRound(round_number=1, agent_statements=_STATEMENTS, timestamp=aware)
    assert round_.timestamp.utcoffset().total_seconds() == 0
