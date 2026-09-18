"""Circle tools: find, confirm, create, rename, delete, membership, invites, join link.

Every mutation that targets a circle takes a ``CircleRef`` whose id must already
be confirmed in the conversation's :class:`EntityContext`; a spoken circle name
only ever reaches ``resolve_circle``, which offers candidate ids and never
confirms one on its own. Names read back to the person always come from a real
service row or from the confirmed entity, never from the model's arguments.

All circle service calls run on the vault-owner plane (``user_id``) and are
synchronous SQLAlchemy code, so they are dispatched with ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Literal
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.one_voice.tools.base import (
    CircleRef,
    ConfirmedCircle,
    PersonRef,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    now_iso,
)
from hushh_mcp.one_voice.tools.people import ServiceError as PeopleServiceError
from hushh_mcp.one_voice.tools.people import load_people_snapshot
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
)
from hushh_mcp.services.spoken_name_resolver import (
    is_fuzzy_match,
    join_names_for_speech,
    match_circle_by_name,
    normalize_spoken_name,
)

CIRCLE_SERVICE = "circles"
CIRCLE_JOIN_PATH = "/circle/join"
# Client surfaces to refresh after a successful mutation (screen ids from session.py).
REFRESH_CIRCLES = ("location_circles",)
REFRESH_INVITES = ("location_circles", "location_needs_review")
# How many circle names / invitations are read aloud before "and N more".
SPOKEN_LIST_LIMIT = 6
# One roster page. Bounded so a large circle is read a page at a time and the
# result always says whether more follow; never the whole roster at once.
MEMBERS_PAGE_LIMIT = 20

CircleKind = Literal["family", "friends", "other"]
InviteStatus = Literal["pending", "accepted", "declined", "cancelled", "expired"]

_SERVICE_ERRORS = (OneLocationCircleError, OneLocationAgentError)


# -- shared helpers -----------------------------------------------------------


def _service(ctx: ToolContext) -> Any:
    return ctx.service(CIRCLE_SERVICE, OneLocationCircleService)


def _rejected(exc: Exception) -> Rejected:
    code = str(getattr(exc, "code", "") or "").strip() or "circle_service_error"
    message = str(getattr(exc, "message", "") or "").strip() or "That didn't go through."
    return Rejected(reason_code=code, spoken_facts=[message])


def _circle_label(name: str) -> str:
    """'the Family circle', but never 'the SMS Circle circle'."""
    clean = " ".join(str(name or "").split())
    if not clean:
        return "that circle"
    if "circle" in clean.lower():
        return f"the {clean}"
    return f"the {clean} circle"


def _person_name(ctx: ToolContext, user_id: str) -> str:
    person = ctx.entities.person(user_id)
    return person.display_name if person is not None else "that person"


def _circle_name(ctx: ToolContext, circle_id: str) -> str:
    circle = ctx.entities.circle(circle_id)
    return circle.name if circle is not None else ""


def _remember(ctx: ToolContext, row: dict[str, Any]) -> ConfirmedCircle:
    circle = ConfirmedCircle(
        circle_id=str(row.get("id") or ""),
        name=str(row.get("name") or ""),
        kind=str(row.get("kind") or "other"),
        member_count=int(row.get("memberCount") or 0),
        confirmed_at=now_iso(),
    )
    ctx.entities.remember_circle(circle)
    return circle


def _forget(ctx: ToolContext, circle_id: str) -> None:
    ctx.entities.circles.pop(circle_id, None)
    if ctx.entities.last_circle_id == circle_id:
        ctx.entities.last_circle_id = None
    ctx.entities.offered_circle_ids = [
        item for item in ctx.entities.offered_circle_ids if item != circle_id
    ]
    if ctx.entities.offered_person_circle_id == circle_id:
        ctx.entities.offer_people([])


def _in_scope(ctx: ToolContext, circle_id: str) -> bool:
    """An id a read tool may act on: confirmed in this conversation, offered by
    the last list/resolve, or the circle whose screen is open. Anything else is
    an id the model made up."""
    return (
        ctx.entities.circle(circle_id) is not None
        or circle_id in ctx.entities.offered_circle_ids
        or circle_id == ctx.screen.active_circle_id
    )


def _target_circle_id(ctx: ToolContext, ref: CircleRef | None) -> str | Rejected:
    """The circle a read is about: the given id if in scope, else the one on
    screen. The screen id is a hint only; the service authorizes the read."""
    if ref is not None:
        if not _in_scope(ctx, ref.circle_id):
            return Rejected(
                reason_code="circle_not_offered",
                needs="disambiguation",
                spoken_facts=["That circle wasn't one of the options. Let me look it up again."],
            )
        return ref.circle_id
    active = str(ctx.screen.active_circle_id or "")
    if active:
        return active
    return Rejected(
        reason_code="no_circle_in_view",
        needs="disambiguation",
        spoken_facts=["Which circle do you mean?"],
    )


async def _refresh_remembered(ctx: ToolContext, circle_id: str) -> None:
    """Re-read the circle after a membership change so the remembered count is
    the server's, not a cached number plus or minus one. If the read fails the
    count is dropped rather than guessed."""
    service = _service(ctx)
    try:
        row = dict(
            await asyncio.to_thread(
                service.get_circle_overview, user_id=ctx.user_id, circle_id=circle_id
            )
            or {}
        )
    except _SERVICE_ERRORS:
        row = {}
    if row.get("id"):
        _remember(ctx, row)
        return
    circle = ctx.entities.circle(circle_id)
    if circle is not None:
        ctx.entities.remember_circle(circle.model_copy(update={"member_count": None}))


async def _fresh_relationship(ctx: ToolContext, user_id: str) -> str:
    """The person's current relationship to the viewer, re-read now. Falls
    back to what was true when they were confirmed if the people plane is
    unavailable, and says so via ``none`` only when nothing is known."""
    try:
        snapshot = await load_people_snapshot(ctx)
    except PeopleServiceError:
        person = ctx.entities.person(user_id)
        return person.relationship if person is not None else "none"
    record = snapshot.people.get(user_id)
    if record is not None:
        return str(record.get("relationship") or "none")
    return "none"


def _public_app_origin() -> str:
    """Where a shareable link must point. Read from the runtime, never from the
    device: the installed app's own origin is ``App://localhost`` -- dead for
    whoever receives it."""
    for key in ("HUSHH_ONE_PUBLIC_APP_URL", "NEXT_PUBLIC_APP_URL", "APP_PUBLIC_URL"):
        value = str(os.getenv(key) or "").strip().rstrip("/")
        if value:
            return value
    return ""


def build_circle_join_url(code: str, origin: str | None = None) -> str:
    """Twin of ``hushh-webapp/lib/one-location/circle-join-url.ts``."""
    base = (origin if origin is not None else _public_app_origin()).rstrip("/")
    clean_code = str(code or "").strip()
    query = f"?code={quote(clean_code, safe='')}" if clean_code else ""
    return f"{base}{CIRCLE_JOIN_PATH}{query}"


# -- result rows ----------------------------------------------------------------


class CircleSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    circle_id: str
    name: str
    kind: str
    member_count: int
    is_owner: bool
    is_system: bool = False

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> CircleSummary:
        return cls(
            circle_id=str(row.get("id") or ""),
            name=str(row.get("name") or ""),
            kind=str(row.get("kind") or "other"),
            member_count=int(row.get("memberCount") or 0),
            is_owner=str(row.get("role") or "") == "owner",
            is_system=bool(row.get("isSystem")),
        )


class CircleDetails(CircleSummary):
    """What ``get_circle_details`` reads back: the summary plus the viewer's
    capabilities and the product classification. Never the join code."""

    system_kind: str | None = None
    member_limit: int | None = None
    can_add_members: bool = False
    can_manage: bool = False
    can_delete: bool = False
    can_leave: bool = False
    updated_at: str | None = None

    @classmethod
    def from_overview(cls, row: dict[str, Any]) -> CircleDetails:
        caps = dict(row.get("viewerCapabilities") or {})
        base = CircleSummary.from_row(row)
        limit = row.get("memberLimit")
        return cls(
            **base.model_dump(),
            system_kind=str(row.get("systemKind") or "") or None,
            member_limit=int(limit) if isinstance(limit, int) else None,
            can_add_members=bool(caps.get("canInviteMembers")),
            can_manage=bool(caps.get("canManageCircle")),
            can_delete=bool(caps.get("canDeleteCircle")),
            can_leave=bool(caps.get("canLeaveCircle")),
            updated_at=str(row.get("updatedAt") or "") or None,
        )

    def spoken(self) -> list[str]:
        kind = "" if self.kind == "other" else f"{self.kind} "
        count = f"{self.member_count} member{'s' if self.member_count != 1 else ''}"
        facts = [f"{self.name} is a {kind}circle with {count}."]
        if self.is_owner:
            facts.append("You own it.")
        else:
            facts.append("You're a member; the owner manages it.")
        if self.is_system and self.is_owner and not self.can_delete:
            facts.append("It's managed by the app, so it can't be deleted.")
        return facts


class CircleMember(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    display_name: str
    role: str
    # Membership is not connection: how this member relates to the viewer.
    relationship: Literal["connected", "pending_outgoing", "pending_incoming", "none", "self"]
    is_self: bool = False
    joined_at: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any], *, viewer_user_id: str) -> CircleMember:
        user_id = str(row.get("userId") or "")
        relationship = str(row.get("relationship") or "none")
        if relationship not in {
            "connected",
            "pending_outgoing",
            "pending_incoming",
            "none",
            "self",
        }:
            relationship = "none"
        is_self = user_id == viewer_user_id
        return cls(
            user_id=user_id,
            display_name=str(row.get("displayName") or "") or "Circle member",
            role=str(row.get("role") or "member"),
            relationship="self" if is_self else relationship,  # type: ignore[arg-type]
            is_self=is_self,
            joined_at=str(row.get("joinedAt") or "") or None,
        )


class CircleInvite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invite_id: str
    circle_id: str
    circle_name: str
    direction: Literal["incoming", "outgoing"]
    inviter_name: str
    invitee_name: str
    status: InviteStatus
    expires_at: str | None = None

    @classmethod
    def from_row(
        cls, row: dict[str, Any], direction: Literal["incoming", "outgoing"]
    ) -> CircleInvite:
        return cls(
            invite_id=str(row.get("id") or ""),
            circle_id=str(row.get("circleId") or ""),
            circle_name=str(row.get("circleName") or ""),
            direction=direction,
            inviter_name=str(row.get("inviterDisplayName") or ""),
            invitee_name=str(row.get("inviteeDisplayName") or ""),
            status=str(row.get("status") or "pending"),  # type: ignore[arg-type]
            expires_at=row.get("expiresAt"),
        )


# -- list_circles -----------------------------------------------------------------


class ListCirclesInput(ToolInput):
    pass


class ListCirclesResult(ToolResult):
    status: Literal["ok", "none"]
    circles: list[CircleSummary] = Field(default_factory=list)


async def _list_circle_rows(ctx: ToolContext) -> list[dict[str, Any]]:
    service = _service(ctx)
    rows = await asyncio.to_thread(service.list_circles, user_id=ctx.user_id)
    return [dict(row) for row in (rows or [])]


async def list_circles(ctx: ToolContext, args: ListCirclesInput) -> ToolResult:
    try:
        rows = await _list_circle_rows(ctx)
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    circles = [CircleSummary.from_row(row) for row in rows]
    # Every id here came from the service, so any of them may be confirmed next.
    ctx.entities.offered_circle_ids = [circle.circle_id for circle in circles]
    if not circles:
        return ListCirclesResult(status="none", spoken_facts=["You're not in any circles yet."])
    if len(circles) == 1:
        # One row is an unambiguous canonical record; remembering it lets
        # "rename it" work without a resolve/confirm round trip.
        _remember(ctx, rows[0])
    names = [circle.name for circle in circles[:SPOKEN_LIST_LIMIT]]
    extra = len(circles) - len(names)
    spoken = join_names_for_speech(names) + (f", and {extra} more" if extra > 0 else "")
    count = f"{len(circles)} circle{'s' if len(circles) != 1 else ''}"
    return ListCirclesResult(
        status="ok",
        circles=circles,
        spoken_facts=[f"You're in {count}: {spoken}."],
    )


# -- resolve_circle ---------------------------------------------------------------


class ResolveCircleInput(ToolInput):
    spoken_name: str = Field(
        min_length=1,
        max_length=120,
        description="The circle name as the person said it. Suggestion only; never an id.",
    )


class ResolveCircleResult(ToolResult):
    status: Literal["single_likely", "multiple", "none"]
    candidates: list[CircleSummary] = Field(default_factory=list)


_FILLER_WORDS = {"circle", "circles", "group", "the", "my"}


def _spoken_target(spoken_name: str) -> str:
    """'my family circle' -> 'family'; a name that is only filler stays whole."""
    normalized = normalize_spoken_name(spoken_name)
    kept = [word for word in normalized.split(" ") if word and word not in _FILLER_WORDS]
    return " ".join(kept) if kept else normalized


def match_circles(rows: list[dict[str, Any]], spoken_name: str) -> list[dict[str, Any]]:
    """Exact -> word-boundary -> substring (shared resolver), then a bounded
    fuzzy fallback on the whole name or any single word. Suggestion only."""
    target = _spoken_target(spoken_name)
    if not target:
        return []
    tiered = match_circle_by_name(rows, target, lambda row: str(row.get("name") or ""))
    if tiered.match is not None:
        return [tiered.match]
    if tiered.ambiguous:
        return list(tiered.ambiguous)
    fuzzy: list[dict[str, Any]] = []
    for row in rows:
        name = normalize_spoken_name(str(row.get("name") or ""))
        if is_fuzzy_match(target, name) or any(
            is_fuzzy_match(target, word) for word in name.split(" ")
        ):
            fuzzy.append(row)
    return fuzzy


async def resolve_circle(ctx: ToolContext, args: ResolveCircleInput) -> ToolResult:
    try:
        rows = await _list_circle_rows(ctx)
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    matched = match_circles(rows, args.spoken_name)
    candidates = [CircleSummary.from_row(row) for row in matched]
    ctx.entities.offered_circle_ids = [circle.circle_id for circle in candidates]
    if not candidates:
        all_names = [str(row.get("name") or "") for row in rows[:SPOKEN_LIST_LIMIT]]
        facts = ["No circle matches that name."]
        if all_names:
            facts.append(f"Your circles are {join_names_for_speech(all_names)}.")
        else:
            facts.append("You're not in any circles yet.")
        return ResolveCircleResult(status="none", needs="repeat_name", spoken_facts=facts)
    if len(candidates) == 1:
        only = candidates[0]
        return ResolveCircleResult(
            status="single_likely",
            candidates=candidates,
            needs="confirmation",
            spoken_facts=[f"Did you mean {_circle_label(only.name)}?"],
        )
    names = join_names_for_speech([circle.name for circle in candidates[:SPOKEN_LIST_LIMIT]])
    return ResolveCircleResult(
        status="multiple",
        candidates=candidates,
        needs="disambiguation",
        spoken_facts=[f"I found {len(candidates)} circles: {names}. Which one?"],
    )


# -- confirm_circle ---------------------------------------------------------------


class ConfirmCircleInput(ToolInput):
    circle_id: str = Field(
        min_length=36,
        max_length=36,
        description="One of the ids offered by resolve_circle or list_circles.",
    )


class ConfirmCircleResult(ToolResult):
    status: Literal["confirmed"]
    circle: CircleSummary


async def confirm_circle(ctx: ToolContext, args: ConfirmCircleInput) -> ToolResult:
    if (
        args.circle_id not in ctx.entities.offered_circle_ids
        and args.circle_id != ctx.screen.active_circle_id
    ):
        return Rejected(
            reason_code="circle_not_offered",
            needs="disambiguation",
            spoken_facts=["That circle wasn't one of the options. Let me look it up again."],
        )
    service = _service(ctx)
    try:
        row = await asyncio.to_thread(
            service.get_circle, user_id=ctx.user_id, circle_id=args.circle_id
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    row = dict(row or {})
    circle = _remember(ctx, row)
    return ConfirmCircleResult(
        status="confirmed",
        circle=CircleSummary.from_row(row),
        spoken_facts=[f"Got it, {_circle_label(circle.name)}."],
    )


# -- get_circle_details -----------------------------------------------------------


class GetCircleDetailsInput(ToolInput):
    circle: CircleRef | None = Field(
        default=None,
        description=(
            "A circle id from list_circles, resolve_circle, or confirm_circle. Leave it out to "
            "read the circle whose screen the person is looking at."
        ),
    )


class GetCircleDetailsResult(ToolResult):
    status: Literal["ok"]
    circle: CircleDetails


async def get_circle_details(ctx: ToolContext, args: GetCircleDetailsInput) -> ToolResult:
    target = _target_circle_id(ctx, args.circle)
    if isinstance(target, Rejected):
        return target
    service = _service(ctx)
    try:
        row = dict(
            await asyncio.to_thread(
                service.get_circle_overview, user_id=ctx.user_id, circle_id=target
            )
            or {}
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    details = CircleDetails.from_overview(row)
    # An authorized read of one circle by id is an unambiguous canonical
    # record, so "rename it" can follow without a resolve/confirm round trip.
    _remember(ctx, row)
    if details.circle_id not in ctx.entities.offered_circle_ids:
        ctx.entities.offered_circle_ids = [details.circle_id]
    return GetCircleDetailsResult(status="ok", circle=details, spoken_facts=details.spoken())


# -- list_circle_members ----------------------------------------------------------


class ListCircleMembersInput(ToolInput):
    circle: CircleRef | None = Field(
        default=None,
        description=(
            "A circle id from list_circles, resolve_circle, or confirm_circle. Leave it out to "
            "read the circle whose screen the person is looking at."
        ),
    )
    query: str | None = Field(
        default=None,
        max_length=120,
        description="A name to look for in the roster. Suggestion only; never an id.",
    )
    page: int = Field(default=1, ge=1, le=50, description="Roster page, starting at 1.")


class ListCircleMembersResult(ToolResult):
    status: Literal["ok", "none"]
    circle_id: str
    circle_name: str
    members: list[CircleMember] = Field(default_factory=list)
    page: int = 1
    has_more: bool = False
    total_count: int = 0


def _spoken_members(members: list[CircleMember]) -> str:
    names = [("you" if member.is_self else member.display_name) for member in members]
    # "you" reads best last.
    names.sort(key=lambda name: name == "you")
    # ``spoken_name_resolver`` is an un-followed module; pin its str contract.
    spoken: str = join_names_for_speech(names)
    return spoken


async def list_circle_members(ctx: ToolContext, args: ListCircleMembersInput) -> ToolResult:
    target = _target_circle_id(ctx, args.circle)
    if isinstance(target, Rejected):
        return target
    service = _service(ctx)
    circle = ctx.entities.circle(target)
    try:
        if circle is None:
            row = dict(
                await asyncio.to_thread(
                    service.get_circle_overview, user_id=ctx.user_id, circle_id=target
                )
                or {}
            )
            circle = _remember(ctx, row)
        page = dict(
            await asyncio.to_thread(
                service.list_circle_members_page,
                user_id=ctx.user_id,
                circle_id=target,
                query=str(args.query or ""),
                page=args.page,
                limit=MEMBERS_PAGE_LIMIT,
            )
            or {}
        )
    except _SERVICE_ERRORS as exc:
        # A failed read is a refusal, never an empty roster.
        return _rejected(exc)
    members = [
        CircleMember.from_row(dict(item), viewer_user_id=ctx.user_id)
        for item in (page.get("items") or [])
    ]
    total = int(page.get("totalCount") or 0)
    has_more = bool(page.get("hasMore"))
    label = _circle_label(circle.name)
    # Every member here came from the authorized roster; any of them (but not
    # the person themself) may be confirmed next, as a member of THIS circle.
    ctx.entities.offer_people(
        [member.user_id for member in members if not member.is_self], circle_id=target
    )
    base: dict[str, Any] = {
        "circle_id": target,
        "circle_name": circle.name,
        "page": int(page.get("page") or args.page),
        "has_more": has_more,
        "total_count": total,
    }
    if not members:
        fact = (
            f"Nobody in {label} matches that name."
            if args.query
            else f"There's nobody on page {args.page} of {label}."
            if args.page > 1
            else f"{label[0].upper()}{label[1:]} has no members yet."
        )
        return ListCircleMembersResult(status="none", **base, spoken_facts=[fact])
    spoken = _spoken_members(members[:SPOKEN_LIST_LIMIT])
    extra = len(members) - min(len(members), SPOKEN_LIST_LIMIT)
    if args.query:
        facts = [f"In {label}, I found {spoken}."]
    elif has_more or args.page > 1:
        # "the first 20" and "20 members" are different claims; keep both.
        facts = [
            f"{label[0].upper()}{label[1:]} has {total} members. "
            f"Page {base['page']} has {spoken}" + (f", and {extra} more" if extra > 0 else "") + "."
        ]
        if has_more:
            facts.append("There are more on the next page.")
    else:
        count = f"{total} member{'s' if total != 1 else ''}"
        facts = [
            f"{label[0].upper()}{label[1:]} has {count}: {spoken}"
            + (f", and {extra} more" if extra > 0 else "")
            + "."
        ]
    return ListCircleMembersResult(status="ok", members=members, **base, spoken_facts=facts)


# -- create_circle ----------------------------------------------------------------


class CreateCircleInput(ToolInput):
    name: str = Field(min_length=1, max_length=80, description="The circle's name.")
    kind: CircleKind = Field(default="other")


class CreateCircleResult(ToolResult):
    status: Literal["created", "already_exists"]
    circle: CircleSummary


def _owned_circle_named(rows: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    wanted = normalize_spoken_name(name)
    for row in rows:
        if str(row.get("role") or "") != "owner":
            continue
        if normalize_spoken_name(str(row.get("name") or "")) == wanted:
            return row
    return None


async def create_circle(ctx: ToolContext, args: CreateCircleInput) -> ToolResult:
    service = _service(ctx)
    try:
        existing = _owned_circle_named(await _list_circle_rows(ctx), args.name)
        if existing is not None:
            circle = _remember(ctx, existing)
            return CreateCircleResult(
                status="already_exists",
                circle=CircleSummary.from_row(existing),
                spoken_facts=[f"You already have a circle called {circle.name}."],
            )
        row = await asyncio.to_thread(
            service.create_circle, owner_user_id=ctx.user_id, name=args.name, kind=args.kind
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    row = dict(row or {})
    circle = _remember(ctx, row)
    return CreateCircleResult(
        status="created",
        circle=CircleSummary.from_row(row),
        spoken_facts=[f"Created {_circle_label(circle.name)}."],
    )


def summarize_create_circle(ctx: ToolContext, args: CreateCircleInput) -> str:
    if args.kind == "other":
        return f"create a circle called {args.name}"
    return f"create a {args.kind} circle called {args.name}"


# -- rename_circle ----------------------------------------------------------------


class RenameCircleInput(ToolInput):
    circle: CircleRef
    name: str = Field(min_length=1, max_length=80, description="The new name.")


class RenameCircleResult(ToolResult):
    status: Literal["renamed"]
    circle: CircleSummary
    previous_name: str


async def rename_circle(ctx: ToolContext, args: RenameCircleInput) -> ToolResult:
    previous = _circle_name(ctx, args.circle.circle_id)
    service = _service(ctx)
    try:
        row = await asyncio.to_thread(
            service.update_circle,
            owner_user_id=ctx.user_id,
            circle_id=args.circle.circle_id,
            name=args.name,
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    row = dict(row or {})
    circle = _remember(ctx, row)
    return RenameCircleResult(
        status="renamed",
        circle=CircleSummary.from_row(row),
        previous_name=previous,
        spoken_facts=[f"Renamed {_circle_label(previous)} to {circle.name}."],
    )


def summarize_rename_circle(ctx: ToolContext, args: RenameCircleInput) -> str:
    return f"rename {_circle_label(_circle_name(ctx, args.circle.circle_id))} to {args.name}"


# -- delete_circle ----------------------------------------------------------------


class DeleteCircleInput(ToolInput):
    circle: CircleRef


class DeleteCircleResult(ToolResult):
    status: Literal["deleted"]
    circle_id: str
    name: str


async def delete_circle(ctx: ToolContext, args: DeleteCircleInput) -> ToolResult:
    name = _circle_name(ctx, args.circle.circle_id)
    service = _service(ctx)
    try:
        await asyncio.to_thread(
            service.delete_circle, owner_user_id=ctx.user_id, circle_id=args.circle.circle_id
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    _forget(ctx, args.circle.circle_id)
    return DeleteCircleResult(
        status="deleted",
        circle_id=args.circle.circle_id,
        name=name,
        spoken_facts=[f"Deleted {_circle_label(name)}."],
    )


def summarize_delete_circle(ctx: ToolContext, args: DeleteCircleInput) -> str:
    return f"delete {_circle_label(_circle_name(ctx, args.circle.circle_id))}"


# -- add_circle_member ------------------------------------------------------------


class AddCircleMemberInput(ToolInput):
    circle: CircleRef
    person: PersonRef


AddMemberStatus = Literal[
    "added",
    "invite_pending",
    "already_member",
    "not_connected",
    "connection_pending_outgoing",
    "connection_pending_incoming",
    "not_eligible",
]


class AddCircleMemberResult(ToolResult):
    status: AddMemberStatus
    circle_id: str
    user_id: str
    # The relationship the decision was made on, re-read at execution time.
    relationship: str | None = None


async def add_circle_member(ctx: ToolContext, args: AddCircleMemberInput) -> ToolResult:
    """Add one confirmed connection to one confirmed circle.

    Decision order, every branch on a fresh read: already a member -> report
    it; an eligible direct connection -> the service's direct add; otherwise
    say exactly which prerequisite is missing (a pending request either way,
    a legacy circle invitation, or no connection at all). Nothing here sends
    a connection request: that is its own action with its own confirmation.
    """
    circle_id = args.circle.circle_id
    user_id = args.person.user_id
    person_name = _person_name(ctx, user_id)
    circle_label = _circle_label(_circle_name(ctx, circle_id))
    service = _service(ctx)
    base: dict[str, Any] = {"circle_id": circle_id, "user_id": user_id}

    def already() -> AddCircleMemberResult:
        return AddCircleMemberResult(
            status="already_member",
            **base,
            spoken_facts=[f"{person_name} is already in {circle_label}."],
        )

    try:
        circle_row = dict(
            await asyncio.to_thread(service.get_circle, user_id=ctx.user_id, circle_id=circle_id)
            or {}
        )
        member_ids = {str(row.get("userId") or "") for row in (circle_row.get("members") or [])}
        if user_id in member_ids:
            return already()
        eligible = await asyncio.to_thread(
            service.list_eligible_direct_connections, actor_user_id=ctx.user_id, circle_id=circle_id
        )
        eligible_ids = {str(row.get("userId") or "") for row in (eligible or [])}
        if user_id not in eligible_ids:
            outgoing = await asyncio.to_thread(
                service.list_member_invites,
                user_id=ctx.user_id,
                circle_id=circle_id,
                direction="outgoing",
            )
            for invite in outgoing or []:
                if (
                    str(invite.get("inviteeUserId") or "") == user_id
                    and invite.get("status") == "pending"
                ):
                    return AddCircleMemberResult(
                        status="invite_pending",
                        **base,
                        spoken_facts=[
                            f"{person_name} already has a pending invitation to {circle_label}. "
                            "It's pending until they accept."
                        ],
                    )
            relationship = await _fresh_relationship(ctx, user_id)
            if relationship == "pending_outgoing":
                return AddCircleMemberResult(
                    status="connection_pending_outgoing",
                    relationship=relationship,
                    **base,
                    spoken_facts=[
                        f"Your connection request to {person_name} is still pending. "
                        f"They can be added to {circle_label} once they accept."
                    ],
                )
            if relationship == "pending_incoming":
                return AddCircleMemberResult(
                    status="connection_pending_incoming",
                    relationship=relationship,
                    **base,
                    spoken_facts=[
                        f"{person_name} has asked to connect with you. "
                        f"Accept their request first, then they can be added to {circle_label}."
                    ],
                )
            if relationship == "connected":
                return AddCircleMemberResult(
                    status="not_eligible",
                    relationship=relationship,
                    **base,
                    spoken_facts=[
                        f"{person_name} is connected with you, but can't be added to "
                        f"{circle_label} right now."
                    ],
                )
            return AddCircleMemberResult(
                status="not_connected",
                relationship=relationship,
                **base,
                needs="invite",
                spoken_facts=[
                    f"You aren't connected with {person_name} yet, so they can't be added to "
                    f"{circle_label}. Send them a connection request, or share the circle's "
                    "join link."
                ],
            )
        result = await asyncio.to_thread(
            service.create_member_invites,
            actor_user_id=ctx.user_id,
            circle_id=circle_id,
            invitee_user_ids=[user_id],
        )
    except _SERVICE_ERRORS as exc:
        if getattr(exc, "code", "") == "LOCATION_CIRCLE_ALREADY_MEMBER":
            return already()
        if getattr(exc, "code", "") == "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED":
            return AddCircleMemberResult(
                status="not_connected",
                **base,
                needs="invite",
                reason_code=str(exc.code),
                spoken_facts=[str(exc.message)],
            )
        return _rejected(exc)
    result = dict(result or {})
    if user_id in {str(item) for item in (result.get("addedUserIds") or [])}:
        await _refresh_remembered(ctx, circle_id)
        return AddCircleMemberResult(
            status="added",
            relationship="connected",
            **base,
            spoken_facts=[f"Added {person_name} to {circle_label}."],
        )
    for invite in result.get("invites") or []:
        if str(invite.get("inviteeUserId") or "") == user_id and invite.get("status") == "pending":
            return AddCircleMemberResult(
                status="invite_pending",
                **base,
                spoken_facts=[
                    f"Invited {person_name} to {circle_label}. It's pending until they accept."
                ],
            )
    skipped = dict(result.get("skippedReasons") or {})
    if skipped.get(user_id) == "already_member":
        return already()
    return Rejected(
        reason_code=str(skipped.get(user_id) or "not_added"),
        spoken_facts=[f"{person_name} wasn't added to {circle_label}."],
    )


def summarize_add_circle_member(ctx: ToolContext, args: AddCircleMemberInput) -> str:
    return (
        f"add {_person_name(ctx, args.person.user_id)} to "
        f"{_circle_label(_circle_name(ctx, args.circle.circle_id))}"
    )


# -- remove_circle_member ---------------------------------------------------------


class RemoveCircleMemberInput(ToolInput):
    circle: CircleRef
    person: PersonRef


class RemoveCircleMemberResult(ToolResult):
    status: Literal["removed"]
    circle_id: str
    user_id: str


async def remove_circle_member(ctx: ToolContext, args: RemoveCircleMemberInput) -> ToolResult:
    person_name = _person_name(ctx, args.person.user_id)
    circle_label = _circle_label(_circle_name(ctx, args.circle.circle_id))
    service = _service(ctx)
    try:
        await asyncio.to_thread(
            service.remove_member,
            owner_user_id=ctx.user_id,
            circle_id=args.circle.circle_id,
            member_user_id=args.person.user_id,
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    await _refresh_remembered(ctx, args.circle.circle_id)
    if args.person.user_id in ctx.entities.offered_person_ids:
        # They are no longer a roster candidate for this circle.
        ctx.entities.offer_people(
            [uid for uid in ctx.entities.offered_person_ids if uid != args.person.user_id],
            circle_id=ctx.entities.offered_person_circle_id,
        )
    return RemoveCircleMemberResult(
        status="removed",
        circle_id=args.circle.circle_id,
        user_id=args.person.user_id,
        spoken_facts=[f"Removed {person_name} from {circle_label}."],
    )


def summarize_remove_circle_member(ctx: ToolContext, args: RemoveCircleMemberInput) -> str:
    return (
        f"remove {_person_name(ctx, args.person.user_id)} from "
        f"{_circle_label(_circle_name(ctx, args.circle.circle_id))}"
    )


# -- leave_circle -----------------------------------------------------------------


class LeaveCircleInput(ToolInput):
    circle: CircleRef


class LeaveCircleResult(ToolResult):
    status: Literal["left"]
    circle_id: str
    name: str


async def leave_circle(ctx: ToolContext, args: LeaveCircleInput) -> ToolResult:
    name = _circle_name(ctx, args.circle.circle_id)
    service = _service(ctx)
    try:
        await asyncio.to_thread(
            service.leave_circle, user_id=ctx.user_id, circle_id=args.circle.circle_id
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    _forget(ctx, args.circle.circle_id)
    return LeaveCircleResult(
        status="left",
        circle_id=args.circle.circle_id,
        name=name,
        spoken_facts=[f"You left {_circle_label(name)}."],
    )


def summarize_leave_circle(ctx: ToolContext, args: LeaveCircleInput) -> str:
    return f"leave {_circle_label(_circle_name(ctx, args.circle.circle_id))}"


# -- list_circle_invites ----------------------------------------------------------


class ListCircleInvitesInput(ToolInput):
    direction: Literal["incoming", "outgoing", "all"] = Field(default="all")


class ListCircleInvitesResult(ToolResult):
    status: Literal["ok", "none"]
    invites: list[CircleInvite] = Field(default_factory=list)


def _invite_sentence(invite: CircleInvite) -> str:
    label = _circle_label(invite.circle_name)
    if invite.direction == "incoming":
        return f"{invite.inviter_name} invited you to {label}; it's {invite.status}."
    return f"Your invitation for {invite.invitee_name} to {label} is {invite.status}."


async def list_circle_invites(ctx: ToolContext, args: ListCircleInvitesInput) -> ToolResult:
    service = _service(ctx)
    directions: list[Literal["incoming", "outgoing"]] = (
        ["incoming", "outgoing"] if args.direction == "all" else [args.direction]
    )
    invites: list[CircleInvite] = []
    try:
        for direction in directions:
            rows = await asyncio.to_thread(
                service.list_member_invites, user_id=ctx.user_id, direction=direction
            )
            invites.extend(CircleInvite.from_row(dict(row), direction) for row in (rows or []))
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    if not invites:
        what = {
            "incoming": "No circle invitations are waiting for you.",
            "outgoing": "You have no circle invitations out.",
            "all": "There are no circle invitations either way.",
        }[args.direction]
        return ListCircleInvitesResult(status="none", spoken_facts=[what])
    facts = [_invite_sentence(invite) for invite in invites[:SPOKEN_LIST_LIMIT]]
    extra = len(invites) - len(facts)
    if extra > 0:
        facts.append(f"And {extra} more.")
    return ListCircleInvitesResult(status="ok", invites=invites, spoken_facts=facts)


# -- respond_circle_invite --------------------------------------------------------


class RespondCircleInviteInput(ToolInput):
    invite_id: str = Field(
        min_length=36, max_length=36, description="Invite id from list_circle_invites."
    )
    accept: bool = Field(description="True to accept, false to decline.")


class RespondCircleInviteResult(ToolResult):
    status: Literal["accepted", "declined", "already_responded"]
    invite_id: str
    circle_id: str | None = None
    circle_name: str | None = None
    invite_status: InviteStatus | None = None


async def respond_circle_invite(ctx: ToolContext, args: RespondCircleInviteInput) -> ToolResult:
    service = _service(ctx)
    try:
        if args.accept:
            result = dict(
                await asyncio.to_thread(
                    service.accept_member_invite, user_id=ctx.user_id, invite_id=args.invite_id
                )
                or {}
            )
        else:
            result = {
                "invite": dict(
                    await asyncio.to_thread(
                        service.decline_member_invite, user_id=ctx.user_id, invite_id=args.invite_id
                    )
                    or {}
                )
            }
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    invite = dict(result.get("invite") or {})
    invite_status = str(invite.get("status") or "")
    circle_row = dict(result.get("circle") or {})
    circle_name = str(circle_row.get("name") or invite.get("circleName") or "")
    circle_id = str(circle_row.get("id") or invite.get("circleId") or "") or None
    base: dict[str, Any] = {
        "invite_id": args.invite_id,
        "circle_id": circle_id,
        "circle_name": circle_name or None,
        "invite_status": invite_status or None,
    }
    if args.accept:
        if not result.get("accepted"):
            return RespondCircleInviteResult(
                status="already_responded",
                **base,
                spoken_facts=[
                    f"That invitation to {_circle_label(circle_name)} was already {invite_status or 'handled'}."
                ],
            )
        if circle_row:
            _remember(ctx, circle_row)
        return RespondCircleInviteResult(
            status="accepted",
            **base,
            spoken_facts=[f"You're in {_circle_label(circle_name)} now."],
        )
    if invite_status != "declined":
        return RespondCircleInviteResult(
            status="already_responded",
            **base,
            spoken_facts=[
                f"That invitation to {_circle_label(circle_name)} was already {invite_status or 'handled'}."
            ],
        )
    return RespondCircleInviteResult(
        status="declined",
        **base,
        spoken_facts=[f"Declined the invitation to {_circle_label(circle_name)}."],
    )


def summarize_respond_circle_invite(ctx: ToolContext, args: RespondCircleInviteInput) -> str:
    return "accept that circle invitation" if args.accept else "decline that circle invitation"


# -- cancel_circle_invite ---------------------------------------------------------


class CancelCircleInviteInput(ToolInput):
    invite_id: str = Field(
        min_length=36, max_length=36, description="Invite id from list_circle_invites."
    )


class CancelCircleInviteResult(ToolResult):
    status: Literal["cancelled", "already_cancelled"]
    invite_id: str
    circle_id: str | None = None
    circle_name: str | None = None
    invitee_name: str | None = None


async def cancel_circle_invite(ctx: ToolContext, args: CancelCircleInviteInput) -> ToolResult:
    service = _service(ctx)
    try:
        invite = dict(
            await asyncio.to_thread(
                service.get_member_invite, user_id=ctx.user_id, invite_id=args.invite_id
            )
            or {}
        )
        cancelled = await asyncio.to_thread(
            service.cancel_member_invite, actor_user_id=ctx.user_id, invite_id=args.invite_id
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    circle_name = str(invite.get("circleName") or "")
    invitee = str(invite.get("inviteeDisplayName") or "")
    base: dict[str, Any] = {
        "invite_id": args.invite_id,
        "circle_id": str(invite.get("circleId") or "") or None,
        "circle_name": circle_name or None,
        "invitee_name": invitee or None,
    }
    if not cancelled:
        return CancelCircleInviteResult(
            status="already_cancelled",
            **base,
            spoken_facts=[
                f"The invitation for {invitee} to {_circle_label(circle_name)} was already cancelled."
            ],
        )
    return CancelCircleInviteResult(
        status="cancelled",
        **base,
        spoken_facts=[f"Cancelled the invitation for {invitee} to {_circle_label(circle_name)}."],
    )


def summarize_cancel_circle_invite(ctx: ToolContext, args: CancelCircleInviteInput) -> str:
    return "cancel that circle invitation"


# -- create_circle_invite_link ----------------------------------------------------


class CreateCircleInviteLinkInput(ToolInput):
    circle: CircleRef


class ClientStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["open_share_sheet"]
    url: str
    code: str
    circle_name: str


class CreateCircleInviteLinkResult(ToolResult):
    status: Literal["link_ready"]
    needs: Literal["client_step"] = "client_step"
    circle_id: str
    code: str
    url: str
    expires_at: str | None = None
    client_step: ClientStep


async def create_circle_invite_link(
    ctx: ToolContext, args: CreateCircleInviteLinkInput
) -> ToolResult:
    name = _circle_name(ctx, args.circle.circle_id)
    service = _service(ctx)
    try:
        payload = dict(
            await asyncio.to_thread(
                service.create_invite_code,
                actor_user_id=ctx.user_id,
                circle_id=args.circle.circle_id,
            )
            or {}
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    code = str(payload.get("code") or "")
    if not code:
        return Rejected(
            reason_code="invite_code_unavailable",
            spoken_facts=[f"I couldn't get an invite code for {_circle_label(name)}."],
        )
    url = build_circle_join_url(code)
    return CreateCircleInviteLinkResult(
        status="link_ready",
        circle_id=args.circle.circle_id,
        code=code,
        url=url,
        expires_at=payload.get("expiresAt"),
        client_step=ClientStep(kind="open_share_sheet", url=url, code=code, circle_name=name),
        spoken_facts=[
            f"The invite link for {_circle_label(name)} is ready. I'm opening the share sheet."
        ],
    )


def summarize_create_circle_invite_link(ctx: ToolContext, args: CreateCircleInviteLinkInput) -> str:
    return f"create an invite link for {_circle_label(_circle_name(ctx, args.circle.circle_id))}"


# -- catalog --------------------------------------------------------------------------


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="list_circles",
        gateway_action_id="location.open_circles",
        policy=ToolPolicy.read,
        input_model=ListCirclesInput,
        output_model=ListCirclesResult,
        description=(
            "List the circles the person belongs to, with each circle's canonical id, name, "
            "kind, member count, and whether they own it. Read only. Use it before any circle "
            "action when you do not yet have a confirmed circle id."
        ),
        handler=list_circles,
    ),
    ToolSpec(
        name="resolve_circle",
        gateway_action_id="location.open_circles",
        policy=ToolPolicy.read,
        input_model=ResolveCircleInput,
        output_model=ResolveCircleResult,
        description=(
            "Find which of the person's circles a spoken name refers to. Returns candidate "
            "circles (single_likely, multiple, or none) and never confirms one on its own: read "
            "the candidate's name back and call confirm_circle with its id once the person agrees."
        ),
        handler=resolve_circle,
    ),
    ToolSpec(
        name="confirm_circle",
        gateway_action_id="location.open_circles",
        policy=ToolPolicy.read,
        input_model=ConfirmCircleInput,
        output_model=ConfirmCircleResult,
        description=(
            "Confirm the circle the person meant. Only accepts an id offered by the most recent "
            "resolve_circle or list_circles call. Required before any circle mutation."
        ),
        handler=confirm_circle,
    ),
    ToolSpec(
        name="get_circle_details",
        gateway_action_id="location.open_circles",
        policy=ToolPolicy.read,
        input_model=GetCircleDetailsInput,
        output_model=GetCircleDetailsResult,
        description=(
            "Read one circle's current name, kind, member count, whether the person owns it, "
            "and what they can do with it (add members, rename, delete, leave). Read only. With "
            "no circle argument it reads the circle whose screen is open, so it answers 'this "
            "circle'. Use it to answer who manages a circle or what kind it is."
        ),
        handler=get_circle_details,
    ),
    ToolSpec(
        name="list_circle_members",
        gateway_action_id="location.open_circles",
        policy=ToolPolicy.read,
        input_model=ListCircleMembersInput,
        output_model=ListCircleMembersResult,
        description=(
            "Read who is in a circle: one page of members with each one's canonical id, real "
            "name, role, and relationship to the person. Read only. With no circle argument it "
            "reads the circle whose screen is open. Use it for 'who is in this group' and to "
            "find the member to remove: someone can be in a circle without being a connection, "
            "so remove_circle_member needs a member from here confirmed with confirm_person. "
            "The result says whether more pages follow; the total is the total, not the page."
        ),
        handler=list_circle_members,
    ),
    ToolSpec(
        name="create_circle",
        gateway_action_id="location.create_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=CreateCircleInput,
        output_model=CreateCircleResult,
        description=(
            "Create an empty circle with the given name (kind family, friends, or other). "
            "Creating a circle sends no invitations and shares no location; adding people is a "
            "separate action. Reports already_exists when the person already owns one by that name."
        ),
        handler=create_circle,
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_create_circle,
    ),
    ToolSpec(
        name="rename_circle",
        gateway_action_id="location.rename_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=RenameCircleInput,
        output_model=RenameCircleResult,
        description=(
            "Rename a circle the person owns. Changes only the name: members, kind, sharing, and "
            "ownership stay as they are. Takes a confirmed circle id, never a spoken name."
        ),
        handler=rename_circle,
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_rename_circle,
    ),
    ToolSpec(
        name="delete_circle",
        gateway_action_id="location.delete_circle",
        policy=ToolPolicy.confirm_tap,
        input_model=DeleteCircleInput,
        output_model=DeleteCircleResult,
        description=(
            "Permanently delete a circle the person owns. Every member loses the sharing that "
            "circle provided and it cannot be undone, so it needs a tap on the confirmation card."
        ),
        handler=delete_circle,
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_delete_circle,
    ),
    ToolSpec(
        name="add_circle_member",
        gateway_action_id="location.add_to_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=AddCircleMemberInput,
        output_model=AddCircleMemberResult,
        description=(
            "Add a confirmed person to a confirmed circle. Only an existing connection can be "
            "added; the result says exactly what happened: added, already_member, invite_pending, "
            "connection_pending_outgoing (your request to them is waiting), "
            "connection_pending_incoming (their request to you is waiting), not_eligible, or "
            "not_connected. It never sends a connection request: that is invite_person, and only "
            "if the person asks. Both arguments are canonical ids, never names."
        ),
        handler=add_circle_member,
        person_args=("person",),
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_add_circle_member,
    ),
    ToolSpec(
        name="remove_circle_member",
        gateway_action_id="location.remove_from_circle",
        policy=ToolPolicy.confirm_tap,
        input_model=RemoveCircleMemberInput,
        output_model=RemoveCircleMemberResult,
        description=(
            "Remove a confirmed person from a circle the person owns. Only that circle membership "
            "ends: it does not disconnect from them (remove_connection) and does not delete the "
            "circle. Revokes what that circle shared with them, so it needs a tap on the "
            "confirmation card."
        ),
        handler=remove_circle_member,
        person_args=("person",),
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_remove_circle_member,
    ),
    ToolSpec(
        name="leave_circle",
        gateway_action_id="location.leave_circle",
        policy=ToolPolicy.confirm_tap,
        input_model=LeaveCircleInput,
        output_model=LeaveCircleResult,
        description=(
            "Leave a circle the person is a member of but does not own: only their own "
            "membership ends, the circle stays for everyone else (that is not delete_circle). "
            "Ends the sharing that circle gave them, so it needs a tap on the confirmation card."
        ),
        handler=leave_circle,
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_leave_circle,
    ),
    ToolSpec(
        name="list_circle_invites",
        gateway_action_id="location.open_needs_review",
        policy=ToolPolicy.read,
        input_model=ListCircleInvitesInput,
        output_model=ListCircleInvitesResult,
        description=(
            "List circle invitations: incoming (waiting for the person to accept or decline), "
            "outgoing (sent by them or into circles they own), or all. Each invite carries its id "
            "and real status (pending, accepted, declined, cancelled, expired). Read only."
        ),
        handler=list_circle_invites,
    ),
    ToolSpec(
        name="respond_circle_invite",
        gateway_action_id="location.accept_circle_invite",
        policy=ToolPolicy.confirm_voice,
        input_model=RespondCircleInviteInput,
        output_model=RespondCircleInviteResult,
        description=(
            "Accept or decline an incoming circle invitation by its id from list_circle_invites. "
            "Accepting joins the circle; declining closes the invitation."
        ),
        handler=respond_circle_invite,
        ui_refresh=REFRESH_INVITES,
        summarize=summarize_respond_circle_invite,
    ),
    ToolSpec(
        name="cancel_circle_invite",
        gateway_action_id="location.decline_circle_invite",
        policy=ToolPolicy.confirm_voice,
        input_model=CancelCircleInviteInput,
        output_model=CancelCircleInviteResult,
        description=(
            "Cancel an outgoing circle invitation the person sent (or one into a circle they own), "
            "by its id from list_circle_invites."
        ),
        handler=cancel_circle_invite,
        ui_refresh=REFRESH_INVITES,
        summarize=summarize_cancel_circle_invite,
    ),
    ToolSpec(
        name="create_circle_invite_link",
        gateway_action_id="location.open_join_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=CreateCircleInviteLinkInput,
        output_model=CreateCircleInviteLinkResult,
        description=(
            "Get a shareable join link for a circle the person owns and open the share sheet with it. "
            "This is the only way to invite someone who is not yet connected with the person: "
            "add_circle_member only works for existing eligible connections. Anyone who opens the "
            "link can join the circle. System circles have no link."
        ),
        handler=create_circle_invite_link,
        circle_args=("circle",),
        summarize=summarize_create_circle_invite_link,
    ),
)

__all__ = ["MEMBERS_PAGE_LIMIT", "TOOLS", "build_circle_join_url", "match_circles"]
