"""Advisory Gmail send readiness for One's typed-chat Gmail draft; it never raises."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from hushh_mcp.one_adk import email_draft_readiness as draft_readiness
from hushh_mcp.services.gmail_receipts_service import GmailApiError

OWNER = "owner-1"


class _Gmail:
    def __init__(self, error: Exception | None, state: str | Exception) -> None:
        self.error = error
        self.state = state
        self.owners: list[str] = []

    async def assert_send_ready(self, *, user_id: str) -> None:
        self.owners.append(user_id)
        if self.error is not None:
            raise self.error

    async def get_status(self, *, user_id: str) -> dict[str, Any]:
        if isinstance(self.state, Exception):
            raise self.state
        return {"connection_state": self.state}


def _admission(code: str) -> GmailApiError:
    return GmailApiError("refused", status_code=409, code=code)


@pytest.mark.parametrize(
    ("error", "state", "expected"),
    [
        (None, "connected", "ready"),
        (_admission("GMAIL_NOT_CONNECTED"), "not_connected", "connect_required"),
        # Admission calls a lapsed grant "not connected" too; the Mail card says
        # "Reconnect Mail" for it, so readiness must not say "Connect Gmail".
        (_admission("GMAIL_NOT_CONNECTED"), "needs_reauth", "reconnect_required"),
        (_admission("GMAIL_NOT_CONNECTED"), RuntimeError("database unavailable"), "unknown"),
        (_admission("GMAIL_SEND_PERMISSION_REQUIRED"), "connected", "send_permission_required"),
        (_admission("GMAIL_SEND_DISABLED"), "connected", "send_disabled"),
        (_admission("GMAIL_SENDER_UNAVAILABLE"), "connected", "unknown"),
        (RuntimeError("database unavailable"), "connected", "unknown"),
    ],
)
async def test_send_readiness_maps_each_admission_code(monkeypatch, error, state, expected):
    gmail = _Gmail(error, state)
    monkeypatch.setattr(draft_readiness, "get_gmail_receipts_service", lambda: gmail)

    assert await draft_readiness.gmail_send_readiness(OWNER) == expected
    assert gmail.owners == [OWNER]


@pytest.mark.parametrize("stalled", ["assert_send_ready", "get_status"])
async def test_send_readiness_times_out_to_unknown(monkeypatch, stalled):
    never = asyncio.Event()
    finished = asyncio.Event()

    class _Stalled:
        async def assert_send_ready(self, *, user_id: str) -> None:
            if stalled == "assert_send_ready":
                await never.wait()
            raise _admission("GMAIL_NOT_CONNECTED")

        async def get_status(self, *, user_id: str) -> dict[str, Any]:
            try:
                await never.wait()
            except asyncio.CancelledError:
                # Like the real account check: finish the database call first.
                await finished.wait()
                raise
            return {"connection_state": "needs_reauth"}

    monkeypatch.setattr(draft_readiness, "get_gmail_receipts_service", _Stalled)

    # One budget covers both reads; the outer bound fails the test instead of hanging.
    readiness = draft_readiness.gmail_send_readiness(OWNER, timeout_seconds=0.01)
    assert await asyncio.wait_for(readiness, timeout=1) == "unknown"
    finished.set()
