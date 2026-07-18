"""Tests that debate_engine uses UTC-aware datetimes instead of deprecated utcnow().

Uses source-level assertions to avoid import-time side effects from the agent
stack that requires environment variables.
"""

import pathlib
import re

_SRC = (
    pathlib.Path(__file__).parent.parent
    / "hushh_mcp"
    / "agents"
    / "kai"
    / "debate_engine.py"
)


def test_utc_imported():
    src = _SRC.read_text()
    assert re.search(r"from datetime import.*\bUTC\b", src), (
        "debate_engine must import UTC from datetime"
    )


def test_no_utcnow_calls():
    src = _SRC.read_text()
    assert "datetime.utcnow()" not in src, (
        "debate_engine must not call deprecated datetime.utcnow()"
    )


def test_datetime_now_utc_used():
    src = _SRC.read_text()
    assert re.search(r"datetime\.now\(UTC\)", src), (
        "debate_engine must use datetime.now(UTC) for DebateRound timestamps"
    )
