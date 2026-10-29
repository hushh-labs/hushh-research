"""One's typed-chat draft recipients and Gmail send readiness.

Names match only the owner's active connections; a refusal never carries an
email address; a supplied address needs no lookup; readiness never raises.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from hushh_mcp.one_adk import email_draft_recipients as recipients
from hushh_mcp.services.gmail_receipts_service import GmailApiError

OWNER = "owner-1"


def _row(name: str, email: str | None) -> dict[str, Any]:
    return {
        "connectionId": f"connection-{name}",
        "userId": f"user-{name}",
        "displayName": name,
        "email": email,
        "emailVerified": True,
    }


class _Connections:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.reads: list[str] = []

    def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        self.reads.append(user_id)
        return self.rows


@pytest.fixture
def connections(monkeypatch: pytest.MonkeyPatch) -> _Connections:
    fake = _Connections()
    monkeypatch.setattr(recipients, "ConnectionsService", lambda: fake)
    return fake


@pytest.mark.parametrize("arguments", [{"recipient_names": "Sharu"}, {"to": "Sharu"}])
async def test_a_nickname_resolves_to_its_connection_email(connections, arguments):
    connections.rows = [
        _row("Priya Shah", "priya@example.com"),
        _row("Sharukh Khan", "Sharukh@Example.com"),
    ]

    result = await recipients.resolve_draft_recipients(OWNER, **arguments)

    assert result == {
        "status": "ok",
        "to": "sharukh@example.com",
        "cc": "",
        "bcc": "",
        "recipients": [{"name": "Sharukh Khan", "role": "to"}],
    }
    assert connections.reads == [OWNER]


async def test_two_matching_connections_need_a_choice_without_any_email(connections):
    connections.rows = [
        _row("Sharukh Khan", "khan@example.com"),
        _row("Sharuk Mehta", "mehta@example.com"),
        # A provider-synced display name can itself be an address.
        _row("sharuk.r@example.com", "sharuk.r@example.com"),
    ]

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sharu")

    assert result["status"] == "recipient_choice_needed"
    assert result["name"] == "Sharu"
    assert result["candidates"] == ["Sharukh Khan", "Sharuk Mehta", "Hussh member"]
    assert "@" not in json.dumps(result)


async def test_a_whole_word_match_breaks_a_tie_only_when_it_is_unique(connections):
    connections.rows = [
        _row("Devika Rao", "devika@example.com"),
        _row("Dev Patel", "dev@example.com"),
    ]

    picked = await recipients.resolve_draft_recipients(OWNER, recipient_names="Dev")
    connections.rows.append(_row("Dev Shah", "shah@example.com"))
    still_ambiguous = await recipients.resolve_draft_recipients(OWNER, recipient_names="Dev")

    assert (picked["to"], picked["recipients"]) == (
        "dev@example.com",
        [{"name": "Dev Patel", "role": "to"}],
    )
    assert still_ambiguous["status"] == "recipient_choice_needed"
    assert still_ambiguous["candidates"] == ["Dev Patel", "Dev Shah", "Devika Rao"]


async def test_connections_sharing_one_mailbox_count_as_one(connections):
    connections.rows = [
        _row("Sharukh Khan", "khan@example.com"),
        _row("Sharukh K", "KHAN@example.com"),
    ]

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sharu")

    assert result["status"] == "ok"
    assert result["to"] == "khan@example.com"


async def test_a_name_outside_active_connections_is_not_found(connections):
    connections.rows = [_row("Priya Shah", "priya@example.com")]

    result = await recipients.resolve_draft_recipients(OWNER, to="Sharu")

    assert (result["status"], result["name"]) == ("recipient_not_found", "Sharu")
    assert "Sharu" in result["message"]
    assert "@" not in json.dumps(result)


@pytest.mark.parametrize("email", [None, "", "s•••@example.com", "not-an-address"])
async def test_a_connection_without_a_usable_email_is_reported(connections, email):
    connections.rows = [_row("Sharukh Khan", email)]

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sharu")

    assert result["status"] == "recipient_email_unavailable"
    assert (result["name"], result["display_name"]) == ("Sharu", "Sharukh Khan")
    assert "@" not in json.dumps(result)


async def test_supplied_addresses_pass_through_untouched_without_a_lookup(connections):
    result = await recipients.resolve_draft_recipients(
        OWNER,
        # The quoted comma is part of one display name, not a second recipient.
        to='"Khan, Sharukh" <Sharukh@Example.com>',
        bcc="dev@example.com",
    )

    assert result == {
        "status": "ok",
        "to": '"Khan, Sharukh" <Sharukh@Example.com>',
        "cc": "",
        "bcc": "dev@example.com",
        "recipients": [],
    }
    assert connections.reads == []


@pytest.mark.parametrize(
    "arguments",
    [
        {"to": "sharu@"},
        {"cc": "Priya Shah, priya@@example"},
        {"bcc": "s***@example.com"},
        {"to": "sharu@example.com dev"},
    ],
)
async def test_an_invalid_address_is_refused_without_echo_or_lookup(connections, arguments):
    result = await recipients.resolve_draft_recipients(OWNER, **arguments)

    assert result["status"] == "invalid_recipient"
    assert "@" not in json.dumps(result)
    assert connections.reads == []


async def test_cc_names_take_cc_and_each_mailbox_appears_once(connections):
    connections.rows = [
        _row("Sharukh Khan", "sharukh@example.com"),
        _row("Priya Shah", "priya@example.com"),
        _row("Dev Patel", "dev@example.com"),
    ]

    result = await recipients.resolve_draft_recipients(
        OWNER,
        to="Priya@Example.com; Sharu",
        recipient_names="sharu",
        cc="PRIYA@example.com",
        cc_names="Priya and Dev",
    )

    assert result == {
        "status": "ok",
        "to": "Priya@Example.com, sharukh@example.com",
        "cc": "dev@example.com",
        "bcc": "",
        "recipients": [
            {"name": "Sharukh Khan", "role": "to"},
            {"name": "Priya Shah", "role": "to"},
            {"name": "Dev Patel", "role": "cc"},
        ],
    }
    assert connections.reads == [OWNER]


async def test_too_many_recipients_are_refused_before_a_lookup(connections):
    names = ", ".join(f"Person{index}" for index in range(recipients.MAX_DRAFT_RECIPIENTS + 1))

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names=names)

    assert result["status"] == "too_many_recipients"
    assert connections.reads == []


async def test_a_failed_connections_read_is_a_refusal_not_a_guess(monkeypatch):
    class _Unavailable:
        def list_connections(self, user_id: str) -> list[dict[str, Any]]:
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(recipients, "ConnectionsService", _Unavailable)

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sharu")

    assert result["status"] == "recipient_lookup_unavailable"


class _Gmail:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.owners: list[str] = []

    async def assert_send_ready(self, *, user_id: str) -> None:
        self.owners.append(user_id)
        if self.error is not None:
            raise self.error


def _admission(code: str) -> GmailApiError:
    return GmailApiError("refused", status_code=409, code=code)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (None, "ready"),
        (_admission("GMAIL_NOT_CONNECTED"), "connect_required"),
        (_admission("GMAIL_SEND_PERMISSION_REQUIRED"), "send_permission_required"),
        (_admission("GMAIL_SEND_DISABLED"), "send_disabled"),
        (_admission("GMAIL_SENDER_UNAVAILABLE"), "unknown"),
        (RuntimeError("database unavailable"), "unknown"),
    ],
)
async def test_send_readiness_maps_each_admission_code(monkeypatch, error, expected):
    gmail = _Gmail(error)
    monkeypatch.setattr(recipients, "get_gmail_receipts_service", lambda: gmail)

    assert await recipients.gmail_send_readiness(OWNER) == expected
    assert gmail.owners == [OWNER]


async def test_send_readiness_times_out_to_unknown(monkeypatch):
    never = asyncio.Event()

    class _Stalled:
        async def assert_send_ready(self, *, user_id: str) -> None:
            await never.wait()

    monkeypatch.setattr(recipients, "get_gmail_receipts_service", _Stalled)

    assert await recipients.gmail_send_readiness(OWNER, timeout_seconds=0.01) == "unknown"
