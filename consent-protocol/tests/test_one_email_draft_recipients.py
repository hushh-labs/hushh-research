"""One's typed-chat draft recipients and Gmail send readiness.

Names match only the owner's active connections, and a name addresses the
draft only when it is the whole name, or whole words, of the one connection it
matches; anything else is a question. A refusal never carries an email
address; a supplied address needs no lookup; readiness never raises.
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


@pytest.mark.parametrize(
    ("arguments", "name", "address"),
    [
        ({"recipient_names": "Sharu"}, "Sharu Kumar", "sharu@example.com"),
        ({"to": "Sharu"}, "Sharu Kumar", "sharu@example.com"),
        ({"recipient_names": "priya sharma"}, "Priya Sharma", "priya.sharma@example.com"),
    ],
)
async def test_a_whole_name_or_whole_word_of_one_connection_addresses_the_draft(
    connections, arguments, name, address
):
    connections.rows = [
        _row("Priya Shah", "priya@example.com"),
        _row("Priya Sharma", "Priya.Sharma@Example.com"),
        _row("Sharu Kumar", "Sharu@Example.com"),
    ]

    result = await recipients.resolve_draft_recipients(OWNER, **arguments)

    assert result == {
        "status": "ok",
        "to": address,
        "cc": "",
        "bcc": "",
        "recipients": [{"name": name, "role": "to"}],
    }
    assert connections.reads == [OWNER]


@pytest.mark.parametrize(("said", "closest"), [("Mark", "Mary Chen"), ("Jo", "Benjamin Jones")])
async def test_a_misspelled_or_partial_match_is_a_question_not_an_address(
    connections, said, closest
):
    connections.rows = [
        _row("Mary Chen", "mary@example.com"),
        _row("Benjamin Jones", "ben@example.com"),
    ]

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names=said)

    # The shared spoken-name rule finds each alone, by edit distance or by a
    # substring of "Jones"; neither is the name or whole words of it.
    assert result == {
        "status": "recipient_choice_needed",
        "name": said,
        "candidates": [closest],
        "message": f"No connection is named {said} exactly; the closest is {closest}. "
        f"Ask whether they mean {closest}.",
    }


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


async def test_a_whole_word_match_beside_a_partial_one_is_still_a_question(connections):
    connections.rows = [
        _row("Samantha Ray", "samantha@example.com"),
        _row("Sam Lee", "sam@example.com"),
    ]

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sam")

    # No host tie-break: both are offered, the whole-word match first.
    assert result == {
        "status": "recipient_choice_needed",
        "name": "Sam",
        "candidates": ["Sam Lee", "Samantha Ray"],
        "message": "More than one connection matches Sam. Ask which one they mean.",
    }


@pytest.mark.parametrize(
    ("rows", "said", "candidates", "message"),
    [
        (
            [
                _row("Sharu Kumar", "a.kumar@example.com"),
                _row("Sharu Kumar", "b.kumar@example.com"),
            ],
            "Sharu",
            ["Sharu Kumar"],
            "2 connections are named Sharu Kumar. Ask for the email address of the one they mean.",
        ),
        (
            # Case, accents and spacing aside, these are one name to the person.
            [_row("José Ruiz", "jose@example.com"), _row("jose  ruiz", "ruiz@example.com")],
            "Jose",
            ["José Ruiz"],
            "2 connections are named José Ruiz. Ask for the email address of the one they mean.",
        ),
        (
            [_row("Mary Chen", "mary@example.com"), _row("Mary Chen", "chen@example.com")],
            "Mark",
            ["Mary Chen"],
            "No connection is named Mark exactly; the closest are 2 connections named "
            "Mary Chen. Ask whether they mean Mary Chen and, if so, for the email address "
            "of the one they mean.",
        ),
        (
            [_row("Raj", "raj@example.com"), _row("Raj Kumar", "kumar@example.com")],
            "Raj",
            ["Raj", "Raj Kumar"],
            "More than one connection matches Raj. Ask which one they mean; "
            "if it's Raj, ask for the email address.",
        ),
        (
            [
                _row("Sharu Kumar", "sharu@example.com"),
                _row("sharuk.r@example.com", "sharuk.r@example.com"),
            ],
            "Sharu",
            ["Sharu Kumar", "Hussh member"],
            "More than one connection matches Sharu. Ask which one they mean; "
            "if it's one without a name, ask for the email address.",
        ),
        (
            [_row("Raj", "raj@example.com"), _row("raj.k@example.com", "raj.k@example.com")],
            "Raj",
            ["Raj", "Hussh member"],
            "More than one connection matches Raj, and none can be told apart by name. "
            "Ask for the email address of the one they mean.",
        ),
        (
            [_row("Mary Chen", "mary@example.com"), _row("Marc Lee", "marc@example.com")],
            "Mark",
            ["Mary Chen", "Marc Lee"],
            "No connection is named Mark exactly; the closest are Mary Chen and Marc Lee. "
            "Ask which one they mean.",
        ),
        (
            [_row("sharuk.r@example.com", "sharuk.r@example.com")],
            "Sharu",
            ["Hussh member"],
            "No connection is named Sharu exactly. Ask for their email address.",
        ),
        (
            # A word of an address is no name: a provider or employer word
            # ("example" here) must never fill the draft.
            [
                _row("sharuk.r@example.com", "sharuk.r@example.com"),
                _row("Priya Shah", "priya@example.com"),
            ],
            "example",
            ["Hussh member"],
            "No connection is named example exactly. Ask for their email address.",
        ),
        (
            # A full-width at-sign, as CJK input methods type it, is still an address.
            [_row("sharuk＠infosys.com", "sharuk@infosys.com"), _row("Priya Shah", "p@x.com")],
            "infosys",
            ["Hussh member"],
            "No connection is named infosys exactly. Ask for their email address.",
        ),
    ],
    ids=[
        "same_name",
        "same_name_spelled_differently",
        "misspelled_same_name",
        "whole_name_inside_another",
        "named_and_unnamed",
        "none_named_apart",
        "misspelled_distinct_names",
        "no_name_to_show",
        "word_of_an_address_name",
        "full_width_at_sign",
    ],
)
async def test_a_connection_no_name_can_single_out_is_asked_for_by_address(
    connections, rows, said, candidates, message
):
    connections.rows = rows

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names=said)

    # Asking for a name here would loop: saying it again matches the same rows.
    assert result == {
        "status": "recipient_choice_needed",
        "name": said,
        "candidates": candidates,
        "message": message,
    }


async def test_connections_sharing_one_mailbox_count_as_one(connections):
    connections.rows = [
        _row("Sharukh Khan", "khan@example.com"),
        _row("Sharukh K", "KHAN@example.com"),
    ]

    # Both rows match; the one whose whole name was said stands for the mailbox.
    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sharukh K")

    assert result["status"] == "ok"
    assert result["to"] == "khan@example.com"
    assert result["recipients"] == [{"name": "Sharukh K", "role": "to"}]


async def test_a_name_outside_active_connections_is_not_found(connections):
    connections.rows = [_row("Priya Shah", "priya@example.com")]

    result = await recipients.resolve_draft_recipients(OWNER, to="Sharu")

    assert (result["status"], result["name"]) == ("recipient_not_found", "Sharu")
    assert "Sharu" in result["message"]
    assert "@" not in json.dumps(result)


@pytest.mark.parametrize("email", [None, "", "s•••@example.com", "not-an-address"])
async def test_a_connection_without_a_usable_email_is_reported(connections, email):
    connections.rows = [_row("Sharukh Khan", email)]

    result = await recipients.resolve_draft_recipients(OWNER, recipient_names="Sharukh")

    assert result["status"] == "recipient_email_unavailable"
    assert (result["name"], result["display_name"]) == ("Sharukh", "Sharukh Khan")
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
        to="Priya@Example.com; Sharukh",
        recipient_names="sharukh",
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
    monkeypatch.setattr(recipients, "get_gmail_receipts_service", lambda: gmail)

    assert await recipients.gmail_send_readiness(OWNER) == expected
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

    monkeypatch.setattr(recipients, "get_gmail_receipts_service", _Stalled)

    # One budget covers both reads; the outer bound fails the test instead of hanging.
    readiness = recipients.gmail_send_readiness(OWNER, timeout_seconds=0.01)
    assert await asyncio.wait_for(readiness, timeout=1) == "unknown"
    finished.set()
