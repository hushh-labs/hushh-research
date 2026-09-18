"""Circle tools: ids not names, real facts only, honest statuses, confirm cards."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from hushh_mcp.one_voice.tools import circles
from hushh_mcp.one_voice.tools.base import (
    ConfirmedCircle,
    ConfirmedPerson,
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolPolicy,
    now_iso,
)
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from hushh_mcp.services.one_location_circle_service import OneLocationCircleError

USER = "user-owner"
AYESHA = "user-ayesha"
PRIYA = "user-priya"
FAMILY = "11111111-1111-4111-8111-111111111111"
WORK = "22222222-2222-4222-8222-222222222222"
SCHOOL = "33333333-3333-4333-8333-333333333333"
INVITE_IN = "44444444-4444-4444-8444-444444444444"
INVITE_OUT = "55555555-5555-4555-8555-555555555555"
NOT_OFFERED = "99999999-9999-4999-8999-999999999999"


def _row(
    circle_id: str, name: str, *, kind: str = "other", role: str = "owner", members=None, **extra
):
    members = members or []
    return {
        "id": circle_id,
        "name": name,
        "kind": kind,
        "role": role,
        "isSystem": False,
        "memberCount": len(members) or 1,
        "members": [
            {
                "userId": uid,
                "displayName": label,
                "role": "owner" if (uid == USER and role == "owner") else "member",
                "relationship": "self" if uid == USER else "connected",
                "joinedAt": "2030-01-01T00:00:00+00:00",
            }
            for uid, label in members
        ],
        **extra,
    }


def _invite(
    invite_id: str,
    *,
    circle_id: str,
    circle_name: str,
    inviter: str,
    invitee: str,
    invitee_id: str,
    status: str = "pending",
):
    return {
        "id": invite_id,
        "circleId": circle_id,
        "circleName": circle_name,
        "circleKind": "other",
        "inviterUserId": USER,
        "inviterDisplayName": inviter,
        "inviteeUserId": invitee_id,
        "inviteeDisplayName": invitee,
        "status": status,
        "expiresAt": "2030-01-01T00:00:00+00:00",
    }


class FakeCircleService:
    """Sync double with the canonical keyword-only signatures."""

    def __init__(self) -> None:
        self.circles: list[dict[str, Any]] = [
            _row(FAMILY, "Family", kind="family", members=[(USER, "Me"), (PRIYA, "Priya Nair")]),
            _row(WORK, "Work Friends", kind="friends", role="member"),
            _row(SCHOOL, "School Friends", kind="friends"),
        ]
        self.eligible: dict[str, list[dict[str, Any]]] = {
            FAMILY: [{"userId": AYESHA, "displayName": "Ayesha Sharma"}],
        }
        self.incoming: list[dict[str, Any]] = [
            _invite(
                INVITE_IN,
                circle_id=WORK,
                circle_name="Work Friends",
                inviter="Rohan Mehta",
                invitee="Me",
                invitee_id=USER,
            ),
        ]
        self.outgoing: list[dict[str, Any]] = [
            _invite(
                INVITE_OUT,
                circle_id=FAMILY,
                circle_name="Family",
                inviter="Me",
                invitee="Kabir Singh",
                invitee_id="user-kabir",
            ),
        ]
        self.add_result: dict[str, Any] = {
            "invites": [],
            "createdInviteIds": [],
            "addedUserIds": [AYESHA],
            "skippedUserIds": [],
            "skippedReasons": {},
        }
        self.cancel_result = True
        self.errors: dict[str, Exception] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _hit(self, method: str, **kwargs: Any) -> None:
        self.calls.append((method, kwargs))
        if method in self.errors:
            raise self.errors[method]

    def _find(self, circle_id: str) -> dict[str, Any]:
        for row in self.circles:
            if row["id"] == circle_id:
                return dict(row)
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_NOT_FOUND", "Circle not found.", status_code=404
        )

    def list_circles(self, *, user_id: str):
        self._hit("list_circles", user_id=user_id)
        return [{k: v for k, v in row.items() if k != "members"} for row in self.circles]

    def get_circle(self, *, user_id: str, circle_id: str):
        self._hit("get_circle", user_id=user_id, circle_id=circle_id)
        return self._find(circle_id)

    def _stored(self, circle_id: str) -> dict[str, Any]:
        for row in self.circles:
            if row["id"] == circle_id:
                return row
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_NOT_FOUND", "Circle not found.", status_code=404
        )

    def get_circle_overview(self, *, user_id: str, circle_id: str):
        """Canonical overview shape: capabilities, classification, and -- for
        the owner -- the join code, which the voice layer must never read back."""
        self._hit("get_circle_overview", user_id=user_id, circle_id=circle_id)
        row = self._find(circle_id)
        if user_id not in {m["userId"] for m in row["members"]} and row["role"] != "owner":
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_NOT_FOUND", "Circle not found.", status_code=404
            )
        is_owner = row["role"] == "owner"
        is_system = bool(row.get("isSystem"))
        members = row.pop("members")
        return {
            **row,
            "memberCount": len(members),
            "memberLimit": 100,
            "systemKind": "sms" if is_system else None,
            "updatedAt": "2030-01-02T00:00:00+00:00",
            "viewerCapabilities": {
                "canInviteMembers": is_owner,
                "canViewInviteCode": is_owner and not is_system,
                "canRotateInviteCode": is_owner and not is_system,
                "canManageCircle": is_owner,
                "canModerateInvites": is_owner,
                "canDeleteCircle": is_owner and not is_system,
                "canLeaveCircle": not is_owner,
            },
            "activeInviteCode": (
                {"code": "SECRET-CODE", "expiresAt": "2030-01-01T00:00:00+00:00"}
                if is_owner and not is_system
                else None
            ),
        }

    def list_circle_members_page(
        self, *, user_id: str, circle_id: str, query: str = "", page: int = 1, limit: int = 50
    ):
        self._hit(
            "list_circle_members_page",
            user_id=user_id,
            circle_id=circle_id,
            query=query,
            page=page,
            limit=limit,
        )
        row = self._find(circle_id)
        members = list(row["members"])
        if user_id not in {m["userId"] for m in members} and row["role"] != "owner":
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_NOT_FOUND", "Circle not found.", status_code=404
            )
        needle = str(query or "").strip().lower()
        if needle:
            members = [m for m in members if needle in m["displayName"].lower()]
        total = len(members)
        offset = (page - 1) * limit
        items = members[offset : offset + limit]
        return {
            "items": [dict(m) for m in items],
            "page": page,
            "hasMore": offset + len(items) < total,
            "totalCount": total,
        }

    def create_circle(self, *, owner_user_id: str, name: str, kind: str | None = None):
        self._hit("create_circle", owner_user_id=owner_user_id, name=name, kind=kind)
        row = _row(
            "66666666-6666-4666-8666-666666666666",
            name,
            kind=kind or "other",
            members=[(USER, "Me")],
        )
        self.circles.append(row)
        return dict(row)

    def update_circle(self, *, owner_user_id: str, circle_id: str, name=None, kind=None):
        self._hit(
            "update_circle", owner_user_id=owner_user_id, circle_id=circle_id, name=name, kind=kind
        )
        row = self._find(circle_id)
        row["name"] = name
        return row

    def delete_circle(self, *, owner_user_id: str, circle_id: str):
        self._hit("delete_circle", owner_user_id=owner_user_id, circle_id=circle_id)
        self._find(circle_id)
        return None

    def leave_circle(self, *, user_id: str, circle_id: str):
        self._hit("leave_circle", user_id=user_id, circle_id=circle_id)
        return None

    def remove_member(self, *, owner_user_id: str, circle_id: str, member_user_id: str):
        self._hit(
            "remove_member",
            owner_user_id=owner_user_id,
            circle_id=circle_id,
            member_user_id=member_user_id,
        )
        row = self._stored(circle_id)
        row["members"] = [m for m in row["members"] if m["userId"] != member_user_id]
        return None

    def list_eligible_direct_connections(self, *, actor_user_id: str, circle_id: str):
        self._hit(
            "list_eligible_direct_connections", actor_user_id=actor_user_id, circle_id=circle_id
        )
        return list(self.eligible.get(circle_id, []))

    def create_member_invites(
        self, *, actor_user_id: str, circle_id: str, invitee_user_ids: list[str]
    ):
        self._hit(
            "create_member_invites",
            actor_user_id=actor_user_id,
            circle_id=circle_id,
            invitee_user_ids=invitee_user_ids,
        )
        row = self._stored(circle_id)
        for uid in self.add_result.get("addedUserIds") or []:
            if uid in invitee_user_ids and uid not in {m["userId"] for m in row["members"]}:
                label = next(
                    (
                        e["displayName"]
                        for e in self.eligible.get(circle_id, [])
                        if e["userId"] == uid
                    ),
                    uid,
                )
                row["members"].append(
                    {
                        "userId": uid,
                        "displayName": label,
                        "role": "member",
                        "relationship": "connected",
                        "joinedAt": "2030-01-03T00:00:00+00:00",
                    }
                )
        return dict(self.add_result)

    def list_member_invites(
        self, *, user_id: str, circle_id: str | None = None, direction: str = "incoming"
    ):
        self._hit("list_member_invites", user_id=user_id, circle_id=circle_id, direction=direction)
        rows = self.incoming if direction == "incoming" else self.outgoing
        return [dict(r) for r in rows if circle_id is None or r["circleId"] == circle_id]

    def _invite_row(self, invite_id: str) -> dict[str, Any]:
        for row in self.incoming + self.outgoing:
            if row["id"] == invite_id:
                return row
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_INVITE_NOT_FOUND", "Circle invitation not found.", status_code=404
        )

    def get_member_invite(self, *, user_id: str, invite_id: str):
        self._hit("get_member_invite", user_id=user_id, invite_id=invite_id)
        return dict(self._invite_row(invite_id))

    def accept_member_invite(self, *, user_id: str, invite_id: str):
        self._hit("accept_member_invite", user_id=user_id, invite_id=invite_id)
        invite = self._invite_row(invite_id)
        already = invite["status"] != "pending"
        invite["status"] = "accepted"
        return {
            "circle": self._find(invite["circleId"]),
            "invite": dict(invite),
            "accepted": not already,
            "joined": not already,
        }

    def decline_member_invite(self, *, user_id: str, invite_id: str):
        self._hit("decline_member_invite", user_id=user_id, invite_id=invite_id)
        invite = self._invite_row(invite_id)
        invite["status"] = "declined"
        return dict(invite)

    def cancel_member_invite(self, *, actor_user_id: str, invite_id: str):
        self._hit("cancel_member_invite", actor_user_id=actor_user_id, invite_id=invite_id)
        return self.cancel_result

    def create_invite_code(self, *, actor_user_id: str, circle_id: str, rotate: bool = False):
        self._hit(
            "create_invite_code", actor_user_id=actor_user_id, circle_id=circle_id, rotate=rotate
        )
        return {
            "id": "code-row",
            "circleId": circle_id,
            "code": "96RE-HUNF-KMVX",
            "expiresAt": "2030-01-01T00:00:00+00:00",
        }


class FakeConnectionsService:
    """People plane double: what ``load_people_snapshot`` reads for a fresh
    relationship. Rows use the canonical camelCase keys."""

    def __init__(self) -> None:
        self.connections: list[dict[str, Any]] = [
            {"userId": AYESHA, "displayName": "Ayesha Sharma", "connectionId": "c-1"},
            {"userId": PRIYA, "displayName": "Priya Nair", "connectionId": "c-2"},
        ]
        self.incoming: list[dict[str, Any]] = []
        self.outgoing: list[dict[str, Any]] = []

    def list_connections(self, user_id: str):
        return [dict(r) for r in self.connections]

    def list_requests(self, user_id: str, direction: str = "incoming"):
        rows = self.incoming if direction == "incoming" else self.outgoing
        return [dict(r) for r in rows]

    def search_directory(self, user_id: str, *, query: str = "", page: int = 1, limit: int = 20):
        return {"items": [], "page": page, "hasMore": False, "audience": "all"}


class FakeLocationAgentService:
    def list_verified_recipients(self, *, owner_user_id: str, limit: int):
        return []

    def search_directory_candidates(
        self, *, owner_user_id: str, candidate_user_id: str | None = None, **kwargs: Any
    ):
        return {"items": [], "page": 1, "hasMore": False}


def _request(request_id: str, counterpart: str, name: str) -> dict[str, Any]:
    return {
        "id": request_id,
        "counterpartUserId": counterpart,
        "counterpartDisplayName": name,
        "status": "pending",
        "createdAt": "2030-01-01T00:00:00+00:00",
    }


def make_ctx(
    service: FakeCircleService | None = None,
    *,
    confirm_family: bool = True,
    confirm_ayesha: bool = True,
    connections: FakeConnectionsService | None = None,
    screen: ScreenContext | None = None,
):
    entities = EntityContext()
    if confirm_family:
        entities.remember_circle(
            ConfirmedCircle(
                circle_id=FAMILY,
                name="Family",
                kind="family",
                member_count=2,
                confirmed_at=now_iso(),
            )
        )
    if confirm_ayesha:
        entities.remember_person(
            ConfirmedPerson(
                user_id=AYESHA,
                display_name="Ayesha Sharma",
                relationship="connected",
                confirmed_at=now_iso(),
            )
        )
    return ToolContext(
        user_id=USER,
        conversation_id="conv-1",
        entities=entities,
        screen=screen or ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test double, not a credential
        services={
            circles.CIRCLE_SERVICE: service or FakeCircleService(),
            "connections": connections or FakeConnectionsService(),
            "location": FakeLocationAgentService(),
        },
    )


def spec(name: str):
    return next(tool for tool in circles.TOOLS if tool.name == name)


def run(tool_name: str, ctx: ToolContext, **args: Any):
    tool = spec(tool_name)
    return asyncio.run(tool.handler(ctx, tool.input_model.model_validate(args)))


def summary(tool_name: str, ctx: ToolContext, **args: Any) -> str:
    tool = spec(tool_name)
    assert tool.summarize is not None, f"{tool_name} needs a confirmation-card summary"
    return tool.summarize(ctx, tool.input_model.model_validate(args))


# -- catalog ---------------------------------------------------------------------


def test_catalog_policies_and_gateway_ids():
    expected = {
        "list_circles": (ToolPolicy.read, "location.open_circles"),
        "resolve_circle": (ToolPolicy.read, "location.open_circles"),
        "confirm_circle": (ToolPolicy.read, "location.open_circles"),
        "get_circle_details": (ToolPolicy.read, "location.open_circles"),
        "list_circle_members": (ToolPolicy.read, "location.open_circles"),
        "create_circle": (ToolPolicy.confirm_voice, "location.create_circle"),
        "rename_circle": (ToolPolicy.confirm_voice, "location.rename_circle"),
        "delete_circle": (ToolPolicy.confirm_tap, "location.delete_circle"),
        "add_circle_member": (ToolPolicy.confirm_voice, "location.add_to_circle"),
        "remove_circle_member": (ToolPolicy.confirm_tap, "location.remove_from_circle"),
        "leave_circle": (ToolPolicy.confirm_tap, "location.leave_circle"),
        "list_circle_invites": (ToolPolicy.read, "location.open_needs_review"),
        "respond_circle_invite": (ToolPolicy.confirm_voice, "location.accept_circle_invite"),
        "cancel_circle_invite": (ToolPolicy.confirm_voice, "location.decline_circle_invite"),
        "create_circle_invite_link": (ToolPolicy.confirm_voice, "location.open_join_circle"),
    }
    assert {tool.name: (tool.policy, tool.gateway_action_id) for tool in circles.TOOLS} == expected
    for tool in circles.TOOLS:
        assert tool.declaration()["parameters_json_schema"]["additionalProperties"] is False
        if tool.policy.needs_confirmation:
            assert tool.summarize is not None, tool.name
        # Circle routes are all vault-owner plane; nothing here touches the profile plane.
        assert tool.firebase_plane is False


def test_no_tool_accepts_a_spoken_name_for_a_person_or_circle():
    for tool in circles.TOOLS:
        if tool.circle_args:
            for arg in tool.circle_args:
                with pytest.raises(ValidationError):
                    tool.input_model.model_validate(
                        {arg: "Family", "person": {"user_id": AYESHA}, "name": "x"}
                    )
                with pytest.raises(ValidationError):
                    tool.input_model.model_validate(
                        {arg: {"name": "Family"}, "person": {"user_id": AYESHA}}
                    )
        if tool.person_args:
            for arg in tool.person_args:
                with pytest.raises(ValidationError):
                    tool.input_model.model_validate(
                        {arg: "Ayesha", "circle": {"circle_id": FAMILY}}
                    )
                with pytest.raises(ValidationError):
                    tool.input_model.model_validate(
                        {arg: {"display_name": "Ayesha"}, "circle": {"circle_id": FAMILY}}
                    )
        # Unknown fields never slip through (extra="forbid"), so a free-text
        # name cannot ride next to a typed id slot.
        with pytest.raises(ValidationError):
            tool.input_model.model_validate({"circle_name": "Family", "person_name": "Ayesha"})
    # Only resolve_circle takes spoken text, and it is read-only.
    assert spec("resolve_circle").policy is ToolPolicy.read
    for tool in circles.TOOLS:
        if tool.name != "resolve_circle":
            assert "spoken_name" not in tool.input_model.model_fields


def test_executor_guard_rejects_unconfirmed_circle_and_person():
    ctx = make_ctx(confirm_family=False, confirm_ayesha=False)
    tool = spec("add_circle_member")
    parsed = tool.input_model.model_validate(
        {"circle": {"circle_id": FAMILY}, "person": {"user_id": AYESHA}}
    )
    problem = ToolExecutor._entity_problem(tool, ctx, parsed)
    assert problem is not None and problem.reason_code == "person_not_confirmed"
    ctx = make_ctx(confirm_family=False, confirm_ayesha=True)
    problem = ToolExecutor._entity_problem(tool, ctx, parsed)
    assert problem is not None and problem.reason_code == "circle_not_confirmed"
    assert ToolExecutor._entity_problem(tool, make_ctx(), parsed) is None


# -- list / resolve / confirm ----------------------------------------------------------


def test_list_circles_reads_real_names_and_offers_ids():
    ctx = make_ctx(confirm_family=False)
    result = run("list_circles", ctx)
    assert result.status == "ok"
    assert [c.circle_id for c in result.circles] == [FAMILY, WORK, SCHOOL]
    assert result.circles[0].is_owner is True and result.circles[1].is_owner is False
    assert result.spoken_facts == ["You're in 3 circles: Family, Work Friends and School Friends."]
    assert ctx.entities.offered_circle_ids == [FAMILY, WORK, SCHOOL]
    # Three rows are not an unambiguous record: nothing is confirmed by a list.
    assert ctx.entities.circle(FAMILY) is None


def test_list_circles_none_and_single_row_is_remembered():
    service = FakeCircleService()
    service.circles = []
    result = run("list_circles", make_ctx(service, confirm_family=False))
    assert result.status == "none"
    assert result.spoken_facts == ["You're not in any circles yet."]

    service.circles = [_row(WORK, "Work Friends", role="member")]
    ctx = make_ctx(service, confirm_family=False)
    result = run("list_circles", ctx)
    assert result.status == "ok"
    assert (
        ctx.entities.circle(WORK) is not None and ctx.entities.circle(WORK).name == "Work Friends"
    )


def test_list_circles_maps_service_error():
    service = FakeCircleService()
    service.errors["list_circles"] = OneLocationCircleError(
        "LOCATION_CIRCLE_UNAVAILABLE", "Circle service is down."
    )
    result = run("list_circles", make_ctx(service))
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_CIRCLE_UNAVAILABLE"
    assert result.spoken_facts == ["Circle service is down."]


def test_resolve_circle_single_likely_offers_but_never_confirms():
    ctx = make_ctx(confirm_family=False)
    result = run("resolve_circle", ctx, spoken_name="my family circle")
    assert result.status == "single_likely"
    assert result.needs == "confirmation"
    assert [c.circle_id for c in result.candidates] == [FAMILY]
    assert result.spoken_facts == ["Did you mean the Family circle?"]
    assert ctx.entities.offered_circle_ids == [FAMILY]
    assert ctx.entities.circle(FAMILY) is None


def test_resolve_circle_multiple_and_fuzzy_and_none():
    ctx = make_ctx(confirm_family=False)
    result = run("resolve_circle", ctx, spoken_name="friends")
    assert result.status == "multiple" and result.needs == "disambiguation"
    assert ctx.entities.offered_circle_ids == [WORK, SCHOOL]
    assert result.spoken_facts == ["I found 2 circles: Work Friends and School Friends. Which one?"]

    result = run("resolve_circle", ctx, spoken_name="famly")
    assert result.status == "single_likely"
    assert ctx.entities.offered_circle_ids == [FAMILY]

    result = run("resolve_circle", ctx, spoken_name="Basketball")
    assert result.status == "none" and result.needs == "repeat_name"
    assert ctx.entities.offered_circle_ids == []
    assert result.spoken_facts == [
        "No circle matches that name.",
        "Your circles are Family, Work Friends and School Friends.",
    ]


def test_confirm_circle_only_accepts_offered_ids():
    ctx = make_ctx(confirm_family=False)
    result = run("confirm_circle", ctx, circle_id=FAMILY)
    assert result.status == "rejected" and result.reason_code == "circle_not_offered"
    assert result.needs == "disambiguation"
    assert ctx.entities.circle(FAMILY) is None

    run("resolve_circle", ctx, spoken_name="family")
    result = run("confirm_circle", ctx, circle_id=NOT_OFFERED)
    assert result.status == "rejected" and result.reason_code == "circle_not_offered"

    result = run("confirm_circle", ctx, circle_id=FAMILY)
    assert result.status == "confirmed"
    assert result.circle.name == "Family" and result.circle.member_count == 2
    assert result.spoken_facts == ["Got it, the Family circle."]
    confirmed = ctx.entities.circle(FAMILY)
    assert confirmed is not None and confirmed.name == "Family" and confirmed.kind == "family"
    assert ctx.entities.last_circle_id == FAMILY


def test_confirm_circle_maps_service_error():
    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    run("list_circles", ctx)
    service.errors["get_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_NOT_FOUND", "Circle not found.", status_code=404
    )
    result = run("confirm_circle", ctx, circle_id=WORK)
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_NOT_FOUND"
    assert ctx.entities.circle(WORK) is None


# -- create / rename / delete ------------------------------------------------------------


def test_create_circle_created_and_remembered():
    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    result = run("create_circle", ctx, name="Hiking", kind="friends")
    assert result.status == "created"
    assert result.spoken_facts == ["Created the Hiking circle."]
    assert (
        "create_circle",
        {"owner_user_id": USER, "name": "Hiking", "kind": "friends"},
    ) in service.calls
    assert ctx.entities.last_circle_id == result.circle.circle_id
    assert ctx.entities.circle(result.circle.circle_id).name == "Hiking"
    assert (
        summary("create_circle", ctx, name="Hiking", kind="friends")
        == "create a friends circle called Hiking"
    )
    assert summary("create_circle", ctx, name="Hiking") == "create a circle called Hiking"


def test_create_circle_already_exists_does_not_create():
    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    result = run("create_circle", ctx, name="family")
    assert result.status == "already_exists"
    assert result.circle.circle_id == FAMILY
    assert result.spoken_facts == ["You already have a circle called Family."]
    assert not [call for call in service.calls if call[0] == "create_circle"]
    assert ctx.entities.last_circle_id == FAMILY


def test_create_circle_rejects_bad_kind_and_maps_errors():
    with pytest.raises(ValidationError):
        spec("create_circle").input_model.model_validate({"name": "X", "kind": "work"})
    service = FakeCircleService()
    service.errors["create_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_NAME_INVALID", "Circle name must be between 1 and 80 characters."
    )
    result = run("create_circle", make_ctx(service), name="Zed")
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_NAME_INVALID"


def test_rename_circle_uses_confirmed_name_and_updates_entity():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert (
        summary("rename_circle", ctx, circle={"circle_id": FAMILY}, name="Home")
        == "rename the Family circle to Home"
    )
    result = run("rename_circle", ctx, circle={"circle_id": FAMILY}, name="Home")
    assert result.status == "renamed"
    assert result.previous_name == "Family" and result.circle.name == "Home"
    assert result.spoken_facts == ["Renamed the Family circle to Home."]
    assert ctx.entities.circle(FAMILY).name == "Home"
    assert (
        "update_circle",
        {"owner_user_id": USER, "circle_id": FAMILY, "name": "Home", "kind": None},
    ) in service.calls


def test_rename_circle_maps_owner_error():
    service = FakeCircleService()
    service.errors["update_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_OWNER_REQUIRED", "Only the Circle owner can rename it.", status_code=403
    )
    ctx = make_ctx(service)
    result = run("rename_circle", ctx, circle={"circle_id": FAMILY}, name="Home")
    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_CIRCLE_OWNER_REQUIRED"
    assert result.spoken_facts == ["Only the Circle owner can rename it."]
    assert ctx.entities.circle(FAMILY).name == "Family"


def test_delete_circle_forgets_the_entity():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert summary("delete_circle", ctx, circle={"circle_id": FAMILY}) == "delete the Family circle"
    result = run("delete_circle", ctx, circle={"circle_id": FAMILY})
    assert result.status == "deleted" and result.name == "Family"
    assert result.spoken_facts == ["Deleted the Family circle."]
    assert ctx.entities.circle(FAMILY) is None and ctx.entities.last_circle_id is None
    assert ("delete_circle", {"owner_user_id": USER, "circle_id": FAMILY}) in service.calls


def test_delete_system_circle_is_rejected_with_service_message():
    service = FakeCircleService()
    service.errors["delete_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_SYSTEM_PROTECTED", "Your SMS Circle can't be deleted.", status_code=409
    )
    ctx = make_ctx(service)
    result = run("delete_circle", ctx, circle={"circle_id": FAMILY})
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_SYSTEM_PROTECTED"
    assert result.spoken_facts == ["Your SMS Circle can't be deleted."]
    assert ctx.entities.circle(FAMILY) is not None


# -- membership ------------------------------------------------------------------------


def test_add_circle_member_added_when_eligible():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert summary(
        "add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": AYESHA}
    ) == ("add Ayesha Sharma to the Family circle")
    result = run("add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": AYESHA})
    assert result.status == "added"
    assert result.spoken_facts == ["Added Ayesha Sharma to the Family circle."]
    assert (
        "create_member_invites",
        {"actor_user_id": USER, "circle_id": FAMILY, "invitee_user_ids": [AYESHA]},
    ) in service.calls
    # The remembered count is re-read from the server, not incremented.
    assert ("get_circle_overview", {"user_id": USER, "circle_id": FAMILY}) in service.calls
    assert ctx.entities.circle(FAMILY).member_count == 3
    assert result.relationship == "connected"


def test_add_circle_member_reports_pending_invite_only_when_service_says_so():
    service = FakeCircleService()
    service.add_result = {
        "invites": [
            _invite(
                "77777777-7777-4777-8777-777777777777",
                circle_id=FAMILY,
                circle_name="Family",
                inviter="Me",
                invitee="Ayesha Sharma",
                invitee_id=AYESHA,
            )
        ],
        "createdInviteIds": ["77777777-7777-4777-8777-777777777777"],
        "addedUserIds": [],
        "skippedUserIds": [],
        "skippedReasons": {},
    }
    result = run(
        "add_circle_member",
        make_ctx(service),
        circle={"circle_id": FAMILY},
        person={"user_id": AYESHA},
    )
    assert result.status == "invite_pending"
    assert result.spoken_facts == [
        "Invited Ayesha Sharma to the Family circle. It's pending until they accept."
    ]


def test_add_circle_member_already_member():
    service = FakeCircleService()
    ctx = make_ctx(service)
    ctx.entities.remember_person(
        ConfirmedPerson(
            user_id=PRIYA,
            display_name="Priya Nair",
            relationship="connected",
            confirmed_at=now_iso(),
        )
    )
    result = run("add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": PRIYA})
    assert result.status == "already_member"
    assert result.spoken_facts == ["Priya Nair is already in the Family circle."]
    assert not [call for call in service.calls if call[0] == "create_member_invites"]

    # The service's own refusal maps to the same honest status.
    service = FakeCircleService()
    service.errors["create_member_invites"] = OneLocationCircleError(
        "LOCATION_CIRCLE_ALREADY_MEMBER", "Already in the Circle.", status_code=409
    )
    result = run(
        "add_circle_member",
        make_ctx(service),
        circle={"circle_id": FAMILY},
        person={"user_id": AYESHA},
    )
    assert result.status == "already_member"


def test_add_circle_member_pending_invite_and_not_connected():
    service = FakeCircleService()
    ctx = make_ctx(service)
    ctx.entities.remember_person(
        ConfirmedPerson(
            user_id="user-kabir",
            display_name="Kabir Singh",
            relationship="connected",
            confirmed_at=now_iso(),
        )
    )
    result = run(
        "add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": "user-kabir"}
    )
    assert result.status == "invite_pending"
    assert result.spoken_facts == [
        "Kabir Singh already has a pending invitation to the Family circle. It's pending until they accept."
    ]

    ctx.entities.remember_person(
        ConfirmedPerson(
            user_id="user-stranger",
            display_name="Dev Patel",
            relationship="none",
            confirmed_at=now_iso(),
        )
    )
    result = run(
        "add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": "user-stranger"}
    )
    assert result.status == "not_connected" and result.needs == "invite"
    assert result.relationship == "none"
    assert result.spoken_facts == [
        "You aren't connected with Dev Patel yet, so they can't be added to the Family circle. "
        "Send them a connection request, or share the circle's join link."
    ]
    # Nothing here sent a connection request or an invitation.
    assert not any(name == "create_member_invites" for name, _ in service.calls)
    assert not [call for call in service.calls if call[0] == "create_member_invites"]


def test_add_circle_member_maps_other_errors():
    service = FakeCircleService()
    service.errors["list_eligible_direct_connections"] = OneLocationCircleError(
        "LOCATION_CIRCLE_MEMBERSHIP_REQUIRED",
        "Only an active Circle member can invite people.",
        status_code=403,
    )
    result = run(
        "add_circle_member",
        make_ctx(service),
        circle={"circle_id": FAMILY},
        person={"user_id": AYESHA},
    )
    assert (
        result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_MEMBERSHIP_REQUIRED"
    )


def test_remove_circle_member():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert summary(
        "remove_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": AYESHA}
    ) == ("remove Ayesha Sharma from the Family circle")
    result = run(
        "remove_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": AYESHA}
    )
    assert result.status == "removed"
    assert result.spoken_facts == ["Removed Ayesha Sharma from the Family circle."]
    assert (
        "remove_member",
        {"owner_user_id": USER, "circle_id": FAMILY, "member_user_id": AYESHA},
    ) in service.calls
    # Re-read, not decremented: Ayesha was never in the fake roster, so the
    # server still says two members.
    assert ("get_circle_overview", {"user_id": USER, "circle_id": FAMILY}) in service.calls
    assert ctx.entities.circle(FAMILY).member_count == 2

    service.errors["remove_member"] = OneLocationCircleError(
        "LOCATION_CIRCLE_OWNER_REQUIRED", "Only the owner can remove members."
    )
    result = run(
        "remove_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": AYESHA}
    )
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_OWNER_REQUIRED"


def test_leave_circle():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert summary("leave_circle", ctx, circle={"circle_id": FAMILY}) == "leave the Family circle"
    result = run("leave_circle", ctx, circle={"circle_id": FAMILY})
    assert result.status == "left"
    assert result.spoken_facts == ["You left the Family circle."]
    assert ("leave_circle", {"user_id": USER, "circle_id": FAMILY}) in service.calls
    assert ctx.entities.circle(FAMILY) is None

    service.errors["leave_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_OWNER_CANNOT_LEAVE", "Owners can't leave."
    )
    ctx = make_ctx(service)
    result = run("leave_circle", ctx, circle={"circle_id": FAMILY})
    assert result.status == "rejected" and result.spoken_facts == ["Owners can't leave."]


# -- invitations -----------------------------------------------------------------------


def test_list_circle_invites_all_incoming_outgoing_none():
    service = FakeCircleService()
    ctx = make_ctx(service)
    result = run("list_circle_invites", ctx)
    assert result.status == "ok"
    assert [(i.invite_id, i.direction, i.status) for i in result.invites] == [
        (INVITE_IN, "incoming", "pending"),
        (INVITE_OUT, "outgoing", "pending"),
    ]
    assert result.spoken_facts == [
        "Rohan Mehta invited you to the Work Friends circle; it's pending.",
        "Your invitation for Kabir Singh to the Family circle is pending.",
    ]

    result = run("list_circle_invites", ctx, direction="incoming")
    assert [i.invite_id for i in result.invites] == [INVITE_IN]
    result = run("list_circle_invites", ctx, direction="outgoing")
    assert [i.invite_id for i in result.invites] == [INVITE_OUT]

    service.incoming = []
    result = run("list_circle_invites", ctx, direction="incoming")
    assert result.status == "none"
    assert result.spoken_facts == ["No circle invitations are waiting for you."]


def test_respond_circle_invite_accept_joins_and_remembers_circle():
    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    assert (
        summary("respond_circle_invite", ctx, invite_id=INVITE_IN, accept=True)
        == "accept that circle invitation"
    )
    result = run("respond_circle_invite", ctx, invite_id=INVITE_IN, accept=True)
    assert result.status == "accepted"
    assert result.circle_name == "Work Friends" and result.invite_status == "accepted"
    assert result.spoken_facts == ["You're in the Work Friends circle now."]
    assert ("accept_member_invite", {"user_id": USER, "invite_id": INVITE_IN}) in service.calls
    assert (
        ctx.entities.circle(WORK) is not None and ctx.entities.circle(WORK).name == "Work Friends"
    )

    # Accepting again is not a second success.
    result = run("respond_circle_invite", ctx, invite_id=INVITE_IN, accept=True)
    assert result.status == "already_responded"
    assert result.spoken_facts == [
        "That invitation to the Work Friends circle was already accepted."
    ]


def test_respond_circle_invite_decline_and_errors():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert (
        summary("respond_circle_invite", ctx, invite_id=INVITE_IN, accept=False)
        == "decline that circle invitation"
    )
    result = run("respond_circle_invite", ctx, invite_id=INVITE_IN, accept=False)
    assert result.status == "declined" and result.invite_status == "declined"
    assert result.spoken_facts == ["Declined the invitation to the Work Friends circle."]
    assert ("decline_member_invite", {"user_id": USER, "invite_id": INVITE_IN}) in service.calls

    service.errors["accept_member_invite"] = OneLocationCircleError(
        "LOCATION_CIRCLE_INVITE_EXPIRED", "This Circle invitation has expired.", status_code=409
    )
    result = run("respond_circle_invite", ctx, invite_id=INVITE_IN, accept=True)
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_INVITE_EXPIRED"
    assert result.spoken_facts == ["This Circle invitation has expired."]

    with pytest.raises(ValidationError):
        spec("respond_circle_invite").input_model.model_validate(
            {"invite_id": "short", "accept": True}
        )


def test_cancel_circle_invite_names_the_invitee_and_circle():
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert (
        summary("cancel_circle_invite", ctx, invite_id=INVITE_OUT)
        == "cancel that circle invitation"
    )
    result = run("cancel_circle_invite", ctx, invite_id=INVITE_OUT)
    assert result.status == "cancelled"
    assert result.invitee_name == "Kabir Singh" and result.circle_name == "Family"
    assert result.spoken_facts == ["Cancelled the invitation for Kabir Singh to the Family circle."]
    assert (
        "cancel_member_invite",
        {"actor_user_id": USER, "invite_id": INVITE_OUT},
    ) in service.calls

    service.cancel_result = False
    result = run("cancel_circle_invite", ctx, invite_id=INVITE_OUT)
    assert result.status == "already_cancelled"

    result = run("cancel_circle_invite", ctx, invite_id=NOT_OFFERED)
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_INVITE_NOT_FOUND"


# -- invite link -------------------------------------------------------------------------


def test_create_circle_invite_link_opens_share_sheet(monkeypatch):
    monkeypatch.setenv("HUSHH_ONE_PUBLIC_APP_URL", "https://uat.one.hushh.ai/")
    service = FakeCircleService()
    ctx = make_ctx(service)
    assert summary("create_circle_invite_link", ctx, circle={"circle_id": FAMILY}) == (
        "create an invite link for the Family circle"
    )
    result = run("create_circle_invite_link", ctx, circle={"circle_id": FAMILY})
    assert result.status == "link_ready" and result.needs == "client_step"
    assert result.url == "https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX"
    assert result.client_step.model_dump() == {
        "kind": "open_share_sheet",
        "url": "https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX",
        "code": "96RE-HUNF-KMVX",
        "circle_name": "Family",
    }
    assert result.spoken_facts == [
        "The invite link for the Family circle is ready. I'm opening the share sheet."
    ]
    assert (
        "create_invite_code",
        {"actor_user_id": USER, "circle_id": FAMILY, "rotate": False},
    ) in service.calls
    assert (
        "only way to invite someone who is not yet connected"
        in spec("create_circle_invite_link").description
    )


def test_create_circle_invite_link_refused_for_system_circle():
    service = FakeCircleService()
    service.errors["create_invite_code"] = OneLocationCircleError(
        "LOCATION_CIRCLE_SYSTEM_NO_CODE",
        "This Circle is managed for you and cannot be shared with a code.",
        status_code=409,
    )
    result = run("create_circle_invite_link", make_ctx(service), circle={"circle_id": FAMILY})
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_SYSTEM_NO_CODE"
    assert result.spoken_facts == [
        "This Circle is managed for you and cannot be shared with a code."
    ]


def test_build_circle_join_url_matches_webapp_twin(monkeypatch):
    assert circles.build_circle_join_url("96RE-HUNF-KMVX", "https://one.hushh.ai/") == (
        "https://one.hushh.ai/circle/join?code=96RE-HUNF-KMVX"
    )
    for key in ("HUSHH_ONE_PUBLIC_APP_URL", "NEXT_PUBLIC_APP_URL", "APP_PUBLIC_URL"):
        monkeypatch.delenv(key, raising=False)
    assert circles.build_circle_join_url("AB CD") == "/circle/join?code=AB%20CD"


# -- get_circle_details: the circle on screen, capabilities, no secrets --------------


def _screen_with(circle_id: str) -> ScreenContext:
    return ScreenContext(screen_id="one_location_circle", active_circle_id=circle_id)


def test_get_circle_details_reads_the_circle_on_screen_without_an_argument():
    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False, screen=_screen_with(FAMILY))
    result = run("get_circle_details", ctx)
    assert result.status == "ok"
    assert result.circle.circle_id == FAMILY
    assert result.circle.kind == "family" and result.circle.member_count == 2
    assert result.circle.is_owner is True
    assert result.circle.can_add_members is True
    assert result.circle.can_manage is True
    assert result.circle.can_delete is True
    assert result.circle.can_leave is False
    assert result.circle.member_limit == 100
    assert result.spoken_facts == ["Family is a family circle with 2 members.", "You own it."]
    # The screen id was only a hint: the read went through the authorized service.
    assert ("get_circle_overview", {"user_id": USER, "circle_id": FAMILY}) in service.calls
    # One authorized record by id is unambiguous: "rename it" can follow.
    assert ctx.entities.circle(FAMILY) is not None
    assert ctx.entities.last_circle_id == FAMILY
    assert FAMILY in ctx.entities.offered_circle_ids


def test_get_circle_details_never_reads_back_the_join_code():
    ctx = make_ctx(screen=_screen_with(FAMILY))
    public = run("get_circle_details", ctx).public()
    text = str(public)
    assert "SECRET-CODE" not in text
    assert "activeInviteCode" not in text and "invite_code" not in text


def test_get_circle_details_member_view_and_system_circle():
    service = FakeCircleService()
    service.circles[1] = _row(
        WORK,
        "Work Friends",
        kind="friends",
        role="member",
        members=[("user-rohan", "Rohan"), (USER, "Me")],
    )
    ctx = make_ctx(service, confirm_family=False)
    run("list_circles", ctx)  # offers WORK
    result = run("get_circle_details", ctx, circle={"circle_id": WORK})
    assert result.status == "ok"
    assert result.circle.is_owner is False and result.circle.can_leave is True
    assert result.circle.can_delete is False and result.circle.can_add_members is False
    assert result.spoken_facts == [
        "Work Friends is a friends circle with 2 members.",
        "You're a member; the owner manages it.",
    ]
    service.circles[2] = _row(SCHOOL, "Emergency", isSystem=True, members=[(USER, "Me")])
    run("list_circles", ctx)
    result = run("get_circle_details", ctx, circle={"circle_id": SCHOOL})
    assert result.circle.is_system is True and result.circle.system_kind == "sms"
    assert result.circle.can_delete is False and result.circle.can_manage is True
    assert result.spoken_facts[-1] == "It's managed by the app, so it can't be deleted."


def test_get_circle_details_refuses_when_nothing_is_on_screen_or_offered():
    ctx = make_ctx(confirm_family=False)
    result = run("get_circle_details", ctx)
    assert result.status == "rejected" and result.reason_code == "no_circle_in_view"
    assert result.needs == "disambiguation"
    # An id the model made up is not in scope even though the service would have found it.
    result = run("get_circle_details", ctx, circle={"circle_id": WORK})
    assert result.status == "rejected" and result.reason_code == "circle_not_offered"
    assert ctx.entities.circle(WORK) is None


def test_get_circle_details_is_a_refusal_when_the_read_fails():
    service = FakeCircleService()
    service.errors["get_circle_overview"] = OneLocationCircleError(
        "LOCATION_CIRCLE_NOT_FOUND", "Circle not found.", status_code=404
    )
    ctx = make_ctx(service, confirm_family=False, screen=_screen_with(NOT_OFFERED))
    result = run("get_circle_details", ctx)
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_NOT_FOUND"
    assert ctx.entities.circle(NOT_OFFERED) is None


def test_confirm_circle_accepts_the_circle_on_screen():
    ctx = make_ctx(confirm_family=False, screen=_screen_with(FAMILY))
    result = run("confirm_circle", ctx, circle_id=FAMILY)
    assert result.status == "confirmed" and ctx.entities.circle(FAMILY) is not None
    other = make_ctx(confirm_family=False, screen=_screen_with(FAMILY))
    assert run("confirm_circle", other, circle_id=WORK).reason_code == "circle_not_offered"


# -- list_circle_members: paging honesty, roster candidates, failures ----------------


def _big_family(service: FakeCircleService, count: int) -> None:
    members = [(USER, "Me")] + [(f"user-{i:03d}", f"Member {i:03d}") for i in range(1, count)]
    service.circles[0] = _row(FAMILY, "Family", kind="family", members=members)


def test_list_circle_members_reads_the_roster_and_offers_member_ids_for_this_circle():
    service = FakeCircleService()
    ctx = make_ctx(service, screen=_screen_with(FAMILY))
    result = run("list_circle_members", ctx)
    assert result.status == "ok"
    assert result.circle_id == FAMILY and result.circle_name == "Family"
    assert [m.user_id for m in result.members] == [USER, PRIYA]
    assert result.members[0].is_self is True and result.members[0].relationship == "self"
    assert result.members[1].display_name == "Priya Nair"
    assert result.members[1].relationship == "connected" and result.members[1].role == "member"
    assert result.total_count == 2 and result.has_more is False and result.page == 1
    assert result.spoken_facts == ["The Family circle has 2 members: Priya Nair and you."]
    # Priya (not the viewer) may be confirmed next -- as a member of Family.
    assert ctx.entities.offered_person_ids == [PRIYA]
    assert ctx.entities.offered_person_circle_id == FAMILY
    call = next(c for c in service.calls if c[0] == "list_circle_members_page")
    assert call[1]["limit"] == circles.MEMBERS_PAGE_LIMIT


def test_list_circle_members_distinguishes_the_page_from_the_total():
    service = FakeCircleService()
    _big_family(service, 45)
    ctx = make_ctx(service)
    first = run("list_circle_members", ctx, circle={"circle_id": FAMILY})
    assert first.status == "ok"
    assert len(first.members) == circles.MEMBERS_PAGE_LIMIT
    assert first.total_count == 45 and first.has_more is True
    assert first.spoken_facts[0].startswith("The Family circle has 45 members. Page 1 has ")
    assert first.spoken_facts[0].endswith(", and 14 more.")
    assert first.spoken_facts[1] == "There are more on the next page."
    assert len(ctx.entities.offered_person_ids) == circles.MEMBERS_PAGE_LIMIT - 1  # self excluded
    third = run("list_circle_members", ctx, circle={"circle_id": FAMILY}, page=3)
    assert len(third.members) == 5 and third.has_more is False and third.total_count == 45
    fourth = run("list_circle_members", ctx, circle={"circle_id": FAMILY}, page=4)
    assert fourth.status == "none"
    assert fourth.spoken_facts == ["There's nobody on page 4 of the Family circle."]
    assert ctx.entities.offered_person_ids == []


def test_list_circle_members_search_by_name_is_a_suggestion_only():
    ctx = make_ctx(screen=_screen_with(FAMILY))
    hit = run("list_circle_members", ctx, query="priya")
    assert hit.status == "ok" and [m.user_id for m in hit.members] == [PRIYA]
    assert hit.spoken_facts == ["In the Family circle, I found Priya Nair."]
    miss = run("list_circle_members", ctx, query="nobody")
    assert miss.status == "none"
    assert miss.spoken_facts == ["Nobody in the Family circle matches that name."]
    assert ctx.entities.offered_person_ids == []


def test_list_circle_members_read_failure_is_never_an_empty_roster():
    service = FakeCircleService()
    service.errors["list_circle_members_page"] = OneLocationCircleError(
        "LOCATION_CIRCLE_UNAVAILABLE", "Circle service is down."
    )
    ctx = make_ctx(service)
    result = run("list_circle_members", ctx, circle={"circle_id": FAMILY})
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_UNAVAILABLE"
    assert not hasattr(result, "members")
    # Nothing was offered from a read that failed.
    assert ctx.entities.offered_person_ids == []
    assert ctx.entities.offered_person_circle_id is None


def test_list_circle_members_without_a_circle_needs_one():
    result = run("list_circle_members", make_ctx(confirm_family=False))
    assert result.status == "rejected" and result.reason_code == "no_circle_in_view"


def test_duplicate_circle_names_are_read_by_id_not_name():
    service = FakeCircleService()
    twin = "77777777-7777-4777-8777-777777777777"
    service.circles.append(
        _row(twin, "Family", kind="other", members=[(USER, "Me"), (AYESHA, "Ayesha Sharma")])
    )
    ctx = make_ctx(service, confirm_family=False)
    found = run("resolve_circle", ctx, spoken_name="family")
    assert found.status == "multiple" and [c.circle_id for c in found.candidates] == [FAMILY, twin]
    assert run("confirm_circle", ctx, circle_id=twin).status == "confirmed"
    roster = run("list_circle_members", ctx, circle={"circle_id": twin})
    assert [m.user_id for m in roster.members] == [USER, AYESHA]
    assert ctx.entities.offered_person_circle_id == twin
    details = run("get_circle_details", ctx, circle={"circle_id": twin})
    assert details.circle.kind == "other"


# -- stale references after rename / delete ------------------------------------------


def test_rename_updates_the_remembered_name_and_leaves_kind_alone():
    service = FakeCircleService()
    ctx = make_ctx(service)
    result = run("rename_circle", ctx, circle={"circle_id": FAMILY}, name="Fam")
    assert result.status == "renamed" and result.circle.kind == "family"
    assert (
        ctx.entities.circle(FAMILY).name == "Fam" and ctx.entities.circle(FAMILY).kind == "family"
    )
    call = next(c for c in service.calls if c[0] == "update_circle")
    assert call[1] == {"owner_user_id": USER, "circle_id": FAMILY, "name": "Fam", "kind": None}
    # "Rename it again" targets the same id, not a name search.
    assert ctx.entities.last_circle_id == FAMILY


def test_delete_invalidates_the_circle_and_its_roster_candidates():
    service = FakeCircleService()
    ctx = make_ctx(service)
    run("list_circle_members", ctx, circle={"circle_id": FAMILY})
    assert ctx.entities.offered_person_ids == [PRIYA]
    result = run("delete_circle", ctx, circle={"circle_id": FAMILY})
    assert result.status == "deleted"
    assert ctx.entities.circle(FAMILY) is None and ctx.entities.last_circle_id is None
    assert FAMILY not in ctx.entities.offered_circle_ids
    assert ctx.entities.offered_person_ids == [] and ctx.entities.offered_person_circle_id is None


# -- add_circle_member: every prerequisite state, on a fresh read --------------------


def _confirm(ctx: ToolContext, user_id: str, name: str, relationship: str = "none") -> None:
    ctx.entities.remember_person(
        ConfirmedPerson(
            user_id=user_id,
            display_name=name,
            relationship=relationship,  # type: ignore[arg-type]
            confirmed_at=now_iso(),
        )
    )


def test_add_circle_member_already_member_is_reported_before_any_write():
    service = FakeCircleService()
    ctx = make_ctx(service)
    _confirm(ctx, PRIYA, "Priya Nair", "connected")
    result = run("add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": PRIYA})
    assert result.status == "already_member"
    assert result.spoken_facts == ["Priya Nair is already in the Family circle."]
    assert not any(name == "create_member_invites" for name, _ in service.calls)


def test_add_circle_member_reports_a_pending_outgoing_connection_request():
    service = FakeCircleService()
    connections = FakeConnectionsService()
    connections.outgoing = [_request("req-1", "user-rohan", "Rohan Mehta")]
    ctx = make_ctx(service, connections=connections)
    # Confirmed earlier as not connected; the request was sent since. The
    # decision is made on the fresh read, not the stale card.
    _confirm(ctx, "user-rohan", "Rohan Mehta", "none")
    result = run(
        "add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": "user-rohan"}
    )
    assert result.status == "connection_pending_outgoing"
    assert result.relationship == "pending_outgoing"
    assert result.spoken_facts == [
        "Your connection request to Rohan Mehta is still pending. "
        "They can be added to the Family circle once they accept."
    ]
    assert result.needs is None
    assert not any(name == "create_member_invites" for name, _ in service.calls)


def test_add_circle_member_reports_a_pending_incoming_connection_request():
    connections = FakeConnectionsService()
    connections.incoming = [_request("req-2", "user-kushal", "Kushal Rao")]
    ctx = make_ctx(connections=connections)
    _confirm(ctx, "user-kushal", "Kushal Rao", "pending_incoming")
    result = run(
        "add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": "user-kushal"}
    )
    assert result.status == "connection_pending_incoming"
    assert result.spoken_facts == [
        "Kushal Rao has asked to connect with you. "
        "Accept their request first, then they can be added to the Family circle."
    ]


def test_add_circle_member_connected_but_not_eligible_is_its_own_state():
    ctx = make_ctx()  # Priya is connected (people plane) but not in Family's eligible list
    _confirm(ctx, PRIYA, "Priya Nair", "connected")
    ctx.services[circles.CIRCLE_SERVICE].circles[0]["members"] = [
        m
        for m in ctx.services[circles.CIRCLE_SERVICE].circles[0]["members"]
        if m["userId"] != PRIYA
    ]
    result = run("add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": PRIYA})
    assert result.status == "not_eligible" and result.relationship == "connected"
    assert result.spoken_facts == [
        "Priya Nair is connected with you, but can't be added to the Family circle right now."
    ]


def test_add_circle_member_falls_back_to_the_confirmed_relationship_when_people_plane_is_down():
    from hushh_mcp.services.connections_service import ConnectionsError

    class DownConnections(FakeConnectionsService):
        def list_connections(self, user_id: str):
            raise ConnectionsError("CONNECTIONS_UNAVAILABLE", "People are unavailable.")

    ctx = make_ctx(connections=DownConnections())
    _confirm(ctx, "user-rohan", "Rohan Mehta", "pending_outgoing")
    result = run(
        "add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": "user-rohan"}
    )
    assert result.status == "connection_pending_outgoing"


def test_add_circle_member_count_is_dropped_not_guessed_when_the_refresh_fails():
    service = FakeCircleService()
    service.errors["get_circle_overview"] = OneLocationCircleError(
        "LOCATION_CIRCLE_UNAVAILABLE", "Circle service is down."
    )
    ctx = make_ctx(service)
    result = run("add_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": AYESHA})
    assert result.status == "added"
    assert ctx.entities.circle(FAMILY).member_count is None


# -- remove via the roster: a member who is not a connection ------------------------


def _people_ctx_with_roster_member() -> tuple[ToolContext, FakeCircleService]:
    """Family has a member, Dev, who joined by link and is nobody's connection
    and hidden from the directory. Only the roster knows him."""
    service = FakeCircleService()
    service.circles[0]["members"].append(
        {
            "userId": "user-dev",
            "displayName": "Dev Patel",
            "role": "member",
            "relationship": "none",
            "joinedAt": "2030-01-04T00:00:00+00:00",
            "phoneVerified": True,
        }
    )
    return make_ctx(service), service


def test_remove_member_resolves_the_person_from_the_roster_not_the_connections_list():
    from hushh_mcp.one_voice.tools import people

    ctx, service = _people_ctx_with_roster_member()
    person_tool = next(t for t in people.TOOLS if t.name == "confirm_person")

    # Not a connection, not in the directory: resolve_person cannot offer him.
    resolve_tool = next(t for t in people.TOOLS if t.name == "resolve_person")
    found = asyncio.run(
        resolve_tool.handler(ctx, resolve_tool.input_model.model_validate({"spoken_name": "Dev"}))
    )
    assert "user-dev" not in [c.user_id for c in getattr(found, "candidates", [])]

    # The roster offers him, bound to Family.
    roster = run("list_circle_members", ctx, circle={"circle_id": FAMILY})
    assert "user-dev" in ctx.entities.offered_person_ids
    assert ctx.entities.offered_person_circle_id == FAMILY
    confirmed = asyncio.run(
        person_tool.handler(ctx, person_tool.input_model.model_validate({"user_id": "user-dev"}))
    )
    assert confirmed.status == "confirmed"
    assert confirmed.person.display_name == "Dev Patel"
    assert ctx.entities.person("user-dev").relationship == "none"
    # Revalidated against the circle's membership, not taken from the model.
    assert ("get_circle", {"user_id": USER, "circle_id": FAMILY}) in service.calls

    removed = run(
        "remove_circle_member", ctx, circle={"circle_id": FAMILY}, person={"user_id": "user-dev"}
    )
    assert removed.status == "removed"
    assert removed.spoken_facts == ["Removed Dev Patel from the Family circle."]
    assert (
        "remove_member",
        {"owner_user_id": USER, "circle_id": FAMILY, "member_user_id": "user-dev"},
    ) in service.calls
    # The count is the server's after the change, and he is no longer a candidate.
    assert ctx.entities.circle(FAMILY).member_count == 2
    assert "user-dev" not in ctx.entities.offered_person_ids
    # Membership ended; the connection graph was never touched.
    assert not any(name == "remove_connection" for name, _ in service.calls)
    assert len(roster.members) == 3


def test_roster_candidate_who_left_since_the_read_is_not_confirmed():
    from hushh_mcp.one_voice.tools import people

    ctx, service = _people_ctx_with_roster_member()
    run("list_circle_members", ctx, circle={"circle_id": FAMILY})
    assert "user-dev" in ctx.entities.offered_person_ids
    service.circles[0]["members"] = [
        m for m in service.circles[0]["members"] if m["userId"] != "user-dev"
    ]
    person_tool = next(t for t in people.TOOLS if t.name == "confirm_person")
    result = asyncio.run(
        person_tool.handler(ctx, person_tool.input_model.model_validate({"user_id": "user-dev"}))
    )
    assert result.status == "rejected" and result.reason_code == "person_not_found"
    assert ctx.entities.person("user-dev") is None


def test_resolve_person_clears_the_roster_source():
    from hushh_mcp.one_voice.tools import people

    ctx, _ = _people_ctx_with_roster_member()
    run("list_circle_members", ctx, circle={"circle_id": FAMILY})
    assert ctx.entities.offered_person_circle_id == FAMILY
    resolve_tool = next(t for t in people.TOOLS if t.name == "resolve_person")
    asyncio.run(
        resolve_tool.handler(ctx, resolve_tool.input_model.model_validate({"spoken_name": "Priya"}))
    )
    assert ctx.entities.offered_person_circle_id is None
    assert "user-dev" not in ctx.entities.offered_person_ids


# -- executor: roster-confirmed member reaches a tap-tier card, never runs on its own --


def test_executor_creates_a_tap_card_for_a_roster_confirmed_removal():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _people_ctx_with_roster_member()
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    asyncio.run(executor.call(ctx, "list_circle_members", {"circle": {"circle_id": FAMILY}}))
    confirmed = asyncio.run(executor.call(ctx, "confirm_person", {"user_id": "user-dev"}))
    assert confirmed.result.status == "confirmed"
    outcome = asyncio.run(
        executor.call(
            ctx,
            "remove_circle_member",
            {"circle": {"circle_id": FAMILY}, "person": {"user_id": "user-dev"}},
        )
    )
    assert outcome.result.status == "confirmation_required"
    assert outcome.result.tier == "tap" and outcome.receipt_token
    assert outcome.pending is not None and outcome.pending.tool_name == "remove_circle_member"
    assert not any(name == "remove_member" for name, _ in service.calls)
    # Identity confirmation is not mutation approval: a spoken yes is refused.
    spoken = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": outcome.pending.id})
    )
    assert spoken.result.status == "tap_required"
    assert not any(name == "remove_member" for name, _ in service.calls)
