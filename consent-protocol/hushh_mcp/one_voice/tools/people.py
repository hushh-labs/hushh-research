"""People tools: resolve a spoken name to a canonical person, then act on ids.

The family enforces the canonical-identity rule mechanically:

* ``resolve_person`` ranks candidates and *offers* them (ids are written to
  ``ctx.entities.offered_person_ids``); it never confirms, even when only
  one person is likely.
* ``confirm_person`` accepts only an offered id, re-reads the record from
  the service, and remembers it as a :class:`ConfirmedPerson`.
* Every mutation takes a ``PersonRef`` (an id) and reads the display name
  from the confirmed entity, never from its arguments.

Two auth planes: the Location service (recipient keys) is the vault-owner
plane and takes ``ctx.user_id``; connection requests and disconnects are the
Firebase plane, so those tools set ``firebase_plane=True``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    Needs,
    OfferedRequest,
    PersonRef,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    Unsupported,
    now_iso,
)
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)
from hushh_mcp.services.phonetic_person_matcher import (
    TIER_PHONETIC,
    ScoredCandidate,
    rank_candidates,
)
from hushh_mcp.services.requester_identity import label_from_identity_row
from hushh_mcp.services.spoken_name_resolver import (
    join_names_for_speech,
    normalize_spoken_name,
    split_spoken_names,
)

Relationship = Literal["connected", "pending_outgoing", "pending_incoming", "none", "self"]

UNNAMED = "Unnamed connection"
RECIPIENT_LIMIT = 100
DIRECTORY_LIMIT = 50
# Bounded additional retrieval: a common prefix can fill page 1, so up to this
# many directory pages are read before "nobody" or "one likely" is claimed.
# Past that the result says so instead of scanning the whole directory.
DIRECTORY_MAX_PAGES = 3
# One page of connections read back to the model. Counts carry the totals.
LIST_PAGE_LIMIT = 20
# How many names are read aloud before "and N more".
SPOKEN_PEOPLE_LIMIT = 6
# The connections route's own bound (api/routes/one/connections.py); the
# person-profile route caps at 500, but that is a different surface. The
# service and column are unbounded, so this is the cap the voice path keeps.
MESSAGE_MAX_CHARS = 1000
PEOPLE_REFRESH: tuple[str, ...] = ("location_people", "connections")
ServiceError = (ConnectionsError, OneLocationAgentError)


# -- service access ---------------------------------------------------------


def _connections(ctx: ToolContext) -> Any:
    return ctx.service("connections", ConnectionsService)


def _location(ctx: ToolContext) -> Any:
    return ctx.service("location", OneLocationAgentService)


def _rejected(err: Exception) -> Rejected:
    code = str(getattr(err, "code", "") or "service_error")
    message = str(getattr(err, "message", "") or err) or "That didn't go through."
    needs: Needs | None = "client_step" if code == "CONNECTION_SCOPE_SELECTION_REQUIRED" else None
    return Rejected(reason_code=code, spoken_facts=[message], needs=needs)


# -- people snapshot --------------------------------------------------------


def _blank_record(user_id: str) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "public_person_ref": None,
        "display_name": "",
        "photo_url": None,
        "relationship": "none",
        "has_location_key": False,
        "phone_verified": False,
        "key_id": None,
        "connection_id": None,
        "request_id": None,
        "connected_at": None,
        "connected_from_contacts": False,
        "is_ria": False,
    }


def _label(row: dict[str, Any], *, allow_email_handle: bool) -> str:
    # ``label_from_identity_row`` lives in the un-followed services package; pin its str contract.
    label: str = label_from_identity_row(
        {
            "user_id": row.get("userId") or row.get("counterpartUserId"),
            "display_name": row.get("displayName") or row.get("counterpartDisplayName"),
            "email": row.get("email"),
        },
        allow_email_handle=allow_email_handle,
        fallback="",
    )
    return label


def _request_summary(row: dict[str, Any], *, direction: str) -> dict[str, Any]:
    return {
        "request_id": str(row.get("id") or ""),
        "user_id": str(row.get("counterpartUserId") or ""),
        "display_name": _label(row, allow_email_handle=False) or UNNAMED,
        "photo_url": row.get("counterpartPhotoUrl"),
        "message": row.get("message"),
        "created_at": row.get("createdAt"),
        "direction": direction,
    }


@dataclass
class PeopleSnapshot:
    """Everything the viewer's people surface knows, keyed by user id."""

    people: dict[str, dict[str, Any]] = field(default_factory=dict)
    pending_incoming: list[dict[str, Any]] = field(default_factory=list)
    pending_outgoing: list[dict[str, Any]] = field(default_factory=list)

    @property
    def connected(self) -> list[dict[str, Any]]:
        return [p for p in self.people.values() if p["relationship"] == "connected"]

    @property
    def ready_for_location(self) -> list[dict[str, Any]]:
        return [p for p in self.people.values() if p["has_location_key"]]

    def counts(self) -> dict[str, int]:
        return {
            "connections": len(self.connected),
            "ready_for_location": len(self.ready_for_location),
            "pending_incoming": len(self.pending_incoming),
            "pending_outgoing": len(self.pending_outgoing),
        }


async def load_people_snapshot(ctx: ToolContext) -> PeopleSnapshot:
    connections = _connections(ctx)
    location = _location(ctx)
    rows = await asyncio.to_thread(connections.list_connections, ctx.user_id)
    recipients = await asyncio.to_thread(
        location.list_verified_recipients, owner_user_id=ctx.user_id, limit=RECIPIENT_LIMIT
    )
    incoming = await asyncio.to_thread(connections.list_requests, ctx.user_id, direction="incoming")
    outgoing = await asyncio.to_thread(connections.list_requests, ctx.user_id, direction="outgoing")

    snapshot = PeopleSnapshot()
    people = snapshot.people
    for row in rows or []:
        uid = str(row.get("userId") or "")
        if not uid or uid == ctx.user_id:
            continue
        record = people.setdefault(uid, _blank_record(uid))
        record.update(
            relationship="connected",
            connection_id=str(row.get("connectionId") or "") or None,
            connected_at=row.get("createdAt"),
            public_person_ref=row.get("publicPersonRef") or record["public_person_ref"],
            display_name=_label(row, allow_email_handle=True) or record["display_name"],
            photo_url=row.get("photoUrl") or record["photo_url"],
            connected_from_contacts=bool(row.get("connectedFromContacts")),
            is_ria=bool(row.get("isRia")),
        )
    for row in recipients or []:
        uid = str(row.get("userId") or "")
        if not uid or uid == ctx.user_id:
            continue
        record = people.setdefault(uid, _blank_record(uid))
        key_id = str(row.get("keyId") or "") or None
        record.update(
            has_location_key=bool(key_id) or bool(row.get("canReceiveLocation")),
            key_id=key_id,
            phone_verified=bool(row.get("phoneVerified")),
            public_person_ref=record["public_person_ref"] or row.get("publicPersonRef"),
            display_name=record["display_name"] or str(row.get("displayName") or "").strip(),
            photo_url=record["photo_url"] or row.get("photoUrl"),
        )
    for direction, rows_for, bucket in (
        ("incoming", incoming, snapshot.pending_incoming),
        ("outgoing", outgoing, snapshot.pending_outgoing),
    ):
        for row in rows_for or []:
            if str(row.get("status") or "pending") != "pending":
                continue
            summary = _request_summary(row, direction=direction)
            bucket.append(summary)
            uid = summary["user_id"]
            if not uid or uid == ctx.user_id:
                continue
            record = people.setdefault(uid, _blank_record(uid))
            if record["relationship"] == "none":
                record["relationship"] = f"pending_{direction}"
                record["request_id"] = summary["request_id"]
            record["display_name"] = record["display_name"] or summary["display_name"]
            record["photo_url"] = record["photo_url"] or summary["photo_url"]
    for record in people.values():
        record["display_name"] = record["display_name"] or UNNAMED
    return snapshot


def _by_name(record: dict[str, Any]) -> tuple[str, str]:
    return (str(record["display_name"]).lower(), str(record["user_id"]))


def looks_like_contact_identifier(text: str) -> bool:
    """A phone number or email is not a searchable name. The directory searches
    display names only; a number spoken as a name must not be quietly folded
    into a prefix search that happens to match somebody."""
    raw = str(text or "")
    if "@" in raw:
        return True
    digits = sum(ch.isdigit() for ch in raw)
    return digits >= 7


async def load_connected_people(ctx: ToolContext) -> list[dict[str, Any]]:
    """Connected people with ``has_location_key``/``phone_verified``; used by
    the sharing and circle families to check a confirmed person's eligibility."""
    snapshot = await load_people_snapshot(ctx)
    return sorted(snapshot.connected, key=_by_name)


async def _directory_record(ctx: ToolContext, user_id: str) -> dict[str, Any] | None:
    """One person from the discovery directory, by id, or ``None``."""
    page = await asyncio.to_thread(
        _location(ctx).search_directory_candidates,
        owner_user_id=ctx.user_id,
        candidate_user_id=user_id,
        page=1,
        limit=1,
    )
    items = [item for item in (page or {}).get("items") or [] if str(item.get("userId")) == user_id]
    if not items:
        return None
    row = items[0]
    record = _blank_record(user_id)
    key_id = str(row.get("keyId") or "") or None
    record.update(
        public_person_ref=row.get("publicPersonRef"),
        display_name=str(row.get("displayName") or "").strip() or UNNAMED,
        photo_url=row.get("photoUrl"),
        has_location_key=bool(key_id) or bool(row.get("canReceiveLocation")),
        key_id=key_id,
        phone_verified=bool(row.get("phoneVerified")),
        is_ria=bool(row.get("isRia")),
    )
    return record


async def _roster_record(ctx: ToolContext, user_id: str) -> dict[str, Any] | None:
    """One person as a current member of the circle whose roster offered them.

    Only consulted when ``resolve``/``list_circle_members`` offered this id
    from a circle roster: the circle service re-reads the membership, so a
    member who left since the roster was read is not confirmed.
    """
    circle_id = ctx.entities.offered_person_circle_id
    if not circle_id or user_id not in ctx.entities.offered_person_ids:
        return None
    from hushh_mcp.services.one_location_circle_service import (
        OneLocationCircleError,
        OneLocationCircleService,
    )

    service = ctx.service("circles", OneLocationCircleService)
    try:
        circle = dict(
            await asyncio.to_thread(service.get_circle, user_id=ctx.user_id, circle_id=circle_id)
            or {}
        )
    except OneLocationCircleError as err:
        raise ConnectionsError(str(err.code), str(err.message)) from err
    for row in circle.get("members") or []:
        if str(row.get("userId") or "") != user_id:
            continue
        record = _blank_record(user_id)
        key_id = str(row.get("keyId") or "") or None
        record.update(
            public_person_ref=row.get("publicPersonRef"),
            display_name=str(row.get("displayName") or "").strip() or UNNAMED,
            photo_url=row.get("photoUrl"),
            relationship=str(row.get("relationship") or "none"),
            has_location_key=bool(key_id) or bool(row.get("canReceiveLocation")),
            key_id=key_id,
            phone_verified=bool(row.get("phoneVerified")),
            is_ria=bool(row.get("isRia")),
        )
        return record
    return None


async def _fresh_record(
    ctx: ToolContext, user_id: str
) -> tuple[PeopleSnapshot, dict[str, Any] | None]:
    """The person's current record: from the people snapshot, else the roster
    that offered them, else the directory."""
    snapshot = await load_people_snapshot(ctx)
    record = snapshot.people.get(user_id)
    if record is None:
        record = await _roster_record(ctx, user_id)
    if record is None:
        record = await _directory_record(ctx, user_id)
    return snapshot, record


def _confirmed(record: dict[str, Any]) -> ConfirmedPerson:
    return ConfirmedPerson(
        user_id=record["user_id"],
        public_person_ref=record.get("public_person_ref"),
        display_name=record["display_name"],
        photo_url=record.get("photo_url"),
        relationship=record.get("relationship") or "none",
        has_location_key=bool(record.get("has_location_key")),
        phone_verified=bool(record.get("phone_verified")),
        confirmed_at=now_iso(),
    )


def _name(ctx: ToolContext, ref: PersonRef | None) -> str | None:
    if ref is None:
        return None
    person = ctx.entities.person(ref.user_id)
    return person.display_name if person else None


# -- models -----------------------------------------------------------------


class PersonCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    public_person_ref: str | None = None
    display_name: str
    photo_url: str | None = None
    relationship: Relationship
    has_location_key: bool
    phone_verified: bool
    match_tier: int


class PersonCard(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    public_person_ref: str | None = None
    display_name: str
    photo_url: str | None = None
    relationship: Relationship
    has_location_key: bool
    phone_verified: bool
    connection_id: str | None = None
    request_id: str | None = None
    connected_at: str | None = None
    connected_from_contacts: bool = False


class PendingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str
    user_id: str
    display_name: str
    photo_url: str | None = None
    message: str | None = None
    created_at: str | None = None
    direction: Literal["incoming", "outgoing"]


class PeopleCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connections: int
    ready_for_location: int
    pending_incoming: int
    pending_outgoing: int


def _card(record: dict[str, Any]) -> PersonCard:
    fields: dict[str, Any] = {key: record.get(key) for key in PersonCard.model_fields}
    return PersonCard(**fields)


def _candidate(item: ScoredCandidate) -> PersonCandidate:
    record = item.candidate
    return PersonCandidate(
        user_id=record["user_id"],
        public_person_ref=record.get("public_person_ref"),
        display_name=record["display_name"],
        photo_url=record.get("photo_url"),
        relationship=record.get("relationship") or "none",
        has_location_key=bool(record.get("has_location_key")),
        phone_verified=bool(record.get("phone_verified")),
        match_tier=item.tier,
    )


# -- resolve_person ---------------------------------------------------------


class ResolvePersonInput(ToolInput):
    spoken_name: str = Field(
        min_length=1, max_length=120, description="One name exactly as the person said it."
    )
    pool: Literal["connections", "directory"] = Field(
        default="connections",
        description=(
            "'connections' = people already in your life (connected, location-ready, or with a "
            "pending request). 'directory' = anyone findable on Hussh, for inviting someone new."
        ),
    )


class ResolvePersonResult(ToolResult):
    status: Literal[
        "single_likely", "multiple", "none", "low_confidence", "no_connections", "truncated"
    ]
    spoken_name: str
    pool: Literal["connections", "directory"]
    candidates: list[PersonCandidate] = Field(default_factory=list)
    # The directory had more pages than were read: what is shown is a sample,
    # not the whole match set, so nobody here is "the only" match.
    truncated: bool = False
    # Which offer these candidates belong to; confirm_person needs the same one.
    offer_revision: int = 0


async def _directory_candidates(ctx: ToolContext, target: str) -> tuple[list[dict[str, Any]], bool]:
    """Directory rows for ``target`` across up to ``DIRECTORY_MAX_PAGES`` pages,
    and whether more pages were left unread. The visibility predicate is the
    service's; nothing here widens it."""
    connections = _connections(ctx)
    items: list[dict[str, Any]] = []

    async def _read(query: str) -> bool:
        """Fill ``items`` for ``query``; True when pages were left unread."""
        items.clear()
        for page_number in range(1, DIRECTORY_MAX_PAGES + 1):
            page = await asyncio.to_thread(
                connections.search_directory,
                ctx.user_id,
                query=query,
                page=page_number,
                limit=DIRECTORY_LIMIT,
            )
            rows = list((page or {}).get("items") or [])
            items.extend(rows)
            if not (page or {}).get("hasMore"):
                return False
        return True

    # Only the name the person actually said can be "truncated": the short
    # prefix below is a net for near-spellings, and a crowded prefix says
    # nothing about how many people share the spoken name.
    truncated = await _read(target)
    first = target.split(" ")[0]
    if not items and len(first) >= 2:
        # The directory is prefix-only in SQL; a short prefix pulls in the
        # near-spellings so the phonetic ranking below can consider them.
        await _read(first[:2])
        truncated = False
    records: list[dict[str, Any]] = []
    for row in items:
        uid = str(row.get("userId") or "")
        if not uid or uid == ctx.user_id:
            continue
        record = _blank_record(uid)
        record.update(
            public_person_ref=row.get("publicPersonRef"),
            display_name=str(row.get("displayName") or "").strip(),
            photo_url=row.get("photoUrl"),
            relationship=str(row.get("relationship") or "none"),
            is_ria=bool(row.get("isRia")),
        )
        if record["display_name"]:
            records.append(record)
    return records, truncated


async def resolve_person(ctx: ToolContext, args: ResolvePersonInput) -> ToolResult:
    names = split_spoken_names(args.spoken_name)
    if len(names) != 1:
        ctx.entities.offer_people([])
        return Rejected(
            reason_code="one_name_at_a_time",
            needs="repeat_name",
            spoken_facts=["One person at a time, please. Who first?"],
        )
    if looks_like_contact_identifier(names[0]):
        ctx.entities.offer_people([])
        return Rejected(
            reason_code="identifier_not_a_name",
            needs="repeat_name",
            spoken_facts=[
                "I look people up by name, not by phone number or email. What's their name?"
            ],
        )
    target = normalize_spoken_name(names[0])
    if not target:
        ctx.entities.offer_people([])
        return Rejected(reason_code="invalid_arguments", needs="repeat_name")

    truncated = False
    try:
        if args.pool == "connections":
            snapshot = await load_people_snapshot(ctx)
            pool = list(snapshot.people.values())
            if not pool:
                ctx.entities.offer_people([])
                return ResolvePersonResult(
                    status="no_connections",
                    needs="invite",
                    spoken_name=names[0],
                    pool=args.pool,
                    spoken_facts=["You don't have anyone connected yet."],
                )
        else:
            snapshot = await load_people_snapshot(ctx)
            pool, truncated = await _directory_candidates(ctx, target)
            for record in pool:
                known = snapshot.people.get(record["user_id"])
                if known:
                    record["has_location_key"] = known["has_location_key"]
                    record["phone_verified"] = known["phone_verified"]
    except ServiceError as err:
        ctx.entities.offer_people([])
        return _rejected(err)

    ranked = rank_candidates(target, pool)
    revision = ctx.entities.offer_people([item.user_id for item in ranked])
    candidates = [_candidate(item) for item in ranked]
    where = "your connections" if args.pool == "connections" else "the Hussh directory"
    common: dict[str, Any] = {
        "spoken_name": names[0],
        "pool": args.pool,
        "truncated": truncated,
        "offer_revision": revision,
    }
    if not ranked:
        facts = [f"Nobody in {where} matches that name."]
        if truncated:
            facts = [
                f"Too many people in {where} start like that for me to read them all. "
                "What's their full name?"
            ]
        return ResolvePersonResult(status="none", needs="repeat_name", **common, spoken_facts=facts)
    names_spoken = join_names_for_speech([item.display_name for item in ranked])
    if truncated:
        # More pages than were read: the candidates are what was seen, not
        # the whole match set. Offer them, but never "the one".
        return ResolvePersonResult(
            status="truncated",
            needs="repeat_name",
            **common,
            candidates=candidates,
            spoken_facts=[
                f"Lots of people in {where} match that; the closest I saw were {names_spoken}. "
                "Say their full name, or pick one of those."
            ],
        )
    if ranked[0].tier >= TIER_PHONETIC:
        return ResolvePersonResult(
            status="low_confidence",
            needs="repeat_name",
            **common,
            candidates=candidates,
            spoken_facts=[f"The closest in {where} is {names_spoken}."],
        )
    if len(ranked) == 1:
        person = _confirmed(ranked[0].candidate)
        return ResolvePersonResult(
            status="single_likely",
            needs="confirmation",
            **common,
            candidates=candidates,
            spoken_facts=[f"I found {person.spoken()}."],
        )
    return ResolvePersonResult(
        status="multiple",
        needs="disambiguation",
        **common,
        candidates=candidates,
        spoken_facts=[f"I found {names_spoken}."],
    )


# -- confirm_person ---------------------------------------------------------


class ConfirmPersonInput(ToolInput):
    user_id: str = Field(
        min_length=1,
        max_length=128,
        description="The user_id of the candidate the person chose. Must come from resolve_person.",
    )


class ConfirmPersonResult(ToolResult):
    status: Literal["confirmed"]
    person: PersonCard


async def confirm_person(ctx: ToolContext, args: ConfirmPersonInput) -> ToolResult:
    if ctx.entities.offered_person_ids and not ctx.entities.offer_is_fresh():
        ctx.entities.offer_people([])
        return Rejected(
            reason_code="offer_expired",
            needs="repeat_name",
            spoken_facts=["That list is a while old. Say the name again and I'll look them up."],
        )
    if args.user_id not in ctx.entities.offered_person_ids:
        return Rejected(
            reason_code="person_not_offered",
            needs="disambiguation",
            spoken_facts=["That wasn't one of the people I found. Say the name again."],
        )
    if args.user_id == ctx.user_id:
        return Rejected(reason_code="person_is_self", spoken_facts=["That's you."])
    try:
        _, record = await _fresh_record(ctx, args.user_id)
    except ServiceError as err:
        return _rejected(err)
    if record is None:
        return Rejected(
            reason_code="person_not_found",
            needs="repeat_name",
            spoken_facts=["I can't find that person anymore."],
        )
    person = _confirmed(record)
    ctx.entities.remember_person(person)
    return ConfirmPersonResult(
        status="confirmed", person=_card(record), spoken_facts=[person.spoken()]
    )


# -- list_people ------------------------------------------------------------


class ListPeopleInput(ToolInput):
    query: str | None = Field(
        default=None,
        max_length=120,
        description="A name to filter your connections by. Suggestion only; never an id.",
    )
    page: int = Field(default=1, ge=1, le=50, description="Connections page, starting at 1.")


class ListPeopleResult(ToolResult):
    status: Literal["ok", "no_connections"]
    # One page of connections. ``counts.connections`` is the total; the page
    # is not the total.
    connected: list[PersonCard] = Field(default_factory=list)
    page: int = 1
    has_more: bool = False
    ready_for_location: list[PersonCard] = Field(default_factory=list)
    pending_incoming: list[PendingRequest] = Field(default_factory=list)
    pending_outgoing: list[PendingRequest] = Field(default_factory=list)
    counts: PeopleCounts


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return f"{count} {singular if count == 1 else (plural or singular + 's')}"


def _page_record(row: dict[str, Any], snapshot: PeopleSnapshot) -> dict[str, Any]:
    uid = str(row.get("userId") or "")
    known = snapshot.people.get(uid)
    record = dict(known) if known else _blank_record(uid)
    record.update(
        relationship="connected",
        connection_id=str(row.get("connectionId") or "") or record.get("connection_id"),
        display_name=_label(row, allow_email_handle=True) or record.get("display_name") or UNNAMED,
        photo_url=row.get("photoUrl") or record.get("photo_url"),
        public_person_ref=row.get("publicPersonRef") or record.get("public_person_ref"),
        connected_from_contacts=bool(row.get("connectedFromContacts")),
        is_ria=bool(row.get("isRia")),
    )
    return record


async def list_people(ctx: ToolContext, args: ListPeopleInput) -> ToolResult:
    """Who the person is connected with, one page at a time, plus pending
    requests both ways. The page comes from the paged service read (server
    ordering, at most ``LIST_PAGE_LIMIT``); the totals come from the counts.
    The unbounded legacy list never becomes model context."""
    try:
        snapshot = await load_people_snapshot(ctx)
        page = dict(
            await asyncio.to_thread(
                _connections(ctx).list_connections_page,
                ctx.user_id,
                query=str(args.query or "").strip(),
                page=args.page,
                limit=LIST_PAGE_LIMIT,
            )
            or {}
        )
    except ServiceError as err:
        return _rejected(err)
    page_records = [
        _page_record(dict(row), snapshot)
        for row in (page.get("items") or [])
        if str(row.get("userId") or "") and str(row.get("userId") or "") != ctx.user_id
    ]
    total = int(page.get("totalCount") or 0)
    has_more = bool(page.get("hasMore"))
    ready = sorted(snapshot.ready_for_location, key=_by_name)
    counts = snapshot.counts()
    counts["connections"] = total if not args.query else counts["connections"]
    facts: list[str] = []
    names = join_names_for_speech([p["display_name"] for p in page_records[:SPOKEN_PEOPLE_LIMIT]])
    if args.query:
        facts.append(
            f"{_plural(total, 'connection')} match that name"
            + (f": {names}." if page_records else ".")
        )
    elif not page_records and args.page == 1:
        facts.append("You don't have anyone connected yet.")
    elif not page_records:
        facts.append(f"There's nobody on page {args.page}.")
    elif total <= SPOKEN_PEOPLE_LIMIT and not has_more and args.page == 1:
        facts.append(f"You're connected with {names}.")
    else:
        # "the first N" and "N connections" are different claims; keep both.
        facts.append(
            f"You have {_plural(total, 'connection')}. Page {int(page.get('page') or args.page)} "
            f"has {names}"
            + (
                f", and {len(page_records) - SPOKEN_PEOPLE_LIMIT} more"
                if len(page_records) > SPOKEN_PEOPLE_LIMIT
                else ""
            )
            + "."
        )
        if has_more:
            facts.append("There are more on the next page.")
    if ready and not args.query:
        facts.append(f"{_plural(len(ready), 'person', 'people')} can receive your location.")
    if snapshot.pending_incoming and not args.query:
        facts.append(
            f"{join_names_for_speech([r['display_name'] for r in snapshot.pending_incoming[:5]])} "
            f"asked to connect with you."
        )
    if snapshot.pending_outgoing and not args.query:
        facts.append(
            f"Your request to "
            f"{join_names_for_speech([r['display_name'] for r in snapshot.pending_outgoing[:5]])} "
            f"is still pending."
        )
    ctx.entities.offer_requests(
        [
            OfferedRequest(
                request_id=str(r["request_id"]),
                user_id=str(r["user_id"]),
                display_name=str(r["display_name"]),
                direction=direction,  # type: ignore[arg-type]
            )
            for direction, rows in (
                ("incoming", snapshot.pending_incoming),
                ("outgoing", snapshot.pending_outgoing),
            )
            for r in rows
            if r.get("request_id")
        ]
    )
    no_connections = total == 0 and not args.query
    return ListPeopleResult(
        status="no_connections" if no_connections else "ok",
        needs="invite" if no_connections else None,
        connected=[_card(p) for p in page_records],
        page=int(page.get("page") or args.page),
        has_more=has_more,
        ready_for_location=[_card(p) for p in ready[:LIST_PAGE_LIMIT]],
        pending_incoming=[PendingRequest(**r) for r in snapshot.pending_incoming[:LIST_PAGE_LIMIT]],
        pending_outgoing=[PendingRequest(**r) for r in snapshot.pending_outgoing[:LIST_PAGE_LIMIT]],
        counts=PeopleCounts(**counts),
        spoken_facts=facts,
    )


# -- get_person -------------------------------------------------------------


class GetPersonInput(ToolInput):
    person: PersonRef


class GetPersonResult(ToolResult):
    status: Literal["ok", "not_found"]
    person: PersonCard | None = None
    counts: PeopleCounts


async def get_person(ctx: ToolContext, args: GetPersonInput) -> ToolResult:
    try:
        snapshot, record = await _fresh_record(ctx, args.person.user_id)
    except ServiceError as err:
        return _rejected(err)
    counts = PeopleCounts(**snapshot.counts())
    known = ctx.entities.person(args.person.user_id)
    if record is None:
        name = known.display_name if known else "That person"
        return GetPersonResult(
            status="not_found",
            counts=counts,
            spoken_facts=[f"{name} isn't findable on Hussh right now."],
        )
    person = _confirmed(record)
    ctx.entities.remember_person(person)
    facts = [person.spoken()]
    if record["relationship"] == "connected":
        facts.append(
            f"{person.display_name} can receive your location."
            if person.has_location_key
            else f"{person.display_name} hasn't set up Location yet, so they can't receive it."
        )
    return GetPersonResult(status="ok", person=_card(record), counts=counts, spoken_facts=facts)


# -- invite_person ----------------------------------------------------------


class InvitePersonInput(ToolInput):
    person: PersonRef
    message: str | None = Field(
        default=None,
        max_length=MESSAGE_MAX_CHARS,
        description="An optional note to the person, sent as written. Never invented.",
    )


class InvitePersonResult(ToolResult):
    # ``sent`` needs a committed request id from the service; ``already_pending``
    # names the direction of the request that already exists.
    status: Literal["sent", "already_connected", "already_pending", "unsupported"]
    request_id: str | None = None
    request_status: str | None = None
    direction: Literal["incoming", "outgoing"] | None = None


def summarize_invite(ctx: ToolContext, args: InvitePersonInput) -> str:
    who = _name(ctx, args.person) or "this person"
    if args.message and args.message.strip():
        return f"send a connection request to {who} with your note"
    return f"send a connection request to {who}"


def _pending_result(
    name: str, request: dict[str, Any], *, direction: str, fresh: bool
) -> InvitePersonResult:
    if direction == "outgoing":
        facts = [f"Your request to {name} is still pending."]
    else:
        facts = [f"{name} already asked to connect with you. You can accept it."]
    return InvitePersonResult(
        status="already_pending",
        request_id=str(request.get("id") or "") or None,
        request_status="pending",
        direction=direction,  # type: ignore[arg-type]
        spoken_facts=facts,
    )


async def invite_person(ctx: ToolContext, args: InvitePersonInput) -> ToolResult:
    """Send one plain connection request. The decision is made on a fresh
    read, and the *committed* payload decides what is said: ``sent`` needs a
    new pending request whose requester is this person; an existing request
    in either direction is reported as what it is; a missing id or status is
    a malformed result, never a success."""
    uid = args.person.user_id
    name = _name(ctx, args.person) or "this person"
    if uid == ctx.user_id:
        return Unsupported(
            reason_code="person_is_self",
            spoken_facts=["You can't send a connection request to yourself."],
        )
    try:
        snapshot = await load_people_snapshot(ctx)
        record = snapshot.people.get(uid)
        if record and record["relationship"] == "connected":
            return InvitePersonResult(
                status="already_connected",
                spoken_facts=[f"You're already connected with {name}."],
            )
        if record and record["relationship"] == "pending_outgoing":
            return _pending_result(
                name, {"id": record["request_id"]}, direction="outgoing", fresh=False
            )
        if record and record["relationship"] == "pending_incoming":
            return _pending_result(
                name, {"id": record["request_id"]}, direction="incoming", fresh=False
            )
        created = dict(
            await asyncio.to_thread(
                _connections(ctx).create_request,
                ctx.user_id,
                addressee_user_id=uid,
                message=(args.message or "").strip() or None,
            )
            or {}
        )
    except ConnectionsError as err:
        if err.code == "CONNECTION_ALREADY_CONNECTED":
            return InvitePersonResult(
                status="already_connected", spoken_facts=[f"You're already connected with {name}."]
            )
        return _rejected(err)
    except OneLocationAgentError as err:
        return _rejected(err)
    # Interpret what was committed, not what was expected.
    request_id = str(created.get("id") or "").strip()
    request_status = str(created.get("status") or "").strip()
    requester = str(created.get("requesterUserId") or "").strip()
    addressee = str(created.get("addresseeUserId") or "").strip()
    if not request_id or not request_status or not requester or not addressee:
        return Rejected(
            reason_code="malformed_request_result",
            spoken_facts=[
                f"I couldn't confirm whether the request to {name} went through. "
                "Check your pending requests before trying again."
            ],
        )
    if request_status != "pending":
        return Rejected(
            reason_code="request_not_pending",
            spoken_facts=[f"The request to {name} is {request_status}."],
        )
    if requester != ctx.user_id:
        # The service returned the other person's pending request to us:
        # they asked first. Nothing was sent backwards.
        if requester != uid or addressee != ctx.user_id:
            return Rejected(
                reason_code="malformed_request_result",
                spoken_facts=[f"I couldn't confirm the request to {name}; it names other people."],
            )
        return _pending_result(name, created, direction="incoming", fresh=True)
    if addressee != uid:
        # A request from us to somebody else is not this request.
        return Rejected(
            reason_code="malformed_request_result",
            spoken_facts=[f"I couldn't confirm the request to {name}; it names other people."],
        )
    known = ctx.entities.person(uid)
    if known is not None:
        ctx.entities.remember_person(known.model_copy(update={"relationship": "pending_outgoing"}))
    return InvitePersonResult(
        status="sent",
        request_id=request_id,
        request_status=request_status,
        direction="outgoing",
        spoken_facts=[f"Connection request sent to {name}. It's waiting for them to accept."],
    )


# -- accept_connection_request / decline_connection_request --------------------


class ConnectionRequestInput(ToolInput):
    request_id: str = Field(
        min_length=1, max_length=64, description="A request_id from list_people's pending_incoming."
    )
    person: PersonRef | None = Field(
        default=None,
        description="The confirmed person this request is from, when known. Only names the card.",
    )


class AcceptConnectionRequestResult(ToolResult):
    # ``accepted`` is an active connection now. ``scope_review_required`` opens
    # the request-review screen: the request carries information scopes that
    # only an explicit on-screen review can accept; opening it accepts nothing.
    status: Literal["accepted", "scope_review_required"]
    request_id: str
    user_id: str
    display_name: str
    request_status: Literal["accepted", "pending"]
    connection_id: str | None = None
    client_step: dict[str, Any] | None = None


class DeclineConnectionRequestResult(ToolResult):
    # A decline that went through is ``declined``; the row's own state is
    # ``request_status`` ("rejected" is what the service stores).
    status: Literal["declined"]
    request_id: str
    user_id: str
    display_name: str
    request_status: Literal["rejected"]


def _request_counterpart(ctx: ToolContext, request_id: str, ref: PersonRef | None) -> str | None:
    """The card names the request's real counterpart (from the server's own
    listing), never a name the model supplied."""
    offered = ctx.entities.offered_request(request_id)
    if offered is not None:
        return offered.display_name
    return _name(ctx, ref)


def _request_not_offered() -> Rejected:
    return Rejected(
        reason_code="request_not_offered",
        needs="disambiguation",
        spoken_facts=["I need to look up your requests first. One moment."],
    )


def summarize_accept(ctx: ToolContext, args: ConnectionRequestInput) -> str:
    name = _request_counterpart(ctx, args.request_id, args.person)
    return f"accept the connection request from {name}" if name else "accept the connection request"


def summarize_decline(ctx: ToolContext, args: ConnectionRequestInput) -> str:
    name = _request_counterpart(ctx, args.request_id, args.person)
    return (
        f"decline the connection request from {name}" if name else "decline the connection request"
    )


def _find_request(rows: list[dict[str, Any]], request_id: str) -> dict[str, Any] | None:
    return next((r for r in rows if r["request_id"] == request_id), None)


async def _incoming_request(
    ctx: ToolContext, args: ConnectionRequestInput
) -> tuple[PeopleSnapshot, dict[str, Any]] | Rejected:
    """The incoming request this id names, revalidated: it must be pending, addressed
    to this person, and -- when a person was named -- from that person."""
    if args.person is not None and ctx.entities.person(args.person.user_id) is None:
        return Rejected(reason_code="person_not_confirmed", needs="disambiguation")
    offered = ctx.entities.offered_request(args.request_id)
    if offered is None or offered.direction != "incoming":
        return _request_not_offered()
    snapshot = await load_people_snapshot(ctx)
    request = _find_request(snapshot.pending_incoming, args.request_id)
    if request is None:
        return Rejected(
            reason_code="request_not_found",
            spoken_facts=["That request isn't waiting for you anymore."],
        )
    if args.person is not None and args.person.user_id != request["user_id"]:
        return Rejected(
            reason_code="request_person_mismatch",
            needs="disambiguation",
            spoken_facts=[f"That request is from {request['display_name']}, not who you named."],
        )
    return snapshot, request


async def accept_connection_request(ctx: ToolContext, args: ConnectionRequestInput) -> ToolResult:
    try:
        found = await _incoming_request(ctx, args)
        if isinstance(found, Rejected):
            return found
        snapshot, request = found
        outcome = dict(
            await asyncio.to_thread(_connections(ctx).accept_request, ctx.user_id, args.request_id)
            or {}
        )
    except ConnectionsError as err:
        if err.code == "CONNECTION_SCOPE_SELECTION_REQUIRED":
            # The request carries information scopes. Only the review screen
            # can accept those, and only the person can choose them; the relay
            # re-reads the request after the screen closes and reports what
            # actually happened.
            return AcceptConnectionRequestResult(
                status="scope_review_required",
                needs="client_step",
                request_id=args.request_id,
                user_id=request["user_id"],
                display_name=request["display_name"],
                request_status="pending",
                client_step={
                    "kind": "open_request_review",
                    "purpose": "connection_scope_review",
                    "request_id": args.request_id,
                    "user_id": request["user_id"],
                    "display_name": request["display_name"],
                    "timeout_s": 600,
                },
                spoken_facts=[
                    f"{request['display_name']}'s request includes information they want to "
                    "share or see. I'm opening it so you can review that before accepting."
                ],
            )
        return _rejected(err)
    except OneLocationAgentError as err:
        return _rejected(err)
    status = str(outcome.get("status") or "")
    name = request["display_name"]
    if status != "accepted":
        return Rejected(
            reason_code="unexpected_request_status",
            spoken_facts=[f"The request from {name} is {status or 'in an unknown state'}."],
        )
    record = snapshot.people.get(request["user_id"]) or _blank_record(request["user_id"])
    record.update(relationship="connected", request_id=None, display_name=name)
    ctx.entities.remember_person(_confirmed(record))
    return AcceptConnectionRequestResult(
        status="accepted",
        request_id=args.request_id,
        user_id=request["user_id"],
        display_name=name,
        request_status="accepted",
        connection_id=str(outcome.get("connectionId") or "") or None,
        spoken_facts=[f"You're now connected with {name}."],
    )


class RequestReviewOutcome(ToolResult):
    """What a scope review actually did, decided from a re-read after the
    review screen reported back. The client's claim never decides."""

    status: Literal["accepted", "declined", "still_pending", "withdrawn", "review_unverified"]
    request_id: str
    user_id: str
    display_name: str
    request_status: str | None = None
    connection: bool = False


REQUEST_REVIEW_STEP = "open_request_review"


async def settle_request_review(
    ctx: ToolContext, *, request_id: str, user_id: str, display_name: str
) -> RequestReviewOutcome:
    """Re-read the request and the relationship after the review screen closed."""
    try:
        connections = _connections(ctx)
        rows = await asyncio.to_thread(
            connections.list_requests, ctx.user_id, direction="incoming", include_resolved=True
        )
        snapshot = await load_people_snapshot(ctx)
    except ServiceError:
        return RequestReviewOutcome(
            status="review_unverified",
            request_id=request_id,
            user_id=user_id,
            display_name=display_name,
            spoken_facts=[
                f"I couldn't check what happened with {display_name}'s request. "
                "Check your pending requests."
            ],
        )
    row = next((r for r in (rows or []) if str(r.get("id") or "") == request_id), None)
    record = snapshot.people.get(user_id)
    connected = bool(record and record.get("relationship") == "connected")
    request_status = str((row or {}).get("status") or "") or None
    base: dict[str, Any] = {
        "request_id": request_id,
        "user_id": user_id,
        "display_name": display_name,
        "request_status": request_status,
        "connection": connected,
    }
    # The request row decides. An active connection alone does not: two
    # people who were already connected can review a scoped request, and
    # declining it leaves them connected.
    if request_status == "accepted" or (row is None and connected):
        if record is not None:
            ctx.entities.remember_person(_confirmed(record))
        return RequestReviewOutcome(
            status="accepted",
            **base,
            spoken_facts=[f"You're now connected with {display_name}."],
        )
    if request_status == "pending":
        return RequestReviewOutcome(
            status="still_pending",
            **base,
            spoken_facts=[f"{display_name}'s request is still waiting for you."],
        )
    if request_status == "rejected":
        return RequestReviewOutcome(
            status="declined",
            **base,
            spoken_facts=[f"You declined {display_name}'s request."],
        )
    if request_status in {"cancelled", "expired"}:
        return RequestReviewOutcome(
            status="withdrawn",
            **base,
            spoken_facts=[f"{display_name}'s request is no longer open; it was {request_status}."],
        )
    return RequestReviewOutcome(
        status="review_unverified",
        **base,
        spoken_facts=[
            f"I couldn't find {display_name}'s request anymore, and you aren't connected. "
            "Check your pending requests."
        ],
    )


async def decline_connection_request(ctx: ToolContext, args: ConnectionRequestInput) -> ToolResult:
    try:
        found = await _incoming_request(ctx, args)
        if isinstance(found, Rejected):
            return found
        _, request = found
        outcome = dict(
            await asyncio.to_thread(_connections(ctx).reject_request, ctx.user_id, args.request_id)
            or {}
        )
    except ServiceError as err:
        return _rejected(err)
    status = str(outcome.get("status") or "")
    name = request["display_name"]
    if status != "rejected":
        return Rejected(
            reason_code="unexpected_request_status",
            spoken_facts=[f"The request from {name} is {status or 'in an unknown state'}."],
        )
    known = ctx.entities.person(request["user_id"])
    if known is not None:
        ctx.entities.remember_person(known.model_copy(update={"relationship": "none"}))
    return DeclineConnectionRequestResult(
        status="declined",
        request_id=args.request_id,
        user_id=request["user_id"],
        display_name=name,
        request_status="rejected",
        spoken_facts=[f"Declined the request from {name}."],
    )


# -- cancel_connection_request ---------------------------------------------


class CancelConnectionRequestInput(ToolInput):
    request_id: str = Field(
        min_length=1, max_length=64, description="A request_id from list_people's pending_outgoing."
    )
    person: PersonRef | None = Field(
        default=None,
        description="The confirmed person this request went to, when known. Only names the card.",
    )


class CancelConnectionRequestResult(ToolResult):
    status: Literal["cancelled"]
    request_id: str
    user_id: str
    display_name: str


def summarize_cancel(ctx: ToolContext, args: CancelConnectionRequestInput) -> str:
    name = _request_counterpart(ctx, args.request_id, args.person)
    return f"cancel your connection request to {name}" if name else "cancel your connection request"


async def cancel_connection_request(
    ctx: ToolContext, args: CancelConnectionRequestInput
) -> ToolResult:
    if args.person is not None and ctx.entities.person(args.person.user_id) is None:
        return Rejected(reason_code="person_not_confirmed", needs="disambiguation")
    offered = ctx.entities.offered_request(args.request_id)
    if offered is None or offered.direction != "outgoing":
        return _request_not_offered()
    try:
        snapshot = await load_people_snapshot(ctx)
        request = _find_request(snapshot.pending_outgoing, args.request_id)
        if request is None:
            return Rejected(
                reason_code="request_not_found",
                spoken_facts=["That request isn't pending anymore."],
            )
        if args.person is not None and args.person.user_id != request["user_id"]:
            return Rejected(
                reason_code="request_person_mismatch",
                needs="disambiguation",
                spoken_facts=[
                    f"That request went to {request['display_name']}, not who you named."
                ],
            )
        outcome = await asyncio.to_thread(
            _connections(ctx).cancel_request, ctx.user_id, args.request_id
        )
    except ServiceError as err:
        return _rejected(err)
    status = str((outcome or {}).get("status") or "")
    name = request["display_name"]
    if status != "cancelled":
        return Rejected(
            reason_code="unexpected_request_status",
            spoken_facts=[f"The request to {name} is {status or 'in an unknown state'}."],
        )
    known = ctx.entities.person(request["user_id"])
    if known is not None:
        ctx.entities.remember_person(known.model_copy(update={"relationship": "none"}))
    return CancelConnectionRequestResult(
        status="cancelled",
        request_id=args.request_id,
        user_id=request["user_id"],
        display_name=name,
        spoken_facts=[f"Cancelled your request to {name}."],
    )


# -- remove_connection ------------------------------------------------------


class RemoveConnectionInput(ToolInput):
    person: PersonRef


class RemoveConnectionResult(ToolResult):
    # ``removed`` is verified on a re-read; ``unverified`` means the service
    # reported a removal the re-read could not confirm.
    status: Literal["removed", "not_connected", "unverified"]
    user_id: str
    display_name: str
    relationship_after: str | None = None


def summarize_remove(ctx: ToolContext, args: RemoveConnectionInput) -> str:
    who = _name(ctx, args.person) or "this person"
    return (
        f"disconnect from {who}: this ends your connection everywhere, including any circle "
        "memberships that came from it"
    )


async def remove_connection(ctx: ToolContext, args: RemoveConnectionInput) -> ToolResult:
    uid = args.person.user_id
    name = _name(ctx, args.person) or "this person"
    try:
        snapshot = await load_people_snapshot(ctx)
        record = snapshot.people.get(uid)
        connection_id = (record or {}).get("connection_id")
        if not record or record["relationship"] != "connected" or not connection_id:
            return RemoveConnectionResult(
                status="not_connected",
                user_id=uid,
                display_name=name,
                relationship_after=(record or {}).get("relationship") or "none",
                spoken_facts=[f"You're not connected with {name}."],
            )
        outcome = await asyncio.to_thread(
            _connections(ctx).remove_connection, ctx.user_id, connection_id
        )
    except ServiceError as err:
        return _rejected(err)
    if not int((outcome or {}).get("removed") or 0):
        return RemoveConnectionResult(
            status="not_connected",
            user_id=uid,
            display_name=name,
            relationship_after="none",
            spoken_facts=[f"You're not connected with {name}."],
        )
    # Verify the post-state rather than narrate the intent. The removal is
    # committed by now: a failed re-read is "unverified", never a refusal.
    try:
        _, after = await _fresh_record(ctx, uid)
    except ServiceError:
        return RemoveConnectionResult(
            status="unverified",
            user_id=uid,
            display_name=name,
            relationship_after=None,
            spoken_facts=[
                f"The disconnect from {name} went through, but I couldn't re-check it. "
                "Check your connections."
            ],
        )
    relationship_after = str((after or {}).get("relationship") or "none")
    known = ctx.entities.person(uid)
    if after is not None and relationship_after != "connected":
        # Whatever the directory says about their key, they can no longer
        # receive this person's location.
        ctx.entities.remember_person(_confirmed(dict(after, has_location_key=False)))
    elif after is None and known is not None:
        ctx.entities.remember_person(
            known.model_copy(update={"relationship": "none", "has_location_key": False})
        )
    if relationship_after == "connected":
        return RemoveConnectionResult(
            status="unverified",
            user_id=uid,
            display_name=name,
            relationship_after=relationship_after,
            spoken_facts=[
                f"I asked to disconnect from {name}, but they still show as connected. "
                "Check your connections."
            ],
        )
    return RemoveConnectionResult(
        status="removed",
        user_id=uid,
        display_name=name,
        relationship_after=relationship_after,
        spoken_facts=[f"You're no longer connected with {name}."],
    )


# -- catalog ----------------------------------------------------------------


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="resolve_person",
        gateway_action_id="connect.search_people",
        policy=ToolPolicy.read,
        input_model=ResolvePersonInput,
        output_model=ResolvePersonResult,
        description=(
            "Find who the person means by a spoken name, searching by name only (never by "
            "phone or email, and never the device's contacts). Returns candidates to read back; "
            "it never picks one. Always follow with confirm_person after the person agrees, "
            "even when only one candidate is likely. pool='connections' for people already in "
            "their life; pool='directory' for anyone findable on Hussh, to connect with someone "
            "new. A relative ('my uncle') is not a name: ask for the name first."
        ),
        handler=resolve_person,
    ),
    ToolSpec(
        name="confirm_person",
        gateway_action_id="connect.search_people",
        policy=ToolPolicy.read,
        input_model=ConfirmPersonInput,
        output_model=ConfirmPersonResult,
        description=(
            "Confirm one candidate from the last resolve_person or list_circle_members by "
            "user_id, after the person said which one they meant. Only ids from that most "
            "recent offer are accepted; confirming who they meant approves no action."
        ),
        handler=confirm_person,
    ),
    ToolSpec(
        name="list_people",
        gateway_action_id="location.open_people",
        policy=ToolPolicy.read,
        input_model=ListPeopleInput,
        output_model=ListPeopleResult,
        description=(
            "Read who the person is connected with, one page at a time (optionally filtered by "
            "name), who can receive their location, and pending connection requests in both "
            "directions with their request ids. counts carry the totals; the page is not the "
            "total. Read only."
        ),
        handler=list_people,
    ),
    ToolSpec(
        name="get_person",
        gateway_action_id="location.open_people",
        policy=ToolPolicy.read,
        input_model=GetPersonInput,
        output_model=GetPersonResult,
        description=(
            "Fresh relationship (connected, request pending either way, or not connected) and "
            "Location readiness for one confirmed person. Read only."
        ),
        handler=get_person,
        person_args=("person",),
    ),
    ToolSpec(
        name="invite_person",
        gateway_action_id="connect.send_request",
        policy=ToolPolicy.confirm_voice,
        input_model=InvitePersonInput,
        output_model=InvitePersonResult,
        description=(
            "Send a plain in-app connection request from the signed-in person to one confirmed "
            "account. It requests a connection: it does not accept on their behalf, add a "
            "circle member, request location, or attach information-sharing scopes. The result "
            "is the real outcome: sent (with the request id, waiting for acceptance), "
            "already_connected, or already_pending with its direction (if they already asked "
            "you, accept that instead). Needs its own confirmation; confirming who they meant "
            "is not approval to send."
        ),
        handler=invite_person,
        person_args=("person",),
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_invite,
    ),
    ToolSpec(
        name="accept_connection_request",
        gateway_action_id="connect.accept_request",
        policy=ToolPolicy.confirm_voice,
        input_model=ConnectionRequestInput,
        output_model=AcceptConnectionRequestResult,
        description=(
            "Accept one incoming connection request by request_id (from list_people's "
            "pending_incoming). accepted means you are connected now; it starts no location "
            "sharing. If the request carries information scopes it returns "
            "scope_review_required and opens the review screen instead: opening it accepts "
            "nothing, and the real outcome arrives afterwards."
        ),
        handler=accept_connection_request,
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_accept,
    ),
    ToolSpec(
        name="decline_connection_request",
        gateway_action_id="connect.reject_request",
        policy=ToolPolicy.confirm_voice,
        input_model=ConnectionRequestInput,
        output_model=DeclineConnectionRequestResult,
        description=(
            "Decline one incoming connection request by request_id (from list_people's "
            "pending_incoming). declined closes that request; it does not block anyone and "
            "they may ask again later."
        ),
        handler=decline_connection_request,
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_decline,
    ),
    ToolSpec(
        name="cancel_connection_request",
        gateway_action_id="connect.cancel_request",
        policy=ToolPolicy.confirm_tap,
        input_model=CancelConnectionRequestInput,
        output_model=CancelConnectionRequestResult,
        description=(
            "Withdraw one connection request the person sent, by request_id "
            "(from list_people's pending_outgoing). Needs a tap on the confirmation card."
        ),
        handler=cancel_connection_request,
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_cancel,
    ),
    ToolSpec(
        name="remove_connection",
        gateway_action_id="connect.remove_connection",
        policy=ToolPolicy.confirm_tap,
        input_model=RemoveConnectionInput,
        output_model=RemoveConnectionResult,
        description=(
            "End the connection with a confirmed person everywhere: location sharing with them "
            "stops and circle memberships that came from the connection end too. This is not "
            "removing them from one circle (remove_circle_member) and there is no block. Needs "
            "a tap on the confirmation card; the result is verified on a re-read."
        ),
        handler=remove_connection,
        person_args=("person",),
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_remove,
    ),
)


__all__ = [
    "PeopleSnapshot",
    "REQUEST_REVIEW_STEP",
    "TOOLS",
    "load_connected_people",
    "load_people_snapshot",
    "looks_like_contact_identifier",
    "settle_request_review",
]
