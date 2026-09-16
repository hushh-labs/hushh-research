"""
tests/test_pkm_convenience_tools.py

Unit tests for read_own_pkm_attribute, the convenience wrapper that collapses
request_consent -> check_consent_status -> get_encrypted_scoped_export into
one call. All three underlying handlers are monkeypatched -- this file tests
the orchestration logic (immediate grant, pending-then-poll-to-granted,
denied, and timeout-without-resolution), not the real consent backend.
"""

from __future__ import annotations

import json

import pytest

from mcp_modules.tools import pkm_convenience_tools as pkm


def _parse(result) -> dict:
    assert result, "Handler returned empty list"
    return json.loads(result[0].text)


def _content(payload: dict) -> list:
    from mcp.types import TextContent

    return [TextContent(type="text", text=json.dumps(payload))]


# ---------------------------------------------------------------------------
# Scope-component validation -- fails before any network call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalid_domain_rejected():
    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "Not-Valid!", "leaf": "diet"}
        )
    )
    assert payload["status"] == "error"
    assert payload["error_code"] == "INVALID_SCOPE_COMPONENT"


@pytest.mark.asyncio
async def test_invalid_leaf_rejected():
    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "food", "leaf": "###"}
        )
    )
    assert payload["status"] == "error"
    assert payload["error_code"] == "INVALID_SCOPE_COMPONENT"


# ---------------------------------------------------------------------------
# request_consent error passthrough
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_consent_error_is_passed_through(monkeypatch):
    error_payload = {"error_code": "AUTHENTICATION_REQUIRED", "message": "no token"}

    async def fake_request_consent(args):
        return _content(error_payload), error_payload

    monkeypatch.setattr(pkm, "handle_request_consent", fake_request_consent)

    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "food", "leaf": "diet"}
        )
    )
    assert payload["error_code"] == "AUTHENTICATION_REQUIRED"


# ---------------------------------------------------------------------------
# Immediate grant path -- skips polling entirely
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_immediate_grant_skips_polling(monkeypatch):
    granted_payload = {"status": "granted", "grant_ref": "grant_123", "scope": "attr.food.diet.*"}
    export_payload = {"status": "success", "granted_scope": "attr.food.diet.*"}

    calls = {"check_consent_status": 0}

    async def fake_request_consent(args):
        assert args["scope"] == "attr.food.diet.*"
        return _content(granted_payload), granted_payload

    async def fake_check_consent_status(args):
        calls["check_consent_status"] += 1
        raise AssertionError("should not poll when already granted")

    async def fake_get_export(args):
        assert args == {"grant_ref": "grant_123", "expected_scope": "attr.food.diet.*"}
        return _content(export_payload), export_payload

    monkeypatch.setattr(pkm, "handle_request_consent", fake_request_consent)
    monkeypatch.setattr(pkm, "handle_check_consent_status", fake_check_consent_status)
    monkeypatch.setattr(pkm, "handle_get_encrypted_scoped_export", fake_get_export)

    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "food", "leaf": "diet"}
        )
    )
    assert payload == export_payload
    assert calls["check_consent_status"] == 0


# ---------------------------------------------------------------------------
# Pending -> poll -> granted path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pending_then_granted_polls_and_exports(monkeypatch):
    pending_payload = {
        "status": "pending",
        "request_ref": "req_1",
        "poll_after_seconds": 0,
    }
    granted_status_payload = {"status": "granted", "grant_ref": "grant_9"}
    export_payload = {"status": "success", "granted_scope": "attr.food.diet.*"}

    poll_count = {"n": 0}

    async def fake_request_consent(args):
        return _content(pending_payload), pending_payload

    async def fake_check_consent_status(args):
        assert args == {"request_ref": "req_1"}
        poll_count["n"] += 1
        return _content(granted_status_payload), granted_status_payload

    async def fake_get_export(args):
        assert args == {"grant_ref": "grant_9", "expected_scope": "attr.food.diet.*"}
        return _content(export_payload), export_payload

    monkeypatch.setattr(pkm, "handle_request_consent", fake_request_consent)
    monkeypatch.setattr(pkm, "handle_check_consent_status", fake_check_consent_status)
    monkeypatch.setattr(pkm, "handle_get_encrypted_scoped_export", fake_get_export)
    monkeypatch.setattr(pkm.asyncio, "sleep", _fast_sleep)

    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "food", "leaf": "diet", "max_wait_seconds": 5}
        )
    )
    assert payload == export_payload
    assert poll_count["n"] == 1


# ---------------------------------------------------------------------------
# Denied while polling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_denied_while_polling_returns_denied_status(monkeypatch):
    pending_payload = {"status": "pending", "request_ref": "req_2", "poll_after_seconds": 0}
    denied_payload = {"status": "denied"}

    async def fake_request_consent(args):
        return _content(pending_payload), pending_payload

    async def fake_check_consent_status(args):
        return _content(denied_payload), denied_payload

    monkeypatch.setattr(pkm, "handle_request_consent", fake_request_consent)
    monkeypatch.setattr(pkm, "handle_check_consent_status", fake_check_consent_status)
    monkeypatch.setattr(pkm.asyncio, "sleep", _fast_sleep)

    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "food", "leaf": "diet", "max_wait_seconds": 5}
        )
    )
    assert payload["status"] == "denied"
    assert payload["request_ref"] == "req_2"


# ---------------------------------------------------------------------------
# Timeout without resolution -- must return "pending", never raise/hang
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_without_resolution_returns_pending(monkeypatch):
    pending_payload = {"status": "pending", "request_ref": "req_3", "poll_after_seconds": 0}
    still_pending_status_payload = {"status": "pending", "poll_after_seconds": 0}

    async def fake_request_consent(args):
        return _content(pending_payload), pending_payload

    async def fake_check_consent_status(args):
        return _content(still_pending_status_payload), still_pending_status_payload

    monkeypatch.setattr(pkm, "handle_request_consent", fake_request_consent)
    monkeypatch.setattr(pkm, "handle_check_consent_status", fake_check_consent_status)
    monkeypatch.setattr(pkm.asyncio, "sleep", _fast_sleep)
    # Force the deadline loop to exit after a couple of (fast, mocked) polls
    # instead of racing wall-clock time in the test.
    monkeypatch.setattr(pkm.time, "monotonic", _fake_monotonic())

    payload = _parse(
        await pkm.handle_read_own_pkm_attribute(
            {"user_identifier": "u1", "domain": "food", "leaf": "diet", "max_wait_seconds": 1}
        )
    )
    assert payload["status"] == "pending"
    assert payload["request_ref"] == "req_3"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _fast_sleep(_seconds: float) -> None:
    return None


def _fake_monotonic():
    """A monotonic() stub that advances 2s per call, past a 1s deadline fast."""
    state = {"t": 0.0}

    def _next() -> float:
        state["t"] += 2.0
        return state["t"]

    return _next
