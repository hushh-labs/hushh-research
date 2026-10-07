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
        # The owner's connections as ``plan_direct_connection_adds`` classes
        # them; anyone already in the circle reads as "member" automatically.
        self.audience: list[dict[str, Any]] = []
        self.member_limit = 100

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
        stored = self._stored(circle_id)
        # COALESCE semantics: an absent field keeps its value.
        if name is not None:
            stored["name"] = name
        if kind is not None:
            stored["kind"] = kind
        return self._find(circle_id)

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

    def plan_direct_connection_adds(self, *, actor_user_id: str, circle_id: str):
        self._hit("plan_direct_connection_adds", actor_user_id=actor_user_id, circle_id=circle_id)
        row = self._stored(circle_id)
        if row["role"] != "owner":
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_OWNER_REQUIRED",
                "Only the Circle owner can add people to this Circle.",
                status_code=403,
            )
        members = {m["userId"] for m in row["members"]}
        return {
            "circle": {
                "id": circle_id,
                "name": row["name"],
                "kind": row["kind"],
                "isSystem": bool(row.get("isSystem")),
                "systemKind": row.get("systemKind"),
                "memberLimit": self.member_limit,
                "reservedCount": len(members),
            },
            "connections": [
                {
                    "userId": person["userId"],
                    "displayName": person["displayName"],
                    "status": "member"
                    if person["userId"] in members
                    else person.get("status", "addable"),
                }
                for person in self.audience
            ],
        }

    def add_direct_connections(self, *, actor_user_id: str, circle_id: str, user_ids: list[str]):
        self._hit(
            "add_direct_connections",
            actor_user_id=actor_user_id,
            circle_id=circle_id,
            user_ids=list(user_ids),
        )
        row = self._stored(circle_id)
        names = {person["userId"]: person["displayName"] for person in self.audience}
        added: list[str] = []
        skipped: dict[str, str] = {}
        for uid in sorted(set(user_ids)):
            if uid in {m["userId"] for m in row["members"]}:
                skipped[uid] = "already_member"
                continue
            row["members"].append(
                {
                    "userId": uid,
                    "displayName": names.get(uid, uid),
                    "role": "member",
                    "relationship": "connected",
                    "joinedAt": "2030-01-03T00:00:00+00:00",
                }
            )
            added.append(uid)
        return {"addedUserIds": added, "skippedUserIds": sorted(skipped), "skippedReasons": skipped}

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

    def list_connections_page(
        self,
        user_id: str,
        *,
        query: str = "",
        page: int = 1,
        limit: int = 50,
        audience: str = "all",
    ):
        needle = (query or "").lower()
        rows = [
            r for r in self.connections if not needle or needle in str(r["displayName"]).lower()
        ]
        offset = (page - 1) * limit
        items = rows[offset : offset + limit]
        return {
            "items": [dict(r) for r in items],
            "page": page,
            "hasMore": offset + len(items) < len(rows),
            "totalCount": len(rows),
            "audience": audience,
        }


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
        "set_circle_kind": (ToolPolicy.confirm_voice, "location.set_circle_kind"),
        "delete_circle": (ToolPolicy.confirm_tap, "location.delete_circle"),
        "add_circle_member": (ToolPolicy.confirm_voice, "location.add_to_circle"),
        # Same gateway action as the single add: one capability, two arities. The
        # gateway already declares a person-list slot, so this binds rather than
        # minting a second action for the same effect.
        "add_circle_members": (ToolPolicy.confirm_voice, "location.add_to_circle"),
        # The same effect again, with the audience read by the server instead of
        # named by the model.
        "add_all_connections": (ToolPolicy.confirm_voice, "location.add_to_circle"),
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
    _propose_circle(ctx, name="family")
    result = run("create_circle", ctx, name="family")
    assert result.status == "already_exists"
    assert result.circle.circle_id == FAMILY
    assert result.spoken_facts == ["You already have a circle called Family."]
    assert not [call for call in service.calls if call[0] == "create_circle"]
    assert ctx.entities.last_circle_id == FAMILY
    # The name is settled, so no later proposal is held to it.
    assert ctx.entities.circle_name_baseline is None


def test_create_circle_rejects_bad_kind_and_maps_errors():
    with pytest.raises(ValidationError):
        spec("create_circle").input_model.model_validate({"name": "X", "kind": "work"})
    service = FakeCircleService()
    service.errors["create_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_NAME_INVALID", "Circle name must be between 1 and 80 characters."
    )
    result = run("create_circle", make_ctx(service), name="Zed")
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_NAME_INVALID"


# -- create_circle keeps a word the person spelled ------------------------------------
#
# UAT: the person spelled "h u s s h" for HUSSH GARAGE V04 and the next card said
# HUSH. The model declares a word the person spelled; the server keeps it for the
# conversation and refuses a proposed name that drops it, asking instead.

HUSSH_QUESTION = (
    "You spelled HUSSH as H-U-S-S-H, but this name doesn't include it. Should the name use HUSSH?"
)
HUSSH_TO_HUSH = [{"old": "HUSSH", "new": "HUSH"}]
V04_TO_V05 = [{"old": "V04", "new": "V05"}]


def _propose_circle(ctx: ToolContext, executor: ToolExecutor | None = None, **args: Any):
    from tests.one_voice.fakes import MemoryPendingStore

    executor = executor or ToolExecutor(pending_store=MemoryPendingStore())
    return asyncio.run(executor.call(ctx, "create_circle", args))


def test_create_circle_refuses_a_name_that_drops_a_spelled_word():
    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    outcome = _propose_circle(ctx, name="HUSH GARAGE V04", spelled_words=["HUSSH"])
    assert (outcome.result.status, outcome.result.reason_code) == (
        "rejected",
        "spelled_word_missing",
    )
    assert outcome.result.needs == "repeat_name"
    assert outcome.result.spoken_facts == [HUSSH_QUESTION]
    assert outcome.pending is None
    assert "retire_open_proposal" not in outcome.result.public()
    assert "retire_open_proposal" not in outcome.result.model_public()
    # Defence in depth: a stored card whose name lost the word creates nothing.
    ctx.prepared = {"spelled_words": ["HUSSH"]}
    refused = run("create_circle", ctx, name="HUSH GARAGE V04")
    assert (refused.status, refused.reason_code) == ("rejected", "spelled_word_missing")
    assert not [call for call in service.calls if call[0] == "create_circle"]


def test_create_circle_card_reads_back_each_spelled_word():
    ctx = make_ctx(confirm_family=False)
    outcome = _propose_circle(ctx, name="hussh garage V04", spelled_words=["HUSSH"])
    assert outcome.result.status == "confirmation_required"
    assert outcome.result.summary == (
        "create a circle called hussh garage V04, with HUSSH spelled H-U-S-S-H"
    )
    assert outcome.pending.args["_prepared"] == {"spelled_words": ["HUSSH"]}
    # Negative control: nothing spelled, and the card is today's sentence byte for byte.
    plain = _propose_circle(make_ctx(confirm_family=False), name="Hiking", kind="friends")
    assert plain.result.status == "confirmation_required"
    assert plain.result.summary == summary("create_circle", ctx, name="Hiking", kind="friends")
    assert plain.result.summary == "create a friends circle called Hiking"


def test_create_circle_lets_the_person_change_a_spelled_word():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx = make_ctx(confirm_family=False)
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    first = _propose_circle(ctx, executor, name="HUSSH GARAGE", spelled_words=["HUSSH"])
    assert first.result.status == "confirmation_required"
    # A correction that leaves the kept word out without saying so is refused ...
    dropped = _propose_circle(ctx, executor, name="HUSH GARAGE")
    assert dropped.result.reason_code == "name_changed"
    # ... while the person spelling the new word in its place changes it, with
    # no second declaration needed.
    changed = _propose_circle(ctx, executor, name="HUSH GARAGE", spelled_words=["HUSH"])
    assert changed.result.status == "confirmation_required"
    assert changed.result.summary.endswith(", with HUSH spelled H-U-S-H")


def test_create_circle_forgets_the_spelling_once_the_circle_exists():
    from tests.one_voice.fakes import MemoryPendingStore

    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store)
    card = _propose_circle(ctx, executor, name="HUSSH GARAGE V04", spelled_words=["HUSSH"])
    asyncio.run(store.mark_shown(user_id=USER, pending_action_id=card.pending.id))
    done = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.pending.id})
    )
    assert done.result.status == "created"
    assert (
        "create_circle",
        {"owner_user_id": USER, "name": "HUSSH GARAGE V04", "kind": "other"},
    ) in service.calls
    assert ctx.entities.spelled_name_words == []
    assert ctx.entities.circle_name_baseline is None
    # Nothing is waiting to be corrected: a name sharing its words is not held to it.
    alike = _propose_circle(ctx, executor, name="HUSSH GARAGE V05")
    assert alike.result.status == "confirmation_required"
    following = _propose_circle(ctx, executor, name="Book Club")
    assert following.result.status == "confirmation_required"


def test_a_card_from_before_a_word_was_spelled_creates_nothing():
    """A confirm that lands on a card prepared before the person spelled a word
    (or a reused duplicate) is refused at execution, not only at proposal."""
    from tests.one_voice.fakes import MemoryPendingStore

    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store)
    card = _propose_circle(ctx, executor, name="HUSH GARAGE")
    asyncio.run(store.mark_shown(user_id=USER, pending_action_id=card.pending.id))
    tapped = asyncio.run(
        store.confirm(user_id=USER, pending_action_id=card.pending.id, source="http")
    )
    refused = _propose_circle(ctx, executor, name="HUSH GARAGE", spelled_words=["HUSSH"])
    assert refused.result.reason_code == "spelled_word_missing"

    done = asyncio.run(executor.execute_pending(ctx, tapped))

    assert (done.result.status, done.result.reason_code) == ("rejected", "spelled_word_missing")
    assert done.result.spoken_facts == [
        "Earlier you spelled HUSSH as H-U-S-S-H. "
        "Is this a different circle, or should the name keep HUSSH?"
    ]
    assert not [call for call in service.calls if call[0] == "create_circle"]


def test_a_spelled_word_lapses_three_minutes_after_a_proposal_last_needed_it(monkeypatch):
    """An unrelated circle later in the conversation is not held to an old
    spelling, while every proposal that keeps the word extends it."""
    from datetime import datetime, timedelta, timezone

    from tests.one_voice.fakes import MemoryPendingStore

    clock = [datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)]
    monkeypatch.setattr(EntityContext, "_now", staticmethod(lambda: clock[0]))
    ctx = make_ctx(confirm_family=False)
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    first = _propose_circle(ctx, executor, name="HUSSH GARAGE", spelled_words=["HUSSH"])
    assert first.result.status == "confirmation_required"

    clock[0] += timedelta(seconds=170)
    kept = _propose_circle(ctx, executor, name="HUSSH GARAGE V04", changed_words=[{"new": "V04"}])
    assert kept.result.status == "confirmation_required"
    clock[0] += timedelta(seconds=170)
    dropped = _propose_circle(ctx, executor, name="HUSH GARAGE V04")
    assert dropped.result.reason_code == "name_changed"

    clock[0] += timedelta(seconds=181)
    unrelated = _propose_circle(ctx, executor, name="Book Club")
    assert unrelated.result.status == "confirmation_required"
    assert unrelated.result.summary == "create a circle called Book Club"


# -- a correction changes only the words it declares ---------------------------------
#
# UAT: with HUSSH GARAGE V04 waiting, "only make it V05" became HUSH GARAGE V05. The
# model had not declared HUSSH as spelled, so nothing protected it. The last name
# that passed is the one the person is reviewing; a proposal sharing a word with it
# corrects it and must declare each word it changes, or it is refused with a
# question and the waiting card is retired.


def _reviewing(name: str, **args: Any) -> tuple[ToolContext, ToolExecutor]:
    from tests.one_voice.fakes import MemoryPendingStore

    ctx = make_ctx(confirm_family=False)
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    card = _propose_circle(ctx, executor, name=name, **args)
    assert card.result.status == "confirmation_required"
    return ctx, executor


def test_a_correction_cannot_change_an_undeclared_word_even_one_never_spelled():
    ctx, executor = _reviewing("HUSSH GARAGE V04")

    refused = _propose_circle(ctx, executor, name="HUSH GARAGE V05", changed_words=V04_TO_V05)

    assert (refused.result.status, refused.result.reason_code) == ("rejected", "name_changed")
    assert refused.result.needs == "repeat_name"
    assert refused.result.spoken_facts == [
        'This would also change "HUSSH" to "HUSH". Is that what you want?'
    ]
    assert refused.result.retire_open_proposal is True
    assert refused.pending is None
    # Negative controls: the declared change alone passes and HUSSH survives ...
    kept = _propose_circle(ctx, executor, name="HUSSH GARAGE V05", changed_words=V04_TO_V05)
    assert kept.result.status == "confirmation_required"
    assert kept.result.summary == "create a circle called HUSSH GARAGE V05"
    # ... and HUSSH changes too once that change is declared.
    asked = _propose_circle(ctx, executor, name="HUSH GARAGE V05", changed_words=HUSSH_TO_HUSH)
    assert asked.result.status == "confirmation_required"


def test_the_refusal_names_every_word_the_correction_did_not_declare():
    ctx, executor = _reviewing("HUSSH GARAGE V04")
    both = _propose_circle(ctx, executor, name="HUSSH Garaz V4", changed_words=V04_TO_V05)
    assert both.result.reason_code == "name_changed"
    assert both.result.spoken_facts == [
        'This would change "GARAGE V04" to "Garaz V4". Is that what you want?'
    ]
    moved = _propose_circle(ctx, executor, name="GARAGE HUSSH V04")
    assert moved.result.reason_code == "name_changed"
    assert moved.result.spoken_facts == [
        'This would put the words in a different order: "GARAGE HUSSH V04". Is that what you want?'
    ]


@pytest.mark.parametrize(
    ("waiting", "proposed", "declared", "refused"),
    [
        # Case, and a joiner inside a word, are not changes; a leading zero is.
        ("HUSSH GARAGE V04", "hussh Garage V-04", [], False),
        ("HUSSH GARAGE V04", "HUSSH GARAGE V4", [], True),
        # A word added or removed is declared like any other change ...
        ("HUSSH GARAGE", "HUSSH GARAGE V04", [], True),
        ("HUSSH GARAGE", "HUSSH GARAGE V04", [{"new": "V04"}], False),
        ("HUSSH GARAGE V04", "HUSSH V04", [], True),
        ("HUSSH GARAGE V04", "HUSSH V04", [{"old": "GARAGE"}], False),
        # ... including one more or one fewer of a repeated word, each declared
        # once: one declared Go removes one Go (review NG-5).
        ("Go Go Team", "Go Team", [], True),
        ("Go Go Team", "Go Team", [{"old": "Go"}], False),
        ("Go Go Team", "Team", [{"old": "Go"}], True),
        ("Go Go Team", "Team", [{"old": "Go"}, {"old": "Go"}], False),
        # A declared word that did not change is not an error.
        ("HUSSH GARAGE V04", "HUSSH GARAGE V05", [*V04_TO_V05, {"old": "GARAGE"}], False),
        # A move is declared like any other change (review NG-3): the moved word
        # leaves one place and arrives in another. Naming a word as its own
        # change declares nothing.
        ("HUSSH GARAGE V04", "GARAGE HUSSH V04", [{"old": "HUSSH", "new": "HUSSH"}], True),
        (
            "HUSSH GARAGE V04",
            "GARAGE HUSSH V04",
            [{"old": "HUSSH GARAGE", "new": "GARAGE HUSSH"}],
            False,
        ),
        ("HUSSH GARAGE V04", "GARAGE HUSSH V04", [{"old": "HUSSH"}, {"new": "HUSSH"}], False),
        # A name sharing no word with the waiting one is a different circle ...
        ("HUSSH GARAGE V04", "Book Club", [], False),
        # ... unless a declared change names one of its words: then every other
        # word is still held (review NG-2).
        ("Hush Garage V04", "HUSSH Garaz V4", [{"old": "Hush", "new": "HUSSH"}], True),
        ("GARAGE V04", "GARAZ V05", V04_TO_V05, True),
        ("GARAGE V04", "GARAGE V05", V04_TO_V05, False),
    ],
)
def test_a_correction_declares_every_word_it_changes(waiting, proposed, declared, refused):
    ctx, executor = _reviewing(waiting)
    outcome = _propose_circle(ctx, executor, name=proposed, changed_words=declared)
    if refused:
        assert (outcome.result.status, outcome.result.reason_code) == ("rejected", "name_changed")
    else:
        assert outcome.result.status == "confirmation_required"


def test_a_newly_spelled_word_declares_the_word_it_replaces():
    ctx, executor = _reviewing("Hush Garage V04")
    spelled = _propose_circle(ctx, executor, name="HUSSH Garage V04", spelled_words=["HUSSH"])
    assert spelled.result.status == "confirmation_required"
    assert spelled.result.summary.endswith(", with HUSSH spelled H-U-S-S-H")
    # Negative control: the spelling declares its own word, not the one beside it.
    ctx, executor = _reviewing("Hush Garage V04")
    beside = _propose_circle(ctx, executor, name="HUSSH Garaz V04", spelled_words=["HUSSH"])
    assert beside.result.reason_code == "name_changed"


def _kept_words(ctx: ToolContext) -> list[str]:
    return [entry.word for entry in ctx.entities.spelled_name_words]


def test_a_spelled_change_replaces_only_its_own_word():
    """Review NG-1: a spelled word declared as a change's new word was also
    counted as a spare replacement, so it covered a second, untouched word."""
    hussh = [{"old": "Hush", "new": "HUSSH"}]
    ctx, executor = _reviewing("Hush Garage V04")
    # "No, H U S S H. Keep the rest." -- and GARAGE goes missing.
    dropped = _propose_circle(
        ctx, executor, name="HUSSH V04", spelled_words=["HUSSH"], changed_words=hussh
    )
    assert dropped.result.reason_code == "name_changed"
    assert dropped.result.spoken_facts == [
        'This would change "Hush Garage" to "HUSSH". Is that what you want?'
    ]
    # A kept spelled word is not given up for a change to the word beside it.
    ctx, executor = _reviewing("HUSSH GARAGE V04", spelled_words=["HUSSH"])
    kayra = _propose_circle(
        ctx,
        executor,
        name="KAYRA V04",
        spelled_words=["KAYRA"],
        changed_words=[{"old": "GARAGE", "new": "KAYRA"}],
    )
    assert kayra.result.reason_code == "name_changed"
    assert "HUSSH" in _kept_words(ctx)
    # Negative control: the same correction keeping the rest passes.
    ctx, executor = _reviewing("Hush Garage V04")
    kept = _propose_circle(
        ctx, executor, name="HUSSH Garage V04", spelled_words=["HUSSH"], changed_words=hussh
    )
    assert kept.result.status == "confirmation_required"


@pytest.mark.parametrize(
    ("waiting", "kept", "proposed", "args"),
    [
        # "sorry, just one S, H U S H, the rest stays" -- and Garage goes missing.
        (
            "HUSSH Garage V04",
            ["HUSSH"],
            "HUSH V04",
            {"spelled_words": ["HUSH"], "release_spelled_words": ["HUSSH"]},
        ),
        # The same respelling drops a second kept spelled word.
        (
            "MEERA HUSSH Club",
            ["MEERA", "HUSSH"],
            "HUSH Club",
            {"spelled_words": ["HUSH"], "release_spelled_words": ["HUSSH"]},
        ),
        # A removal declared in changed_words pairs with its respelling the same way.
        (
            "Hush Garage V04",
            [],
            "HUSSH V04",
            {"spelled_words": ["HUSSH"], "changed_words": [{"old": "Hush"}]},
        ),
    ],
)
def test_a_respelling_replaces_only_the_word_it_respells(waiting, kept, proposed, args):
    """Verification of the review fixes: a released (or declared-removed) word
    and the spelled word that replaced it were counted as two changes, so the
    spelling also covered an untouched neighbour."""
    ctx, executor = _reviewing(waiting, spelled_words=kept)
    outcome = _propose_circle(ctx, executor, name=proposed, **args)
    assert outcome.result.reason_code == "name_changed"
    assert all(word in _kept_words(ctx) for word in kept)


def test_the_respelling_itself_still_passes():
    # Negative control for the rows above: the eval's own shape keeps the rest.
    ctx, executor = _reviewing("HUSSH Garage V04", spelled_words=["HUSSH"])
    outcome = _propose_circle(
        ctx,
        executor,
        name="HUSH Garage V04",
        spelled_words=["HUSH"],
        release_spelled_words=["HUSSH"],
    )
    assert outcome.result.status == "confirmation_required"
    assert _kept_words(ctx) == ["HUSH"]


def test_a_declared_change_is_read_against_the_name_it_describes():
    # "A B" on a card "Team A B" names two of its words, not a spelled "AB".
    ctx, executor = _reviewing("Team A B")
    dropped = _propose_circle(ctx, executor, name="Team", changed_words=[{"old": "A B"}])
    assert dropped.result.status == "confirmation_required"
    # A word the card had spelled, declared letter by letter, is released as
    # that word, so the spelling check does not ask for it back.
    ctx, executor = _reviewing("HUSSH GARAGE", spelled_words=["HUSSH"])
    respelled = _propose_circle(
        ctx, executor, name="HUSH GARAGE", changed_words=[{"old": "H U S S H", "new": "HUSH"}]
    )
    assert respelled.result.status == "confirmation_required"
    assert "HUSSH" not in _kept_words(ctx)


def test_a_refused_correction_gives_up_no_spelled_word():
    """Review NG-4: a correction refused for an undeclared change had already
    released HUSSH, so the next proposal could leave it out unasked."""
    ctx, executor = _reviewing("HUSSH GARAGE V04", spelled_words=["HUSSH"])
    refused = _propose_circle(ctx, executor, name="GARAJ V04", spelled_words=["GARAJ"])
    assert refused.result.reason_code == "name_changed"
    assert _kept_words(ctx) == ["HUSSH", "GARAJ"]

    nxt = _propose_circle(ctx, executor, name="HUSH GARAJ")

    assert nxt.result.reason_code == "spelled_word_missing"


def test_releasing_a_spelled_word_declares_its_removal_only():
    """Review SEC-2: the tool description offers release_spelled_words as the
    answer to name_changed, so a released word counts as a declared removal."""
    ctx, executor = _reviewing("HUSSH Garage", spelled_words=["HUSSH"])
    dropped = _propose_circle(ctx, executor, name="Garage", release_spelled_words=["HUSSH"])
    assert dropped.result.status == "confirmation_required"
    assert dropped.result.summary == "create a circle called Garage"
    # Negative control: it declares no added word.
    ctx, executor = _reviewing("HUSSH Garage", spelled_words=["HUSSH"])
    added = _propose_circle(ctx, executor, name="Garage Club", release_spelled_words=["HUSSH"])
    assert added.result.reason_code == "name_changed"


def test_a_name_the_person_typed_is_theirs_and_becomes_the_one_to_correct():
    ctx, executor = _reviewing("HUSSH GARAGE V04", spelled_words=["HUSSH"])
    # Negative control: spoken, the same name changes two words it never declared.
    spoken = _propose_circle(ctx, executor, name="Hush Garage V05")
    assert spoken.result.reason_code == "name_changed"

    ctx.typed_name = True
    typed = _propose_circle(ctx, executor, name="Hush Garage V05")
    assert typed.result.status == "confirmation_required"
    assert typed.result.summary == "create a circle called Hush Garage V05"
    assert ctx.entities.spelled_name_words == []

    ctx.typed_name = False
    retyped = _propose_circle(ctx, executor, name="Hush Garage V06")
    assert retyped.result.reason_code == "name_changed"
    declared = [{"old": "V05", "new": "V06"}]
    assert (
        _propose_circle(ctx, executor, name="Hush Garage V06", changed_words=declared).result.status
        == "confirmation_required"
    )


def test_the_waiting_name_survives_a_reconnect_and_an_older_row_still_restores():
    from hushh_mcp.one_voice.tools.base import restore_context

    ctx, _ = _reviewing("HUSSH GARAGE V04")
    stored = ctx.entities.model_dump(mode="json")

    restored = restore_context(EntityContext, stored)
    assert restored.circle_name_baseline == ctx.entities.circle_name_baseline
    assert restored.circle_name_baseline.name == "HUSSH GARAGE V04"
    older = {key: value for key, value in stored.items() if key != "circle_name_baseline"}
    assert restore_context(EntityContext, older).circle_name_baseline is None
    damaged = restore_context(
        EntityContext, {**stored, "circle_name_baseline": {"name": 4, "at": "soon"}}
    )
    assert damaged.circle_name_baseline is None
    assert AYESHA in damaged.people


def test_changed_words_bounds_only_the_list_in_the_declaration():
    """Vertex Live refuses a declaration with length bounds on array items."""
    changed = spec("create_circle").declaration()["parameters_json_schema"]["properties"][
        "changed_words"
    ]
    assert changed["maxItems"] == 8
    assert set(changed["items"]["properties"]) == {"old", "new"}
    assert changed["items"]["additionalProperties"] is False
    for prop in changed["items"]["properties"].values():
        assert not {"maxLength", "minLength"} & set(prop)
    with pytest.raises(ValidationError):
        circles.CreateCircleInput(name="X", changed_words=[{"old": "A" * 81}])


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


# -- set_circle_kind: its own action, kind only, never a rename's receipt ----------


def test_set_circle_kind_changes_only_the_kind_through_its_own_action():
    service = FakeCircleService()
    ctx = make_ctx(service)
    tool = spec("set_circle_kind")
    assert tool.gateway_action_id == "location.set_circle_kind"
    assert tool.policy is ToolPolicy.confirm_voice and tool.circle_args == ("circle",)
    assert summary("set_circle_kind", ctx, circle={"circle_id": FAMILY}, kind="friends") == (
        "make the Family circle a friends circle"
    )
    assert summary("set_circle_kind", ctx, circle={"circle_id": FAMILY}, kind="other") == (
        "make the Family circle a plain circle, neither family nor friends"
    )
    result = run("set_circle_kind", ctx, circle={"circle_id": FAMILY}, kind="friends")
    assert result.status == "kind_changed" and result.previous_kind == "family"
    assert result.spoken_facts == ["Family is now a friends circle."]
    call = next(c for c in service.calls if c[0] == "update_circle")
    # name=None: the service's COALESCE leaves the name; nothing else is sent.
    assert call[1] == {"owner_user_id": USER, "circle_id": FAMILY, "name": None, "kind": "friends"}
    assert result.circle.name == "Family" and result.circle.kind == "friends"
    assert ctx.entities.circle(FAMILY).kind == "friends"
    assert ctx.entities.circle(FAMILY).name == "Family"


def test_set_circle_kind_reports_no_change_without_a_write():
    service = FakeCircleService()
    ctx = make_ctx(service)
    result = run("set_circle_kind", ctx, circle={"circle_id": FAMILY}, kind="family")
    assert result.status == "already_kind" and result.previous_kind == "family"
    assert result.spoken_facts == ["Family is already a family circle."]
    assert not any(name == "update_circle" for name, _ in service.calls)


def test_set_circle_kind_refuses_an_unsupported_kind_and_maps_owner_errors():
    with pytest.raises(ValidationError):
        spec("set_circle_kind").input_model.model_validate(
            {"circle": {"circle_id": FAMILY}, "kind": "emergency"}
        )
    service = FakeCircleService()
    service.errors["update_circle"] = OneLocationCircleError(
        "LOCATION_CIRCLE_OWNER_REQUIRED",
        "Only the Circle owner can make this change.",
        status_code=403,
    )
    result = run("set_circle_kind", make_ctx(service), circle={"circle_id": FAMILY}, kind="other")
    assert result.status == "rejected" and result.reason_code == "LOCATION_CIRCLE_OWNER_REQUIRED"


def test_rename_and_set_kind_are_separate_actions_with_separate_receipts():
    assert spec("rename_circle").gateway_action_id == "location.rename_circle"
    assert spec("set_circle_kind").gateway_action_id == "location.set_circle_kind"
    # rename never sends a kind; set_kind never sends a name.
    service = FakeCircleService()
    ctx = make_ctx(service)
    run("rename_circle", ctx, circle={"circle_id": FAMILY}, name="Fam")
    run("set_circle_kind", ctx, circle={"circle_id": FAMILY}, kind="friends")
    updates = [kw for name, kw in service.calls if name == "update_circle"]
    assert [(u["name"], u["kind"]) for u in updates] == [("Fam", None), (None, "friends")]


# -- add_circle_members: one card, one call, an answer per person -----------------------

DEV = "user-dev"


def _batch_ctx(service: FakeCircleService | None = None):
    """A context where all three people are confirmed, so the names One says are
    the server's and not the model's arguments."""
    service = service or FakeCircleService()
    ctx = make_ctx(service)
    for user_id, name, relationship in (
        (PRIYA, "Priya Nair", "connected"),
        (DEV, "Dev Kapoor", "none"),
    ):
        ctx.entities.remember_person(
            ConfirmedPerson(
                user_id=user_id,
                display_name=name,
                relationship=relationship,
                confirmed_at=now_iso(),
            )
        )
    return ctx, service


def test_add_circle_members_answers_for_each_person_and_claims_nothing_more():
    """The point of the batch: one write, and three different true answers."""
    ctx, service = _batch_ctx()

    result = run(
        "add_circle_members",
        ctx,
        circle={"circle_id": FAMILY},
        people=[{"user_id": AYESHA}, {"user_id": PRIYA}, {"user_id": DEV}],
    )

    assert result.status == "partially_added"
    assert [(row.user_id, row.status) for row in result.added] == [(AYESHA, "added")]
    assert [(row.user_id, row.status) for row in result.skipped] == [
        (PRIYA, "already_member"),
        (DEV, "not_connected"),
    ]
    assert result.spoken_facts == [
        "Added Ayesha Sharma to the Family circle.",
        "Priya Nair was already in the Family circle.",
        "You aren't connected with Dev Kapoor yet, so I skipped them.",
    ]
    # Only the addable person was written, so a non-connection cannot take the
    # whole batch down with them.
    assert (
        "create_member_invites",
        {"actor_user_id": USER, "circle_id": FAMILY, "invitee_user_ids": [AYESHA]},
    ) in service.calls


def test_a_person_named_twice_is_decided_once_and_written_once():
    ctx, service = _batch_ctx()

    result = run(
        "add_circle_members",
        ctx,
        circle={"circle_id": FAMILY},
        people=[{"user_id": AYESHA}, {"user_id": DEV}, {"user_id": AYESHA}],
    )

    assert [row.user_id for row in result.added] == [AYESHA]
    writes = [kwargs for name, kwargs in service.calls if name == "create_member_invites"]
    assert writes == [{"actor_user_id": USER, "circle_id": FAMILY, "invitee_user_ids": [AYESHA]}], (
        "a repeated name must not become a repeated add"
    )


def test_more_than_twenty_people_is_refused_before_anything_is_read_or_written():
    """The service caps the batch at twenty. Discovering that after the person
    said yes would mean refusing work already approved."""
    import pytest
    from pydantic import ValidationError

    ctx, service = _batch_ctx()
    too_many = [{"user_id": f"user-{index:02d}"} for index in range(21)]

    with pytest.raises(ValidationError):
        run("add_circle_members", ctx, circle={"circle_id": FAMILY}, people=too_many)
    assert service.calls == [], "nothing may be read or written for a refused batch"


def test_one_person_is_not_a_batch():
    """Keeping the arities disjoint is what stops the model having to choose
    between two tools that would both fit."""
    import pytest
    from pydantic import ValidationError

    ctx, _ = _batch_ctx()
    with pytest.raises(ValidationError):
        run("add_circle_members", ctx, circle={"circle_id": FAMILY}, people=[{"user_id": AYESHA}])


def test_a_batch_asks_once_rather_than_once_per_person():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _batch_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())

    outcome = asyncio.run(
        executor.call(
            ctx,
            "add_circle_members",
            {
                "circle": {"circle_id": FAMILY},
                "people": [{"user_id": AYESHA}, {"user_id": PRIYA}],
            },
        )
    )

    assert outcome.result.status == "confirmation_required"
    assert outcome.result.tier == "voice"
    assert outcome.pending is not None and outcome.pending.tool_name == "add_circle_members"
    # One card for the group, and nothing written until it is answered.
    assert [name for name, _ in service.calls if name == "create_member_invites"] == []
    assert (
        summary(
            "add_circle_members",
            ctx,
            circle={"circle_id": FAMILY},
            people=[{"user_id": AYESHA}, {"user_id": PRIYA}],
        )
        == "add Ayesha Sharma and Priya Nair to the Family circle"
    )


def test_an_unconfirmed_person_anywhere_in_the_batch_is_refused():
    """The negative control for the widened guard: every id in the list has to
    have been offered and confirmed, not just the first one."""
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _batch_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())

    outcome = asyncio.run(
        executor.call(
            ctx,
            "add_circle_members",
            {
                "circle": {"circle_id": FAMILY},
                "people": [{"user_id": AYESHA}, {"user_id": NOT_OFFERED}],
            },
        )
    )

    assert outcome.result.status == "rejected"
    assert outcome.result.reason_code == "person_not_confirmed"
    assert service.calls == []


def test_a_refused_write_reports_nobody_added_rather_than_a_partial_success():
    """The service writes nobody when it raises, so this must never read as
    "added some". Its refusals do not name a person, which is exactly why the
    batch cannot invent per-person detail here."""
    ctx, service = _batch_ctx()
    service.errors["create_member_invites"] = OneLocationCircleError(
        "LOCATION_CIRCLE_INVITE_COOLDOWN", "Try again in an hour.", status_code=429
    )

    result = run(
        "add_circle_members",
        ctx,
        circle={"circle_id": FAMILY},
        people=[{"user_id": AYESHA}, {"user_id": PRIYA}],
    )

    assert result.status == "rejected"
    assert result.reason_code == "LOCATION_CIRCLE_INVITE_COOLDOWN"
    assert getattr(result, "added", []) == []


def test_everyone_already_in_the_circle_is_an_answer_not_a_failure():
    ctx, service = _batch_ctx()
    service.errors["create_member_invites"] = OneLocationCircleError(
        "LOCATION_CIRCLE_ALREADY_MEMBER",
        "One or more selected connections are already in the Circle.",
        status_code=409,
    )

    result = run(
        "add_circle_members",
        ctx,
        circle={"circle_id": FAMILY},
        people=[{"user_id": AYESHA}, {"user_id": PRIYA}],
    )

    assert result.status == "none_added"
    assert result.added == []
    assert {row.status for row in result.skipped} == {"already_member"}


def test_the_cooldown_the_service_reports_is_not_flattened_into_not_eligible():
    """``left_recently`` is a different fact from "can't be added": one is a wait
    and the other is a prerequisite."""
    ctx, service = _batch_ctx()
    service.eligible[FAMILY] = [
        {"userId": AYESHA, "displayName": "Ayesha Sharma"},
        {"userId": DEV, "displayName": "Dev Kapoor"},
    ]
    service.add_result = {
        "invites": [],
        "createdInviteIds": [],
        "addedUserIds": [AYESHA],
        "skippedUserIds": [DEV],
        "skippedReasons": {DEV: "left_recently"},
    }

    result = run(
        "add_circle_members",
        ctx,
        circle={"circle_id": FAMILY},
        people=[{"user_id": AYESHA}, {"user_id": DEV}],
    )

    assert result.status == "partially_added"
    assert [(row.user_id, row.status) for row in result.skipped] == [(DEV, "left_recently")]
    assert result.spoken_facts[-1] == (
        "Dev Kapoor left the Family circle recently, so I couldn't add them back yet."
    )


# -- add_all_connections: the server decides who, one card binds exactly them -----------

KABIR = "user-kabir"


def _everyone_ctx():
    """Family holds the owner and Priya. The owner's connections: Ayesha and
    Kabir can join, Priya is already in, Dev left Family moments ago."""
    service = FakeCircleService()
    service.audience = [
        {"userId": AYESHA, "displayName": "Ayesha Sharma"},
        {"userId": KABIR, "displayName": "Kabir Singh"},
        {"userId": PRIYA, "displayName": "Priya Nair"},
        {"userId": DEV, "displayName": "Dev Kapoor", "status": "left_recently"},
    ]
    ctx = make_ctx(service, confirm_ayesha=False)
    return ctx, service


def _propose_everyone(ctx, executor):
    outcome = asyncio.run(
        executor.call(ctx, "add_all_connections", {"circle": {"circle_id": FAMILY}})
    )
    return outcome


def _say_yes(executor, ctx, outcome):
    asyncio.run(executor.pending.mark_shown(user_id=USER, pending_action_id=outcome.pending.id))
    return asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": outcome.pending.id})
    )


def _writes(service):
    return [
        kwargs["user_ids"] for name, kwargs in service.calls if name == "add_direct_connections"
    ]


def test_add_all_shows_one_card_with_the_exact_counts_and_writes_nothing():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())

    outcome = _propose_everyone(ctx, executor)

    assert outcome.result.status == "confirmation_required" and outcome.result.tier == "voice"
    assert outcome.result.summary == (
        "add 2 of your 4 connections to the Family circle "
        "(1 is already in it, 1 can't be added right now)"
    )
    assert _writes(service) == []
    # The server, not the model, decided the audience: no lookup per person.
    assert {name for name, _ in service.calls} == {"plan_direct_connection_adds"}
    # The exact ids ride the server's private snapshot, never the card or the model.
    stored = outcome.pending.args["_prepared"]
    assert stored["user_ids"] == sorted([AYESHA, KABIR])
    public = outcome.pending.public()
    assert "_prepared" not in public["args"]
    assert AYESHA not in str(outcome.result.model_public())


def test_add_all_adds_exactly_the_reviewed_group_once():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    outcome = _propose_everyone(ctx, executor)

    done = _say_yes(executor, ctx, outcome)
    late = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": outcome.pending.id})
    )

    assert done.result.status == "added"
    assert (done.result.added_count, done.result.already_member_count) == (2, 0)
    assert done.result.spoken_facts == [
        "Added 2 people to the Family circle: Ayesha Sharma and Kabir Singh."
    ]
    assert "location_circles" in done.result.ui_refresh
    assert late.result.status == "not_pending"
    assert _writes(service) == [sorted([AYESHA, KABIR])]


def test_someone_who_connects_after_the_card_is_never_added_on_its_strength():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    outcome = _propose_everyone(ctx, executor)
    service.audience.append({"userId": "user-new", "displayName": "New Person"})

    done = _say_yes(executor, ctx, outcome)

    assert done.result.status == "added"
    assert _writes(service) == [sorted([AYESHA, KABIR])]
    assert done.result.spoken_facts[-1] == (
        "1 newer connection was not on the card, so I left them out."
    )


@pytest.mark.parametrize("change", ["disconnected", "left_recently"])
def test_an_approved_person_who_can_no_longer_join_stops_the_whole_add(change):
    """Negative control for the binding: the card no longer says what would
    happen, so nothing is written and the person is asked again."""
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    outcome = _propose_everyone(ctx, executor)
    if change == "disconnected":
        service.audience = [p for p in service.audience if p["userId"] != KABIR]
    else:
        next(p for p in service.audience if p["userId"] == KABIR)["status"] = "left_recently"

    done = _say_yes(executor, ctx, outcome)

    assert done.result.status == "not_added"
    assert done.result.reason_code == "audience_changed"
    assert _writes(service) == []


def test_without_room_for_everyone_nobody_is_added_and_no_card_is_shown():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    service.member_limit = 3  # two seats taken, one left, two people to add
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store)

    outcome = _propose_everyone(ctx, executor)

    assert outcome.result.status == "not_enough_room"
    assert outcome.result.spoken_facts == [
        "The Family circle only has room for 1 more, so I can't add all 2 as you asked. "
        "Nobody was added."
    ]
    assert outcome.pending is None and store.rows == {}
    assert _writes(service) == []


@pytest.mark.parametrize(("is_system", "system_kind"), [(False, "trusted"), (True, "sms")])
def test_trusted_and_the_sms_circle_are_never_filled_with_everyone(is_system, system_kind):
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    family = service._stored(FAMILY)
    family["isSystem"], family["systemKind"] = is_system, system_kind
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store)

    outcome = _propose_everyone(ctx, executor)

    assert outcome.result.status == "unsupported"
    assert outcome.result.reason_code == "managed_circle"
    assert store.rows == {} and _writes(service) == []


def test_nobody_left_to_add_is_an_answer_without_a_card():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    service.audience = [{"userId": PRIYA, "displayName": "Priya Nair"}]
    executor = ToolExecutor(pending_store=MemoryPendingStore())

    outcome = _propose_everyone(ctx, executor)

    assert outcome.result.status == "no_one_to_add"
    assert outcome.result.spoken_facts == [
        "Everyone you're connected with is already in the Family circle."
    ]
    assert outcome.pending is None


def test_only_the_owner_can_fill_a_circle_with_everyone():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    ctx.entities.remember_circle(
        ConfirmedCircle(circle_id=WORK, name="Work Friends", kind="friends", confirmed_at=now_iso())
    )
    executor = ToolExecutor(pending_store=MemoryPendingStore())

    outcome = asyncio.run(
        executor.call(ctx, "add_all_connections", {"circle": {"circle_id": WORK}})
    )

    assert outcome.result.status == "rejected"
    assert outcome.result.reason_code == "LOCATION_CIRCLE_OWNER_REQUIRED"
    assert outcome.pending is None


def test_the_model_cannot_name_the_audience():
    tool = spec("add_all_connections")
    assert set(tool.declaration()["parameters_json_schema"]["properties"]) == {"circle"}
    with pytest.raises(ValidationError):
        tool.input_model.model_validate(
            {"circle": {"circle_id": FAMILY}, "people": [{"user_id": AYESHA}]}
        )


def test_without_the_reviewed_binding_nothing_is_added():
    """A missing or altered snapshot is not an approval of anyone."""
    ctx, service = _everyone_ctx()
    ctx.prepared = {
        "circle_id": FAMILY,
        "user_ids": sorted([AYESHA, KABIR]),
        "audience": "not-the-digest",
    }

    result = run("add_all_connections", ctx, circle={"circle_id": FAMILY})

    assert (result.status, result.reason_code) == ("not_added", "review_required")
    assert _writes(service) == []


def test_a_refused_bulk_write_reports_nobody_added():
    from tests.one_voice.fakes import MemoryPendingStore

    ctx, service = _everyone_ctx()
    executor = ToolExecutor(pending_store=MemoryPendingStore())
    outcome = _propose_everyone(ctx, executor)
    service.errors["add_direct_connections"] = OneLocationCircleError(
        "LOCATION_CIRCLE_INVITE_COOLDOWN", "Try again in an hour.", status_code=429
    )

    done = _say_yes(executor, ctx, outcome)

    assert done.result.status == "rejected"
    assert done.result.reason_code == "LOCATION_CIRCLE_INVITE_COOLDOWN"
    assert getattr(done.result, "added_count", 0) == 0


def test_a_spelling_the_schema_cannot_read_retires_the_card_it_corrected():
    """UAT 2026-10-06: with the card for HUSH GARAGE V04 open, the model declared
    "HUSSH GARAGE" as one spelled word. The schema refused the call and the old
    card stayed confirmable, so a yes would have created the name the person had
    just corrected. The refusal now retires that card and asks for the word."""
    from tests.one_voice.fakes import MemoryPendingStore

    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    store = MemoryPendingStore()
    executor = ToolExecutor(pending_store=store)
    card = _propose_circle(ctx, executor, name="HUSH GARAGE V04")
    asyncio.run(store.mark_shown(user_id=USER, pending_action_id=card.pending.id))

    bad = _propose_circle(ctx, executor, name="HUSSH GARAGE V04", spelled_words=["HUSSH GARAGE"])

    assert (bad.result.status, bad.result.reason_code, bad.result.needs) == (
        "rejected",
        "invalid_spelling",
        "repeat_name",
    )
    assert bad.result.spoken_facts == [
        "I couldn't read how that was spelled. Which word did they spell? "
        "Ask them to spell just that word."
    ]
    assert [row.id for row in bad.superseded] == [card.pending.id]
    late_yes = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.pending.id})
    )
    assert late_yes.result.status == "not_pending"
    assert not [call for call in service.calls if call[0] == "create_circle"]
    # Negative control: a malformed call that declares no spelling gets the
    # generic answer. The spelling question is asked only about a spelling ...
    unspelled = _propose_circle(ctx, executor, name="")
    assert unspelled.result.reason_code == "invalid_arguments"
    # ... and only when the spelling is what failed (review NG-6): a readable
    # spelling beside a bad kind is answered about the kind.
    other = _propose_circle(
        ctx, executor, name="HUSSH GARAGE V04", kind="work", spelled_words=["HUSSH"]
    )
    assert other.result.reason_code == "invalid_arguments"
    assert other.result.spoken_facts == ["I'm missing kind for that."]
