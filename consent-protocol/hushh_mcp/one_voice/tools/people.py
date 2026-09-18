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
    status: Literal["single_likely", "multiple", "none", "low_confidence", "no_connections"]
    spoken_name: str
    pool: Literal["connections", "directory"]
    candidates: list[PersonCandidate] = Field(default_factory=list)


async def _directory_candidates(ctx: ToolContext, target: str) -> list[dict[str, Any]]:
    connections = _connections(ctx)
    page = await asyncio.to_thread(
        connections.search_directory, ctx.user_id, query=target, page=1, limit=DIRECTORY_LIMIT
    )
    items = list((page or {}).get("items") or [])
    first = target.split(" ")[0]
    if not items and len(first) >= 2:
        # The directory is prefix-only in SQL; a short prefix pulls in the
        # near-spellings so the phonetic ranking below can consider them.
        page = await asyncio.to_thread(
            connections.search_directory,
            ctx.user_id,
            query=first[:2],
            page=1,
            limit=DIRECTORY_LIMIT,
        )
        items = list((page or {}).get("items") or [])
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
    return records


async def resolve_person(ctx: ToolContext, args: ResolvePersonInput) -> ToolResult:
    names = split_spoken_names(args.spoken_name)
    if len(names) != 1:
        ctx.entities.offer_people([])
        return Rejected(
            reason_code="one_name_at_a_time",
            needs="repeat_name",
            spoken_facts=["One person at a time, please. Who first?"],
        )
    target = normalize_spoken_name(names[0])
    if not target:
        ctx.entities.offer_people([])
        return Rejected(reason_code="invalid_arguments", needs="repeat_name")

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
            pool = await _directory_candidates(ctx, target)
            for record in pool:
                known = snapshot.people.get(record["user_id"])
                if known:
                    record["has_location_key"] = known["has_location_key"]
                    record["phone_verified"] = known["phone_verified"]
    except ServiceError as err:
        ctx.entities.offer_people([])
        return _rejected(err)

    ranked = rank_candidates(target, pool)
    ctx.entities.offer_people([item.user_id for item in ranked])
    candidates = [_candidate(item) for item in ranked]
    where = "your connections" if args.pool == "connections" else "the Hussh directory"
    if not ranked:
        return ResolvePersonResult(
            status="none",
            needs="repeat_name",
            spoken_name=names[0],
            pool=args.pool,
            spoken_facts=[f"Nobody in {where} matches that name."],
        )
    names_spoken = join_names_for_speech([item.display_name for item in ranked])
    if ranked[0].tier >= TIER_PHONETIC:
        return ResolvePersonResult(
            status="low_confidence",
            needs="repeat_name",
            spoken_name=names[0],
            pool=args.pool,
            candidates=candidates,
            spoken_facts=[f"The closest in {where} is {names_spoken}."],
        )
    if len(ranked) == 1:
        person = _confirmed(ranked[0].candidate)
        return ResolvePersonResult(
            status="single_likely",
            needs="confirmation",
            spoken_name=names[0],
            pool=args.pool,
            candidates=candidates,
            spoken_facts=[f"I found {person.spoken()}."],
        )
    return ResolvePersonResult(
        status="multiple",
        needs="disambiguation",
        spoken_name=names[0],
        pool=args.pool,
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
    pass


class ListPeopleResult(ToolResult):
    status: Literal["ok", "no_connections"]
    connected: list[PersonCard] = Field(default_factory=list)
    ready_for_location: list[PersonCard] = Field(default_factory=list)
    pending_incoming: list[PendingRequest] = Field(default_factory=list)
    pending_outgoing: list[PendingRequest] = Field(default_factory=list)
    counts: PeopleCounts


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return f"{count} {singular if count == 1 else (plural or singular + 's')}"


async def list_people(ctx: ToolContext, args: ListPeopleInput) -> ToolResult:
    try:
        snapshot = await load_people_snapshot(ctx)
    except ServiceError as err:
        return _rejected(err)
    connected = sorted(snapshot.connected, key=_by_name)
    ready = sorted(snapshot.ready_for_location, key=_by_name)
    counts = snapshot.counts()
    facts: list[str] = []
    if not connected:
        facts.append("You don't have anyone connected yet.")
    elif len(connected) <= 5:
        facts.append(
            f"You're connected with {join_names_for_speech([p['display_name'] for p in connected])}."
        )
    else:
        facts.append(f"You have {_plural(len(connected), 'connection')}.")
    if ready:
        facts.append(f"{_plural(len(ready), 'person', 'people')} can receive your location.")
    if snapshot.pending_incoming:
        facts.append(
            f"{join_names_for_speech([r['display_name'] for r in snapshot.pending_incoming[:5]])} "
            f"asked to connect with you."
        )
    if snapshot.pending_outgoing:
        facts.append(
            f"Your request to "
            f"{join_names_for_speech([r['display_name'] for r in snapshot.pending_outgoing[:5]])} "
            f"is still pending."
        )
    return ListPeopleResult(
        status="ok" if connected else "no_connections",
        needs=None if connected else "invite",
        connected=[_card(p) for p in connected],
        ready_for_location=[_card(p) for p in ready],
        pending_incoming=[PendingRequest(**r) for r in snapshot.pending_incoming],
        pending_outgoing=[PendingRequest(**r) for r in snapshot.pending_outgoing],
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
    message: str | None = Field(default=None, max_length=280)


class InvitePersonResult(ToolResult):
    status: Literal["sent", "already_connected", "already_pending", "unsupported"]
    request_id: str | None = None
    request_status: str | None = None
    direction: Literal["incoming", "outgoing"] | None = None


def summarize_invite(ctx: ToolContext, args: InvitePersonInput) -> str:
    return f"send a connection request to {_name(ctx, args.person) or 'this person'}"


async def invite_person(ctx: ToolContext, args: InvitePersonInput) -> ToolResult:
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
            return InvitePersonResult(
                status="already_pending",
                request_id=record["request_id"],
                request_status="pending",
                direction="outgoing",
                spoken_facts=[f"Your request to {name} is still pending."],
            )
        if record and record["relationship"] == "pending_incoming":
            return InvitePersonResult(
                status="already_pending",
                request_id=record["request_id"],
                request_status="pending",
                direction="incoming",
                spoken_facts=[f"{name} already asked to connect with you. You can accept it."],
            )
        created = await asyncio.to_thread(
            _connections(ctx).create_request,
            ctx.user_id,
            addressee_user_id=uid,
            message=(args.message or "").strip() or None,
        )
    except ConnectionsError as err:
        if err.code == "CONNECTION_ALREADY_CONNECTED":
            return InvitePersonResult(
                status="already_connected", spoken_facts=[f"You're already connected with {name}."]
            )
        return _rejected(err)
    except OneLocationAgentError as err:
        return _rejected(err)
    request_status = str((created or {}).get("status") or "pending")
    if request_status != "pending":
        return Rejected(
            reason_code="request_not_pending",
            spoken_facts=[f"The request to {name} is {request_status}."],
        )
    return InvitePersonResult(
        status="sent",
        request_id=str((created or {}).get("id") or "") or None,
        request_status=request_status,
        direction="outgoing",
        spoken_facts=[f"Connection request sent to {name}."],
    )


# -- respond_connection_request --------------------------------------------


class RespondConnectionRequestInput(ToolInput):
    request_id: str = Field(
        min_length=1, max_length=64, description="A request_id from list_people's pending_incoming."
    )
    accept: bool = Field(description="true to accept, false to decline.")
    person: PersonRef | None = Field(
        default=None,
        description="The confirmed person this request is from, when known. Only names the card.",
    )


class RespondConnectionRequestResult(ToolResult):
    status: Literal["accepted", "rejected"]
    request_id: str
    user_id: str
    display_name: str
    connection_id: str | None = None


def summarize_respond(ctx: ToolContext, args: RespondConnectionRequestInput) -> str:
    verb = "accept" if args.accept else "decline"
    name = _name(ctx, args.person)
    return (
        f"{verb} the connection request from {name}" if name else f"{verb} the connection request"
    )


def _find_request(rows: list[dict[str, Any]], request_id: str) -> dict[str, Any] | None:
    return next((row for row in rows if row["request_id"] == request_id), None)


async def respond_connection_request(
    ctx: ToolContext, args: RespondConnectionRequestInput
) -> ToolResult:
    if args.person is not None and ctx.entities.person(args.person.user_id) is None:
        return Rejected(reason_code="person_not_confirmed", needs="disambiguation")
    try:
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
                spoken_facts=[
                    f"That request is from {request['display_name']}, not who you named."
                ],
            )
        connections = _connections(ctx)
        if args.accept:
            outcome = await asyncio.to_thread(
                connections.accept_request, ctx.user_id, args.request_id
            )
        else:
            outcome = await asyncio.to_thread(
                connections.reject_request, ctx.user_id, args.request_id
            )
    except ServiceError as err:
        return _rejected(err)
    status = str((outcome or {}).get("status") or "")
    name = request["display_name"]
    if status == "accepted":
        record = snapshot.people.get(request["user_id"]) or _blank_record(request["user_id"])
        record.update(relationship="connected", request_id=None, display_name=name)
        ctx.entities.remember_person(_confirmed(record))
        return RespondConnectionRequestResult(
            status="accepted",
            request_id=args.request_id,
            user_id=request["user_id"],
            display_name=name,
            connection_id=str((outcome or {}).get("connectionId") or "") or None,
            spoken_facts=[f"You're now connected with {name}."],
        )
    if status == "rejected":
        return RespondConnectionRequestResult(
            status="rejected",
            request_id=args.request_id,
            user_id=request["user_id"],
            display_name=name,
            spoken_facts=[f"Declined the request from {name}."],
        )
    return Rejected(
        reason_code="unexpected_request_status",
        spoken_facts=[f"The request from {name} is {status or 'in an unknown state'}."],
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
    name = _name(ctx, args.person)
    return f"cancel your connection request to {name}" if name else "cancel your connection request"


async def cancel_connection_request(
    ctx: ToolContext, args: CancelConnectionRequestInput
) -> ToolResult:
    if args.person is not None and ctx.entities.person(args.person.user_id) is None:
        return Rejected(reason_code="person_not_confirmed", needs="disambiguation")
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
    status: Literal["removed", "not_connected"]
    user_id: str
    display_name: str


def summarize_remove(ctx: ToolContext, args: RemoveConnectionInput) -> str:
    return f"remove {_name(ctx, args.person) or 'this person'} from your connections"


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
            spoken_facts=[f"You're not connected with {name}."],
        )
    record.update(relationship="none", connection_id=None, has_location_key=False)
    ctx.entities.remember_person(_confirmed(record))
    return RemoveConnectionResult(
        status="removed",
        user_id=uid,
        display_name=name,
        spoken_facts=[f"Removed {name} from your connections."],
    )


# -- catalog ----------------------------------------------------------------


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="resolve_person",
        gateway_action_id="location.find_contacts",
        policy=ToolPolicy.read,
        input_model=ResolvePersonInput,
        output_model=ResolvePersonResult,
        description=(
            "Find who the person means by a spoken name. Returns candidates to read back; it "
            "never picks one. Always follow with confirm_person after the person agrees, even "
            "when only one candidate is likely. Use pool='directory' only to invite someone new."
        ),
        handler=resolve_person,
    ),
    ToolSpec(
        name="confirm_person",
        gateway_action_id="location.find_contacts",
        policy=ToolPolicy.read,
        input_model=ConfirmPersonInput,
        output_model=ConfirmPersonResult,
        description=(
            "Confirm one candidate from the last resolve_person by user_id, after the person "
            "said which one they meant. Only offered ids are accepted."
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
            "List the person's connections, who can receive their location, and pending "
            "connection requests in both directions. Read only."
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
            "Fresh relationship and Location readiness for one confirmed person, plus the "
            "person's people counts. Read only."
        ),
        handler=get_person,
        person_args=("person",),
    ),
    ToolSpec(
        name="invite_person",
        gateway_action_id="people.profile.connect",
        policy=ToolPolicy.confirm_voice,
        input_model=InvitePersonInput,
        output_model=InvitePersonResult,
        description=(
            "Send a connection request to a confirmed person. Connecting grants no information. "
            "Reports already_connected or already_pending instead of sending twice."
        ),
        handler=invite_person,
        person_args=("person",),
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_invite,
    ),
    ToolSpec(
        name="respond_connection_request",
        gateway_action_id="people.profile.connect",
        policy=ToolPolicy.confirm_voice,
        input_model=RespondConnectionRequestInput,
        output_model=RespondConnectionRequestResult,
        description=(
            "Accept or decline one incoming connection request by request_id "
            "(from list_people's pending_incoming)."
        ),
        handler=respond_connection_request,
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_respond,
    ),
    ToolSpec(
        name="cancel_connection_request",
        gateway_action_id="people.profile.cancel_connection_request",
        policy=ToolPolicy.confirm_tap,
        input_model=CancelConnectionRequestInput,
        output_model=CancelConnectionRequestResult,
        description=(
            "Withdraw one connection request the person sent, by request_id "
            "(from list_people's pending_outgoing)."
        ),
        handler=cancel_connection_request,
        ui_refresh=PEOPLE_REFRESH,
        firebase_plane=True,
        summarize=summarize_cancel,
    ),
    ToolSpec(
        name="remove_connection",
        gateway_action_id="people.profile.remove_connection",
        policy=ToolPolicy.confirm_tap,
        input_model=RemoveConnectionInput,
        output_model=RemoveConnectionResult,
        description=(
            "End the connection with a confirmed person. Location sharing with them stops; "
            "other consent is governed separately."
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
    "TOOLS",
    "load_connected_people",
    "load_people_snapshot",
]
