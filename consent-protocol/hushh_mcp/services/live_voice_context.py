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
        _COMPLETED_ACTIONS_BY_SESSION.pop(clean_id, None)
        _FAILED_ACTIONS_BY_SESSION.pop(clean_id, None)


# Actions that have already SUCCEEDED in this session, and are therefore not
# worth doing again until the person says something new.
#
# Same freshness problem as the context above, for the same reason: a tool
# reading `tool_context.state` cannot see a settlement that arrived after the
# streaming invocation opened, so `run_app_action` had no way to know the thing
# it was about to park a directive for had just been done.
#
# What that cost, observed live: One shared a location successfully, the
# composer cleared its selection the way it always does after a send, and One
# -- never having learned it succeeded -- tried again. Every retry then found
# an empty composer, settled "nobody is selected yet", and it tried again. A
# hard loop, on an action that had already worked. Removing confirmation is
# what exposed it: the card used to end One's turn, so a repeat was seconds
# apart instead of immediate.
_COMPLETED_ACTIONS_BY_SESSION: dict[str, dict[str, str]] = {}


def record_completed_action(session_id: str | None, action_id: str, fingerprint: str) -> None:
    """Remember that ``action_id`` succeeded, so an immediate repeat can be refused."""
    clean_id = str(session_id or "").strip()
    clean_action = str(action_id or "").strip()
    if not clean_id or not clean_action:
        return
    _COMPLETED_ACTIONS_BY_SESSION.setdefault(clean_id, {})[clean_action] = str(fingerprint or "")


def read_completed_action(session_id: str | None, action_id: str) -> str | None:
    """Return the fingerprint ``action_id`` last succeeded with, if any."""
    clean_id = str(session_id or "").strip()
    clean_action = str(action_id or "").strip()
    if not clean_id or not clean_action:
        return None
    return _COMPLETED_ACTIONS_BY_SESSION.get(clean_id, {}).get(clean_action)


def clear_completed_actions(session_id: str | None) -> None:
    """Forget what has been done, because the person has asked for something new.

    Called on fresh speech. Saying "share with Sarah" twice on purpose must
    work the second time -- this only ever suppresses One repeating itself
    inside one uninterrupted turn, never a person repeating themselves.
    """
    clean_id = str(session_id or "").strip()
    if clean_id:
        _COMPLETED_ACTIONS_BY_SESSION.pop(clean_id, None)
        _FAILED_ACTIONS_BY_SESSION.pop(clean_id, None)


# Actions that have already FAILED in this session, with the reason they gave.
#
# The success store above is only half the guard, and the missing half is the
# one that actually spins. A settlement is recorded only when it succeeds, so a
# failed action leaves no trace at all: `read_completed_action` returns None,
# the already-completed refusal cannot fire, and the relay admits the identical
# call again. Nothing anywhere says "this was just tried and did not work".
#
# Observed live on UAT: sharing with someone whose account has no encryption
# keys settled `failed`, and `location.share_selected` was then re-issued 24
# times in 15 seconds -- roughly twice a second -- against a backend that could
# only ever refuse it. Failure is the case that loops hardest precisely because
# it leaves the person's request unsatisfied, so the model keeps trying to
# satisfy it.
#
# The reason text is kept, not just the fingerprint, so the refusal can hand
# One the actual failure to report instead of a bare "stop". Telling a model to
# stop without giving it anything to say is what makes it try again.
_FAILED_ACTIONS_BY_SESSION: dict[str, dict[str, tuple[str, str]]] = {}


def record_failed_action(
    session_id: str | None,
    action_id: str,
    fingerprint: str,
    reason: str = "",
) -> None:
    """Remember that ``action_id`` failed, so an immediate identical retry can be refused."""
    clean_id = str(session_id or "").strip()
    clean_action = str(action_id or "").strip()
    if not clean_id or not clean_action:
        return
    _FAILED_ACTIONS_BY_SESSION.setdefault(clean_id, {})[clean_action] = (
        str(fingerprint or ""),
        str(reason or ""),
    )


def read_failed_action(session_id: str | None, action_id: str) -> tuple[str, str] | None:
    """Return ``(fingerprint, reason)`` for ``action_id``'s last failure, if any."""
    clean_id = str(session_id or "").strip()
    clean_action = str(action_id or "").strip()
    if not clean_id or not clean_action:
        return None
    return _FAILED_ACTIONS_BY_SESSION.get(clean_id, {}).get(clean_action)


def clear_failed_action(session_id: str | None, action_id: str) -> None:
    """Drop one action's failure record.

    Called when the same action later succeeds. Without this a success would sit
    behind a stale failure for the rest of the turn: the person fixes whatever
    was wrong, the action works, and the next legitimate call is still refused
    by a record describing a problem that no longer exists.
    """
    clean_id = str(session_id or "").strip()
    clean_action = str(action_id or "").strip()
    if not clean_id or not clean_action:
        return
    session_failures = _FAILED_ACTIONS_BY_SESSION.get(clean_id)
    if session_failures is not None:
        session_failures.pop(clean_action, None)
