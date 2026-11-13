"""The owner confirms what their own agent prepared: Calendar, Gmail, Drive, once each.

``POST /api/one/pod/actions/{proposal_id}/confirm`` is the only way a prepared change
reaches Google from an owner-cloud agent. It opens on the owner's own app session with
scope ``pod.act`` and a held incarnation, refuses a hub consent token even when valid,
exists only in an owner-cloud agent, and claims the proposal in the owner's own log
before anything is sent, so a repeat confirmation runs nothing.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta
from email import policy
from email.parser import BytesParser
from types import SimpleNamespace

# ruff: noqa: S106 -- token strings below name test fixtures, not credentials.
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.adk.tools import FunctionTool
from google.genai import types

from api.routes.one import pod_actions, pod_session, pod_turn
from hushh_mcp.agents.calendar import tools as calendar_tools
from hushh_mcp.agents.calendar.read_offer import STATE_OPENING_OFFER
from hushh_mcp.one_adk.external_read_boundary import (
    before_external_read_model,
    before_external_read_tool,
)
from hushh_mcp.pod_connectors.contacts_tool import (
    STATE_CONTACT_ATTENDEE_OFFER,
    search_my_contacts,
)
from hushh_mcp.services import google_calendar_service, pod_consent_client
from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX, SCOPE_POD_ACT
from tests import pod_connector_harness as h

OWNER_SESSION = {"Authorization": "Bearer pod-session-fixture"}
_CLAIMS = {"role": "app", "scopes": [SCOPE_POD_ACT], "user_id": h.OWNER_UID}
EVENTS = f"{h.CALENDAR}/calendars/primary/events"
PEOPLE_SEARCH = "https://people.googleapis.com/v1/people:searchContacts"
OTHER_CONTACTS_SEARCH = "https://people.googleapis.com/v1/otherContacts:search"


@pytest.mark.parametrize("target", ["same_chat", "other_chat", "new_grant"])
async def test_recent_confirmed_booking_is_exact_chat_reschedule_source(agent, target):
    _log, _tokens, google = agent
    proposal_id = await _propose_lunch()
    with _client() as client:
        assert (
            client.post(
                f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION
            ).status_code
            == 200
        )
    event = {
        "id": "evt1",
        "etag": '"reviewed-version"',
        "summary": "Lunch",
        "start": {"dateTime": "2026-10-07T12:00:00Z"},
        "end": {"dateTime": "2026-10-07T13:00:00Z"},
    }
    google.on("GET", f"{EVENTS}/evt1", event)
    google.on("PATCH", f"{EVENTS}/evt1", event)
    context = h.tool_context()
    if target == "other_chat":
        context.state["hussh:conversation_id"] = "another-conversation"
    if target == "new_grant":
        credentials.set_active_connector_credentials(
            {
                "calendar": h.credential(
                    "calendar", h.SCOPES["calendar"], credential_id="new-calendar-grant"
                ),
            }
        )
    result = await calendar_tools.propose_calendar_reschedule(
        context, recent_booking=True, start_at="2026-10-07T16:00:00Z", end_at="2026-10-07T17:00:00Z"
    )
    if target != "same_chat":
        assert result["status"] != "confirmation_required"
        assert google.calls("GET", f"{EVENTS}/evt1") == []
        return
    assert result["directive"]["payload"]["eventId"] == "evt1"
    assert len(google.calls("GET", f"{EVENTS}/evt1")) == 1
    assert google.calls("PATCH", f"{EVENTS}/evt1") == []
    with _client() as client:
        assert (
            client.post(
                f"/api/one/pod/actions/{result['proposal_id']}/confirm", headers=OWNER_SESSION
            ).status_code
            == 200
        )
    [write] = google.calls("PATCH", f"{EVENTS}/evt1")
    assert write.headers["If-Match"] == '"reviewed-version"'


@pytest.mark.parametrize(
    "action, revoke", [("reschedule", False), ("cancel", False), ("reschedule", True)]
)
async def test_secondary_calendar_edit_checks_writable_copy_before_one_confirmed_write(
    agent, action, revoke
):
    from hushh_mcp.services.pod_connector_credential_seal import POD_CALENDAR_LIST_SCOPE

    _log, tokens, google = agent
    credentials.set_active_connector_credentials(
        {"calendar": h.credential("calendar", (*h.SCOPES["calendar"], POD_CALENDAR_LIST_SCOPE))}
    )
    secondary = "project@example.com"
    inventory = f"{h.CALENDAR}/users/me/calendarList"
    target = f"{h.CALENDAR}/calendars/{secondary}/events"
    event_path = f"{target}/same-id"
    entry = {"id": secondary, "summary": "Project Calendar", "accessRole": "writer"}
    event = {
        "id": "same-id",
        "etag": '"version"',
        "summary": "Project review",
        "organizer": {"self": True},
        "start": {"dateTime": "2026-11-13T12:00:00Z"},
        "end": {"dateTime": "2026-11-13T12:30:00Z"},
    }
    google.on("GET", inventory, {"items": [entry]})
    google.on("GET", f"{inventory}/{secondary}", entry)
    google.on("GET", target, {"items": [event]})
    google.on("GET", event_path, event)
    google.on("PATCH", event_path, event)
    google.on("DELETE", event_path, {})
    context = h.tool_context()
    assert (await calendar_tools.calendar_calendars(context))["status"] == "ok"
    assert (
        await calendar_tools.calendar_events(
            context, "2026-11-13T12:00:00Z", "2026-11-14T00:00:00Z", calendar_ordinal=1
        )
    )["status"] == "ok"
    if action == "reschedule":
        review = await calendar_tools.propose_calendar_reschedule(
            context, event_ordinal=1, start_at="2026-11-13T13:00:00Z", end_at="2026-11-13T13:30:00Z"
        )
    else:
        review = await calendar_tools.propose_calendar_cancellation(context, event_ordinal=1)
    assert review["status"] == "confirmation_required", review
    assert review["directive"]["payload"]["calendarId"] == secondary
    assert review["directive"]["payload"]["calendarLabel"] == "Project Calendar"
    assert ("calendar", "read_calendar_list") in tokens.asks
    method = "PATCH" if action == "reschedule" else "DELETE"
    assert google.calls(method, event_path) == []
    if revoke:
        google.on("GET", f"{inventory}/{secondary}", {**entry, "accessRole": "reader"})
    with _client() as client:
        outcome = client.post(
            f"/api/one/pod/actions/{review['proposal_id']}/confirm", headers=OWNER_SESSION
        )
    assert outcome.status_code == (409 if revoke else 200)
    assert len(google.calls(method, event_path)) == (0 if revoke else 1)
    assert google.calls(method, f"{EVENTS}/same-id") == []


async def _verifier(_token: str, *, expected_scope: str) -> ConsentVerdict:
    return ConsentVerdict(True, True, h.OWNER_UID, h.OWNER_HUSHH, expected_scope)


class _Session:
    held = 0

    def local_token(self, _claims: dict) -> str:
        return LOCAL_TOKEN_PREFIX + "fixture"

    def local_verifier(self, _claims: dict) -> Any:
        return _verifier

    async def require_held(self) -> None:
        type(self).held += 1


@pytest.fixture
def agent(monkeypatch, tmp_path):
    # These executor fixtures start after request assessment. The real SDK runner
    # covers current-turn scope in tests/agents/test_calendar_request_scope.py.
    from hushh_mcp.agents.calendar import request_scope

    monkeypatch.setattr(
        "hushh_mcp.agents.calendar.request_scope.scope_receipt",
        lambda _: {"actions": ["create", "reschedule", "cancel", "respond"], "continuation": False},
    )
    monkeypatch.setattr(
        request_scope, "request_scope", AsyncMock(return_value=("create", "reschedule", "cancel"))
    )
    log, tokens, google = h.install(
        monkeypatch,
        tmp_path,
        connectors={
            "calendar": h.credential("calendar", h.SCOPES["calendar"]),
            "gmail": h.credential("gmail", h.SCOPES["gmail_manage"]),
            "drive": h.credential("drive", h.SCOPES["drive"]),
            "contacts": h.credential("contacts", h.SCOPES["contacts"]),
        },
    )
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_consent_client, "verify_consent", _verifier)
    monkeypatch.setattr(google_calendar_service, "_singleton", None)

    def _verified(authorization: Any, *, role: str, scope: Any = None) -> tuple:
        assert authorization == OWNER_SESSION["Authorization"] and role == "app"
        assert scope == SCOPE_POD_ACT
        return _Session(), _CLAIMS

    monkeypatch.setattr(pod_session, "verified_session", _verified)
    google.on("POST", f"{h.CALENDAR}/freeBusy", {"calendars": {"primary": {"busy": []}}})
    google.on("GET", EVENTS, {"items": []})
    google.on(
        "POST",
        EVENTS,
        {"id": "evt1", "status": "confirmed", "summary": "Lunch", "start": {}, "end": {}},
    )
    _Session.held = 0
    yield log, tokens, google
    h.uninstall()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(pod_actions.router)
    return TestClient(app, raise_server_exceptions=False)


async def _propose_lunch() -> str:
    result = await calendar_tools.propose_calendar_event(
        h.tool_context(),
        title="Lunch",
        start_at="2026-10-07T12:00:00Z",
        end_at="2026-10-07T13:00:00Z",
    )
    assert result["status"] == "confirmation_required", result
    return str(result["proposal_id"])


async def test_a_calendar_change_runs_once_on_the_owners_own_confirmation(agent):
    _log, tokens, google = agent
    proposal_id = await _propose_lunch()
    assert proposal_id.startswith("gcal_")
    assert google.calls("POST", EVENTS) == [], "nothing reaches Google before confirmation"

    client = _client()
    first = client.post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    again = client.post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)

    assert first.status_code == 200, first.text
    assert first.json()["kind"] == "calendar"
    assert again.status_code == 409 and again.json()["detail"]["code"] == "CALENDAR_ACTION_REFUSED"
    assert len(google.calls("POST", EVENTS)) == 1, "a repeat confirmation sends nothing"
    assert ("calendar", "manage") in tokens.asks
    assert _Session.held >= 2, "every confirmation requires a held incarnation"


def _contact_response(request):
    if not request.url.params["query"]:
        return {}
    return {
        "results": [
            {
                "person": {
                    "names": [{"displayName": "Priya Example"}],
                    "emailAddresses": [
                        {"value": "Priya@example.com"},
                        {"value": "pri\u0000ya@example.com"},
                    ],
                    "phoneNumbers": [{"value": "+15550101000"}],
                }
            }
        ]
    }


@pytest.mark.parametrize("granted", [False, True])
async def test_other_contacts_fallback_uses_its_separate_scope(agent, granted):
    from hushh_mcp.services.pod_connector_credential_seal import OTHER_CONTACTS_SCOPE

    _log, tokens, google = agent
    scopes = (*h.SCOPES["contacts"], OTHER_CONTACTS_SCOPE) if granted else h.SCOPES["contacts"]
    credentials.set_active_connector_credentials({"contacts": h.credential("contacts", scopes)})
    google.on("GET", PEOPLE_SEARCH, {})
    google.on("GET", OTHER_CONTACTS_SEARCH, _contact_response)
    context = h.tool_context()
    context.invocation_id = "lookup"
    result = await search_my_contacts(context, query="Priya Example", for_calendar=True)
    other_requests = google.calls("GET", OTHER_CONTACTS_SEARCH)
    if granted:
        assert result["attendee_choices"][0]["name"] == "Priya Example"
        assert tokens.asks == [("contacts", "read"), ("contacts", "read_other")]
        assert [request.url.params["query"] for request in other_requests] == ["", "Priya Example"]
        assert all(
            request.url.params["readMask"] == "names,emailAddresses" for request in other_requests
        )
    else:
        assert result["other_contacts_available"] is False
        assert result["attendee_choices"] == []
        assert other_requests == []
        assert tokens.asks == [("contacts", "read")]


async def test_multiple_contact_names_require_one_choice_per_guest(agent):
    _log, _tokens, google = agent

    def lookup(request):
        name = request.url.params["query"]
        if not name:
            return {}
        emails = (
            ["Priya@example.com", "Priya2@example.com"] if name == "Priya" else ["Sam@example.com"]
        )
        return {
            "results": [
                {
                    "person": {
                        "names": [{"displayName": name}],
                        "emailAddresses": [{"value": email} for email in emails],
                    }
                }
            ]
        }

    google.on("GET", PEOPLE_SEARCH, lookup)
    context = h.tool_context()
    context.invocation_id = "multi-guest"
    contact_tool = FunctionTool(search_my_contacts)
    proposal_tool = FunctionTool(calendar_tools.propose_calendar_event)
    lookup_args = {"queries": ["Priya", "Sam"], "for_calendar": True}
    assert before_external_read_tool(contact_tool, lookup_args, context) is None
    search = await search_my_contacts(context, **lookup_args)
    assert [(item["query"], item["ordinal"]) for item in search["attendee_choices"]] == [
        ("Priya", 1),
        ("Priya", 2),
        ("Sam", 3),
    ]
    window = {"start_at": "2026-11-13T12:00:00Z", "end_at": "2026-11-13T12:30:00Z"}
    proposal_args = {"title": "Plan", "contact_ordinals": [2, 3], **window}
    blocked = before_external_read_tool(proposal_tool, proposal_args, context)
    assert blocked["reason"] == "connector_read_complete"
    request = SimpleNamespace(
        tools_dict={proposal_tool.name: proposal_tool, contact_tool.name: contact_tool},
        config=types.GenerateContentConfig(),
    )
    before_external_read_model(context, request)
    assert set(request.tools_dict) == {proposal_tool.name}
    assert before_external_read_tool(proposal_tool, proposal_args, context) is None
    rejected = await calendar_tools.propose_calendar_event(
        context, title="Plan", contact_ordinals=[1, 2], **window
    )
    assert rejected["reason_code"] == "contact_selection_unavailable"
    review = await calendar_tools.propose_calendar_event(context, **proposal_args)
    assert review["directive"]["payload"]["attendees"] == ["Priya2@example.com", "Sam@example.com"]
    assert google.calls("POST", EVENTS) == []
    with _client() as client:
        assert (
            client.post(
                f"/api/one/pod/actions/{review['proposal_id']}/confirm", headers=OWNER_SESSION
            ).status_code
            == 200
        )
    [write] = google.calls("POST", EVENTS)
    assert h.body(write)["attendees"] == [
        {"email": "Priya2@example.com"},
        {"email": "Sam@example.com"},
    ]


async def test_past_calendar_event_guest_is_reviewed_and_delivered_from_an_exact_selection(agent):
    _log, _tokens, google = agent
    google.on("GET", EVENTS, {"items": [{"id": "past", "summary": "Planning"}]})
    google.on(
        "GET",
        f"{EVENTS}/past",
        {
            "id": "past",
            "attendees": [
                {"email": "owner@example.com", "self": True},
                {"email": "room@example.com", "resource": True},
                {
                    "email": "Priya@example.com",
                    "displayName": "Priya",
                    "responseStatus": "accepted",
                },
            ],
        },
    )
    context = h.tool_context()
    start, end = "2026-11-13T12:00:00Z", "2026-11-13T12:30:00Z"
    assert (await calendar_tools.calendar_events(context, start, end))["status"] == "ok"
    detail = await calendar_tools.calendar_event_detail(context, ordinal=1)
    assert detail["attendee_choices"] == [
        {"ordinal": 1, "name": "Priya", "mailbox_hint": "P… (example.com)"}
    ]
    foreign = h.tool_context(**context.state)
    foreign.state["hussh:conversation_id"] = "unrelated"
    blocked = await calendar_tools.propose_calendar_event(
        foreign, title="Follow up", start_at=start, end_at=end, event_attendee_ordinals=[1]
    )
    assert blocked["reason_code"] == "calendar_attendee_offer_required"
    review = await calendar_tools.propose_calendar_event(
        context, title="Follow up", start_at=start, end_at=end, event_attendee_ordinals=[1]
    )
    assert review["directive"]["payload"]["attendees"] == ["Priya@example.com"]
    assert google.calls("POST", EVENTS) == []
    with _client() as client:
        assert (
            client.post(
                f"/api/one/pod/actions/{review['proposal_id']}/confirm", headers=OWNER_SESSION
            ).status_code
            == 200
        )
    [request] = google.calls("POST", EVENTS)
    assert h.body(request)["attendees"] == [{"email": "Priya@example.com"}]


def _mail_sender_context(google):
    from hushh_mcp.services.email_delegated_read import make_mail_read_offer

    grant = credentials.active_connector_credential("gmail")
    assert grant is not None
    context = h.tool_context()
    context.state["hussh:mail_read_offer"] = make_mail_read_offer(
        {
            "account": grant.account_subject,
            "mailbox": "inbox",
            "message_ids": ["mail-1"],
            "pod_credential_id": grant.credential_id,
        },
        owner_id=h.OWNER_UID,
        conversation_id=context.state["hussh:conversation_id"],
    )
    google.on("GET", f"{h.GMAIL}/profile", {"emailAddress": "owner@example.com"})
    message_path = f"{h.GMAIL}/messages/mail-1"
    google.on(
        "GET",
        message_path,
        {
            **h.gmail_message("mail-1", sender="Priya <Priya@example.com>"),
            "labelIds": ["INBOX"],
            "payload": {
                "headers": [
                    {"name": "From", "value": "Priya <Priya@example.com>"},
                    {"name": "Reply-To", "value": "routing@example.com"},
                    {"name": "Subject", "value": "Meeting"},
                    {"name": "Message-ID", "value": "<mail-1@example.com>"},
                ],
            },
        },
    )
    return context, message_path


@pytest.mark.parametrize("reconnect", [False, True])
async def test_selected_gmail_sender_remains_bound_through_calendar_confirmation(agent, reconnect):
    _log, _tokens, google = agent
    context, message_path = _mail_sender_context(google)
    review = await calendar_tools.propose_calendar_event(
        context,
        title="Follow up",
        start_at="2026-11-13T12:00:00Z",
        end_at="2026-11-13T12:30:00Z",
        mail_sender_ordinal=1,
    )
    assert review["status"] == "confirmation_required", review
    assert review["directive"]["payload"]["attendees"] == ["Priya@example.com"]
    assert "mail_attendee_grant" not in review["plan"]
    [read] = google.calls("GET", message_path)
    assert read.url.params["format"] == "metadata"
    assert google.calls("POST", EVENTS) == []
    if reconnect:
        credentials.set_active_connector_credentials(
            {
                "calendar": h.credential("calendar", h.SCOPES["calendar"]),
                "gmail": h.credential(
                    "gmail", h.SCOPES["gmail_manage"], credential_id="new-gmail-grant"
                ),
            }
        )
    with _client() as client:
        outcome = client.post(
            f"/api/one/pod/actions/{review['proposal_id']}/confirm", headers=OWNER_SESSION
        )
    assert outcome.status_code == (409 if reconnect else 200)
    writes = google.calls("POST", EVENTS)
    assert len(writes) == (0 if reconnect else 1)
    if writes:
        assert h.body(writes[0])["attendees"] == [{"email": "Priya@example.com"}]


@pytest.mark.parametrize(
    ("calendar_status", "gmail_status", "expected"),
    [
        (200, 200, "sent"),
        (200, 403, "not_sent"),
        (200, 503, "outcome_unknown"),
        (200, None, "not_sent"),
        (503, 200, "not_sent"),
    ],
)
async def test_linked_calendar_and_gmail_review_settles_each_provider_once(
    agent, calendar_status, gmail_status, expected, monkeypatch
):
    _log, _tokens, google = agent
    context, _ = _mail_sender_context(google)
    gmail_send = f"{h.GMAIL}/messages/send"
    google.on("POST", EVENTS, {"id": "confirmed-event"}, status=calendar_status)
    if gmail_status is None:
        from hushh_mcp.services.pod_google_connections import PodCalendarProposalStore

        async def refuse_checkpoint(self, **receipt):
            return False

        monkeypatch.setattr(PodCalendarProposalStore, "record_calendar_reply", refuse_checkpoint)
    else:
        google.on(
            "POST", gmail_send, {"id": "sent-reply", "threadId": "t-mail-1"}, status=gmail_status
        )
    result = await calendar_tools.propose_calendar_event(
        context,
        title="Follow up",
        start_at="2026-11-13T12:00:00Z",
        end_at="2026-11-13T12:30:00Z",
        mail_sender_ordinal=1,
        mail_reply_body="I sent the calendar invite.",
    )
    assert result["status"] == "confirmation_required", result
    assert result["linked_review"] is True and "directive" not in result
    review = context.state["hussh:pending_directive:calendar"]["payload"]
    assert review["attendees"] == ["Priya@example.com"]
    assert review["gmailReply"] == {
        "to": ["routing@example.com"],
        "subject": "Re: Meeting",
        "body": "I sent the calendar invite.",
    }
    assert google.calls("POST", EVENTS) == google.calls("POST", gmail_send) == []
    route = f"/api/one/pod/actions/{result['proposal_id']}"
    with _client() as client:
        assert client.get(f"{route}/status", headers=OWNER_SESSION).json()["calendar"] == "prepared"
        settled = client.post(f"{route}/confirm", headers=OWNER_SESSION)
        assert client.post(f"{route}/confirm", headers=OWNER_SESSION).status_code == 409
        receipt = client.get(f"{route}/status", headers=OWNER_SESSION).json()
    [invite] = google.calls("POST", EVENTS)
    assert receipt["gmail"] == expected
    if calendar_status == 503:
        assert settled.status_code == 502
        assert receipt["calendar"] == "outcome_unknown"
        assert google.calls("POST", gmail_send) == []
        return
    assert settled.status_code == 200
    assert settled.json()["result"]["gmail_reply"]["status"] == expected
    assert receipt["calendar"] == "created"
    if gmail_status is None:
        assert google.calls("POST", gmail_send) == []
        return
    assert receipt["eventId"] == "confirmed-event"
    [send] = google.calls("POST", gmail_send)
    assert google.requests.index(invite) < google.requests.index(send)
    payload = h.body(send)
    assert payload["threadId"] == "t-mail-1"
    mime = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(payload["raw"]))
    assert mime["To"] == "routing@example.com"
    assert mime["In-Reply-To"] == mime["References"] == "<mail-1@example.com>"
    assert mime.get_body().get_content().strip() == "I sent the calendar invite."


@pytest.mark.parametrize(
    "binding_change",
    [
        "none",
        "conversation",
        "contacts_grant",
        "calendar_grant",
        "contacts_after_review",
        "contacts_during_calendar_token_exchange",
    ],
)
async def test_contact_lookup_to_reviewed_calendar_invite(agent, binding_change, monkeypatch):
    _log, tokens, google = agent
    # Offered openings must remain future appointments whenever CI runs.
    day = (datetime.now(UTC) + timedelta(days=1)).date().isoformat()
    google.on("GET", PEOPLE_SEARCH, _contact_response)
    lookup_context = h.tool_context()
    lookup_context.invocation_id = "lookup"
    window = {
        "start_at": f"{day}T12:00:00Z",
        "end_at": f"{day}T14:00:00Z",
        "duration_minutes": 30,
        "limit": 2,
    }
    lookup_args = {
        "query": "Priya Example",
        "for_calendar": True,
        **{f"availability_{key}": value for key, value in window.items()},
    }
    contact_tool = FunctionTool(search_my_contacts)
    openings_tool = FunctionTool(calendar_tools.calendar_free_slots)
    assert before_external_read_tool(contact_tool, lookup_args, lookup_context) is None
    search = await search_my_contacts(lookup_context, **lookup_args)
    assert search == {
        "status": "ok",
        "source": "google_contacts",
        "attendee_choices": [
            {"ordinal": 1, "name": "Priya Example", "mailbox_hint": "P… (example.com)"}
        ],
    }
    reads = google.calls("GET", PEOPLE_SEARCH)
    assert [request.url.params["query"] for request in reads] == ["", "Priya Example"]
    assert all(request.url.params["readMask"] == "names,emailAddresses" for request in reads)
    assert tokens.asks == [("contacts", "read")]
    google.on(
        "POST",
        f"{h.CALENDAR}/freeBusy",
        {
            "calendars": {
                "primary": {"busy": [{"start": f"{day}T12:30:00Z", "end": f"{day}T13:00:00Z"}]}
            }
        },
    )
    request = SimpleNamespace(
        tools_dict={openings_tool.name: openings_tool}, config=types.GenerateContentConfig()
    )
    before_external_read_model(lookup_context, request)
    assert set(request.tools_dict) == {"calendar_free_slots"}
    assert before_external_read_tool(openings_tool, window, lookup_context) is None
    openings = await calendar_tools.calendar_free_slots(lookup_context, **window)
    assert [slot["opening_ordinal"] for slot in openings["openings"]] == [1, 2]
    provider_reads = len(google.requests)

    context = h.tool_context(
        **{
            STATE_CONTACT_ATTENDEE_OFFER: lookup_context.state[STATE_CONTACT_ATTENDEE_OFFER],
            STATE_OPENING_OFFER: lookup_context.state[STATE_OPENING_OFFER],
        }
    )
    if binding_change == "conversation":
        context.state["hussh:conversation_id"] = "other-conversation"
    if binding_change in {"contacts_grant", "calendar_grant"}:
        connector = binding_change.removesuffix("_grant")
        logins = {name: h.credential(name, h.SCOPES[name]) for name in ("contacts", "calendar")}
        logins[connector] = h.credential(
            connector,
            h.SCOPES[connector],
            credential_id="77777777-2222-4333-8444-555555555555",
        )
        credentials.set_active_connector_credentials(logins)
    proposal = await calendar_tools.propose_calendar_event(
        context,
        title="Planning",
        contact_ordinals=[1],
        opening_ordinal=2,
    )
    assert google.calls("POST", EVENTS) == []
    if binding_change not in {
        "none",
        "contacts_after_review",
        "contacts_during_calendar_token_exchange",
    }:
        assert proposal["reason_code"] == (
            "contact_selection_unavailable"
            if binding_change in {"contacts_grant", "conversation"}
            else "calendar_connection_changed"
        )
        assert len(google.requests) == provider_reads
        return

    assert proposal["status"] == "confirmation_required"
    assert proposal["directive"]["payload"]["attendees"] == ["Priya@example.com"]
    calendar_only = {"calendar": h.credential("calendar", h.SCOPES["calendar"])}
    if binding_change == "contacts_after_review":
        credentials.set_active_connector_credentials(calendar_only)
    disconnected_during_exchange = False
    if binding_change == "contacts_during_calendar_token_exchange":
        get_token = tokens.access_token
        conflicts_reads = len(google.calls("GET", EVENTS))

        async def disconnect_during_exchange(service, level):
            nonlocal disconnected_during_exchange
            if (service, level) == ("calendar", "manage") and len(
                google.calls("GET", EVENTS)
            ) > conflicts_reads:
                credentials.set_active_connector_credentials(calendar_only)
                disconnected_during_exchange = True
            return await get_token(service, level)

        monkeypatch.setattr(tokens, "access_token", disconnect_during_exchange)
    with _client() as client:
        route = f"/api/one/pod/actions/{proposal['proposal_id']}/confirm"
        if binding_change in {"contacts_after_review", "contacts_during_calendar_token_exchange"}:
            assert client.post(route, headers=OWNER_SESSION).status_code == 409
            assert disconnected_during_exchange == (
                binding_change == "contacts_during_calendar_token_exchange"
            )
            assert google.calls("POST", EVENTS) == []
            return
        assert client.post(route, headers=OWNER_SESSION).status_code == 200
        assert client.post(route, headers=OWNER_SESSION).status_code == 409
    [sent] = google.calls("POST", EVENTS)
    assert h.body(sent)["attendees"] == [{"email": "Priya@example.com"}]
    assert h.body(sent)["start"]["dateTime"].startswith(f"{day}T13:00:00")
    assert h.body(sent)["end"]["dateTime"].startswith(f"{day}T13:30:00")
    assert sent.url.params["sendUpdates"] == "all"
    assert sent.url.params["conferenceDataVersion"] == "1"


@pytest.mark.parametrize("foreign_turn", ["voice", "other_owner"])
async def test_calendar_tools_refuse_non_owner_turns_before_local_provider_access(
    agent, foreign_turn
):
    _log, tokens, google = agent
    context = (
        h.tool_context(**{"temp:one_execution_surface": "voice"})
        if foreign_turn == "voice"
        else h.tool_context(owner="someone-else")
    )
    before = (len(tokens.asks), len(google.requests))
    read = await calendar_tools.calendar_summary(context)
    write = await calendar_tools.propose_calendar_event(
        context,
        title="Lunch",
        start_at="2026-10-07T12:00:00Z",
        end_at="2026-10-07T13:00:00Z",
    )
    assert read["status"] == "failed"
    assert write["status"] == "runtime_unavailable"
    assert (len(tokens.asks), len(google.requests)) == before


async def test_a_hub_consent_token_never_confirms(agent):
    proposal_id = await _propose_lunch()
    response = _client().post(
        f"/api/one/pod/actions/{proposal_id}/confirm", headers={"X-Consent-Token": "hub-token"}
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "OWNER_SESSION_REQUIRED"


async def test_only_an_owner_cloud_agent_has_the_door(agent, monkeypatch):
    proposal_id = await _propose_lunch()
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    response = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    assert response.status_code == 404
    for headers in ({}, {"X-Consent-Token": "hub-token"}):
        anonymous = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=headers)
        assert anonymous.status_code == 404, "no answer that tells a caller the door exists"


async def test_a_session_for_another_person_is_refused(agent, monkeypatch):
    proposal_id = await _propose_lunch()
    monkeypatch.setitem(_CLAIMS, "user_id", "someone-else")

    async def other(_token: str, *, expected_scope: str) -> ConsentVerdict:
        return ConsentVerdict(True, True, "someone-else", h.OWNER_HUSHH, expected_scope)

    monkeypatch.setattr(_Session, "local_verifier", lambda self, claims: other)
    response = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "OWNER_MISMATCH"


async def test_an_id_this_agent_never_minted_is_unknown(agent):
    response = _client().post(
        "/api/one/pod/actions/gxyz_abcdefghijklmnopqrstu/confirm", headers=OWNER_SESSION
    )
    assert response.status_code == 404


@pytest.mark.parametrize("outcome", ["executed", "outcome_unknown", "partially_executed"])
async def test_a_reviewed_gmail_change_is_applied_once(agent, outcome):
    _log, tokens, google = agent
    h.route_inbox(google)
    action = "trash" if outcome == "partially_executed" else "archive"
    if action == "trash":
        google.on("POST", f"{h.GMAIL}/messages/m1/trash", {})
        google.on("POST", f"{h.GMAIL}/messages/m2/trash", {}, status=403)
    else:
        google.on(
            "POST",
            f"{h.GMAIL}/messages/batchModify",
            {},
            status=503 if outcome == "outcome_unknown" else 200,
        )
    from hushh_mcp.agents.email.mailbox_tools import propose_gmail_mailbox_change

    prepared = await propose_gmail_mailbox_change(
        h.tool_context(), action=action, query="from:ravi", limit=2
    )
    assert prepared["status"] == "confirmation_required", prepared
    assert {r.url.host for r in google.requests} == {"gmail.googleapis.com"}
    assert google.calls("POST", f"{h.GMAIL}/messages/batchModify") == []
    # The id travels only in the owner's review card; the model never sees it.
    assert "proposal_id" not in prepared
    from hushh_mcp.services.pod_action_proposals import RECORD_KIND, SETTLED_KIND

    records = [r for r in await agent[0].replay() if r["kind"] == RECORD_KIND]
    directive_id = records[-1]["payload"]["proposalId"]
    assert directive_id.startswith("gmod_")

    client = _client()
    first = client.post(f"/api/one/pod/actions/{directive_id}/confirm", headers=OWNER_SESSION)
    again = client.post(f"/api/one/pod/actions/{directive_id}/confirm", headers=OWNER_SESSION)

    assert first.status_code == 200, first.text
    expected = {
        "status": outcome,
        "action": action,
        "count": 2 if outcome == "executed" else 1 if action == "trash" else 0,
    }
    if outcome != "executed":
        expected["total"] = 2
    assert first.json()["result"] == expected
    assert again.status_code == 409
    records = [r for r in await agent[0].replay() if r["kind"] == SETTLED_KIND]
    assert records[-1]["payload"]["status"] == (
        "executed" if outcome == "executed" else "executing"
    )
    writes = [request for request in google.requests if request.method == "POST"]
    assert len(writes) == (2 if action == "trash" else 1), (
        "no replay after uncertain or partial dispatch"
    )
    if action == "archive":
        assert h.body(writes[0]) == {
            "ids": ["m1", "m2"],
            "addLabelIds": [],
            "removeLabelIds": ["INBOX"],
        }
    assert all(request.headers["authorization"] == "Bearer ya29.gmail.manage" for request in writes)


async def test_owner_email_prepare_keeps_exact_terms_until_one_confirmation(agent):
    _log, _tokens, google = agent
    google.on("POST", f"{h.GMAIL}/messages/send", {"id": "synthetic-sent"})
    client = _client()
    body = {
        "action": "send_email",
        "draft": {"to": ["synthetic@example.test"], "subject": "Fixture", "body": "Synthetic"},
    }
    refused = client.post(
        "/api/one/pod/actions/gmail/proposals",
        json=body,
        headers={"X-Consent-Token": "hub-consent"},
    )
    assert refused.status_code == 403
    prepared = client.post("/api/one/pod/actions/gmail/proposals", json=body, headers=OWNER_SESSION)
    assert prepared.status_code == 200, prepared.text
    assert google.calls("POST", f"{h.GMAIL}/messages/send") == []
    assert prepared.json()["preview"]["body"] == "Synthetic"
    proposal = prepared.json()["proposal_id"]
    first = client.post(f"/api/one/pod/actions/{proposal}/confirm", headers=OWNER_SESSION)
    again = client.post(f"/api/one/pod/actions/{proposal}/confirm", headers=OWNER_SESSION)
    assert first.status_code == 200, first.text
    assert again.status_code == 409
    receipt = client.get(f"/api/one/pod/actions/{proposal}/status", headers=OWNER_SESSION)
    assert receipt.json() == {"proposalId": proposal, "kind": "gmail_mailbox", "state": "sent"}
    refused = client.get(
        f"/api/one/pod/actions/{proposal}/status", headers={"X-Consent-Token": "hub-consent"}
    )
    assert refused.status_code == 403
    assert len(google.calls("POST", f"{h.GMAIL}/messages/send")) == 1


async def test_a_reviewed_drive_share_runs_once_and_refuses_after_a_reconnect(agent):
    from hushh_mcp.services import pod_connector_credentials as store
    from hushh_mcp.services.pod_drive import PodDriveReview, propose_drive_review

    review = await propose_drive_review(
        owner_id=h.OWNER_UID,
        action="share",
        tool_name="share_file",
        arguments={
            "fileId": "f1",
            "email": "a@b.com",
            "role": "reader",
            "notify": True,
            "message": "",
        },
    )
    assert isinstance(review, PodDriveReview) and review.directive_id.startswith("gdrv_")

    class _Writer:
        calls: list[dict] = []

        async def write_tool(self, *, user_id: str, tool_name: str, arguments: dict) -> Any:
            type(self).calls.append({"user": user_id, "tool": tool_name, **arguments})
            from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

            return ExternalMcpToolResult(is_error=False, payload={"shared": True}, truncated=False)

    result = await pod_actions.run_action_confirm(
        review.directive_id,
        consent_token=LOCAL_TOKEN_PREFIX + "fixture",
        verifier=_verifier,
        session=_CLAIMS,
        ports={"drive": _Writer()},
    )
    assert result["result"]["status"] == "ok" and len(_Writer.calls) == 1
    assert _Writer.calls[0]["tool"] == "share_file" and _Writer.calls[0]["email"] == "a@b.com"

    second = await propose_drive_review(
        owner_id=h.OWNER_UID, action="trash", tool_name="trash_file", arguments={"fileId": "f2"}
    )
    store.set_active_connector_credentials(
        {
            "drive": h.credential(
                "drive", h.SCOPES["drive"], credential_id="77777777-2222-4333-8444-555555555555"
            )
        }
    )
    with pytest.raises(Exception) as refused:
        await pod_actions.run_action_confirm(
            second.directive_id,
            consent_token=LOCAL_TOKEN_PREFIX + "fixture",
            verifier=_verifier,
            session=_CLAIMS,
            ports={"drive": _Writer()},
        )
    assert getattr(refused.value, "status_code", None) == 409
    assert len(_Writer.calls) == 1, "reviewed under another login: nothing is sent"


async def test_a_calendar_review_does_not_survive_a_reconnect_to_the_same_account(agent):
    from hushh_mcp.services import pod_connector_credentials as store

    proposal_id = await _propose_lunch()
    store.set_active_connector_credentials(
        {
            "calendar": h.credential(
                "calendar",
                h.SCOPES["calendar"],
                credential_id="77777777-2222-4333-8444-555555555555",
            )
        }
    )
    response = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    assert response.status_code == 409
    assert agent[2].calls("POST", EVENTS) == [], "same subject is not the same reviewed custody"


@pytest.mark.parametrize(
    "action,path,key",
    [("save_draft", "/drafts", "draft_id"), ("send_email", "/messages/send", "message_id")],
)
async def test_reviewed_email_saves_or_sends_the_exact_envelope_once(agent, action, path, key):
    from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions

    async def require_access():
        return None

    google = agent[2]
    google.on("POST", f"{h.GMAIL}{path}", {"id": "provider-id"})
    mailbox = PodGmailMailboxActions(h.OWNER_UID)
    proposal = await mailbox.propose_email(
        user_id=h.OWNER_UID,
        action=action,
        draft_payload={
            "to": ["a@example.com"],
            "cc": ["c@example.com"],
            "bcc": ["b@example.com"],
            "subject": "Reviewed title",
            "body": "Exact text",
        },
        require_access=require_access,
    )
    assert google.requests == [], "preparing the review performs no provider change"
    pid = proposal["proposal_id"]
    first = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert first.status_code == 200, first.text
    assert first.json()["result"][key] == "provider-id"
    again = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert again.status_code == 409
    (request,) = google.calls("POST", f"{h.GMAIL}{path}")
    payload = h.body(request)
    raw = payload["message"]["raw"] if action == "save_draft" else payload["raw"]
    mime = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw))
    assert mime["To"] == "a@example.com" and mime["Bcc"] == "b@example.com"
    assert mime["Subject"] == "Reviewed title" and mime.get_content().strip() == "Exact text"
    assert request.headers["authorization"] == "Bearer ya29.gmail.manage"


async def test_email_review_refuses_reconnect_and_unknown_delivery_never_retries(agent):
    from hushh_mcp.services import pod_connector_credentials as store
    from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions

    async def require_access():
        return None

    async def prepare():
        return await PodGmailMailboxActions(h.OWNER_UID).propose_email(
            user_id=h.OWNER_UID,
            action="send_email",
            draft_payload={"to": ["a@example.com"], "subject": "Hi", "body": "Text"},
            require_access=require_access,
        )

    google = agent[2]
    google.on("POST", f"{h.GMAIL}/messages/send", {})  # no provider acknowledgement
    proposal = await prepare()
    pid = proposal["proposal_id"]
    first = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert first.status_code == 502 and "OUTCOME_UNKNOWN" in first.text
    receipt = _client().get(f"/api/one/pod/actions/{pid}/status", headers=OWNER_SESSION)
    assert receipt.json()["state"] == "outcome_unknown"
    again = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert again.status_code == 409 and len(google.calls("POST", f"{h.GMAIL}/messages/send")) == 1
    second = await prepare()
    store.set_active_connector_credentials(
        {
            "gmail": h.credential(
                "gmail",
                h.SCOPES["gmail_manage"],
                credential_id="77777777-2222-4333-8444-555555555555",
            )
        }
    )
    changed = _client().post(
        f"/api/one/pod/actions/{second['proposal_id']}/confirm", headers=OWNER_SESSION
    )
    assert changed.status_code == 409
    assert len(google.calls("POST", f"{h.GMAIL}/messages/send")) == 1


def test_send_status_keeps_neighboring_ingress_routes_closed():
    from api.middlewares.pod_ingress import is_app_surface

    assert is_app_surface("/api/one/pod/actions/gmod_abcdefghijklmnop/status")
    assert is_app_surface("/api/one/pod/actions/gcal_abcdefghijklmnop/status")
    for path in (
        "gcal_short/status",
        "gcal_abcdefghijklmnop/status/provider",
        "gmod_short/status",
        "gmod_abcdefghijklmnop/status/provider",
        "gmod_abcdefghijklmnop/retry",
    ):
        assert not is_app_surface(f"/api/one/pod/actions/{path}")


async def test_hosted_calendar_has_no_hub_or_local_google_fallback(monkeypatch):
    from hushh_mcp.one_adk.pod_connector_tools import (
        calendar_reads_via_door,
        calendar_turn_refusal,
        pod_connector_roster,
        pod_tool_owner,
    )
    from tests.hosted_pod_support import install_hosted_runtime

    install_hosted_runtime(monkeypatch)
    assert not calendar_reads_via_door()
    assert (await calendar_turn_refusal(h.tool_context()))["status"] == "failed"
    assert await pod_tool_owner(h.tool_context(), "calendar") is None
    assert pod_connector_roster() == []


@pytest.mark.parametrize("action", ["reschedule", "cancel"])
async def test_calendar_mutation_keeps_the_owner_cloud_source_grant(agent, action):
    log, _tokens, google = agent
    event = {
        "id": "evt1",
        "etag": '"event-version"',
        "summary": "Lunch",
        "attendees": [],
        "start": {"dateTime": "2026-12-02T16:00:00Z", "timeZone": "UTC"},
        "end": {"dateTime": "2026-12-02T16:30:00Z", "timeZone": "UTC"},
    }
    google.on("GET", EVENTS, {"items": [event]})
    google.on("GET", f"{EVENTS}/evt1", event)
    google.on("PATCH", f"{EVENTS}/evt1", event)
    google.on("DELETE", f"{EVENTS}/evt1", {})
    context = h.tool_context(**{"hussh:conversation_id": "calendar-owner-conversation"})
    assert (await calendar_tools.calendar_summary(context))["status"] == "ok"
    if action == "reschedule":
        result = await calendar_tools.propose_calendar_reschedule(
            context, event_id="evt1", start_at="2026-12-03T16:00:00Z", end_at="2026-12-03T16:30:00Z"
        )
    else:
        result = await calendar_tools.propose_calendar_cancellation(context, event_id="evt1")
    assert result["status"] == "confirmation_required", result
    from hushh_mcp.services.pod_action_proposals import pod_action_proposals

    stored, _ = await pod_action_proposals()._snapshot(log)
    assert (
        len(stored[result["proposal_id"]]["proposal"]["payload"]["plan"]["connection_binding"]) > 6
    )
    assert "connection_binding" not in result["plan"]
    assert google.calls("PATCH", f"{EVENTS}/evt1") == google.calls("DELETE", f"{EVENTS}/evt1") == []
    response = _client().post(
        f"/api/one/pod/actions/{result['proposal_id']}/confirm", headers=OWNER_SESSION
    )
    assert response.status_code == 200, response.json()
    method = "PATCH" if action == "reschedule" else "DELETE"
    assert len(google.calls(method, f"{EVENTS}/evt1")) == 1
