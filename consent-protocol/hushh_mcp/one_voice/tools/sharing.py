"""Sharing tools: location requests, private shares, check-ins, public links.

Every mutation here runs on the vault-owner plane through
:class:`OneLocationAgentService` (sync SQLAlchemy, called via
``asyncio.to_thread``). People are only ever addressed by a confirmed
``PersonRef``; the display name read back comes from the conversation's
:class:`EntityContext`, never from the model.

Two honesty rules shape every result:

* A grant is not a share until the device has published a position. The
  server cannot do that, so ``share_with`` / ``create_check_in`` return
  ``needs="client_step"`` with a ``publish_location_envelopes`` step and never
  say "shared".
* A request is a question, not access. ``request_location`` says the other
  person still has to approve, and quotes the request's real expiry.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    ConfirmedPerson,
    PersonRef,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.operons.location.policy import (
    TIMED_LOCATION_SHARE_DURATION_MODE,
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
    format_duration_label,
)
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)

LOCATION_SERVICE = "location"

SHARING_OFF_FACT = "Location sharing is off. Turn it on first."
PUBLISH_STEP_KIND = "publish_location_envelopes"
SHARE_SHEET_STEP_KIND = "open_share_sheet"

RequestStatus = Literal["pending", "approved", "denied", "cancelled", "expired"]


# -- shared helpers ------------------------------------------------------------


def _service(ctx: ToolContext) -> OneLocationAgentService:
    service: OneLocationAgentService = ctx.service(LOCATION_SERVICE, OneLocationAgentService)
    return service


async def _run(fn: Any, /, **kwargs: Any) -> Any:
    """Canonical Location services are sync; keep them off the event loop."""
    return await asyncio.to_thread(fn, **kwargs)


def _rejected(exc: OneLocationAgentError) -> Rejected:
    if exc.code == "LOCATION_SHARING_OFF":
        return Rejected(
            reason_code="LOCATION_SHARING_OFF", needs="setup", spoken_facts=[SHARING_OFF_FACT]
        )
    return Rejected(reason_code=exc.code, spoken_facts=[exc.message])


def _invalid_id(field: str) -> Rejected:
    return Rejected(
        reason_code="invalid_id",
        spoken_facts=[
            f"I don't have a valid {field.replace('_', ' ')} for that. Read the list first."
        ],
    )


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value or ""))
    except (ValueError, TypeError, AttributeError):
        return False
    return True


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _remaining_label(expires_at: Any, *, now: datetime | None = None) -> str:
    """``"45 minutes"`` / ``"2 hours"`` still to run, or ``""`` when unknown or past."""
    parsed = _parse_iso(expires_at)
    if parsed is None:
        return ""
    remaining_hours = (parsed - (now or datetime.now(timezone.utc))).total_seconds() / 3600
    if remaining_hours <= 0:
        return ""
    # ``format_duration_label`` lives in the un-followed operons package; pin its str contract.
    label: str = format_duration_label(remaining_hours)
    return label


def _duration_phrase(duration_hours: float | None, duration_mode: str | None) -> str:
    """How long a share runs, the way a person says it."""
    if duration_mode == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE:
        return "until you stop it"
    label = format_duration_label(duration_hours)
    return f"for {label}" if label else ""


def _name_for(ctx: ToolContext, user_id: Any, *, service_name: Any = None) -> str | None:
    """A display name from the service result, else from the confirmed entities."""
    label = str(service_name or "").strip()
    if label:
        return label
    person = ctx.entities.person(str(user_id or "")) if user_id else None
    return person.display_name if person is not None else None


def _person_gate(
    ctx: ToolContext, ref: PersonRef
) -> tuple[ConfirmedPerson | None, dict[str, Any] | None]:
    """Return ``(person, problem)``. ``problem`` is result kwargs when the confirmed
    person cannot be targeted; the caller wraps them in its own result model."""
    person = ctx.entities.person(ref.user_id)
    if person is None:
        return None, None
    if person.relationship == "self":
        return person, {
            "status": "rejected",
            "reason_code": "self_target",
            "spoken_facts": ["That's you. Pick someone else."],
        }
    if person.relationship != "connected":
        return person, {
            "status": "not_connected",
            "needs": "invite",
            "reason_code": "not_connected",
            "spoken_facts": [
                f"You are not connected with {person.display_name} yet. Would you like to invite them first?"
            ],
        }
    if not person.has_location_key:
        return person, {
            "status": "recipient_not_ready",
            "reason_code": "recipient_not_ready",
            "spoken_facts": [
                f"{person.display_name} hasn't set up Location on their device yet, so they can't receive it."
            ],
        }
    return person, None


def _not_confirmed() -> Rejected:
    return Rejected(
        reason_code="person_not_confirmed",
        needs="disambiguation",
        spoken_facts=["I need to confirm who you mean first."],
    )


def _gate_result(model: type[ToolResult], problem: dict[str, Any], **extra: Any) -> ToolResult:
    if problem["status"] == "rejected":
        return Rejected(reason_code=problem["reason_code"], spoken_facts=problem["spoken_facts"])
    return model(**problem, **extra)


def _publish_step(grant_id: str, purpose: str) -> dict[str, Any]:
    return {"kind": PUBLISH_STEP_KIND, "grant_ids": [grant_id], "purpose": purpose}


# -- request_location ----------------------------------------------------------


class RequestLocationInput(ToolInput):
    person: PersonRef = Field(description="The confirmed person whose location to ask for.")
    duration_hours: float = Field(
        default=1,
        gt=0,
        le=24,
        description="How long you want to see them for, in hours (15 minutes to 24 hours). Default 1.",
    )
    message: str | None = Field(
        default=None,
        max_length=500,
        description="Optional short note the person sees with the request.",
    )


class RequestLocationResult(ToolResult):
    status: Literal[
        "pending", "approved", "not_connected", "recipient_not_ready", "already_pending"
    ]
    request_id: str | None = None
    person_user_id: str | None = None
    display_name: str | None = None
    requested_duration_hours: float | None = None
    is_extension: bool = False
    expires_at: str | None = None
    grant_id: str | None = None


async def request_location(ctx: ToolContext, args: RequestLocationInput) -> ToolResult:
    person, problem = _person_gate(ctx, args.person)
    if person is None:
        return _not_confirmed()
    if problem is not None:
        return _gate_result(
            RequestLocationResult,
            problem,
            person_user_id=person.user_id,
            display_name=person.display_name,
        )
    service = _service(ctx)
    name = person.display_name

    try:
        open_requests = await _run(
            service.list_pending_requester_requests, requester_user_id=ctx.user_id
        )
    except OneLocationAgentError as exc:
        return _rejected(exc)
    for existing in open_requests or []:
        if str(existing.get("ownerUserId") or "") != person.user_id:
            continue
        remaining = _remaining_label(existing.get("expiresAt"))
        facts = [
            f"You already asked {name} for their location; that request is still waiting for their approval."
        ]
        if remaining:
            facts.append(f"It stays open for another {remaining}.")
        return RequestLocationResult(
            status="already_pending",
            reason_code="request_already_pending",
            request_id=str(existing.get("id") or "") or None,
            person_user_id=person.user_id,
            display_name=name,
            requested_duration_hours=existing.get("requestedDurationHours"),
            is_extension=bool(existing.get("isExtension")),
            expires_at=existing.get("expiresAt"),
            spoken_facts=facts,
        )

    try:
        request = await _run(
            service.request_access,
            requester_user_id=ctx.user_id,
            owner_user_id=person.user_id,
            message=args.message,
            requested_duration_hours=args.duration_hours,
            requested_duration_mode=TIMED_LOCATION_SHARE_DURATION_MODE,
        )
    except OneLocationAgentError as exc:
        return _rejected(exc)

    request = dict(request or {})
    request_status = str(request.get("status") or "")
    label = format_duration_label(request.get("requestedDurationHours"))
    is_extension = bool(request.get("isExtension"))
    common: dict[str, Any] = {
        "request_id": str(request.get("id") or "") or None,
        "person_user_id": person.user_id,
        "display_name": name,
        "requested_duration_hours": request.get("requestedDurationHours"),
        "is_extension": is_extension,
        "expires_at": request.get("expiresAt"),
        "grant_id": str(request.get("approvedGrantId") or "") or None,
    }
    if request_status == "approved":
        return RequestLocationResult(
            status="approved",
            spoken_facts=[f"{name} approved your request; their location is on its way."],
            **common,
        )
    if request_status != "pending":
        return Rejected(
            reason_code="LOCATION_REQUEST_STATE_UNEXPECTED",
            spoken_facts=[f"The request to {name} is {request_status or 'in an unknown state'}."],
        )
    if is_extension and label:
        facts = [f"Asked {name} for {label} more on the share you already have."]
    elif label:
        facts = [f"Asked {name} to share their location for {label}."]
    else:
        facts = [f"Asked {name} to share their location."]
    facts.append("They need to approve it before you can see where they are.")
    remaining = _remaining_label(request.get("expiresAt"))
    if remaining:
        facts.append(f"The request stays open for {remaining}.")
    return RequestLocationResult(status="pending", spoken_facts=facts, **common)


def summarize_request_location(ctx: ToolContext, args: RequestLocationInput) -> str:
    person = ctx.entities.person(args.person.user_id)
    name = person.display_name if person is not None else "them"
    label = format_duration_label(args.duration_hours) or "1 hour"
    return f"ask {name} for their location for {label}"


# -- list_requests -------------------------------------------------------------


class ListRequestsInput(ToolInput):
    direction: Literal["incoming", "outgoing", "all"] = Field(
        default="all",
        description="incoming = people asking for your location; outgoing = requests you sent.",
    )


class ListRequestsResult(ToolResult):
    status: Literal["ok", "empty"]
    direction: str = "all"
    requests: list[dict[str, Any]] = Field(default_factory=list)
    incoming_pending: int = 0
    outgoing_pending: int = 0


def _request_item(ctx: ToolContext, row: dict[str, Any], *, direction: str) -> dict[str, Any]:
    if direction == "incoming":
        counterpart_id = str(row.get("requesterUserId") or "")
        counterpart_name = _name_for(
            ctx, counterpart_id, service_name=row.get("requesterDisplayName")
        )
    else:
        counterpart_id = str(row.get("ownerUserId") or "")
        counterpart_name = _name_for(ctx, counterpart_id, service_name=row.get("ownerDisplayName"))
    return {
        "request_id": str(row.get("id") or ""),
        "direction": direction,
        "status": str(row.get("status") or "pending"),
        "counterpart_user_id": counterpart_id,
        "counterpart_name": counterpart_name,
        "requested_duration_hours": row.get("requestedDurationHours"),
        "requested_duration_mode": row.get("requestedDurationMode"),
        "is_extension": bool(row.get("isExtension")),
        "message": row.get("message"),
        "requested_at": row.get("requestedAt"),
        "expires_at": row.get("expiresAt"),
        "resolved_at": row.get("resolvedAt"),
        "approved_grant_id": row.get("approvedGrantId"),
    }


def _names(items: list[dict[str, Any]]) -> str:
    labels = [str(item.get("counterpart_name") or "someone") for item in items]
    if len(labels) == 1:
        return labels[0]
    return ", ".join(labels[:-1]) + f" and {labels[-1]}"


async def list_requests(ctx: ToolContext, args: ListRequestsInput) -> ToolResult:
    service = _service(ctx)
    try:
        state = await _run(service.list_state, user_id=ctx.user_id)
    except OneLocationAgentError as exc:
        return _rejected(exc)
    rows = list((state or {}).get("requests") or [])
    items: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("ownerUserId") or "") == ctx.user_id:
            direction = "incoming"
        elif str(row.get("requesterUserId") or "") == ctx.user_id:
            direction = "outgoing"
        else:
            continue
        if args.direction != "all" and direction != args.direction:
            continue
        items.append(_request_item(ctx, row, direction=direction))

    incoming_pending = [
        item for item in items if item["direction"] == "incoming" and item["status"] == "pending"
    ]
    outgoing_pending = [
        item for item in items if item["direction"] == "outgoing" and item["status"] == "pending"
    ]
    facts: list[str] = []
    if incoming_pending:
        count = len(incoming_pending)
        facts.append(
            f"{count} {'request is' if count == 1 else 'requests are'} waiting for your approval: "
            f"{_names(incoming_pending)}."
        )
    if outgoing_pending:
        count = len(outgoing_pending)
        facts.append(
            f"{count} {'request' if count == 1 else 'requests'} you sent {'is' if count == 1 else 'are'} "
            f"still waiting: {_names(outgoing_pending)}."
        )
    settled = len(items) - len(incoming_pending) - len(outgoing_pending)
    if settled:
        facts.append(
            f"{settled} earlier {'request has' if settled == 1 else 'requests have'} already been settled."
        )
    if not items:
        facts = [
            {
                "incoming": "No location requests are waiting for your approval.",
                "outgoing": "You have no location requests out.",
                "all": "No location requests right now.",
            }[args.direction]
        ]
    return ListRequestsResult(
        status="ok" if items else "empty",
        direction=args.direction,
        requests=items,
        incoming_pending=len(incoming_pending),
        outgoing_pending=len(outgoing_pending),
        spoken_facts=facts,
    )


# -- respond_request -----------------------------------------------------------


class RespondRequestInput(ToolInput):
    request_id: str = Field(
        min_length=1, max_length=64, description="Request id from list_requests (incoming)."
    )
    approve: bool = Field(description="true to approve and start sharing, false to decline.")
    duration_hours: float | None = Field(
        default=None,
        gt=0,
        le=24,
        description="On approve: how long to share, in hours. Leave unset to give what they asked for.",
    )


class RespondRequestResult(ToolResult):
    status: Literal["approved", "denied", "not_found", "expired"]
    request_id: str | None = None
    requester_user_id: str | None = None
    requester_name: str | None = None
    grant_id: str | None = None
    duration_hours: float | None = None
    duration_mode: str | None = None
    expires_at: str | None = None
    client_step: dict[str, Any] | None = None


def _request_gone(
    model: type[ToolResult], exc: OneLocationAgentError, **extra: Any
) -> ToolResult | None:
    if exc.code == "LOCATION_REQUEST_NOT_FOUND":
        return model(
            status="not_found",
            reason_code=exc.code,
            spoken_facts=["There's no pending location request with that id."],
            **extra,
        )
    if exc.code == "LOCATION_REQUEST_EXPIRED":
        return model(
            status="expired",
            reason_code=exc.code,
            spoken_facts=["That location request has expired."],
            **extra,
        )
    return None


async def respond_request(ctx: ToolContext, args: RespondRequestInput) -> ToolResult:
    if not _is_uuid(args.request_id):
        return _invalid_id("request_id")
    service = _service(ctx)
    if args.approve:
        try:
            result = await _run(
                service.approve_request,
                owner_user_id=ctx.user_id,
                request_id=args.request_id,
                approval_mode="manual",
                duration_hours=args.duration_hours,
                duration_mode=TIMED_LOCATION_SHARE_DURATION_MODE
                if args.duration_hours is not None
                else None,
            )
        except OneLocationAgentError as exc:
            gone = _request_gone(RespondRequestResult, exc, request_id=args.request_id)
            return gone if gone is not None else _rejected(exc)
        result = dict(result or {})
        request = dict(result.get("request") or {})
        grant = dict(result.get("grant") or {})
        requester_id = (
            str(request.get("requesterUserId") or grant.get("recipientUserId") or "") or None
        )
        name = _name_for(
            ctx,
            requester_id,
            service_name=request.get("requesterDisplayName") or grant.get("recipientDisplayName"),
        )
        who = name or "them"
        phrase = _duration_phrase(grant.get("durationHours"), grant.get("durationMode"))
        grant_id = str(grant.get("id") or "") or None
        facts = [
            f"Approved. Share created for {who} {phrase}; sending your position now."
            if phrase
            else f"Approved. Share created for {who}; sending your position now."
        ]
        return RespondRequestResult(
            status="approved",
            needs="client_step",
            request_id=str(request.get("id") or args.request_id),
            requester_user_id=requester_id,
            requester_name=name,
            grant_id=grant_id,
            duration_hours=grant.get("durationHours"),
            duration_mode=grant.get("durationMode"),
            expires_at=grant.get("expiresAt"),
            client_step=_publish_step(grant_id, "share") if grant_id else None,
            spoken_facts=facts,
        )
    try:
        request = await _run(
            service.deny_request, owner_user_id=ctx.user_id, request_id=args.request_id
        )
    except OneLocationAgentError as exc:
        gone = _request_gone(RespondRequestResult, exc, request_id=args.request_id)
        return gone if gone is not None else _rejected(exc)
    request = dict(request or {})
    requester_id = str(request.get("requesterUserId") or "") or None
    name = _name_for(ctx, requester_id, service_name=request.get("requesterDisplayName"))
    return RespondRequestResult(
        status="denied",
        request_id=str(request.get("id") or args.request_id),
        requester_user_id=requester_id,
        requester_name=name,
        spoken_facts=[
            f"Declined {name}'s location request. Nothing was shared."
            if name
            else "Declined that location request. Nothing was shared."
        ],
    )


def summarize_respond_request(ctx: ToolContext, args: RespondRequestInput) -> str:
    if not args.approve:
        return "decline that location request"
    label = format_duration_label(args.duration_hours) if args.duration_hours else ""
    return (
        f"approve that location request and share for {label}"
        if label
        else "approve that location request"
    )


# -- withdraw_request ----------------------------------------------------------


class WithdrawRequestInput(ToolInput):
    request_id: str = Field(
        min_length=1, max_length=64, description="Request id from list_requests (outgoing)."
    )


class WithdrawRequestResult(ToolResult):
    status: Literal["withdrawn", "not_found", "expired"]
    request_id: str | None = None
    owner_user_id: str | None = None
    owner_name: str | None = None


async def withdraw_request(ctx: ToolContext, args: WithdrawRequestInput) -> ToolResult:
    if not _is_uuid(args.request_id):
        return _invalid_id("request_id")
    service = _service(ctx)
    try:
        request = await _run(
            service.withdraw_request, requester_user_id=ctx.user_id, request_id=args.request_id
        )
    except OneLocationAgentError as exc:
        gone = _request_gone(WithdrawRequestResult, exc, request_id=args.request_id)
        return gone if gone is not None else _rejected(exc)
    request = dict(request or {})
    owner_id = str(request.get("ownerUserId") or "") or None
    name = _name_for(ctx, owner_id, service_name=request.get("ownerDisplayName"))
    fact = (
        f"Took back your location request to {name}."
        if name
        else "Took back that location request."
    )
    return WithdrawRequestResult(
        status="withdrawn",
        request_id=str(request.get("id") or args.request_id),
        owner_user_id=owner_id,
        owner_name=name,
        spoken_facts=[fact],
    )


def summarize_withdraw_request(ctx: ToolContext, args: WithdrawRequestInput) -> str:
    return "take back the location request you sent"


# -- share_with ----------------------------------------------------------------


class ShareWithInput(ToolInput):
    person: PersonRef = Field(description="The confirmed person to share your location with.")
    duration_hours: float | None = Field(
        default=1,
        gt=0,
        le=24,
        description="How long to share, in hours (15 minutes to 24 hours). Default 1. Ignored when until_stopped.",
    )
    until_stopped: bool = Field(
        default=False, description="Share until you stop it instead of for a fixed time."
    )


class ShareWithResult(ToolResult):
    status: Literal["grant_created", "not_connected", "recipient_not_ready"]
    grant_id: str | None = None
    person_user_id: str | None = None
    display_name: str | None = None
    share_kind: str | None = None
    duration_hours: float | None = None
    duration_mode: str | None = None
    expires_at: str | None = None
    client_step: dict[str, Any] | None = None


async def _recipient_key_id(
    ctx: ToolContext, service: OneLocationAgentService, user_id: str
) -> str | None:
    recipients = await _run(service.list_verified_recipients, owner_user_id=ctx.user_id)
    for recipient in recipients or []:
        if isinstance(recipient, dict) and str(recipient.get("userId") or "") == user_id:
            return str(recipient.get("keyId") or "") or None
    return None


def _recipient_not_ready(model: type[ToolResult], person: ConfirmedPerson) -> ToolResult:
    # Tool-specific fields the caller's result model declares; ``ToolResult`` itself
    # only knows the shared ones, so they are passed the way ``_request_gone`` does.
    extra: dict[str, Any] = {"person_user_id": person.user_id, "display_name": person.display_name}
    return model(
        status="recipient_not_ready",
        reason_code="recipient_not_ready",
        spoken_facts=[f"{person.display_name} isn't ready to receive your location yet."],
        **extra,
    )


async def share_with(ctx: ToolContext, args: ShareWithInput) -> ToolResult:
    person, problem = _person_gate(ctx, args.person)
    if person is None:
        return _not_confirmed()
    if problem is not None:
        return _gate_result(
            ShareWithResult,
            problem,
            person_user_id=person.user_id,
            display_name=person.display_name,
        )
    service = _service(ctx)
    try:
        key_id = await _recipient_key_id(ctx, service, person.user_id)
    except OneLocationAgentError as exc:
        return _rejected(exc)
    if not key_id:
        return _recipient_not_ready(ShareWithResult, person)

    if args.until_stopped:
        duration_hours: float | None = None
        duration_mode = UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
    else:
        duration_hours = args.duration_hours if args.duration_hours is not None else 1.0
        duration_mode = TIMED_LOCATION_SHARE_DURATION_MODE
    try:
        grant = await _run(
            service.create_grant,
            owner_user_id=ctx.user_id,
            recipient_user_id=person.user_id,
            recipient_key_id=key_id,
            duration_hours=duration_hours,
            duration_mode=duration_mode,
            reason=None,
            share_kind="share",
            enforce_connection=True,
            require_recipient_phone_verified=False,
        )
    except OneLocationAgentError as exc:
        return _rejected(exc)
    grant = dict(grant or {})
    grant_id = str(grant.get("id") or "")
    phrase = _duration_phrase(grant.get("durationHours"), grant.get("durationMode"))
    fact = (
        f"Share created for {person.display_name} {phrase}; sending your position now."
        if phrase
        else f"Share created for {person.display_name}; sending your position now."
    )
    return ShareWithResult(
        status="grant_created",
        needs="client_step",
        grant_id=grant_id or None,
        person_user_id=person.user_id,
        display_name=person.display_name,
        share_kind=grant.get("shareKind"),
        duration_hours=grant.get("durationHours"),
        duration_mode=grant.get("durationMode"),
        expires_at=grant.get("expiresAt"),
        client_step=_publish_step(grant_id, "share"),
        spoken_facts=[fact],
    )


def summarize_share_with(ctx: ToolContext, args: ShareWithInput) -> str:
    person = ctx.entities.person(args.person.user_id)
    name = person.display_name if person is not None else "them"
    if args.until_stopped:
        return f"share your location with {name} until you stop it"
    label = (
        format_duration_label(args.duration_hours if args.duration_hours is not None else 1)
        or "1 hour"
    )
    return f"share your location with {name} for {label}"


# -- list_shares ---------------------------------------------------------------


class ListSharesInput(ToolInput):
    pass


class ListSharesResult(ToolResult):
    status: Literal["ok", "empty"]
    outgoing: list[dict[str, Any]] = Field(default_factory=list)
    incoming: list[dict[str, Any]] = Field(default_factory=list)
    active_outgoing: int = 0
    active_incoming: int = 0


def _grant_item(ctx: ToolContext, row: dict[str, Any], *, direction: str) -> dict[str, Any]:
    if direction == "outgoing":
        counterpart_id = str(row.get("recipientUserId") or "")
        counterpart_name = _name_for(
            ctx, counterpart_id, service_name=row.get("recipientDisplayName")
        )
    else:
        counterpart_id = str(row.get("ownerUserId") or "")
        counterpart_name = _name_for(ctx, counterpart_id, service_name=row.get("ownerDisplayName"))
    status = str(row.get("status") or "")
    has_envelope = bool(row.get("latestEnvelopeId"))
    return {
        "grant_id": str(row.get("id") or ""),
        "direction": direction,
        "status": status,
        "counterpart_user_id": counterpart_id,
        "counterpart_name": counterpart_name,
        "share_kind": row.get("shareKind"),
        "duration_mode": row.get("durationMode"),
        "duration_hours": row.get("durationHours"),
        "expires_at": row.get("expiresAt"),
        "created_at": row.get("createdAt"),
        "has_latest_envelope": has_envelope,
        "awaiting_first_position": status == "active" and not has_envelope,
    }


def _share_clause(item: dict[str, Any]) -> str:
    who = str(item.get("counterpart_name") or "someone")
    if item.get("duration_mode") == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE:
        tail = "until stopped"
    else:
        remaining = _remaining_label(item.get("expires_at"))
        tail = f"{remaining} left" if remaining else "ending soon"
    if item.get("awaiting_first_position"):
        tail += ", no position sent yet"
    return f"{who} ({tail})"


async def list_shares(ctx: ToolContext, args: ListSharesInput) -> ToolResult:
    service = _service(ctx)
    try:
        state = await _run(service.list_state, user_id=ctx.user_id)
    except OneLocationAgentError as exc:
        return _rejected(exc)
    state = dict(state or {})
    outgoing = [
        _grant_item(ctx, row, direction="outgoing")
        for row in (state.get("ownerGrants") or [])
        if isinstance(row, dict)
    ]
    incoming = [
        _grant_item(ctx, row, direction="incoming")
        for row in (state.get("receivedGrants") or [])
        if isinstance(row, dict)
    ]
    active_out = [item for item in outgoing if item["status"] == "active"]
    active_in = [item for item in incoming if item["status"] == "active"]
    facts: list[str] = []
    if active_out:
        count = len(active_out)
        facts.append(
            f"You're sharing your location with {count} {'person' if count == 1 else 'people'}: "
            + ", ".join(_share_clause(item) for item in active_out)
            + "."
        )
    if active_in:
        count = len(active_in)
        facts.append(
            f"{count} {'person is' if count == 1 else 'people are'} sharing with you: "
            + ", ".join(_share_clause(item) for item in active_in)
            + "."
        )
    if not active_out and not active_in:
        facts.append("No active location shares right now.")
    return ListSharesResult(
        status="ok" if (active_out or active_in) else "empty",
        outgoing=outgoing,
        incoming=incoming,
        active_outgoing=len(active_out),
        active_incoming=len(active_in),
        spoken_facts=facts,
    )


# -- stop_share ----------------------------------------------------------------


class StopShareInput(ToolInput):
    grant_id: str = Field(min_length=1, max_length=64, description="Grant id from list_shares.")


class StopShareResult(ToolResult):
    status: Literal["stopped", "not_found"]
    grant_id: str | None = None
    counterpart_user_id: str | None = None
    counterpart_name: str | None = None
    share_status: str | None = None


async def stop_share(ctx: ToolContext, args: StopShareInput) -> ToolResult:
    if not _is_uuid(args.grant_id):
        return _invalid_id("grant_id")
    service = _service(ctx)
    try:
        grant = await _run(service.revoke_grant, owner_user_id=ctx.user_id, grant_id=args.grant_id)
    except OneLocationAgentError as exc:
        if exc.code == "LOCATION_GRANT_NOT_FOUND":
            return StopShareResult(
                status="not_found",
                reason_code=exc.code,
                grant_id=args.grant_id,
                spoken_facts=["There's no location share with that id."],
            )
        return _rejected(exc)
    grant = dict(grant or {})
    i_own_it = str(grant.get("ownerUserId") or "") == ctx.user_id
    counterpart_id = str(grant.get("recipientUserId" if i_own_it else "ownerUserId") or "") or None
    counterpart_name = _name_for(
        ctx,
        counterpart_id,
        service_name=grant.get("recipientDisplayName" if i_own_it else "ownerDisplayName"),
    )
    share_status = str(grant.get("status") or "")
    if share_status == "revoked" and grant.get("revokedAt"):
        if i_own_it:
            fact = (
                f"Stopped sharing your location with {counterpart_name}."
                if counterpart_name
                else "Stopped that location share."
            )
        else:
            fact = (
                f"You stopped receiving {counterpart_name}'s location."
                if counterpart_name
                else "You stopped receiving that location share."
            )
        reason_code = None
    else:
        fact = "That share had already ended."
        reason_code = "already_ended"
    return StopShareResult(
        status="stopped",
        reason_code=reason_code,
        grant_id=str(grant.get("id") or args.grant_id),
        counterpart_user_id=counterpart_id,
        counterpart_name=counterpart_name,
        share_status=share_status,
        spoken_facts=[fact],
    )


def summarize_stop_share(ctx: ToolContext, args: StopShareInput) -> str:
    return "stop that location share"


# -- change_share_duration -----------------------------------------------------


class ChangeShareDurationInput(ToolInput):
    grant_id: str = Field(
        min_length=1, max_length=64, description="Grant id from list_shares (one you own)."
    )
    duration_hours: float | None = Field(
        default=None,
        gt=0,
        le=24,
        description="New total length of the share from now, in hours. Required unless until_stopped.",
    )
    until_stopped: bool = Field(
        default=False, description="Keep the share running until you stop it."
    )


class ChangeShareDurationResult(ToolResult):
    status: Literal["updated", "not_active", "not_found"]
    grant_id: str | None = None
    counterpart_user_id: str | None = None
    counterpart_name: str | None = None
    duration_hours: float | None = None
    duration_mode: str | None = None
    expires_at: str | None = None
    share_status: str | None = None


async def change_share_duration(ctx: ToolContext, args: ChangeShareDurationInput) -> ToolResult:
    if not _is_uuid(args.grant_id):
        return _invalid_id("grant_id")
    if not args.until_stopped and args.duration_hours is None:
        return Rejected(
            reason_code="invalid_arguments",
            spoken_facts=["I need a new length for that share, or 'until I stop it'."],
        )
    service = _service(ctx)
    duration_mode = (
        UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
        if args.until_stopped
        else TIMED_LOCATION_SHARE_DURATION_MODE
    )
    try:
        grant = await _run(
            service.set_grant_duration,
            owner_user_id=ctx.user_id,
            grant_id=args.grant_id,
            duration_hours=None if args.until_stopped else args.duration_hours,
            duration_mode=duration_mode,
        )
    except OneLocationAgentError as exc:
        if exc.code == "LOCATION_GRANT_NOT_FOUND":
            return ChangeShareDurationResult(
                status="not_found",
                reason_code=exc.code,
                grant_id=args.grant_id,
                spoken_facts=["There's no location share of yours with that id."],
            )
        return _rejected(exc)
    grant = dict(grant or {})
    counterpart_id = str(grant.get("recipientUserId") or "") or None
    counterpart_name = _name_for(
        ctx, counterpart_id, service_name=grant.get("recipientDisplayName")
    )
    share_status = str(grant.get("status") or "")
    common: dict[str, Any] = {
        "grant_id": str(grant.get("id") or args.grant_id),
        "counterpart_user_id": counterpart_id,
        "counterpart_name": counterpart_name,
        "duration_hours": grant.get("durationHours"),
        "duration_mode": grant.get("durationMode"),
        "expires_at": grant.get("expiresAt"),
        "share_status": share_status,
    }
    if share_status != "active":
        return ChangeShareDurationResult(
            status="not_active",
            reason_code="share_not_active",
            spoken_facts=[
                f"That share is {share_status or 'no longer active'}, so its length can't be changed."
            ],
            **common,
        )
    subject = f"Your share with {counterpart_name}" if counterpart_name else "That share"
    if grant.get("durationMode") == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE:
        fact = f"{subject} now runs until you stop it."
    else:
        remaining = _remaining_label(grant.get("expiresAt"))
        label = format_duration_label(grant.get("durationHours"))
        fact = f"{subject} is now set to {label}" if label else f"{subject} was updated"
        fact += f", with {remaining} left." if remaining else "."
    return ChangeShareDurationResult(status="updated", spoken_facts=[fact], **common)


def summarize_change_share_duration(ctx: ToolContext, args: ChangeShareDurationInput) -> str:
    if args.until_stopped:
        return "keep that location share running until you stop it"
    label = format_duration_label(args.duration_hours) if args.duration_hours else ""
    return (
        f"change that location share to {label}" if label else "change that location share's length"
    )


# -- create_check_in -----------------------------------------------------------


class CreateCheckInInput(ToolInput):
    person: PersonRef = Field(description="The confirmed person to send the check-in to.")
    note: str | None = Field(
        default=None,
        max_length=160,
        description="Optional short note sent with your position, e.g. 'Home safe'.",
    )


class CreateCheckInResult(ToolResult):
    status: Literal["check_in_created", "not_connected", "recipient_not_ready"]
    grant_id: str | None = None
    person_user_id: str | None = None
    display_name: str | None = None
    share_kind: str | None = None
    note: str | None = None
    duration_hours: float | None = None
    expires_at: str | None = None
    client_step: dict[str, Any] | None = None


async def create_check_in(ctx: ToolContext, args: CreateCheckInInput) -> ToolResult:
    person, problem = _person_gate(ctx, args.person)
    if person is None:
        return _not_confirmed()
    if problem is not None:
        return _gate_result(
            CreateCheckInResult,
            problem,
            person_user_id=person.user_id,
            display_name=person.display_name,
        )
    service = _service(ctx)
    try:
        key_id = await _recipient_key_id(ctx, service, person.user_id)
    except OneLocationAgentError as exc:
        return _rejected(exc)
    if not key_id:
        return _recipient_not_ready(CreateCheckInResult, person)
    note = " ".join(str(args.note or "").split()) or None
    try:
        grant = await _run(
            service.create_grant,
            owner_user_id=ctx.user_id,
            recipient_user_id=person.user_id,
            recipient_key_id=key_id,
            duration_hours=1,
            duration_mode=TIMED_LOCATION_SHARE_DURATION_MODE,
            reason=note or "check_in",
            share_kind="check_in",
            enforce_connection=True,
            require_recipient_phone_verified=False,
        )
    except OneLocationAgentError as exc:
        return _rejected(exc)
    grant = dict(grant or {})
    grant_id = str(grant.get("id") or "")
    stored_note = grant.get("shareMessage")
    facts = [f"Check-in created for {person.display_name}; sending your position now."]
    if stored_note:
        facts.append(f"Your note: {stored_note}")
    return CreateCheckInResult(
        status="check_in_created",
        needs="client_step",
        grant_id=grant_id or None,
        person_user_id=person.user_id,
        display_name=person.display_name,
        share_kind=grant.get("shareKind"),
        note=stored_note,
        duration_hours=grant.get("durationHours"),
        expires_at=grant.get("expiresAt"),
        client_step=_publish_step(grant_id, "check_in"),
        spoken_facts=facts,
    )


def summarize_create_check_in(ctx: ToolContext, args: CreateCheckInInput) -> str:
    person = ctx.entities.person(args.person.user_id)
    name = person.display_name if person is not None else "them"
    note = " ".join(str(args.note or "").split())
    if note:
        return f'send {name} a check-in with your location saying "{note[:60]}"'
    return f"send {name} a check-in with your location"


# -- list_links ----------------------------------------------------------------


class ListLinksInput(ToolInput):
    pass


class ListLinksResult(ToolResult):
    status: Literal["ok", "empty"]
    links: list[dict[str, Any]] = Field(default_factory=list)
    active_count: int = 0


def _link_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "invite_id": str(row.get("id") or ""),
        "status": str(row.get("status") or ""),
        "duration_hours": row.get("durationHours"),
        "expires_at": row.get("expiresAt"),
        "created_at": row.get("createdAt"),
        "revoked_at": row.get("revokedAt"),
        "url": row.get("publicUrl"),
    }


async def list_links(ctx: ToolContext, args: ListLinksInput) -> ToolResult:
    service = _service(ctx)
    try:
        state = await _run(service.list_state, user_id=ctx.user_id)
    except OneLocationAgentError as exc:
        return _rejected(exc)
    links = [
        _link_item(row)
        for row in ((state or {}).get("publicInvites") or [])
        if isinstance(row, dict)
    ]
    active = [item for item in links if item["status"] == "active"]
    facts: list[str] = []
    if active:
        count = len(active)
        clauses = []
        for item in active:
            remaining = _remaining_label(item.get("expires_at"))
            clauses.append(f"{remaining} left" if remaining else "ending soon")
        facts.append(
            f"You have {count} live public {'link' if count == 1 else 'links'}: {', '.join(clauses)}. "
            "Anyone with a live link can see your location."
        )
    else:
        facts.append("No live public location links.")
    ended = len(links) - len(active)
    if ended:
        facts.append(f"{ended} earlier {'link has' if ended == 1 else 'links have'} ended.")
    return ListLinksResult(
        status="ok" if active else "empty",
        links=links,
        active_count=len(active),
        spoken_facts=facts,
    )


# -- create_public_link --------------------------------------------------------


class CreatePublicLinkInput(ToolInput):
    duration_hours: float = Field(
        default=1,
        gt=0,
        le=2,
        description="How long the link stays live, in hours: 0.25, 1, or 2 (at most two hours). Default 1.",
    )


class CreatePublicLinkResult(ToolResult):
    status: Literal["created", "reused"]
    invite_id: str | None = None
    url: str | None = None
    duration_hours: float | None = None
    expires_at: str | None = None
    client_step: dict[str, Any] | None = None


async def create_public_link(ctx: ToolContext, args: CreatePublicLinkInput) -> ToolResult:
    service = _service(ctx)
    try:
        result = await _run(
            service.create_public_invite,
            owner_user_id=ctx.user_id,
            duration_hours=args.duration_hours,
        )
    except OneLocationAgentError as exc:
        return _rejected(exc)
    result = dict(result or {})
    invite = dict(result.get("invite") or {})
    url = str(result.get("publicUrl") or invite.get("publicUrl") or "") or None
    reused = bool(result.get("reused"))
    remaining = _remaining_label(invite.get("expiresAt"))
    label = format_duration_label(invite.get("durationHours"))
    if reused:
        fact = "You already have a live public link"
        fact += f"; it has {remaining} left." if remaining else "."
    else:
        fact = "Public link created"
        fact += f"; it stays live for {label}." if label else "."
    facts = [fact, "Anyone with the link can see your location while it's live."]
    return CreatePublicLinkResult(
        status="reused" if reused else "created",
        needs="client_step",
        invite_id=str(invite.get("id") or "") or None,
        url=url,
        duration_hours=invite.get("durationHours"),
        expires_at=invite.get("expiresAt"),
        client_step={"kind": SHARE_SHEET_STEP_KIND, "url": url} if url else None,
        spoken_facts=facts,
    )


def summarize_create_public_link(ctx: ToolContext, args: CreatePublicLinkInput) -> str:
    label = format_duration_label(args.duration_hours) or "1 hour"
    return f"create a public location link that anyone can open for {label}"


# -- revoke_public_link --------------------------------------------------------


class RevokePublicLinkInput(ToolInput):
    invite_id: str = Field(min_length=1, max_length=64, description="Link id from list_links.")


class RevokePublicLinkResult(ToolResult):
    status: Literal["revoked", "not_found"]
    invite_id: str | None = None
    revoked_at: str | None = None


async def revoke_public_link(ctx: ToolContext, args: RevokePublicLinkInput) -> ToolResult:
    if not _is_uuid(args.invite_id):
        return _invalid_id("invite_id")
    service = _service(ctx)
    try:
        invite = await _run(
            service.revoke_public_invite, owner_user_id=ctx.user_id, invite_id=args.invite_id
        )
    except OneLocationAgentError as exc:
        if exc.code == "LOCATION_PUBLIC_INVITE_NOT_FOUND":
            return RevokePublicLinkResult(
                status="not_found",
                reason_code=exc.code,
                invite_id=args.invite_id,
                spoken_facts=["There's no live public link with that id."],
            )
        return _rejected(exc)
    invite = dict(invite or {})
    return RevokePublicLinkResult(
        status="revoked",
        invite_id=str(invite.get("id") or args.invite_id),
        revoked_at=invite.get("revokedAt"),
        spoken_facts=["That public link is revoked. It no longer opens for anyone."],
    )


def summarize_revoke_public_link(ctx: ToolContext, args: RevokePublicLinkInput) -> str:
    return "revoke that public location link"


# -- catalog -------------------------------------------------------------------


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="request_location",
        gateway_action_id="location.send_request",
        policy=ToolPolicy.confirm_voice,
        input_model=RequestLocationInput,
        output_model=RequestLocationResult,
        description=(
            "Ask a confirmed person to share their location with you for a while. Sends a "
            "request they must approve; nothing is visible until they do. Needs a canonical "
            "person id from resolve_person/confirm_person, never a name."
        ),
        handler=request_location,
        person_args=("person",),
        ui_refresh=("location_people",),
        summarize=summarize_request_location,
    ),
    ToolSpec(
        name="list_requests",
        gateway_action_id="location.open_needs_review",
        policy=ToolPolicy.read,
        input_model=ListRequestsInput,
        output_model=ListRequestsResult,
        description=(
            "Read LOCATION requests only: incoming (people asking for your location) and "
            "outgoing (location requests you sent), with real statuses pending, approved, "
            "denied, cancelled or expired. Not connection requests: those are in list_people. "
            "Read this before approving, declining or withdrawing a location request."
        ),
        handler=list_requests,
    ),
    ToolSpec(
        name="respond_request",
        gateway_action_id="location.approve_request",
        policy=ToolPolicy.confirm_voice,
        input_model=RespondRequestInput,
        output_model=RespondRequestResult,
        description=(
            "Approve or decline one incoming location request by its id from list_requests. "
            "Approving starts a share for the time they asked (or duration_hours). Bound to the "
            "approve gateway action for both outcomes: one tool answers the request either way."
        ),
        handler=respond_request,
        ui_refresh=("location_needs_review", "location_active_shares"),
        summarize=summarize_respond_request,
    ),
    ToolSpec(
        name="withdraw_request",
        gateway_action_id="location.send_request",
        policy=ToolPolicy.confirm_voice,
        input_model=WithdrawRequestInput,
        output_model=WithdrawRequestResult,
        description=(
            "Take back a pending location request you sent, by its id from list_requests "
            "(outgoing). Only pending requests can be withdrawn."
        ),
        handler=withdraw_request,
        ui_refresh=("location_people",),
        summarize=summarize_withdraw_request,
    ),
    ToolSpec(
        name="share_with",
        gateway_action_id="location.share_selected",
        policy=ToolPolicy.confirm_voice,
        input_model=ShareWithInput,
        output_model=ShareWithResult,
        description=(
            "Share your live location with a confirmed connection for a fixed time or until "
            "stopped. Creates the share; the device then publishes your position (client_step). "
            "Needs a canonical person id, never a name."
        ),
        handler=share_with,
        person_args=("person",),
        ui_refresh=("location_active_shares", "location_home"),
        summarize=summarize_share_with,
    ),
    ToolSpec(
        name="list_shares",
        gateway_action_id="location.open_active_shares",
        policy=ToolPolicy.read,
        input_model=ListSharesInput,
        output_model=ListSharesResult,
        description=(
            "Read who you are sharing your location with and who is sharing with you, with each "
            "share's real status, time left, and whether a position has been sent yet. Read this "
            "before stopping or changing a share."
        ),
        handler=list_shares,
    ),
    ToolSpec(
        name="stop_share",
        gateway_action_id="location.stop_share",
        policy=ToolPolicy.confirm_tap,
        input_model=StopShareInput,
        output_model=StopShareResult,
        description=(
            "Stop one location share immediately by its grant id from list_shares, after the "
            "person taps Confirm. Works for a share you own or one you receive."
        ),
        handler=stop_share,
        ui_refresh=("location_active_shares", "location_shared_with_me"),
        summarize=summarize_stop_share,
    ),
    ToolSpec(
        name="change_share_duration",
        gateway_action_id="location.change_share_duration",
        policy=ToolPolicy.confirm_voice,
        input_model=ChangeShareDurationInput,
        output_model=ChangeShareDurationResult,
        description=(
            "Set a new length on a share you own (grant id from list_shares): a number of hours "
            "from now, or until you stop it. The share keeps the same id."
        ),
        handler=change_share_duration,
        ui_refresh=("location_active_shares",),
        summarize=summarize_change_share_duration,
    ),
    ToolSpec(
        name="create_check_in",
        gateway_action_id="location.send_check_in",
        policy=ToolPolicy.confirm_voice,
        input_model=CreateCheckInInput,
        output_model=CreateCheckInResult,
        description=(
            "Send a confirmed connection a one-hour check-in with your position and an optional "
            "note. Creates the check-in; the device then publishes your position (client_step). "
            "Needs a canonical person id, never a name."
        ),
        handler=create_check_in,
        person_args=("person",),
        ui_refresh=("location_active_shares", "location_home"),
        summarize=summarize_create_check_in,
    ),
    ToolSpec(
        name="list_links",
        gateway_action_id="location.open_links",
        policy=ToolPolicy.read,
        input_model=ListLinksInput,
        output_model=ListLinksResult,
        description=(
            "Read your public location links with their real status (active, expired, revoked), "
            "time left, and URL. Read this before revoking one."
        ),
        handler=list_links,
    ),
    ToolSpec(
        name="create_public_link",
        gateway_action_id="location.create_public_link",
        policy=ToolPolicy.confirm_voice,
        input_model=CreatePublicLinkInput,
        output_model=CreatePublicLinkResult,
        description=(
            "Create an expiring public location link anyone can open, for at most two hours. "
            "Returns the URL and a client_step to open the share sheet."
        ),
        handler=create_public_link,
        ui_refresh=("location_links",),
        summarize=summarize_create_public_link,
    ),
    ToolSpec(
        name="revoke_public_link",
        gateway_action_id="location.revoke_public_link",
        policy=ToolPolicy.confirm_tap,
        input_model=RevokePublicLinkInput,
        output_model=RevokePublicLinkResult,
        description=(
            "Revoke a live public location link by its id from list_links, after the person "
            "taps Confirm. The link stops opening for everyone."
        ),
        handler=revoke_public_link,
        ui_refresh=("location_links",),
        summarize=summarize_revoke_public_link,
    ),
)

__all__ = [
    "TOOLS",
    "ChangeShareDurationResult",
    "CreateCheckInResult",
    "CreatePublicLinkResult",
    "ListLinksResult",
    "ListRequestsResult",
    "ListSharesResult",
    "RequestLocationResult",
    "RespondRequestResult",
    "RevokePublicLinkResult",
    "ShareWithResult",
    "StopShareResult",
    "WithdrawRequestResult",
]
