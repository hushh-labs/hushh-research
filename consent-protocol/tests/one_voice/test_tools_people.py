"""People tools: resolve/confirm by canonical id, reads, and confirm_* mutations.

Services are doubles injected through ``ToolContext(services=...)``; every
spoken fact asserted here is derived from what the double returned.
"""

from __future__ import annotations

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
    assert table == {
        "resolve_person": (ToolPolicy.read, "location.find_contacts", (), False),
        "confirm_person": (ToolPolicy.read, "location.find_contacts", (), False),
        "list_people": (ToolPolicy.read, "location.open_people", (), False),
        "get_person": (ToolPolicy.read, "location.open_people", ("person",), False),
        "invite_person": (ToolPolicy.confirm_voice, "people.profile.connect", ("person",), True),
        "respond_connection_request": (
            ToolPolicy.confirm_voice,
            "people.profile.connect",
            (),
            True,
        ),
        "cancel_connection_request": (
            ToolPolicy.confirm_tap,
            "people.profile.cancel_connection_request",
            (),
            True,
        ),
        "remove_connection": (
            ToolPolicy.confirm_tap,
            "people.profile.remove_connection",
            ("person",),
            True,
        ),
    }
    for tool in people.TOOLS:
        assert (tool.summarize is not None) == tool.policy.needs_confirmation, tool.name
        statuses = tool.output_model.model_fields["status"].annotation.__args__
        assert statuses and all(isinstance(item, str) for item in statuses), tool.name
        tool.declaration()  # schema must inline without error


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
    ctx, _, _ = make_ctx()
    result = await people.list_people(ctx, people.ListPeopleInput())
    assert result.status == "ok"
    assert [p.display_name for p in result.connected] == ["Aisha Khan", "Ayesha Sharma"]
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
    assert result.request_status == "pending"
    assert result.spoken_facts == ["Connection request sent to Preeti Rao."]
    assert (
        "create_request",
        (OWNER, {"addressee_user_id": "u-preeti", "message": "hello"}),
    ) in connections.calls


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


def test_respond_summary_with_and_without_a_confirmed_person():
    ctx, _, _ = make_ctx()
    summarize = spec("respond_connection_request").summarize
    args = people.RespondConnectionRequestInput(request_id=REQ_IN, accept=True)
    assert summarize(ctx, args) == "accept the connection request"
    args = people.RespondConnectionRequestInput(
        request_id=REQ_IN, accept=False, person=PersonRef(user_id=RAHUL)
    )
    # Unconfirmed person: the card never names anyone the context does not hold.
    assert summarize(ctx, args) == "decline the connection request"
    confirm(ctx, RAHUL, "Rahul Verma", relationship="pending_incoming")
    assert summarize(ctx, args) == "decline the connection request from Rahul Verma"


async def test_respond_accepts_and_remembers_the_new_connection():
    ctx, connections, _ = make_ctx()
    result = await people.respond_connection_request(
        ctx, people.RespondConnectionRequestInput(request_id=REQ_IN, accept=True)
    )
    assert result.status == "accepted"
    assert result.display_name == "Rahul Verma"
    assert result.user_id == RAHUL
    assert result.connection_id == "conn-new"
    assert result.spoken_facts == ["You're now connected with Rahul Verma."]
    assert ("accept_request", (OWNER, REQ_IN)) in connections.calls
    assert ctx.entities.person(RAHUL).relationship == "connected"


async def test_respond_declines():
    ctx, connections, _ = make_ctx()
    result = await people.respond_connection_request(
        ctx, people.RespondConnectionRequestInput(request_id=REQ_IN, accept=False)
    )
    assert result.status == "rejected"
    assert result.spoken_facts == ["Declined the request from Rahul Verma."]
    assert ("reject_request", (OWNER, REQ_IN)) in connections.calls


async def test_respond_unknown_request_and_person_mismatch():
    ctx, connections, _ = make_ctx()
    missing = await people.respond_connection_request(
        ctx, people.RespondConnectionRequestInput(request_id=REQ_OUT, accept=True)
    )
    assert missing.status == "rejected"
    assert missing.reason_code == "request_not_found"
    unconfirmed = await people.respond_connection_request(
        ctx,
        people.RespondConnectionRequestInput(
            request_id=REQ_IN, accept=True, person=PersonRef(user_id=AYESHA)
        ),
    )
    assert unconfirmed.reason_code == "person_not_confirmed"
    confirm(ctx, AYESHA, "Ayesha Sharma")
    mismatch = await people.respond_connection_request(
        ctx,
        people.RespondConnectionRequestInput(
            request_id=REQ_IN, accept=True, person=PersonRef(user_id=AYESHA)
        ),
    )
    assert mismatch.reason_code == "request_person_mismatch"
    assert mismatch.spoken_facts == ["That request is from Rahul Verma, not who you named."]
    assert not [call for call in connections.calls if call[0] == "accept_request"]


async def test_respond_scope_review_error_needs_a_client_step():
    connections = ConnectionsDouble()
    connections.accept_error = ConnectionsError(
        "CONNECTION_SCOPE_SELECTION_REQUIRED",
        "Review the requested and offered scopes before accepting this connection.",
        status_code=409,
    )
    ctx, _, _ = make_ctx(connections=connections)
    result = await people.respond_connection_request(
        ctx, people.RespondConnectionRequestInput(request_id=REQ_IN, accept=True)
    )
    assert result.status == "rejected"
    assert result.reason_code == "CONNECTION_SCOPE_SELECTION_REQUIRED"
    assert result.needs == "client_step"
    assert result.spoken_facts == [
        "Review the requested and offered scopes before accepting this connection."
    ]


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
    result = await people.cancel_connection_request(
        ctx, people.CancelConnectionRequestInput(request_id=REQ_IN)
    )
    assert result.status == "rejected"
    assert result.reason_code == "request_not_found"
    assert not [call for call in connections.calls if call[0] == "cancel_request"]


# -- remove_connection ------------------------------------------------------


def test_remove_summary_names_the_confirmed_person():
    ctx, _, _ = make_ctx()
    confirm(ctx, AYESHA, "Ayesha Sharma")
    args = people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    assert spec("remove_connection").summarize(ctx, args) == (
        "remove Ayesha Sharma from your connections"
    )


async def test_remove_connection_uses_the_real_connection_id():
    ctx, connections, _ = make_ctx()
    confirm(ctx, AYESHA, "Ayesha Sharma")
    result = await people.remove_connection(
        ctx, people.RemoveConnectionInput(person=PersonRef(user_id=AYESHA))
    )
    assert result.status == "removed"
    assert result.spoken_facts == ["Removed Ayesha Sharma from your connections."]
    assert ("remove_connection", (OWNER, "conn-ayesha")) in connections.calls
    remembered = ctx.entities.person(AYESHA)
    assert remembered.relationship == "none"
    assert remembered.has_location_key is False


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
