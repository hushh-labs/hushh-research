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
import hashlib
import logging
import os
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from hushh_mcp.one_voice.tools.base import (
    CircleRef,
    ConfirmedCircle,
    EntityContext,
    Needs,
    PersonRef,
    Prepared,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    Unsupported,
    now_iso,
)
from hushh_mcp.one_voice.tools.name_parts import NamePart, render_name_input, spelled_part_words
from hushh_mcp.one_voice.tools.people import ServiceError as PeopleServiceError
from hushh_mcp.one_voice.tools.people import load_people_snapshot
from hushh_mcp.one_voice.tools.spelling import (
    clean_spelled_word,
    missing_spelled_words,
    name_word_changes,
    name_word_slots,
    spell_out,
    spelling_key,
    unique_spelled_words,
    word_key,
    word_keys,
)
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

logger = logging.getLogger(__name__)

CIRCLE_SERVICE = "circles"
# A proposed name dropped a word the person spelled letter by letter.
SPELLED_WORD_MISSING = "spelled_word_missing"
# A correction changed a word of the name under review that it did not declare.
NAME_CHANGED = "name_changed"
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


async def _relationships(ctx: ToolContext, user_ids: Sequence[str]) -> dict[str, str]:
    """Each person's current relationship to the viewer, from one people read.

    One read for the whole audience, not one per person: ``load_people_snapshot``
    costs four service calls, so asking it per person would cost four times the
    audience inside a confirmation card's lifetime. Reading once also means every
    person in a batch is judged against the same moment rather than a sequence
    that can drift between them.

    Falls back to what was true when each person was confirmed if the people
    plane is unavailable, and says ``none`` only when nothing is known.
    """
    ids = list(dict.fromkeys(user_ids))
    if not ids:
        return {}
    try:
        snapshot = await load_people_snapshot(ctx)
    except PeopleServiceError:
        remembered: dict[str, str] = {}
        for user_id in ids:
            person = ctx.entities.person(user_id)
            remembered[user_id] = person.relationship if person is not None else "none"
        return remembered
    resolved: dict[str, str] = {}
    for user_id in ids:
        record = snapshot.people.get(user_id)
        resolved[user_id] = (
            str(record.get("relationship") or "none") if record is not None else "none"
        )
    return resolved


async def _fresh_relationship(ctx: ToolContext, user_id: str) -> str:
    """One person's current relationship to the viewer, re-read now.

    Delegates to the batch read so adding one person and adding several cannot
    answer this question differently.
    """
    return (await _relationships(ctx, [user_id])).get(user_id, "none")


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


# At most this many spelled words per call. A bound on the list only: Vertex
# Live refuses a schema with length bounds on array items.
MAX_SPELLED_WORDS_PER_CALL = 4
# At most this many changed words per call; a bound on the list only, as above.
MAX_CHANGED_WORDS_PER_CALL = 8
# A changed word longer than a whole circle name is not a word of one. Checked
# by the validator, never declared in the schema (see above).
MAX_CHANGED_WORD_LENGTH = 80


class ChangedWord(BaseModel):
    """One word a correction changes: ``old`` as on the waiting card, ``new`` as
    it becomes. An empty ``old`` is an added word, an empty ``new`` a removed one."""

    model_config = ConfigDict(extra="forbid")
    old: str = ""
    new: str = ""

    @field_validator("old", "new")
    @classmethod
    def _bounded(cls, value: str) -> str:
        if len(value) > MAX_CHANGED_WORD_LENGTH:
            raise ValueError("a changed word is at most 80 characters")
        return value


class CreateCircleInput(ToolInput):
    name_parts: list[NamePart] = Field(
        default_factory=list,
        min_length=1,
        max_length=16,
        exclude=True,
        description=(
            "Spelled name: ordered parts, including spaces and untouched words. Omit name."
        ),
    )
    name: str = Field(
        default="",
        validate_default=True,
        min_length=1,
        max_length=80,
        description="The circle's complete name. Omit when supplying name_parts.",
    )
    kind: CircleKind = Field(default="other")
    spelled_words: list[str] = Field(
        default_factory=list,
        validate_default=True,
        max_length=MAX_SPELLED_WORDS_PER_CALL,
        description=(
            "Legacy spelled words (k a y r a -> KAYRA). name_parts retains these automatically."
        ),
    )
    release_spelled_words: list[str] = Field(
        default_factory=list,
        max_length=MAX_SPELLED_WORDS_PER_CALL,
        description=(
            "Earlier spelled words explicitly changed/dropped; release all for a different circle."
        ),
    )
    changed_words: list[ChangedWord] = Field(
        default_factory=list,
        max_length=MAX_CHANGED_WORDS_PER_CALL,
        description=(
            "Unspelled corrections, even after cancel: old as reviewed (empty for addition), "
            "new as proposed (empty for removal). Keep every undeclared word."
        ),
    )

    @field_validator("name", mode="before")
    @classmethod
    def _render_name(cls, value: Any, info: ValidationInfo) -> str:
        return render_name_input(value, info.data.get("name_parts") or None)

    @field_validator("spelled_words", mode="before")
    @classmethod
    def _retain_parts(cls, value: Any, info: ValidationInfo) -> Any:
        if not isinstance(value, list):
            return value
        return [*value, *spelled_part_words(info.data.get("name_parts"))]

    @field_validator("spelled_words", "release_spelled_words")
    @classmethod
    def _one_word_each(cls, value: list[str]) -> list[str]:
        words: list[str] = []
        for item in value:
            word = clean_spelled_word(item)
            if word is None:
                raise ValueError("each spelled word is one word of letters and digits")
            words.append(word)
        return words


class CreateCircleResult(ToolResult):
    status: Literal["created", "already_exists"]
    circle: CircleSummary


def _spelling_now() -> float:
    """Epoch seconds on the entity context's own clock, which ``prune`` uses too."""
    return EntityContext._now().timestamp()


def _spelled_word_facts(missing: Sequence[str], declared: Sequence[str]) -> list[str]:
    """One question per missing word, phrased by where the word came from.

    A word this proposal declared itself was spelled for this name. A word kept
    from earlier may belong to a different circle, so the question offers that
    reading too and the model can release it in the same turn.
    """
    declared_keys = {spelling_key(word) for word in declared}
    return [
        f"You spelled {word} as {spell_out(word)}, but this name doesn't include it. "
        f"Should the name use {word}?"
        if spelling_key(word) in declared_keys
        else f"Earlier you spelled {word} as {spell_out(word)}. "
        f"Is this a different circle, or should the name keep {word}?"
        for word in missing
    ]


def _spelling_refused(
    missing: Sequence[str], declared: Sequence[str], *, retire_open_proposal: bool
) -> Rejected:
    logger.info("one_voice.spelling.refused missing=%d", len(missing))
    return Rejected(
        reason_code=SPELLED_WORD_MISSING,
        needs="repeat_name",
        spoken_facts=_spelled_word_facts(missing, declared),
        retire_open_proposal=retire_open_proposal,
    )


def _change_phrase(dropped: Sequence[str], put: Sequence[str]) -> str:
    old, new = " ".join(dropped), " ".join(put)
    if dropped and put:
        return f'change "{old}" to "{new}"'
    if dropped:
        return f'drop "{old}"'
    return f'add "{new}"'


def _name_changed(fact: str, *, slots: int, order: str) -> Rejected:
    # Counts and a short enum only: never a word of either name.
    logger.info("one_voice.name_lineage.refused slots=%d order=%s", slots, order)
    return Rejected(
        reason_code=NAME_CHANGED,
        needs="repeat_name",
        spoken_facts=[fact],
        retire_open_proposal=True,
    )


def _declared_words(text: str, names: set[str]) -> list[str]:
    """The words one side of a declared change names, read against the name it
    describes: its words as written when each is a word of that name, else
    letters spelled one by one joined into one word, as in ``spelled_words``."""
    words = text.split()
    if words and all(word_key(word) in names for word in words):
        return words
    joined = clean_spelled_word(text)
    return [joined] if joined else words


@dataclass(frozen=True)
class _Declared:
    """The word keys a call declares changed, each word once.

    ``changed`` are old words a ``changed_words`` pair gives a new word for;
    ``dropped`` are old words declared with no new word, and the words in
    ``release_spelled_words`` (the person changed or dropped that spelled
    word); ``added`` are the pairs' new words.
    """

    changed: Counter[str]
    dropped: Counter[str]
    added: Counter[str]


def _declared_changes(
    args: CreateCircleInput, old_names: set[str], new_names: set[str]
) -> _Declared:
    """What this call declares. A ``changed_words`` pair naming the same words
    in the same order changed nothing and declares nothing."""
    changed: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    added: Counter[str] = Counter()
    for change in args.changed_words:
        old = [word_key(word) for word in _declared_words(change.old, old_names)]
        new = [word_key(word) for word in _declared_words(change.new, new_names)]
        if old == new:
            continue
        (changed if new else dropped).update(old)
        added.update(new)
    dropped.update(word_key(word) for word in args.release_spelled_words)
    return _Declared(changed=changed, dropped=dropped, added=added)


def _use(pool: Counter[str], key: str) -> bool:
    """Use up one ``key`` from ``pool``; False when none is left."""
    if pool[key] <= 0:
        return False
    pool[key] -= 1
    return True


def _corrects_circle_name(baseline: str, args: CreateCircleInput) -> bool:
    base_keys = set(word_keys(baseline))
    declared_old = {
        word_key(word)
        for change in args.changed_words
        for word in _declared_words(change.old, base_keys)
    }
    return bool(base_keys & set(word_keys(args.name)) or base_keys & declared_old)


def retained_creation_kind(ctx: ToolContext, args: CreateCircleInput) -> CircleKind | None:
    """Keep an omitted kind through a rejected correction's existing baseline.

    This is a default for related proposals only. An explicit kind is always
    the model's field, and an unrelated name uses the ordinary new-circle default.
    """
    name = ctx.entities.live_circle_name_baseline(_spelling_now())
    baseline = ctx.entities.circle_name_baseline
    if name is None or baseline is None or not _corrects_circle_name(name, args):
        return None
    return baseline.kind


def _name_lineage(
    baseline: str | None, args: CreateCircleInput
) -> tuple[Rejected | None, list[str]]:
    """Judge a proposal against the name under review. Never edits the name.

    Returns a refusal, or the words of the name under review the person
    changed on purpose, so a spelled one among them stops being kept.

    ``baseline`` is the name the last passing proposal showed the person. A
    proposal corrects it when they share a word or when a ``changed_words``
    old names one of its words; one that does neither is a different circle
    and is not compared. A correction passes when, in each stretch where the
    names differ, every word it adds is declared added or spelled in this call,
    and every word it removes is declared removed or replaced by one of those
    spelled words. Each declaration and each spelled word accounts for one
    word, once: a spelled word declared as a change's new word replaces only
    that change's old word, and a word declared removed (or released) with a
    spelled word in its stretch is one change, a respelling, so that spelled
    word replaces nothing else. A word that moved is removed in one stretch and
    added in another, so a move is declared like any other change. Which words
    changed is the spelling module's exact word comparison; whether the person
    asked for a change is only ever the model's declaration.
    """
    now_keys = set(word_keys(args.name))
    base_keys = set(word_keys(baseline)) if baseline is not None else set()
    released = [
        clean_spelled_word(word) or word
        for change in args.changed_words
        for word in _declared_words(change.old, base_keys)
        if word_key(word) not in now_keys
    ]
    if baseline is None:
        return None, released
    if not _corrects_circle_name(baseline, args):
        return None, released
    declared = _declared_changes(args, base_keys, now_keys)
    spelled = Counter(word_key(word) for word in args.spelled_words)
    slots = name_word_slots(baseline, args.name)
    undeclared: list[str] = []
    for dropped, put in slots:
        loose_new = [word for word in put if not _use(declared.added, word_key(word))]
        replacements = sum(1 for word in loose_new if _use(spelled, word_key(word)))
        loose_old: list[str] = []
        respelled = 0
        for word in dropped:
            key = word_key(word)
            if _use(declared.changed, key):
                continue
            if _use(declared.dropped, key):
                respelled += 1
                continue
            loose_old.append(word)
        # A declared removal with a spelled word in its stretch is that word
        # respelled: the spelled word covers it and nothing else.
        spare = max(0, replacements - respelled)
        if len(loose_new) > replacements or len(loose_old) > spare:
            undeclared.append(_change_phrase(dropped, put))
        else:
            released.extend(clean_spelled_word(word) or word for word in loose_old)
    if not undeclared:
        return None, released
    if not name_word_changes(baseline, args.name)[2]:
        return (
            _name_changed(
                f'This would put the words in a different order: "{args.name}". '
                "Is that what you want?",
                slots=len(undeclared),
                order="moved",
            ),
            [],
        )
    lead = "This would also" if len(undeclared) < len(slots) else "This would"
    return (
        _name_changed(
            f"{lead} {join_names_for_speech(undeclared)}. Is that what you want?",
            slots=len(undeclared),
            order="kept",
        ),
        [],
    )


def _owned_circle_named(rows: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    wanted = normalize_spoken_name(name)
    for row in rows:
        if str(row.get("role") or "") != "owner":
            continue
        if normalize_spoken_name(str(row.get("name") or "")) == wanted:
            return row
    return None


_SPELLING_ARGS = frozenset(
    {"name_parts", "spelled_words", "release_spelled_words", "changed_words"}
)


def _invalid_create_circle_correction(
    raw_args: dict[str, Any], failed: frozenset[str]
) -> Rejected | None:
    """The refusal for a correction whose spelling could not be read: ask for the
    spelled word again, not for a missing detail.

    The executor has already retired the card this proposal was correcting.
    Only which arguments failed validation is checked (their names, never their
    values); a failure anywhere else keeps the executor's generic refusal, which
    names the field. ``None`` keeps that refusal.
    """
    if not failed & _SPELLING_ARGS:
        return None
    return Rejected(
        reason_code="invalid_spelling",
        needs="repeat_name",
        spoken_facts=[
            "I couldn't read how that was spelled. Which word did they spell? "
            "Ask them to spell just that word."
        ],
    )


def _prepared_spelled_words(snapshot: dict[str, Any] | None) -> list[str]:
    raw = snapshot.get("spelled_words") if isinstance(snapshot, dict) else None
    if not isinstance(raw, list):
        return []
    return [word for word in raw if isinstance(word, str) and word]


async def create_circle(ctx: ToolContext, args: CreateCircleInput) -> ToolResult:
    # Defence in depth, checked again at execution: the words the card was
    # prepared with, plus every word the person has spelled since. A card from
    # before a word was spelled (or one reused as a duplicate) never ran that
    # check, so it is refused here and nothing is created.
    required = unique_spelled_words(
        [
            *_prepared_spelled_words(ctx.prepared),
            *ctx.entities.retained_spelled_words(_spelling_now()),
        ]
    )
    missing = missing_spelled_words(args.name, required)
    if missing:
        return _spelling_refused(missing, args.spelled_words, retire_open_proposal=False)
    service = _service(ctx)
    try:
        existing = _owned_circle_named(await _list_circle_rows(ctx), args.name)
        if existing is not None:
            circle = _remember(ctx, existing)
            ctx.entities.clear_spelled_words()
            ctx.entities.clear_circle_name_baseline()
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
    ctx.entities.clear_spelled_words()
    ctx.entities.clear_circle_name_baseline()
    return CreateCircleResult(
        status="created",
        circle=CircleSummary.from_row(row),
        spoken_facts=[f"Created {_circle_label(circle.name)}."],
    )


def summarize_create_circle(ctx: ToolContext, args: CreateCircleInput) -> str:
    if args.kind == "other":
        return f"create a circle called {args.name}"
    return f"create a {args.kind} circle called {args.name}"


async def prepare_create_circle(ctx: ToolContext, args: CreateCircleInput) -> Prepared | ToolResult:
    """Check the proposed name keeps every word the person spelled.

    Which words were spelled is the model's declaration (``spelled_words``),
    kept for the conversation so a correction or a re-proposal after a cancel
    cannot drop one silently; ``release_spelled_words`` is the model saying the
    person changed one. The host only compares the declared words with the
    model's own name text, exactly, and asks when one is missing. It never
    edits the name.

    The person's words are kept before any check, so a refused call still
    remembers how they spelled it. A proposal that passes renews every word it
    needed, so retention runs from the last proposal that used a word.

    Before the spelling check, a correction of the name under review (the last
    one that passed, kept the same 3 minutes and across a cancel) must declare
    every word it changes (see ``_name_lineage``), so an untouched word cannot
    change whether or not it was ever declared as spelled. Only a call that
    passes that check releases a spelled word, declared or respelled: a refused
    one leaves every word for the next proposal to keep. A proposal that passes
    becomes the name under review.

    A name the person typed (``ctx.typed_name``) is theirs as written: it
    releases every spelled word, skips both checks and the spelled read-back,
    and becomes the name under review.
    """
    now = _spelling_now()
    if ctx.typed_name:
        logger.info("one_voice.circle_name.typed")
        ctx.entities.clear_spelled_words()
        ctx.entities.set_circle_name_baseline(args.name, now, kind=args.kind)
        return Prepared(summary=summarize_create_circle(ctx, args), snapshot={"spelled_words": []})
    ctx.entities.remember_spelled_words(args.spelled_words, now)
    refused, released = _name_lineage(ctx.entities.live_circle_name_baseline(now), args)
    if refused is not None:
        return refused
    ctx.entities.release_spelled_words([*args.release_spelled_words, *released])
    retained = ctx.entities.retained_spelled_words(now)
    required = unique_spelled_words([*retained, *args.spelled_words])
    missing = missing_spelled_words(args.name, required)
    if missing:
        return _spelling_refused(missing, args.spelled_words, retire_open_proposal=True)
    ctx.entities.remember_spelled_words(required, now)
    ctx.entities.set_circle_name_baseline(args.name, now, kind=args.kind)
    summary = summarize_create_circle(ctx, args) + "".join(
        f", with {word} spelled {spell_out(word)}" for word in required
    )
    return Prepared(summary=summary, snapshot={"spelled_words": required})


# -- rename_circle ----------------------------------------------------------------


class RenameCircleInput(ToolInput):
    circle: CircleRef
    name: str = Field(
        min_length=1,
        max_length=80,
        description="The new name, exactly as the person said or spelled it.",
    )


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


# -- set_circle_kind --------------------------------------------------------------


class SetCircleKindInput(ToolInput):
    circle: CircleRef
    kind: CircleKind = Field(description="The circle's new type: family, friends, or other.")


class SetCircleKindResult(ToolResult):
    status: Literal["kind_changed", "already_kind"]
    circle: CircleSummary
    previous_kind: str


async def set_circle_kind(ctx: ToolContext, args: SetCircleKindInput) -> ToolResult:
    """Change only the circle's type. Bound to ``location.set_circle_kind``, its
    own gateway action: a kind change never rides a rename's approval, and the
    write passes ``name=None`` so the service's COALESCE leaves the name (and
    everything else) exactly as it is."""
    circle_id = args.circle.circle_id
    service = _service(ctx)
    try:
        current = dict(
            await asyncio.to_thread(
                service.get_circle_overview, user_id=ctx.user_id, circle_id=circle_id
            )
            or {}
        )
        previous = str(current.get("kind") or "other")
        if previous == args.kind:
            circle = _remember(ctx, current)
            return SetCircleKindResult(
                status="already_kind",
                circle=CircleSummary.from_row(current),
                previous_kind=previous,
                spoken_facts=[f"{circle.name} is already a {_kind_word(args.kind)}."],
            )
        row = dict(
            await asyncio.to_thread(
                service.update_circle,
                owner_user_id=ctx.user_id,
                circle_id=circle_id,
                name=None,
                kind=args.kind,
            )
            or {}
        )
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    circle = _remember(ctx, row)
    return SetCircleKindResult(
        status="kind_changed",
        circle=CircleSummary.from_row(row),
        previous_kind=previous,
        spoken_facts=[f"{circle.name} is now a {_kind_word(args.kind)}."],
    )


def _kind_word(kind: str) -> str:
    return "circle" if kind == "other" else f"{kind} circle"


def summarize_set_circle_kind(ctx: ToolContext, args: SetCircleKindInput) -> str:
    label = _circle_label(_circle_name(ctx, args.circle.circle_id))
    if args.kind == "other":
        return f"make {label} a plain circle, neither family nor friends"
    return f"make {label} a {args.kind} circle"


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


# Not a reported status: the one outcome that goes on to the write.
_ELIGIBLE = "eligible"


@dataclass(frozen=True)
class _MemberDecision:
    """What happens to one person, decided before anything is written.

    ``spoken`` is the sentence One says about this person. It is empty only for
    ``_ELIGIBLE``, where what gets said depends on how the write turns out.
    """

    user_id: str
    status: str
    spoken: str = ""
    relationship: str | None = None
    needs: Needs | None = None


def _decide_member(
    *,
    user_id: str,
    person_name: str,
    circle_label: str,
    is_member: bool,
    is_eligible: bool,
    has_pending_invite: bool,
    relationship: str | None,
) -> _MemberDecision:
    """One person's outcome and the sentence that explains it.

    Pure, and shared by the single-person and batch tools, so one question gets
    one answer and the sentences stay in one place. The order is the order the
    single-person handler established: membership, then addability, then the
    missing prerequisite -- most specific first, so "already in" is never
    reported as "not connected".
    """
    if is_member:
        return _MemberDecision(
            user_id, "already_member", f"{person_name} is already in {circle_label}."
        )
    if is_eligible:
        return _MemberDecision(user_id, _ELIGIBLE)
    if has_pending_invite:
        return _MemberDecision(
            user_id,
            "invite_pending",
            f"{person_name} already has a pending invitation to {circle_label}. "
            "It's pending until they accept.",
        )
    if relationship == "pending_outgoing":
        return _MemberDecision(
            user_id,
            "connection_pending_outgoing",
            f"Your connection request to {person_name} is still pending. "
            f"They can be added to {circle_label} once they accept.",
            relationship=relationship,
        )
    if relationship == "pending_incoming":
        return _MemberDecision(
            user_id,
            "connection_pending_incoming",
            f"{person_name} has asked to connect with you. "
            f"Accept their request first, then they can be added to {circle_label}.",
            relationship=relationship,
        )
    if relationship == "connected":
        return _MemberDecision(
            user_id,
            "not_eligible",
            f"{person_name} is connected with you, but can't be added to {circle_label} right now.",
            relationship=relationship,
        )
    return _MemberDecision(
        user_id,
        "not_connected",
        f"You aren't connected with {person_name} yet, so they can't be added to "
        f"{circle_label}. Send them a connection request, or share the circle's join link.",
        relationship=relationship,
        needs="invite",
    )


async def _circle_membership_state(
    ctx: ToolContext, service: Any, circle_id: str
) -> tuple[set[str], set[str]]:
    """Who is in the circle, and who may be added to it.

    Two reads per circle rather than per person, so one person and twenty cost
    the same. These are the only two needed when everybody named is addable.
    """
    circle_row = dict(
        await asyncio.to_thread(service.get_circle, user_id=ctx.user_id, circle_id=circle_id) or {}
    )
    member_ids = {str(row.get("userId") or "") for row in (circle_row.get("members") or [])}
    eligible = await asyncio.to_thread(
        service.list_eligible_direct_connections, actor_user_id=ctx.user_id, circle_id=circle_id
    )
    eligible_ids = {str(row.get("userId") or "") for row in (eligible or [])}
    return member_ids, eligible_ids


async def _pending_invitee_ids(ctx: ToolContext, service: Any, circle_id: str) -> set[str]:
    """Who already holds a pending invitation to this circle.

    Read only once somebody turns out not to be addable, which keeps the ordinary
    path at the two reads it always had.
    """
    outgoing = await asyncio.to_thread(
        service.list_member_invites,
        user_id=ctx.user_id,
        circle_id=circle_id,
        direction="outgoing",
    )
    return {
        str(invite.get("inviteeUserId") or "")
        for invite in (outgoing or [])
        if invite.get("status") == "pending"
    }


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
        member_ids, eligible_ids = await _circle_membership_state(ctx, service, circle_id)
        if user_id in member_ids:
            return already()
        if user_id not in eligible_ids:
            invited = await _pending_invitee_ids(ctx, service, circle_id)
            has_invite = user_id in invited
            # Only reached for someone who is not addable, and only when no
            # invitation already explains it -- the same order as before.
            relationship = None if has_invite else await _fresh_relationship(ctx, user_id)
            decision = _decide_member(
                user_id=user_id,
                person_name=person_name,
                circle_label=circle_label,
                is_member=False,
                is_eligible=False,
                has_pending_invite=has_invite,
                relationship=relationship,
            )
            return AddCircleMemberResult(
                status=decision.status,  # type: ignore[arg-type]
                relationship=decision.relationship,
                needs=decision.needs,
                **base,
                spoken_facts=[decision.spoken],
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


# -- add_circle_members -----------------------------------------------------------

# The service refuses more than twenty in one call, so the input carries the same
# ceiling. Discovering it as a 422 would mean refusing after the person already
# said yes.
MAX_BATCH_MEMBERS = 20


class AddCircleMembersInput(ToolInput):
    """One circle, and the several people to add to it.

    Two or more on purpose: one person is ``add_circle_member``, and keeping the
    two arities disjoint means the model never has to choose between two tools
    that would both fit the same request.
    """

    circle: CircleRef
    people: list[PersonRef] = Field(min_length=2, max_length=MAX_BATCH_MEMBERS)


BatchAddStatus = Literal["added", "partially_added", "none_added"]

# The per-person vocabulary, which is the single-person one plus the cooldown the
# service can report for somebody who left moments ago. Kept separate from
# ``AddMemberStatus`` so adding a reason here does not change what the
# single-person tool declares it can return.
BatchMemberStatus = Literal[
    "added",
    "already_member",
    "invite_pending",
    "not_connected",
    "connection_pending_outgoing",
    "connection_pending_incoming",
    "not_eligible",
    "left_recently",
]


class MemberOutcome(BaseModel):
    """What happened to one person in the batch."""

    model_config = ConfigDict(extra="forbid")

    user_id: str
    person_name: str
    status: BatchMemberStatus


class AddCircleMembersResult(ToolResult):
    """One outcome for the call, and one row per person.

    Parallel lists rather than a list of whole results: the call succeeded or it
    did not, and each person's reason belongs to them. ``none_added`` is an
    answer, not an error -- everybody named may simply have been in the circle
    already.
    """

    status: BatchAddStatus
    circle_id: str
    added: list[MemberOutcome] = Field(default_factory=list)
    skipped: list[MemberOutcome] = Field(default_factory=list)


def _names_for_speech(names: Sequence[str]) -> str:
    """Names One can say, bounded so a long audience stays a sentence."""
    listed = list(names)
    if len(listed) <= SPOKEN_LIST_LIMIT:
        return str(join_names_for_speech(listed))
    extra = len(listed) - SPOKEN_LIST_LIMIT
    return f"{join_names_for_speech(listed[:SPOKEN_LIST_LIMIT])} and {extra} more"


def _batch_spoken(
    circle_label: str, added: Sequence[MemberOutcome], skipped: Sequence[MemberOutcome]
) -> list[str]:
    """What One says, composed only from the outcomes.

    Grouped by reason rather than one sentence per person: twenty sentences is a
    readout, not an answer. Nobody is named in a group they are not in, and every
    name comes from the confirmed entity rather than from the model's arguments.
    """
    lines: list[str] = []
    if added:
        lines.append(
            f"Added {_names_for_speech([row.person_name for row in added])} to {circle_label}."
        )
    grouped: dict[str, list[str]] = {}
    for row in skipped:
        grouped.setdefault(row.status, []).append(row.person_name)
    for status, people in grouped.items():
        names = _names_for_speech(people)
        one = len(people) == 1
        if status == "already_member":
            lines.append(f"{names} {'was' if one else 'were'} already in {circle_label}.")
        elif status == "not_connected":
            lines.append(f"You aren't connected with {names} yet, so I skipped them.")
        elif status == "connection_pending_outgoing":
            lines.append(f"Your connection request to {names} is still pending, so I skipped them.")
        elif status == "connection_pending_incoming":
            lines.append(f"{names} asked to connect with you first, so I skipped them.")
        elif status == "invite_pending":
            lines.append(
                f"{names} already {'has' if one else 'have'} a pending invitation, "
                "so I skipped them."
            )
        elif status == "left_recently":
            lines.append(f"{names} left {circle_label} recently, so I couldn't add them back yet.")
        else:
            lines.append(f"{names} can't be added to {circle_label} right now, so I skipped them.")
    if not lines:
        lines.append(f"Nobody was added to {circle_label}.")
    return lines


async def add_circle_members(ctx: ToolContext, args: AddCircleMembersInput) -> ToolResult:
    """Add several confirmed connections to one confirmed circle, in one step.

    Every person is judged by the same shared decision the single-person tool
    uses, so the two tools cannot disagree about who is addable or why. Only the
    people who pass that check are sent to the service, which matters because the
    service refuses the whole batch -- naming nobody -- if even one id is not an
    active connection. Filtering first is what makes a per-person answer possible
    at all.

    Partial success is reported honestly in both directions: someone skipped is
    never counted as added, and when the write fails nobody is reported as added.
    """
    circle_id = args.circle.circle_id
    circle_label = _circle_label(_circle_name(ctx, circle_id))
    service = _service(ctx)
    # Deduped in request order: the same person named twice is one decision and
    # one row, never two that could disagree.
    user_ids = list(dict.fromkeys(ref.user_id for ref in args.people))
    names = {user_id: _person_name(ctx, user_id) for user_id in user_ids}

    def rows(entries: Sequence[tuple[str, str]]) -> list[MemberOutcome]:
        return [
            MemberOutcome(user_id=user_id, person_name=names[user_id], status=status)  # type: ignore[arg-type]
            for user_id, status in entries
        ]

    try:
        member_ids, eligible_ids = await _circle_membership_state(ctx, service, circle_id)
        undecided = [
            user_id
            for user_id in user_ids
            if user_id not in member_ids and user_id not in eligible_ids
        ]
        invited: set[str] = set()
        relationships: dict[str, str] = {}
        if undecided:
            invited = await _pending_invitee_ids(ctx, service, circle_id)
            relationships = await _relationships(
                ctx, [user_id for user_id in undecided if user_id not in invited]
            )
        decisions = [
            _decide_member(
                user_id=user_id,
                person_name=names[user_id],
                circle_label=circle_label,
                is_member=user_id in member_ids,
                is_eligible=user_id in eligible_ids,
                has_pending_invite=user_id in invited,
                relationship=relationships.get(user_id),
            )
            for user_id in user_ids
        ]
        addable = [decision.user_id for decision in decisions if decision.status == _ELIGIBLE]
        written: dict[str, Any] = {}
        if addable:
            # One call for the whole audience: the service is already atomic over
            # the list, so a second call would be a second transaction.
            written = dict(
                await asyncio.to_thread(
                    service.create_member_invites,
                    actor_user_id=ctx.user_id,
                    circle_id=circle_id,
                    invitee_user_ids=addable,
                )
                or {}
            )
    except _SERVICE_ERRORS as exc:
        if getattr(exc, "code", "") == "LOCATION_CIRCLE_ALREADY_MEMBER":
            # Everyone addable turned out to be in the circle already. An answer,
            # not a failure, and nothing was written.
            skipped = rows([(user_id, "already_member") for user_id in user_ids])
            return AddCircleMembersResult(
                status="none_added",
                circle_id=circle_id,
                skipped=skipped,
                spoken_facts=_batch_spoken(circle_label, (), skipped),
            )
        # Any other refusal takes the whole batch down: the service writes nobody
        # when it raises, so this must not report a partial add.
        return _rejected(exc)

    added_ids = {str(item) for item in (written.get("addedUserIds") or [])}
    service_skips = {
        str(key): str(value) for key, value in dict(written.get("skippedReasons") or {}).items()
    }
    if added_ids:
        await _refresh_remembered(ctx, circle_id)

    added_rows: list[tuple[str, str]] = []
    skipped_rows: list[tuple[str, str]] = []
    for decision in decisions:
        if decision.user_id in added_ids:
            added_rows.append((decision.user_id, "added"))
            continue
        row_status = decision.status
        if row_status == _ELIGIBLE:
            # Addable a moment ago and not in the response: take the service's own
            # reason when it gave one rather than claiming it was added.
            reason = service_skips.get(decision.user_id)
            row_status = reason if reason in {"already_member", "left_recently"} else "not_eligible"
        skipped_rows.append((decision.user_id, row_status))

    added = rows(added_rows)
    skipped = rows(skipped_rows)
    status: BatchAddStatus = "added" if added and not skipped else "none_added"
    if added and skipped:
        status = "partially_added"
    return AddCircleMembersResult(
        status=status,
        circle_id=circle_id,
        added=added,
        skipped=skipped,
        spoken_facts=_batch_spoken(circle_label, added, skipped),
    )


def summarize_add_circle_members(ctx: ToolContext, args: AddCircleMembersInput) -> str:
    people = [_person_name(ctx, ref.user_id) for ref in args.people]
    return f"add {_names_for_speech(people)} to {_circle_label(_circle_name(ctx, args.circle.circle_id))}"


# -- add_all_connections ----------------------------------------------------------

# Circles the app manages, which "everyone I'm connected with" never fills in one
# go: Trusted is curated person by person, and the SMS circle is a short
# emergency list (ten people), not a group.
_BULK_REFUSED_SYSTEM_KINDS = frozenset({"trusted", "sms"})


class AddAllConnectionsInput(ToolInput):
    """Only the circle. Who "all my connections" are is read by the server from
    the person's own connections, never named by the model, so the audience can
    be neither invented nor widened by an argument."""

    circle: CircleRef


AddAllStatus = Literal["added", "no_one_to_add", "not_enough_room", "not_added"]


class AddAllConnectionsResult(ToolResult):
    """Counts, not a roster: the audience can be a hundred people, and the
    circle's own roster read is where the names live."""

    status: AddAllStatus
    circle_id: str
    added_count: int = 0
    already_member_count: int = 0
    unavailable_count: int = 0
    # A few of the people added, for the sentence One says; never all of them.
    added_names: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class _AudiencePlan:
    """Who "all my connections" means for one circle, read without writing."""

    circle_id: str
    circle_name: str
    addable: tuple[str, ...]
    names: dict[str, str]
    member_ids: frozenset[str]
    unavailable_count: int
    connection_count: int
    remaining: int


def _audience_digest(circle_id: str, user_ids: Sequence[str]) -> str:
    """A fingerprint of the exact reviewed audience, stored with the card."""
    material = f"{circle_id}:{','.join(sorted(user_ids))}".encode()
    return hashlib.sha256(material).hexdigest()[:32]


def _count(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


async def _audience_plan(ctx: ToolContext, circle_id: str) -> _AudiencePlan | ToolResult:
    """Read the owner's connections against the circle, as the add would judge them.

    Raises the service's own errors (not the owner, circle gone) for the caller
    to map. A managed circle answers with ``unsupported`` instead of a plan.
    """
    service = _service(ctx)
    plan = dict(
        await asyncio.to_thread(
            service.plan_direct_connection_adds, actor_user_id=ctx.user_id, circle_id=circle_id
        )
        or {}
    )
    circle = dict(plan.get("circle") or {})
    name = str(circle.get("name") or "") or _circle_name(ctx, circle_id)
    system_kind = str(circle.get("systemKind") or "")
    if system_kind in _BULK_REFUSED_SYSTEM_KINDS or bool(circle.get("isSystem")):
        label = _circle_label(name)
        return Unsupported(
            reason_code="managed_circle",
            spoken_facts=[
                f"I can't add all your connections to {label} at once. "
                "Tell me who you want in it and I'll add them."
            ],
        )
    connections = [dict(row) for row in (plan.get("connections") or [])]
    member_ids = frozenset(
        str(row.get("userId") or "") for row in connections if row.get("status") == "member"
    )
    addable_rows = [row for row in connections if row.get("status") == "addable"]
    addable = tuple(sorted(str(row.get("userId") or "") for row in addable_rows))
    limit = int(circle.get("memberLimit") or 0)
    reserved = int(circle.get("reservedCount") or 0)
    return _AudiencePlan(
        circle_id=circle_id,
        circle_name=name,
        addable=addable,
        names={
            str(row.get("userId") or ""): str(row.get("displayName") or "") or "a connection"
            for row in addable_rows
        },
        member_ids=member_ids,
        unavailable_count=len(connections) - len(member_ids) - len(addable),
        connection_count=len(connections),
        remaining=max(0, limit - reserved),
    )


def _already_in(count: int) -> str:
    return f"{count} {'is' if count == 1 else 'are'} already in it"


def _nobody_to_add(plan: _AudiencePlan, label: str) -> AddAllConnectionsResult:
    if not plan.connection_count:
        fact = f"You aren't connected with anyone yet, so there's nobody to add to {label}."
    elif not plan.unavailable_count:
        fact = f"Everyone you're connected with is already in {label}."
    elif not plan.member_ids:
        fact = f"None of your connections can be added to {label} right now."
    else:
        fact = (
            f"Nobody can be added to {label} right now: {_already_in(len(plan.member_ids))}, "
            f"and {plan.unavailable_count} can't be added yet."
        )
    return AddAllConnectionsResult(
        status="no_one_to_add",
        circle_id=plan.circle_id,
        already_member_count=len(plan.member_ids),
        unavailable_count=plan.unavailable_count,
        spoken_facts=[fact],
    )


def _no_room(plan: _AudiencePlan, label: str, wanted: int) -> AddAllConnectionsResult:
    fact = (
        f"{label[0].upper()}{label[1:]} is full, so nobody was added."
        if plan.remaining <= 0
        else f"{label[0].upper()}{label[1:]} only has room for {plan.remaining} more, so I "
        f"can't add all {wanted} as you asked. Nobody was added."
    )
    return AddAllConnectionsResult(
        status="not_enough_room",
        circle_id=plan.circle_id,
        already_member_count=len(plan.member_ids),
        unavailable_count=plan.unavailable_count,
        reason_code="capacity",
        spoken_facts=[fact],
    )


def _add_all_summary(plan: _AudiencePlan, label: str) -> str:
    """The card sentence: exact counts, decided before the person says yes."""
    count = len(plan.addable)
    if count == plan.connection_count:
        who = "your only connection" if count == 1 else f"all {count} of your connections"
    else:
        who = f"{count} of your {plan.connection_count} connections"
    notes: list[str] = []
    if plan.member_ids:
        notes.append(_already_in(len(plan.member_ids)))
    if plan.unavailable_count:
        notes.append(f"{plan.unavailable_count} can't be added right now")
    return f"add {who} to {label}" + (f" ({', '.join(notes)})" if notes else "")


async def prepare_add_all_connections(
    ctx: ToolContext, args: AddAllConnectionsInput
) -> Prepared | ToolResult:
    """Work out exactly who would be added before the card is shown.

    Nothing is written. The card names the counts, and the snapshot binds the
    exact sorted ids, so the yes approves that group and nobody else.
    """
    circle_id = args.circle.circle_id
    try:
        plan = await _audience_plan(ctx, circle_id)
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    if isinstance(plan, ToolResult):
        return plan
    label = _circle_label(plan.circle_name)
    if not plan.addable:
        return _nobody_to_add(plan, label)
    if len(plan.addable) > plan.remaining:
        # All or nothing, decided before asking: never a silent subset.
        return _no_room(plan, label, len(plan.addable))
    return Prepared(
        summary=_add_all_summary(plan, label),
        snapshot={
            "circle_id": circle_id,
            "user_ids": list(plan.addable),
            "audience": _audience_digest(circle_id, plan.addable),
            "already_member_count": len(plan.member_ids),
            "unavailable_count": plan.unavailable_count,
        },
    )


def summarize_add_all_connections(ctx: ToolContext, args: AddAllConnectionsInput) -> str:
    """Fallback card sentence only; the prepared summary carries the counts."""
    return f"add all your connections to {_circle_label(_circle_name(ctx, args.circle.circle_id))}"


def _approved_audience(snapshot: dict[str, Any] | None, circle_id: str) -> tuple[str, ...] | None:
    """The exact ids the person approved, or None when the card's binding is unusable."""
    if not isinstance(snapshot, dict) or snapshot.get("circle_id") != circle_id:
        return None
    raw = snapshot.get("user_ids")
    if not isinstance(raw, list) or not raw or not all(isinstance(item, str) for item in raw):
        return None
    ids = tuple(sorted(raw))
    if snapshot.get("audience") != _audience_digest(circle_id, ids):
        return None
    return ids


async def add_all_connections(ctx: ToolContext, args: AddAllConnectionsInput) -> ToolResult:
    """Add exactly the reviewed audience, in one all-or-nothing write.

    Everything is read again first. Anyone approved who can no longer be added
    (disconnected, left, cooling down) means the card no longer describes what
    would happen, so nothing is written and the person is asked again. Someone
    who connected after the card was shown is never added on its strength.
    """
    circle_id = args.circle.circle_id
    approved = _approved_audience(ctx.prepared, circle_id)
    if approved is None:
        return AddAllConnectionsResult(
            status="not_added",
            circle_id=circle_id,
            reason_code="review_required",
            spoken_facts=["I need to check your connections again before adding anyone."],
        )
    try:
        plan = await _audience_plan(ctx, circle_id)
    except _SERVICE_ERRORS as exc:
        return _rejected(exc)
    if isinstance(plan, ToolResult):
        return plan
    label = _circle_label(plan.circle_name)
    addable = set(plan.addable)
    joined = [user_id for user_id in approved if user_id in plan.member_ids]
    to_add = [user_id for user_id in approved if user_id in addable]
    if len(joined) + len(to_add) != len(approved):
        return AddAllConnectionsResult(
            status="not_added",
            circle_id=circle_id,
            reason_code="audience_changed",
            spoken_facts=[
                f"Your connections or {label} changed since I asked, so I haven't added "
                "anyone. Should I check again?"
            ],
        )
    if not to_add:
        return AddAllConnectionsResult(
            status="no_one_to_add",
            circle_id=circle_id,
            already_member_count=len(joined),
            spoken_facts=[f"Everyone on the card is already in {label}."],
        )
    if len(to_add) > plan.remaining:
        return _no_room(plan, label, len(to_add))
    service = _service(ctx)
    try:
        written = dict(
            await asyncio.to_thread(
                service.add_direct_connections,
                actor_user_id=ctx.user_id,
                circle_id=circle_id,
                user_ids=to_add,
            )
            or {}
        )
    except _SERVICE_ERRORS as exc:
        # One transaction: a refusal means nobody was added.
        return _rejected(exc)
    added = [str(item) for item in (written.get("addedUserIds") or [])]
    skipped = {
        str(key): str(value) for key, value in dict(written.get("skippedReasons") or {}).items()
    }
    if added:
        await _refresh_remembered(ctx, circle_id)
    already = len(joined) + sum(1 for reason in skipped.values() if reason == "already_member")
    unavailable = sum(1 for reason in skipped.values() if reason != "already_member")
    names = [plan.names.get(user_id) or "a connection" for user_id in added]
    facts: list[str] = []
    if added:
        listed = (
            f", including {_names_for_speech(names[:3])}"
            if len(names) > 3
            else f": {_names_for_speech(names)}"
        )
        facts.append(f"Added {_count(len(added), 'person', 'people')} to {label}{listed}.")
    if already:
        facts.append(f"{_count(already, 'person was', 'people were')} already in it.")
    if unavailable:
        facts.append(f"{_count(unavailable, 'person', 'people')} couldn't be added right now.")
    newer = len(addable - set(approved))
    if newer:
        facts.append(
            f"{_count(newer, 'newer connection was', 'newer connections were')} not on the "
            "card, so I left them out."
        )
    return AddAllConnectionsResult(
        status="added" if added else "no_one_to_add",
        circle_id=circle_id,
        added_count=len(added),
        already_member_count=already,
        unavailable_count=unavailable,
        added_names=names[:SPOKEN_LIST_LIMIT],
        spoken_facts=facts or [f"Nobody was added to {label}."],
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
            "Read a circle's name, kind, member count, ownership and allowed actions "
            "(add, rename, delete, leave). No argument reads the circle on screen."
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
            "Read one page of members: ids, names, roles and relationships. No argument reads "
            "the circle on screen. Members need not be connections: before remove_circle_member, "
            "confirm one from here with confirm_person. Counts are totals; has_more marks paging."
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
            "Create an empty circle (family/friends/other); no invitations or location sharing. "
            "Returns already_exists for an owned match. For spelling use name_parts, omit name: "
            "characters assemble literally and are retained; literal parts keep spaces/rest. "
            "Correct only requested words, even after cancel. Declare unspelled edits in "
            "changed_words, explicit respelling/removal in release_spelled_words. Keep the rest. "
            "On name_changed/spelled_word_missing, retry with the requested change declared."
        ),
        handler=create_circle,
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_create_circle,
        prepare=prepare_create_circle,
        on_invalid_correction=_invalid_create_circle_correction,
        # A new circle names no existing person or circle, so a lookup made for
        # a follow-up ("yes, and add Priya to it") must not cancel its card.
        lookup_targets=(),
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
        name="set_circle_kind",
        gateway_action_id="location.set_circle_kind",
        policy=ToolPolicy.confirm_voice,
        input_model=SetCircleKindInput,
        output_model=SetCircleKindResult,
        description=(
            "Change a circle's type to family, friends, or other. Changes only the type: the "
            "name, members, sharing, and ownership stay as they are (a new name is "
            "rename_circle). Takes a confirmed circle id, never a spoken name."
        ),
        handler=set_circle_kind,
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_set_circle_kind,
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
        correction_group="circle_add",
        person_args=("person",),
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_add_circle_member,
    ),
    ToolSpec(
        name="add_circle_members",
        gateway_action_id="location.add_to_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=AddCircleMembersInput,
        output_model=AddCircleMembersResult,
        description=(
            "Add two or more confirmed people to one confirmed circle in a single step, "
            "with one confirmation for the whole group. Use this when the person names "
            "several people at once; use add_circle_member when they name one. The same "
            "rule applies to each person as for a single add: only an existing connection "
            "joins, and anyone else is skipped with their own reason (already_member, "
            "invite_pending, connection_pending_outgoing, connection_pending_incoming, "
            "not_eligible, not_connected, left_recently). Skipping is not inviting: this "
            "never sends a connection request to anybody. The result says who joined and "
            "who did not, so some people can join while others are skipped. Every "
            "argument is a canonical id, never a name."
        ),
        handler=add_circle_members,
        correction_group="circle_add",
        person_args=("people",),
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_add_circle_members,
    ),
    ToolSpec(
        name="add_all_connections",
        gateway_action_id="location.add_to_circle",
        policy=ToolPolicy.confirm_voice,
        input_model=AddAllConnectionsInput,
        output_model=AddAllConnectionsResult,
        description=(
            "Add everyone the person is connected with to one confirmed circle they own, in a "
            "single step with one confirmation. People are not an argument: the server reads "
            "their current connections, and the card gives exact counts (how many will be "
            "added, how many are already in it or can't be added right now). The yes adds "
            "exactly that group, never someone who connects later. All or none: without room "
            "for everyone it adds nobody (not_enough_room). For a few named people use "
            "add_circle_members instead, and never resolve people one by one for this. Trusted "
            "and the SMS circle are refused. It sends no connection requests. The circle is a "
            "canonical id, never a name."
        ),
        handler=add_all_connections,
        correction_group="circle_add",
        circle_args=("circle",),
        ui_refresh=REFRESH_CIRCLES,
        summarize=summarize_add_all_connections,
        prepare=prepare_add_all_connections,
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
