"""Tests that kai_chat_service stores analyzed_at as a UTC-aware datetime.

These tests assert source-level properties to avoid the env-var requirements
that prevent importing the module directly.
"""

import pathlib
import re

_SRC = (
    pathlib.Path(__file__).parent.parent
    / "hushh_mcp"
    / "services"
    / "kai_chat_service.py"
)


def test_datetime_import_includes_utc():
    src = _SRC.read_text()
    assert re.search(r"from datetime import.*\bUTC\b", src), (
        "kai_chat_service must import UTC from datetime"
    )


def test_analyzed_at_uses_utc():
    src = _SRC.read_text()
    assert re.search(r"datetime\.now\(UTC\)", src), (
        "analyzed_at must use datetime.now(UTC) not naive datetime.now()"
    )


def test_naive_datetime_now_not_present_in_analyzed_at():
    src = _SRC.read_text()
    # Look for datetime.now() with no argument (naive call)
    naive_calls = re.findall(r"datetime\.now\(\s*\)", src)
    assert not naive_calls, (
        "kai_chat_service must not call naive datetime.now() -- found: %s" % naive_calls
    )
