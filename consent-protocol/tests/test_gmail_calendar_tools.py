"""
tests/test_gmail_calendar_tools.py

Unit tests for the read-only Gmail receipts + Google Calendar MCP tool
handlers.

The load-bearing assertion in this file is the calendar redaction contract:
list_upcoming_calendar_events must reduce
GoogleCalendarService.list_events()'s raw event summaries (which include
description/location/attendees with emails) down to
title/start/end/status only.
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.google_connection_service import GoogleConnectionError
from mcp_modules.tools import gmail_calendar_tools


def _parse(result) -> dict:
    assert result, "Handler returned empty list"
    return json.loads(result[0].text)


# ---------------------------------------------------------------------------
# Missing-argument / auth-path tests -- no service call reached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_receipts_missing_args_returns_error():
    payload = _parse(await gmail_calendar_tools.handle_list_gmail_receipts({}))
    assert payload["status"] == "error"


@pytest.mark.asyncio
async def test_list_events_missing_args_returns_error():
    payload = _parse(await gmail_calendar_tools.handle_list_upcoming_calendar_events({}))
    assert payload["status"] == "error"


@pytest.mark.asyncio
async def test_list_receipts_wrong_user_token_returns_forbidden(vault_owner_token_for_user):
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await gmail_calendar_tools.handle_list_gmail_receipts(
            {"user_id": "user_b", "consent_token": token}
        )
    )
    assert payload["status"] == "forbidden"
    assert payload["reason"] == "token_user_mismatch"


@pytest.mark.asyncio
async def test_list_events_wrong_user_token_returns_forbidden(vault_owner_token_for_user):
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await gmail_calendar_tools.handle_list_upcoming_calendar_events(
            {
                "user_id": "user_b",
                "consent_token": token,
                "start_at": "2026-01-01T00:00:00Z",
                "end_at": "2026-01-02T00:00:00Z",
            }
        )
    )
    assert payload["status"] == "forbidden"
    assert payload["reason"] == "token_user_mismatch"


@pytest.mark.asyncio
async def test_list_events_missing_start_end_after_auth_returns_error(vault_owner_token_for_user):
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await gmail_calendar_tools.handle_list_upcoming_calendar_events(
            {"user_id": "user_a", "consent_token": token}
        )
    )
    assert payload["status"] == "error"
    assert "start_at" in payload["error"]


# ---------------------------------------------------------------------------
# list_gmail_receipts -- passthrough of the pre-synced receipts table
# ---------------------------------------------------------------------------

_RAW_RECEIPTS_RESULT = {
    "items": [{"id": "r1", "merchant_name": "Acme", "amount": "12.34"}],
    "page": 1,
    "per_page": 25,
    "total": 1,
    "has_more": False,
}


@pytest.mark.asyncio
async def test_list_receipts_returns_service_result(monkeypatch, vault_owner_token_for_user):
    async def fake_list_receipts(self, *, user_id, page, per_page):
        return _RAW_RECEIPTS_RESULT

    monkeypatch.setattr(
        gmail_calendar_tools.get_gmail_receipts_service().__class__,
        "list_receipts",
        fake_list_receipts,
    )
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await gmail_calendar_tools.handle_list_gmail_receipts(
            {"user_id": "user_a", "consent_token": token}
        )
    )
    assert payload["status"] == "ok"
    assert payload["items"] == _RAW_RECEIPTS_RESULT["items"]
    assert payload["total"] == 1


# ---------------------------------------------------------------------------
# list_upcoming_calendar_events -- the redaction contract
# ---------------------------------------------------------------------------

_RAW_EVENTS_RESULT = {
    "events": [
        {
            "id": "e1",
            "etag": '"abc"',
            "title": "1:1 with Jamie",
            "description": "Discuss the Q3 roadmap and comp review.",
            "location": "123 Private Rd, Springfield",
            "start": {"dateTime": "2026-01-01T10:00:00Z"},
            "end": {"dateTime": "2026-01-01T10:30:00Z"},
            "status": "confirmed",
            "attendees": [{"email": "jamie@example.com", "response_status": "accepted"}],
            "html_link": "https://calendar.google.com/event?eid=abc",
            "updated": "2025-12-01T00:00:00Z",
        }
    ],
    "time_zone": "America/Los_Angeles",
}


@pytest.mark.asyncio
async def test_list_events_redacts_sensitive_fields(monkeypatch, vault_owner_token_for_user):
    async def fake_list_events(self, *, user_id, start_at, end_at, max_results=50):
        return _RAW_EVENTS_RESULT

    monkeypatch.setattr(
        gmail_calendar_tools.get_google_calendar_service().__class__,
        "list_events",
        fake_list_events,
    )
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await gmail_calendar_tools.handle_list_upcoming_calendar_events(
            {
                "user_id": "user_a",
                "consent_token": token,
                "start_at": "2026-01-01T00:00:00Z",
                "end_at": "2026-01-02T00:00:00Z",
            }
        )
    )

    assert payload["status"] == "ok"
    assert payload["events"] == [
        {
            "title": "1:1 with Jamie",
            "start": {"dateTime": "2026-01-01T10:00:00Z"},
            "end": {"dateTime": "2026-01-01T10:30:00Z"},
            "status": "confirmed",
        }
    ]

    serialized = json.dumps(payload)
    for forbidden in (
        "description",
        "Q3 roadmap",
        "location",
        "Springfield",
        "attendees",
        "jamie@example.com",
        "html_link",
    ):
        assert forbidden not in serialized, f"{forbidden!r} leaked into calendar event response"


@pytest.mark.asyncio
async def test_list_events_maps_connection_error_to_status_error(
    monkeypatch, vault_owner_token_for_user
):
    async def fake_list_events(self, *, user_id, start_at, end_at, max_results=50):
        raise GoogleConnectionError("Calendar is not connected", status_code=409)

    monkeypatch.setattr(
        gmail_calendar_tools.get_google_calendar_service().__class__,
        "list_events",
        fake_list_events,
    )
    token = vault_owner_token_for_user(user_id="user_a")
    payload = _parse(
        await gmail_calendar_tools.handle_list_upcoming_calendar_events(
            {
                "user_id": "user_a",
                "consent_token": token,
                "start_at": "2026-01-01T00:00:00Z",
                "end_at": "2026-01-02T00:00:00Z",
            }
        )
    )
    assert payload["status"] == "error"
    assert "not connected" in payload["error"]
