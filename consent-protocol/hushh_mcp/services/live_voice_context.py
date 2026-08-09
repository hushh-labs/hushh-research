"""Freshest published browser context for an in-flight live voice session.

``Runner.run_live`` opens ONE long-lived invocation per websocket, so the
session snapshot its tools read is captured when the socket connects and never
observes a later ``app_context`` frame. The relay persists every frame with
``append_event``, but that lands on the session service rather than on the
invocation already streaming.

The observable failure: after a navigation the relay logs the new screen while
the goal tools keep reporting the screen the person was on when they started
talking. A cross-screen journey could therefore never continue, and each retry
re-read the same frozen value instead of converging on the truth.

This module is the freshness seam for that read. It is deliberately NOT an
authority: execution stays gated by the browser-declared action inventory and
the generated manifest, exactly as before. It only stops the tools reasoning
about a screen the person left several turns ago.

It lives in ``hushh_mcp.services`` rather than beside the relay because the
dependency runs one way: ``api`` may import ``hushh_mcp``, never the reverse.
Both the relay (writer) and the action tools (reader) can reach it here.

Scale plane (AGENTS.md, "Postgres now, Redis later"): process-local is correct
today because a live socket is pinned to one instance for its whole lifetime,
so there is no cross-instance reader. Should live sessions ever migrate between
instances, swap the dict for the shared session tier behind these same three
functions and no caller changes.
"""

from __future__ import annotations

from typing import Any

_LIVE_CONTEXT_BY_SESSION: dict[str, dict[str, Any]] = {}


def publish_live_voice_context(session_id: str | None, context: dict[str, Any]) -> None:
    """Record the newest sanitized context for a live session."""
    clean_id = str(session_id or "").strip()
    if clean_id and isinstance(context, dict):
        _LIVE_CONTEXT_BY_SESSION[clean_id] = context


def read_live_voice_context(session_id: str | None) -> dict[str, Any] | None:
    """Return the newest sanitized context for a live session, if published."""
    clean_id = str(session_id or "").strip()
    if not clean_id:
        return None
    return _LIVE_CONTEXT_BY_SESSION.get(clean_id)


def clear_live_voice_context(session_id: str | None) -> None:
    """Drop a session's context when its socket closes."""
    clean_id = str(session_id or "").strip()
    if clean_id:
        _LIVE_CONTEXT_BY_SESSION.pop(clean_id, None)
