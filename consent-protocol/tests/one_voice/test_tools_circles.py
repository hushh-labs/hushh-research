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
        "members": [{"userId": uid, "displayName": label} for uid, label in members],
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


def make_ctx(
    service: FakeCircleService | None = None,
    *,
    confirm_family: bool = True,
    confirm_ayesha: bool = True,
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
        screen=ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test double, not a credential
        services={circles.CIRCLE_SERVICE: service or FakeCircleService()},
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
    assert ctx.entities.circle(FAMILY).member_count == 3


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
    assert result.spoken_facts == [
        "Dev Patel isn't a connection you can add to the Family circle yet. "
        "Connect with them first, or share the circle's invite link."
    ]
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
    assert ctx.entities.circle(FAMILY).member_count == 1

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
