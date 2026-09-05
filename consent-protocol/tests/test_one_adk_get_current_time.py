# tests/test_one_adk_get_current_time.py
"""
Unit tests for One's `get_current_time` root-agent tool
(hushh_mcp/one_adk/action_tools.py).

Contract under test: the tool is the only grounding One's Live/text heads
have for "now" (#voice-current-time). It must
- default to UTC when the session has no declared timezone,
- honor a valid IANA timezone from session state,
- never raise on a garbage timezone string -- falling back to UTC instead,
  the same fail-closed shape as Calendar's own `_timezone` helper.
"""

from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

from hushh_mcp.one_adk import action_tools


def _context(timezone: str | None = None) -> SimpleNamespace:
    state: dict[str, object] = {}
    if timezone is not None:
        state["hussh:timezone"] = timezone
    return SimpleNamespace(state=state)


def test_get_current_time_defaults_to_utc_when_state_has_no_timezone() -> None:
    result = asyncio.run(action_tools.get_current_time(_context()))

    assert result["status"] == "ok"
    assert result["time_zone"] == "UTC"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", result["date"])
    assert re.fullmatch(r"\d{1,2}:\d{2} (AM|PM)", result["time"])
    assert result["weekday"]
    assert "UTC" in result["spoken"]


def test_get_current_time_uses_the_named_timezone_from_state() -> None:
    result = asyncio.run(action_tools.get_current_time(_context("America/Los_Angeles")))

    assert result["status"] == "ok"
    assert result["time_zone"] == "America/Los_Angeles"
    # PDT or PST depending on time of year -- either way, a real Pacific label,
    # proving the tool actually resolved the named zone rather than defaulting.
    assert any(label in result["spoken"] for label in ("PDT", "PST"))


def test_get_current_time_falls_back_to_utc_on_a_garbage_timezone() -> None:
    result = asyncio.run(action_tools.get_current_time(_context("not/a/real/zone")))

    assert result["status"] == "ok"
    assert result["time_zone"] == "UTC"


def test_resolve_timezone_matches_calendar_tools_default_and_fallback_shape() -> None:
    # Same contract as hushh_mcp.agents.calendar.tools._timezone: default
    # "UTC" when unset, validate with ZoneInfo, fall back to "UTC" rather
    # than raising on an unresolvable key.
    assert action_tools._resolve_timezone(_context()) == "UTC"
    assert action_tools._resolve_timezone(_context("Asia/Kolkata")) == "Asia/Kolkata"
    assert action_tools._resolve_timezone(_context("../etc")) == "UTC"
