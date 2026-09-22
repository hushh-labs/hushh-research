"""People tools: resolve/confirm by canonical id, reads, and confirm_* mutations.

Services are doubles injected through ``ToolContext(services=...)``; every
spoken fact asserted here is derived from what the double returned.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import people
from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    EntityContext,
    PersonRef,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    now_iso,
)
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from hushh_mcp.services.connections_service import ConnectionsError
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

OWNER = "owner-1"
AYESHA = "u-ayesha"
AISHA = "u-aisha"
PRIYA = "u-priya"
RAHUL = "u-rahul"
DEV = "u-dev"
REQ_IN = "11111111-1111-4111-8111-111111111111"
REQ_OUT = "22222222-2222-4222-8222-222222222222"


class ConnectionsDouble:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.connections: list[dict[str, Any]] = [
            {
                "connectionId": "conn-ayesha",
                "userId": AYESHA,
                "publicPersonRef": "ppr-ayesha",
                "displayName": "Ayesha Sharma",
                "photoUrl": "https://img/ayesha",
                "email": "ayesha@example.com",
                "createdAt": "2026-01-01T00:00:00+00:00",
                "isRia": False,
                "connectedFromContacts": True,
            },
            {
                "connectionId": "conn-aisha",
                "userId": AISHA,
                "publicPersonRef": "ppr-aisha",
                "displayName": "Aisha Khan",
                "photoUrl": None,
                "email": None,
                "createdAt": "2026-01-02T00:00:00+00:00",
                "isRia": False,
                "connectedFromContacts": False,
            },
        ]
        self.incoming: list[dict[str, Any]] = [
            {
                "id": REQ_IN,
                "requesterUserId": RAHUL,
                "addresseeUserId": OWNER,
                "status": "pending",
                "message": "hi",
                "createdAt": "2026-01-03T00:00:00+00:00",
                "counterpartUserId": RAHUL,
                "counterpartDisplayName": "Rahul Verma",
                "counterpartPhotoUrl": None,
                "scopes": [],
            }
        ]
        self.outgoing: list[dict[str, Any]] = [
            {
                "id": REQ_OUT,
                "requesterUserId": OWNER,
                "addresseeUserId": DEV,
                "status": "pending",
                "message": None,
                "createdAt": "2026-01-04T00:00:00+00:00",
                "counterpartUserId": DEV,
                "counterpartDisplayName": "Dev Patel",
                "counterpartPhotoUrl": None,
                "scopes": [],
            }
        ]
        self.directory: list[dict[str, Any]] = [
            {
                "userId": "u-preeti",
                "publicPersonRef": "ppr-preeti",
                "displayName": "Preeti Rao",
                "photoUrl": None,
                "relationship": "none",
                "isRia": False,
            },
            {
                "userId": PRIYA,
                "publicPersonRef": "ppr-priya",
                "displayName": "Priya Nair",
                "photoUrl": None,
                "relationship": "none",
                "isRia": False,
            },
            {
                "userId": AYESHA,
                "publicPersonRef": "ppr-ayesha",
                "displayName": "Ayesha Sharma",
                "photoUrl": None,
                "relationship": "connected",
                "isRia": False,
            },
        ]
        self.create_error: ConnectionsError | None = None
        self.accept_error: ConnectionsError | None = None
        self.removed = 1

    def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        self.calls.append(("list_connections", user_id))
        return list(self.connections)

    def list_connections_page(
        self,
        user_id: str,
        *,
        query: str = "",
        page: int = 1,
        limit: int = 50,
        audience: str = "all",
    ) -> dict[str, Any]:
        self.calls.append(("list_connections_page", (user_id, query, page, limit)))
        needle = (query or "").lower()
        rows = sorted(
            (r for r in self.connections if not needle or needle in str(r["displayName"]).lower()),
            key=lambda r: str(r["displayName"]).lower(),
        )
        offset = (page - 1) * limit
        items = rows[offset : offset + limit]
        return {
            "items": [dict(r) for r in items],
            "page": page,
            "hasMore": offset + len(items) < len(rows),
            "totalCount": len(rows),
            "audience": audience,
        }

    def list_requests(self, user_id: str, *, direction: str, include_resolved: bool = False):
        self.calls.append(("list_requests", (user_id, direction)))
        return list(self.incoming if direction == "incoming" else self.outgoing)

    def search_directory(self, user_id: str, *, query: str = "", page: int = 1, limit: int = 20):
        self.calls.append(("search_directory", (user_id, query, page, limit)))
        needle = (query or "").lower()
        items = [
            row
            for row in self.directory
            if any(tok.startswith(needle) for tok in str(row["displayName"]).lower().split())
        ]
        return {"items": items, "page": page, "hasMore": False, "audience": "all"}

    def create_request(self, requester_user_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("create_request", (requester_user_id, kwargs)))
        if self.create_error is not None:
            raise self.create_error
        return {
            "id": "req-new",
            "requesterUserId": requester_user_id,
            "addresseeUserId": kwargs.get("addressee_user_id"),
            "status": "pending",
            "message": kwargs.get("message"),
            "scopes": [],
        }

    def accept_request(self, user_id: str, request_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("accept_request", (user_id, request_id)))
        if self.accept_error is not None:
            raise self.accept_error
        return {"status": "accepted", "requestId": request_id, "connectionId": "conn-new"}

    def reject_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        self.calls.append(("reject_request", (user_id, request_id)))
        return {"status": "rejected", "requestId": request_id}

    def cancel_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        self.calls.append(("cancel_request", (user_id, request_id)))
        return {"status": "cancelled", "requestId": request_id}

    def remove_connection(self, user_id: str, connection_id: str) -> dict[str, Any]:
        self.calls.append(("remove_connection", (user_id, connection_id)))
        if self.removed and not getattr(self, "removal_leaves_connected", False):
            self.connections = [c for c in self.connections if c["connectionId"] != connection_id]
        return {"removed": self.removed}


class LocationDouble:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.error: OneLocationAgentError | None = None
        self.recipients: list[dict[str, Any]] = [
            {
                "userId": AYESHA,
                "displayName": "Ayesha Sharma",
                "photoUrl": "https://img/ayesha",
                "phoneVerified": True,
                "keyId": "key-ayesha",
                "canReceiveLocation": True,
                "publicPersonRef": "ppr-ayesha",
            },
            {
                "userId": AISHA,
                "displayName": "Aisha Khan",
                "photoUrl": None,
                "phoneVerified": True,
                "keyId": None,
                "canReceiveLocation": False,
                "publicPersonRef": "ppr-aisha",
            },
            {
                # Circle-mate: location-ready but not a direct connection.
                "userId": PRIYA,
                "displayName": "Priya Nair",
                "photoUrl": None,
                "phoneVerified": False,
                "keyId": "key-priya",
                "canReceiveLocation": True,
                "publicPersonRef": "ppr-priya",
            },
        ]
        self.directory_by_id: dict[str, dict[str, Any]] = {
            "u-preeti": {
                "userId": "u-preeti",
                "displayName": "Preeti Rao",
                "photoUrl": None,
                "phoneVerified": True,
                "keyId": None,
                "canReceiveLocation": False,
                "publicPersonRef": "ppr-preeti",
            }
        }

    def list_verified_recipients(self, *, owner_user_id: str, limit: int = 50):
        self.calls.append(("list_verified_recipients", (owner_user_id, limit)))
        if self.error is not None:
            raise self.error
        return list(self.recipients)

    def search_directory_candidates(
        self, *, owner_user_id: str, candidate_user_id: str | None = None, **kwargs: Any
    ):
        self.calls.append(("search_directory_candidates", (owner_user_id, candidate_user_id)))
        row = self.directory_by_id.get(candidate_user_id or "")
        return {"items": [row] if row else [], "page": 1, "hasMore": False}


def make_ctx(
    *, connections: ConnectionsDouble | None = None, location: LocationDouble | None = None
) -> tuple[ToolContext, ConnectionsDouble, LocationDouble]:
    connections = connections or ConnectionsDouble()
    location = location or LocationDouble()
    ctx = ToolContext(
        user_id=OWNER,
        conversation_id="conv-1",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test fixture, not a credential
        firebase_id_token="firebase-token",  # noqa: S106 - test fixture, not a credential
        services={"connections": connections, "location": location},
    )
    return ctx, connections, location


async def _offer_requests(ctx: ToolContext) -> None:
    """Accept / decline / cancel act only on request ids the server listed."""
    await people.list_people(ctx, people.ListPeopleInput())


def confirm(ctx: ToolContext, user_id: str, name: str, relationship: str = "connected") -> None:
    ctx.entities.remember_person(
        ConfirmedPerson(
            user_id=user_id,
            display_name=name,
            relationship=relationship,  # type: ignore[arg-type]
            has_location_key=True,
            confirmed_at=now_iso(),
        )
    )


def spec(name: str):
    return next(tool for tool in people.TOOLS if tool.name == name)


# -- catalog ----------------------------------------------------------------


def test_catalog_policies_gateway_ids_and_planes():
    table = {
        tool.name: (tool.policy, tool.gateway_action_id, tool.person_args, tool.firebase_plane)
        for tool in people.TOOLS
    }
    # Every people tool binds to the Connect family's own action: searching is
    # connect.search_people (never location.find_contacts, whose meaning is
    # device contact sync), and accept/decline are distinct actions.
    assert table == {
        "resolve_person": (ToolPolicy.read, "connect.search_people", (), False),
        "confirm_person": (ToolPolicy.read, "connect.search_people", (), False),
        "list_people": (ToolPolicy.read, "location.open_people", (), False),
        "get_person": (ToolPolicy.read, "location.open_people", ("person",), False),
        "invite_person": (ToolPolicy.confirm_voice, "connect.send_request", ("person",), True),
        "accept_connection_request": (ToolPolicy.confirm_voice, "connect.accept_request", (), True),
        "decline_connection_request": (
            ToolPolicy.confirm_voice,
            "connect.reject_request",
            (),
            True,
        ),
        "cancel_connection_request": (ToolPolicy.confirm_tap, "connect.cancel_request", (), True),
        "remove_connection": (
            ToolPolicy.confirm_tap,
            "connect.remove_connection",
            ("person",),
            True,
        ),
    }
    assert not any("find_contacts" in tool.gateway_action_id for tool in people.TOOLS)
    for tool in people.TOOLS:
        assert (tool.summarize is not None) == tool.policy.needs_confirmation, tool.name
        statuses = tool.output_model.model_fields["status"].annotation.__args__
        assert statuses and all(isinstance(item, str) for item in statuses), tool.name
        tool.declaration()  # schema must inline without error
    assert people.InvitePersonInput.model_fields["message"].metadata[0].max_length == 1000


def test_no_tool_accepts_a_free_text_name_for_a_person():
    for tool in people.TOOLS:
        if tool.name == "resolve_person":
            continue
        fields = tool.input_model.model_fields
        assert "spoken_name" not in fields and "name" not in fields, tool.name
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"spoken_name": "Ayesha"})
    for model in (people.InvitePersonInput, people.GetPersonInput, people.RemoveConnectionInput):
        with pytest.raises(ValidationError):
            model.model_validate({"person": "Ayesha Sharma"})
        with pytest.raises(ValidationError):
            model.model_validate({"person": {"user_id": AYESHA, "display_name": "Ayesha"}})
        with pytest.raises(ValidationError):
            model.model_validate({"person": {"display_name": "Ayesha"}})
    with pytest.raises(ValidationError):
        people.ConfirmPersonInput.model_validate({"user_id": AYESHA, "display_name": "Ayesha"})


# -- resolve_person ---------------------------------------------------------


async def test_resolve_aysha_offers_both_and_confirms_nothing():
    ctx, connections, _ = make_ctx()
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Aysha"))
    assert result.status == "multiple"
    assert result.needs == "disambiguation"
    assert [c.display_name for c in result.candidates] == ["Ayesha Sharma", "Aisha Khan"]
    assert ctx.entities.offered_person_ids == [AYESHA, AISHA]
    assert ctx.entities.people == {}
    assert result.spoken_facts == ["I found Ayesha Sharma and Aisha Khan."]
    ayesha = result.candidates[0]
    assert (ayesha.relationship, ayesha.has_location_key, ayesha.phone_verified) == (
        "connected",
        True,
        True,
    )
    assert ayesha.public_person_ref == "ppr-ayesha"
    aisha = result.candidates[1]
    assert (aisha.relationship, aisha.has_location_key) == ("connected", False)
    assert ("list_connections", OWNER) in connections.calls


async def test_resolve_single_likely_is_offered_not_confirmed():
    ctx, _, _ = make_ctx()
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Pria"))
    assert result.status == "single_likely"
    assert result.needs == "confirmation"
    assert [c.user_id for c in result.candidates] == [PRIYA]
    assert result.candidates[0].match_tier == 2
    # A circle-mate: location-ready but not connected; said honestly.
    assert result.spoken_facts == ["I found Priya Nair, not connected."]
    assert result.candidates[0].has_location_key is True
    assert ctx.entities.offered_person_ids == [PRIYA]
    assert ctx.entities.person(PRIYA) is None


async def test_resolve_pending_people_are_in_the_connections_pool():
    ctx, _, _ = make_ctx()
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Rahul"))
    assert result.status == "single_likely"
    assert result.candidates[0].relationship == "pending_incoming"
    assert result.spoken_facts == ["I found Rahul Verma, they asked to connect."]


async def test_resolve_none_asks_to_repeat():
    ctx, _, _ = make_ctx()
    ctx.entities.offered_person_ids = [AYESHA]
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Zed"))
    assert result.status == "none"
    assert result.needs == "repeat_name"
    assert result.candidates == []
    assert result.spoken_facts == ["Nobody in your connections matches that name."]
    assert ctx.entities.offered_person_ids == []


async def test_resolve_low_confidence_offers_but_asks_to_repeat():
    ctx, _, _ = make_ctx()
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Priyanka"))
    assert result.status == "low_confidence"
    assert result.needs == "repeat_name"
    assert [(c.display_name, c.match_tier) for c in result.candidates] == [("Priya Nair", 3)]
    assert ctx.entities.offered_person_ids == [PRIYA]
    assert result.spoken_facts == ["The closest in your connections is Priya Nair."]


async def test_resolve_empty_pool_is_no_connections():
    connections = ConnectionsDouble()
    connections.connections = []
    connections.incoming = []
    connections.outgoing = []
    location = LocationDouble()
    location.recipients = []
    ctx, _, _ = make_ctx(connections=connections, location=location)
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Ayesha"))
    assert result.status == "no_connections"
    assert result.needs == "invite"
    assert result.spoken_facts == ["You don't have anyone connected yet."]
    assert ctx.entities.offered_person_ids == []


async def test_resolve_refuses_two_names_at_once():
    ctx, _, _ = make_ctx()
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Ayesha and Priya")
    )
    assert result.status == "rejected"
    assert result.reason_code == "one_name_at_a_time"
    assert result.needs == "repeat_name"


async def test_resolve_directory_pool_uses_search_and_annotates_known_people():
    ctx, connections, _ = make_ctx()
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Preeti", pool="directory")
    )
    assert result.status == "single_likely"
    assert result.candidates[0].user_id == "u-preeti"
    assert result.candidates[0].relationship == "none"
    assert result.candidates[0].has_location_key is False
    assert result.spoken_facts == ["I found Preeti Rao, not connected."]
    assert ("search_directory", (OWNER, "preeti", 1, people.DIRECTORY_LIMIT)) in connections.calls
    # A directory hit that is also a recipient carries the real key state.
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Ayesha", pool="directory")
    )
    assert result.candidates[0].user_id == AYESHA
    assert result.candidates[0].has_location_key is True
    assert result.candidates[0].relationship == "connected"


async def test_resolve_directory_falls_back_to_a_short_prefix_for_near_spellings():
    ctx, connections, _ = make_ctx()
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Pria", pool="directory")
    )
    queries = [call[1][1] for call in connections.calls if call[0] == "search_directory"]
    assert queries == ["pria", "pr"]
    assert result.status == "single_likely"
    assert [c.display_name for c in result.candidates] == ["Priya Nair"]
    assert ctx.entities.offered_person_ids == [PRIYA]


async def test_resolve_directory_none_names_the_directory():
    ctx, _, _ = make_ctx()
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Zed", pool="directory")
    )
    assert result.status == "none"
    assert result.spoken_facts == ["Nobody in the Hussh directory matches that name."]


async def test_resolve_maps_service_errors_to_rejected():
    location = LocationDouble()
    location.error = OneLocationAgentError("LOCATION_NOT_READY", "Set up Location first.")
    ctx, _, _ = make_ctx(location=location)
    result = await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Ayesha"))
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_NOT_READY"
    assert result.spoken_facts == ["Set up Location first."]


# -- confirm_person ---------------------------------------------------------


async def test_confirm_person_rejects_an_id_that_was_not_offered():
    ctx, _, _ = make_ctx()
    result = await people.confirm_person(ctx, people.ConfirmPersonInput(user_id=AYESHA))
    assert result.status == "rejected"
    assert result.reason_code == "person_not_offered"
    assert ctx.entities.person(AYESHA) is None


async def test_confirm_person_reads_the_record_fresh_and_remembers_it():
    ctx, connections, _ = make_ctx()
    await people.resolve_person(ctx, people.ResolvePersonInput(spoken_name="Aysha"))
    # The relationship changed between resolve and confirm: the service wins.
    connections.connections = [row for row in connections.connections if row["userId"] != AYESHA]
    connections.outgoing.append(
        {
            "id": "33333333-3333-4333-8333-333333333333",
            "status": "pending",
            "counterpartUserId": AYESHA,
            "counterpartDisplayName": "Ayesha Sharma",
            "createdAt": None,
            "message": None,
        }
    )
    result = await people.confirm_person(ctx, people.ConfirmPersonInput(user_id=AYESHA))
    assert result.status == "confirmed"
    assert result.person.relationship == "pending_outgoing"
    assert result.person.request_id == "33333333-3333-4333-8333-333333333333"
    assert result.spoken_facts == ["Ayesha Sharma, your request is pending"]
    remembered = ctx.entities.person(AYESHA)
    assert remembered is not None
    assert remembered.display_name == "Ayesha Sharma"
    assert remembered.relationship == "pending_outgoing"
    assert remembered.has_location_key is True
    assert remembered.public_person_ref == "ppr-ayesha"
    assert ctx.entities.last_person_user_id == AYESHA


async def test_confirm_person_from_directory_uses_id_lookup():
    ctx, _, location = make_ctx()
    await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Preeti", pool="directory")
    )
    result = await people.confirm_person(ctx, people.ConfirmPersonInput(user_id="u-preeti"))
    assert result.status == "confirmed"
    assert result.spoken_facts == ["Preeti Rao, not connected"]
    assert ("search_directory_candidates", (OWNER, "u-preeti")) in location.calls
    assert ctx.entities.person("u-preeti").phone_verified is True


async def test_confirm_person_vanished_from_every_source():
    ctx, _, location = make_ctx()
    ctx.entities.offered_person_ids = ["u-gone"]
    result = await people.confirm_person(ctx, people.ConfirmPersonInput(user_id="u-gone"))
    assert result.status == "rejected"
    assert result.reason_code == "person_not_found"
    assert ("search_directory_candidates", (OWNER, "u-gone")) in location.calls


# -- list_people / get_person ---------------------------------------------


async def test_list_people_reports_real_lists_and_counts():
    ctx, connections, _ = make_ctx()
    result = await people.list_people(ctx, people.ListPeopleInput())
    assert result.status == "ok"
    assert [p.display_name for p in result.connected] == ["Aisha Khan", "Ayesha Sharma"]
    assert result.page == 1 and result.has_more is False
    assert [p.display_name for p in result.ready_for_location] == ["Ayesha Sharma", "Priya Nair"]
    assert [(r.request_id, r.display_name) for r in result.pending_incoming] == [
        (REQ_IN, "Rahul Verma")
    ]
    assert [(r.request_id, r.display_name) for r in result.pending_outgoing] == [
        (REQ_OUT, "Dev Patel")
    ]
    assert result.counts.model_dump() == {
        "connections": 2,
        "ready_for_location": 2,
        "pending_incoming": 1,
        "pending_outgoing": 1,
    }
    assert result.spoken_facts == [
        "You're connected with Aisha Khan and Ayesha Sharma.",
        "2 people can receive your location.",
        "Rahul Verma asked to connect with you.",
        "Your request to Dev Patel is still pending.",
    ]
    assert result.connected[1].connection_id == "conn-ayesha"
    assert result.connected[1].connected_from_contacts is True
    # The page came from the paged read, bounded; the legacy full list is not the model's context.
    assert ("list_connections_page", (OWNER, "", 1, people.LIST_PAGE_LIMIT)) in connections.calls


async def test_list_people_pages_and_never_calls_a_page_the_total():
    connections = ConnectionsDouble()
    connections.connections = [
        {
            "connectionId": f"conn-{i:03d}",
            "userId": f"u-{i:03d}",
            "publicPersonRef": None,
            "displayName": f"Person {i:03d}",
            "photoUrl": None,
            "email": None,
            "createdAt": "2026-01-01T00:00:00+00:00",
            "isRia": False,
            "connectedFromContacts": False,
        }
        for i in range(1, 46)
    ]
    ctx, _, _ = make_ctx(connections=connections)
    first = await people.list_people(ctx, people.ListPeopleInput())
    assert len(first.connected) == people.LIST_PAGE_LIMIT
    assert first.has_more is True and first.counts.connections == 45
    assert first.spoken_facts[0].startswith("You have 45 connections. Page 1 has ")
    assert first.spoken_facts[0].endswith(", and 14 more.")
    assert first.spoken_facts[1] == "There are more on the next page."
    third = await people.list_people(ctx, people.ListPeopleInput(page=3))
    assert len(third.connected) == 5 and third.has_more is False
    fourth = await people.list_people(ctx, people.ListPeopleInput(page=4))
    assert fourth.connected == [] and fourth.spoken_facts[0] == "There's nobody on page 4."
    assert fourth.status == "ok"
    filtered = await people.list_people(ctx, people.ListPeopleInput(query="Person 04"))
    assert [p.display_name for p in filtered.connected] == [f"Person 04{i}" for i in range(0, 6)]
    assert filtered.spoken_facts[0].startswith("6 connections match that name: ")


async def test_list_people_no_connections_needs_invite():
    connections = ConnectionsDouble()
    connections.connections = []
    connections.incoming = []
    connections.outgoing = []
    location = LocationDouble()
    location.recipients = []
    ctx, _, _ = make_ctx(connections=connections, location=location)
    result = await people.list_people(ctx, people.ListPeopleInput())
    assert result.status == "no_connections"
    assert result.needs == "invite"
    assert result.spoken_facts == ["You don't have anyone connected yet."]


async def test_list_people_failed_page_is_a_refusal_not_an_empty_page():
    connections = ConnectionsDouble()

    def broken(*args: Any, **kwargs: Any):
        raise ConnectionsError("CONNECTIONS_UNAVAILABLE", "Connections are unavailable.")

    connections.list_connections_page = broken  # type: ignore[method-assign]
    ctx, _, _ = make_ctx(connections=connections)
    result = await people.list_people(ctx, people.ListPeopleInput())
    assert result.status == "rejected" and result.reason_code == "CONNECTIONS_UNAVAILABLE"


async def test_get_person_requires_a_confirmed_person_via_executor_guard():
    ctx, _, _ = make_ctx()
    parsed = people.GetPersonInput(person=PersonRef(user_id=AYESHA))
    problem = ToolExecutor._entity_problem(spec("get_person"), ctx, parsed)
    assert problem is not None and problem.reason_code == "person_not_confirmed"
    confirm(ctx, AYESHA, "Ayesha Sharma")
    assert ToolExecutor._entity_problem(spec("get_person"), ctx, parsed) is None


async def test_get_person_refreshes_relationship_and_entity():
    ctx, _, _ = make_ctx()
    confirm(ctx, AYESHA, "Ayesha Sharma", relationship="none")
    result = await people.get_person(ctx, people.GetPersonInput(person=PersonRef(user_id=AYESHA)))
    assert result.status == "ok"
    assert result.person.relationship == "connected"
    assert result.person.connection_id == "conn-ayesha"
    assert result.counts.connections == 2
    assert result.spoken_facts == [
        "Ayesha Sharma, connected",
        "Ayesha Sharma can receive your location.",
    ]
    assert ctx.entities.person(AYESHA).relationship == "connected"


async def test_get_person_not_found_anymore():
    ctx, _, _ = make_ctx()
    confirm(ctx, "u-gone", "Gone Person")
    result = await people.get_person(ctx, people.GetPersonInput(person=PersonRef(user_id="u-gone")))
    assert result.status == "not_found"
    assert result.spoken_facts == ["Gone Person isn't findable on Hussh right now."]


async def test_load_connected_people_helper():
    ctx, _, _ = make_ctx()
    rows = await people.load_connected_people(ctx)
    assert [(r["user_id"], r["has_location_key"], r["phone_verified"]) for r in rows] == [
        (AISHA, False, True),
        (AYESHA, True, True),
    ]
    assert all(r["relationship"] == "connected" for r in rows)


# -- invite_person ----------------------------------------------------------


def test_invite_summary_names_the_confirmed_person():
    ctx, _, _ = make_ctx()
    confirm(ctx, "u-preeti", "Preeti Rao", relationship="none")
    args = people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    assert spec("invite_person").summarize(ctx, args) == "send a connection request to Preeti Rao"


async def test_invite_person_sends_a_real_request():
    ctx, connections, _ = make_ctx()
    confirm(ctx, "u-preeti", "Preeti Rao", relationship="none")
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"), message="  hello ")
    )
    assert result.status == "sent"
    assert result.request_id == "req-new"
    assert result.request_status == "pending" and result.direction == "outgoing"
    assert result.spoken_facts == [
        "Connection request sent to Preeti Rao. It's waiting for them to accept."
    ]
    assert (
        "create_request",
        (OWNER, {"addressee_user_id": "u-preeti", "message": "hello"}),
    ) in connections.calls
    assert ctx.entities.person("u-preeti").relationship == "pending_outgoing"


async def test_invite_person_reads_the_committed_payload_not_the_expectation():
    """The service returns an existing pending request in either direction and
    the same shape for a new one; only the payload says which happened."""
    ctx, connections, _ = make_ctx()
    confirm(ctx, "u-preeti", "Preeti Rao", relationship="none")

    # They asked first between our read and our write: nothing was sent backwards.
    connections.create_request = lambda requester_user_id, **kw: {  # type: ignore[method-assign]
        "id": "req-theirs",
        "requesterUserId": "u-preeti",
        "addresseeUserId": OWNER,
        "status": "pending",
        "message": None,
        "scopes": [],
    }
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    )
    assert result.status == "already_pending" and result.direction == "incoming"
    assert result.request_id == "req-theirs"
    assert result.spoken_facts == [
        "Preeti Rao already asked to connect with you. You can accept it."
    ]

    # Our own earlier request came back (a concurrent send): pending, not "sent".
    connections.outgoing.append(
        {
            "id": "req-mine",
            "requesterUserId": OWNER,
            "addresseeUserId": "u-preeti",
            "status": "pending",
            "message": None,
            "createdAt": "2026-01-05T00:00:00+00:00",
            "counterpartUserId": "u-preeti",
            "counterpartDisplayName": "Preeti Rao",
            "counterpartPhotoUrl": None,
            "scopes": [],
        }
    )
    ctx2, connections2, _ = make_ctx(connections=connections)
    confirm(ctx2, "u-preeti", "Preeti Rao", relationship="none")
    result = await people.invite_person(
        ctx2, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    )
    assert result.status == "already_pending" and result.direction == "outgoing"
    assert result.request_id == "req-mine"
    assert not [c for c in connections2.calls if c[0] == "create_request"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"id": "", "status": "pending", "requesterUserId": OWNER, "addresseeUserId": "u-preeti"},
        {"id": "req-x", "status": "", "requesterUserId": OWNER, "addresseeUserId": "u-preeti"},
        {
            "id": "req-x",
            "status": "pending",
            "requesterUserId": "u-someone",
            "addresseeUserId": "u-else",
        },
    ],
)
async def test_invite_person_never_says_sent_on_a_malformed_result(payload):
    ctx, connections, _ = make_ctx()
    confirm(ctx, "u-preeti", "Preeti Rao", relationship="none")
    connections.create_request = lambda requester_user_id, **kw: dict(payload)  # type: ignore[method-assign]
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    )
    assert result.status == "rejected" and result.reason_code == "malformed_request_result"
    assert "couldn't confirm" in result.spoken_facts[0]
    assert "sent" not in result.spoken_facts[0].lower().replace("went through", "")


async def test_invite_person_keeps_the_message_as_written_up_to_the_route_limit():
    ctx, connections, _ = make_ctx()
    confirm(ctx, "u-preeti", "Preeti Rao", relationship="none")
    note = "x" * 1000
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"), message=note)
    )
    assert result.status == "sent"
    sent = next(c for c in connections.calls if c[0] == "create_request")[1][1]["message"]
    assert sent == note
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        people.InvitePersonInput(person=PersonRef(user_id="u-preeti"), message="x" * 1001)
    assert (
        people.summarize_invite(
            ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"), message="hi")
        )
        == "send a connection request to Preeti Rao with your note"
    )


async def test_invite_person_already_connected_and_pending_do_not_send():
    ctx, connections, _ = make_ctx()
    confirm(ctx, AYESHA, "Ayesha Sharma")
    confirm(ctx, DEV, "Dev Patel", relationship="pending_outgoing")
    confirm(ctx, RAHUL, "Rahul Verma", relationship="pending_incoming")
    connected = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id=AYESHA))
    )
    assert connected.status == "already_connected"
    assert connected.spoken_facts == ["You're already connected with Ayesha Sharma."]
    outgoing = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id=DEV))
    )
    assert (outgoing.status, outgoing.direction, outgoing.request_id) == (
        "already_pending",
        "outgoing",
        REQ_OUT,
    )
    assert outgoing.spoken_facts == ["Your request to Dev Patel is still pending."]
    incoming = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id=RAHUL))
    )
    assert (incoming.status, incoming.direction, incoming.request_id) == (
        "already_pending",
        "incoming",
        REQ_IN,
    )
    assert not [call for call in connections.calls if call[0] == "create_request"]


async def test_invite_person_service_errors_become_rejected():
    connections = ConnectionsDouble()
    connections.create_error = ConnectionsError(
        "CONNECTION_ALREADY_CONNECTED", "You are already connected with this person."
    )
    ctx, _, _ = make_ctx(connections=connections)
    confirm(ctx, "u-preeti", "Preeti Rao", relationship="none")
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    )
    assert result.status == "already_connected"
    connections.create_error = ConnectionsError(
        "CONNECTION_NO_SELF", "You cannot connect with yourself."
    )
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    )
    assert result.status == "rejected"
    assert result.reason_code == "CONNECTION_NO_SELF"
    assert result.spoken_facts == ["You cannot connect with yourself."]


async def test_invite_person_self_is_unsupported():
    ctx, _, _ = make_ctx()
    confirm(ctx, OWNER, "Me", relationship="self")
    result = await people.invite_person(
        ctx, people.InvitePersonInput(person=PersonRef(user_id=OWNER))
    )
    assert result.status == "unsupported"
    assert result.reason_code == "person_is_self"


async def test_invite_person_executor_guard_rejects_unconfirmed():
    ctx, _, _ = make_ctx()
    parsed = people.InvitePersonInput(person=PersonRef(user_id="u-preeti"))
    problem = ToolExecutor._entity_problem(spec("invite_person"), ctx, parsed)
    assert problem is not None
    assert problem.reason_code == "person_not_confirmed"
    assert problem.needs == "disambiguation"


# -- respond_connection_request --------------------------------------------


def test_accept_and_decline_summaries_with_and_without_a_confirmed_person():
    ctx, _, _ = make_ctx()
    args = people.ConnectionRequestInput(request_id=REQ_IN)
    assert spec("accept_connection_request").summarize(ctx, args) == "accept the connection request"
    args = people.ConnectionRequestInput(request_id=REQ_IN, person=PersonRef(user_id=RAHUL))
    # Unconfirmed person: the card never names anyone the context does not hold.
    assert (
        spec("decline_connection_request").summarize(ctx, args) == "decline the connection request"
    )
    confirm(ctx, RAHUL, "Rahul Verma", relationship="pending_incoming")
    assert spec("decline_connection_request").summarize(ctx, args) == (
        "decline the connection request from Rahul Verma"
    )
    assert spec("accept_connection_request").summarize(ctx, args) == (
        "accept the connection request from Rahul Verma"
    )


async def test_accept_remembers_the_new_connection():
    ctx, connections, _ = make_ctx()
    await _offer_requests(ctx)
    result = await people.accept_connection_request(
        ctx, people.ConnectionRequestInput(request_id=REQ_IN)
    )
    assert result.status == "accepted" and result.request_status == "accepted"
    assert result.display_name == "Rahul Verma"
    assert result.user_id == RAHUL
    assert result.connection_id == "conn-new"
    assert result.client_step is None
    assert result.spoken_facts == ["You're now connected with Rahul Verma."]
    assert ("accept_request", (OWNER, REQ_IN)) in connections.calls
    assert ctx.entities.person(RAHUL).relationship == "connected"


async def test_decline_is_a_success_outcome_over_a_rejected_row():
    ctx, connections, _ = make_ctx()
    await _offer_requests(ctx)
    result = await people.decline_connection_request(
        ctx, people.ConnectionRequestInput(request_id=REQ_IN)
    )
    # A decline that went through is a success outcome; the request row is
    # what the service calls "rejected". Never conflate the two.
    assert result.status == "declined" and result.request_status == "rejected"
    assert result.public()["status"] not in {"rejected", "unsupported"}
    assert result.spoken_facts == ["Declined the request from Rahul Verma."]
    assert ("reject_request", (OWNER, REQ_IN)) in connections.calls
    assert not [c for c in connections.calls if c[0] == "accept_request"]


@pytest.mark.parametrize("tool", ["accept_connection_request", "decline_connection_request"])
async def test_accept_decline_unknown_request_and_person_mismatch(tool):
    ctx, connections, _ = make_ctx()
    await _offer_requests(ctx)
    handler = spec(tool).handler
    # An outgoing id is not an incoming request; a fabricated id never reaches the service.
    missing = await handler(ctx, people.ConnectionRequestInput(request_id=REQ_OUT))
    assert missing.status == "rejected" and missing.reason_code == "request_not_offered"
    made_up = await handler(ctx, people.ConnectionRequestInput(request_id="not-a-real-id"))
    assert made_up.reason_code == "request_not_offered"
    # Listed, then gone before the write: refused as not found, never sent to the service.
    connections.incoming = []
    gone = await handler(ctx, people.ConnectionRequestInput(request_id=REQ_IN))
    assert gone.reason_code == "request_not_found"
    ctx2, connections2, _ = make_ctx()
    await _offer_requests(ctx2)
    connections = connections2
    ctx = ctx2
    unconfirmed = await handler(
        ctx, people.ConnectionRequestInput(request_id=REQ_IN, person=PersonRef(user_id=AYESHA))
    )
    assert unconfirmed.reason_code == "person_not_confirmed"
    confirm(ctx, AYESHA, "Ayesha Sharma")
    mismatch = await handler(
        ctx, people.ConnectionRequestInput(request_id=REQ_IN, person=PersonRef(user_id=AYESHA))
    )
    assert mismatch.reason_code == "request_person_mismatch"
    assert mismatch.spoken_facts == ["That request is from Rahul Verma, not who you named."]
    assert not [
        call for call in connections.calls if call[0] in {"accept_request", "reject_request"}
    ]


async def test_accept_with_scopes_opens_the_review_and_accepts_nothing():
    connections = ConnectionsDouble()
    connections.accept_error = ConnectionsError(
        "CONNECTION_SCOPE_SELECTION_REQUIRED",
        "Review the requested and offered scopes before accepting this connection.",
        status_code=409,
    )
    ctx, _, _ = make_ctx(connections=connections)
    await _offer_requests(ctx)
    result = await people.accept_connection_request(
        ctx, people.ConnectionRequestInput(request_id=REQ_IN)
    )
    assert result.status == "scope_review_required" and result.request_status == "pending"
    assert result.needs == "client_step"
    assert result.client_step == {
        "kind": "open_request_review",
        "purpose": "connection_scope_review",
        "request_id": REQ_IN,
        "user_id": RAHUL,
        "display_name": "Rahul Verma",
        "timeout_s": 600,
    }
    assert result.spoken_facts == [
        "Rahul Verma's request includes information they want to share or see. "
        "I'm opening it so you can review that before accepting."
    ]
    # Opening the review is not acceptance: the relationship is unchanged.
    assert ctx.entities.person(RAHUL) is None
    assert result.public()["status"] not in {"accepted"}


# -- cancel_connection_request ---------------------------------------------


def test_cancel_summary():
    ctx, _, _ = make_ctx()
    summarize = spec("cancel_connection_request").summarize
    args = people.CancelConnectionRequestInput(request_id=REQ_OUT)
    assert summarize(ctx, args) == "cancel your connection request"
    confirm(ctx, DEV, "Dev Patel", relationship="pending_outgoing")
    args = people.CancelConnectionRequestInput(request_id=REQ_OUT, person=PersonRef(user_id=DEV))
    assert summarize(ctx, args) == "cancel your connection request to Dev Patel"


async def test_cancel_connection_request_cancels_the_real_row():
    ctx, connections, _ = make_ctx()
    confirm(ctx, DEV, "Dev Patel", relationship="pending_outgoing")
    await _offer_requests(ctx)
    result = await people.cancel_connection_request(
        ctx, people.CancelConnectionRequestInput(request_id=REQ_OUT, person=PersonRef(user_id=DEV))
    )
    assert result.status == "cancelled"
    assert result.display_name == "Dev Patel"
    assert result.spoken_facts == ["Cancelled your request to Dev Patel."]
    assert ("cancel_request", (OWNER, REQ_OUT)) in connections.calls
    assert ctx.entities.person(DEV).relationship == "none"


async def test_cancel_connection_request_unknown_request():
    ctx, connections, _ = make_ctx()
    await _offer_requests(ctx)
    # An incoming id is not something the person can withdraw.
    result = await people.cancel_connection_request(
        ctx, people.CancelConnectionRequestInput(request_id=REQ_IN)
    )
    assert result.status == "rejected"
    assert result.reason_code == "request_not_offered"
    # Listed as outgoing, then withdrawn elsewhere before the write.
    connections.outgoing = []
    result = await people.cancel_connection_request(
        ctx, people.CancelConnectionRequestInput(request_id=REQ_OUT)
    )
    assert result.reason_code == "request_not_found"
    assert not [call for call in connections.calls if call[0] == "cancel_request"]


# -- remove_connection ------------------------------------------------------


def test_remove_summary_states_the_connection_level_consequence():
    ctx, _, _ = make_ctx()
    confirm(ctx, AYESHA, "Ayesha Sharma")
    args = people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    assert spec("remove_connection").summarize(ctx, args) == (
        "disconnect from Ayesha Sharma: this ends your connection everywhere, including any "
        "circle memberships that came from it"
    )


async def test_remove_connection_uses_the_real_connection_id_and_verifies_the_post_state():
    ctx, connections, location = make_ctx()
    confirm(ctx, AYESHA, "Ayesha Sharma")
    result = await people.remove_connection(
        ctx, people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    )
    assert result.status == "removed" and result.relationship_after == "none"
    assert result.spoken_facts == ["You're no longer connected with Ayesha Sharma."]
    assert ("remove_connection", (OWNER, "conn-ayesha")) in connections.calls
    # Re-read after the write: the relationship is what the server says now.
    reads = [c for c in connections.calls if c[0] == "list_connections"]
    assert len(reads) >= 2
    remembered = ctx.entities.person(AYESHA)
    assert remembered.relationship == "none"


async def test_remove_connection_reports_unverified_when_the_re_read_disagrees():
    connections = ConnectionsDouble()
    connections.removal_leaves_connected = True  # the service said removed, the graph did not move
    ctx, _, _ = make_ctx(connections=connections)
    confirm(ctx, AYESHA, "Ayesha Sharma")
    result = await people.remove_connection(
        ctx, people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    )
    assert result.status == "unverified" and result.relationship_after == "connected"
    assert result.public()["status"] not in {"removed"}
    assert "still show as connected" in result.spoken_facts[0]


async def test_remove_connection_not_connected_and_nothing_removed():
    ctx, connections, _ = make_ctx()
    confirm(ctx, PRIYA, "Priya Nair", relationship="none")
    result = await people.remove_connection(
        ctx, people.RemoveConnectionInput(person=PersonRef(user_id=PRIYA))
    )
    assert result.status == "not_connected"
    assert result.spoken_facts == ["You're not connected with Priya Nair."]
    assert not [call for call in connections.calls if call[0] == "remove_connection"]
    connections.removed = 0
    confirm(ctx, AYESHA, "Ayesha Sharma")
    result = await people.remove_connection(
        ctx, people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    )
    assert result.status == "not_connected"


async def test_remove_connection_executor_guard_rejects_unconfirmed():
    ctx, _, _ = make_ctx()
    parsed = people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    problem = ToolExecutor._entity_problem(spec("remove_connection"), ctx, parsed)
    assert problem is not None and problem.reason_code == "person_not_confirmed"


# -- recipient grounding: names only, bounded pages, fresh offers -----------------


@pytest.mark.parametrize(
    "spoken", ["9876543210", "+91 98765 43210", "priya@example.com", "call 98765-43210"]
)
async def test_resolve_person_refuses_a_phone_or_email_as_a_name(spoken):
    ctx, connections, _ = make_ctx()
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name=spoken, pool="directory")
    )
    assert result.status == "rejected" and result.reason_code == "identifier_not_a_name"
    assert result.needs == "repeat_name"
    assert result.spoken_facts == [
        "I look people up by name, not by phone number or email. What's their name?"
    ]
    assert not [c for c in connections.calls if c[0] == "search_directory"]
    assert ctx.entities.offered_person_ids == []


def _directory_of(count: int, prefix: str = "Pri") -> list[dict[str, Any]]:
    return [
        {
            "userId": f"u-{prefix.lower()}-{i:03d}",
            "publicPersonRef": None,
            "displayName": f"{prefix}ya Number{i:03d}",
            "photoUrl": None,
            "relationship": "none",
            "isRia": False,
        }
        for i in range(count)
    ]


async def test_resolve_person_reads_more_than_one_directory_page_before_claiming_nobody():
    connections = ConnectionsDouble()
    # 70 server-side prefix neighbours ("Pri...") fill page 1; the ranker
    # discards them, and the real Priya Nair sits on page 2.
    connections.directory = _directory_of(70, prefix="Pritam ") + [
        {
            "userId": PRIYA,
            "publicPersonRef": "ppr-priya",
            "displayName": "Priya Nair",
            "photoUrl": None,
            "relationship": "none",
            "isRia": False,
        }
    ]

    def paged(user_id: str, *, query: str = "", page: int = 1, limit: int = 20):
        connections.calls.append(("search_directory", (user_id, query, page, limit)))
        needle = (query or "").lower()[:3]
        rows = [r for r in connections.directory if r["displayName"].lower().startswith(needle)]
        offset = (page - 1) * limit
        items = rows[offset : offset + limit]
        return {
            "items": items,
            "page": page,
            "hasMore": offset + len(items) < len(rows),
            "audience": "all",
        }

    connections.search_directory = paged  # type: ignore[method-assign]
    ctx, _, _ = make_ctx(connections=connections)
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Priya Nair", pool="directory")
    )
    pages = [c[1][2] for c in connections.calls if c[0] == "search_directory"]
    assert pages == [1, 2]
    assert result.status == "single_likely" and result.truncated is False
    assert result.candidates[0].user_id == PRIYA
    assert result.offer_revision == 1 and ctx.entities.offer_revision == 1


async def test_resolve_person_reports_truncation_instead_of_the_only_match():
    connections = ConnectionsDouble()
    connections.directory = _directory_of(400, prefix="Pri")

    def paged(user_id: str, *, query: str = "", page: int = 1, limit: int = 20):
        connections.calls.append(("search_directory", (user_id, query, page, limit)))
        offset = (page - 1) * limit
        items = connections.directory[offset : offset + limit]
        return {
            "items": items,
            "page": page,
            "hasMore": offset + len(items) < len(connections.directory),
            "audience": "all",
        }

    connections.search_directory = paged  # type: ignore[method-assign]
    ctx, _, _ = make_ctx(connections=connections)
    result = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Priya Number", pool="directory")
    )
    pages = [c[1][2] for c in connections.calls if c[0] == "search_directory"]
    assert pages == [1, 2, 3]  # bounded: never the whole directory
    assert result.status == "truncated" and result.truncated is True
    assert result.needs == "repeat_name"
    assert result.spoken_facts[0].startswith("Lots of people in the Hussh directory match that")
    assert result.spoken_facts[0].endswith("Say their full name, or pick one of those.")
    # What was seen is still offered, so "the second one" can be picked.
    assert ctx.entities.offered_person_ids and len(ctx.entities.offered_person_ids) == len(
        result.candidates
    )


async def test_confirm_person_refuses_a_stale_offer_and_a_new_offer_bumps_the_revision():
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.one_voice.tools.base import OFFER_TTL_SECONDS

    ctx, _, _ = make_ctx()
    first = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Preeti", pool="directory")
    )
    assert first.status == "single_likely" and first.offer_revision == 1
    ctx.entities.offered_at = (
        datetime.now(UTC) - timedelta(seconds=OFFER_TTL_SECONDS + 5)
    ).isoformat()
    stale = await people.confirm_person(ctx, people.ConfirmPersonInput(user_id="u-preeti"))
    assert stale.status == "rejected" and stale.reason_code == "offer_expired"
    assert stale.needs == "repeat_name"
    assert ctx.entities.offered_person_ids == []
    again = await people.resolve_person(
        ctx, people.ResolvePersonInput(spoken_name="Preeti", pool="directory")
    )
    assert again.offer_revision > first.offer_revision
    assert ctx.entities.offer_revision == again.offer_revision
    fresh = await people.confirm_person(ctx, people.ConfirmPersonInput(user_id="u-preeti"))
    assert fresh.status == "confirmed"


def test_stale_offers_are_dropped_on_prune():
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.one_voice.tools.base import OFFER_TTL_SECONDS, EntityContext

    entities = EntityContext()
    entities.offer_people(["u-a", "u-b"], circle_id="11111111-1111-4111-8111-111111111111")
    assert entities.offer_is_fresh() and entities.offer_revision == 1
    entities.prune()
    assert entities.offered_person_ids == ["u-a", "u-b"]
    entities.offered_at = (datetime.now(UTC) - timedelta(seconds=OFFER_TTL_SECONDS + 1)).isoformat()
    entities.prune()
    assert entities.offered_person_ids == [] and entities.offered_person_circle_id is None


@pytest.mark.parametrize(
    ("tool", "request_id"),
    [
        ("accept_connection_request", REQ_IN),
        ("decline_connection_request", REQ_IN),
        ("cancel_connection_request", REQ_OUT),
    ],
)
async def test_request_actions_refuse_ids_the_server_never_listed(tool, request_id):
    ctx, connections, _ = make_ctx()
    handler = spec(tool).handler
    model = spec(tool).input_model
    # Real id, but never listed in this conversation: refused before any read or write.
    result = await handler(ctx, model(request_id=request_id))
    assert result.status == "rejected" and result.reason_code == "request_not_offered"
    assert result.needs == "disambiguation"
    assert not [
        c
        for c in connections.calls
        if c[0] in {"accept_request", "reject_request", "cancel_request"}
    ]
    # An outgoing id is not acceptable/declinable and an incoming id is not cancellable.
    await _offer_requests(ctx)
    wrong = REQ_OUT if tool != "cancel_connection_request" else REQ_IN
    result = await handler(ctx, model(request_id=wrong))
    assert result.reason_code == "request_not_offered"


def test_request_cards_name_the_listed_counterpart_even_without_a_person():
    ctx, _, _ = make_ctx()
    asyncio.run(_offer_requests(ctx))
    accept = people.ConnectionRequestInput(request_id=REQ_IN)
    assert spec("accept_connection_request").summarize(ctx, accept) == (
        "accept the connection request from Rahul Verma"
    )
    assert spec("decline_connection_request").summarize(ctx, accept) == (
        "decline the connection request from Rahul Verma"
    )
    cancel = people.CancelConnectionRequestInput(request_id=REQ_OUT)
    assert spec("cancel_connection_request").summarize(ctx, cancel) == (
        "cancel your connection request to Dev Patel"
    )
    # A person the model names never overrides what the server listed.
    confirm(ctx, AYESHA, "Ayesha Sharma")
    named = people.ConnectionRequestInput(request_id=REQ_IN, person=PersonRef(user_id=AYESHA))
    assert spec("accept_connection_request").summarize(ctx, named) == (
        "accept the connection request from Rahul Verma"
    )
