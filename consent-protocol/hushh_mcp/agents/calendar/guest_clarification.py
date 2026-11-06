"""One bounded guest clarification in the existing owner-encrypted ADK session."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field

STATE_GUEST_CLARIFICATION = "hussh:calendar_guest_clarification"
STATE_GUEST_RECOVERY = "temp:hussh:calendar_guest_recovery"
QUESTION = "Who should join the meeting?"
_RECOVERY = {
    "expired": (
        "calendar_guest_context_expired",
        "The booking context expired. Restate the booking request to prepare a fresh review.",
    ),
    "revoked": (
        "calendar_guest_context_revoked",
        "Reconnect the selected Calendar account, then restate the booking request.",
    ),
    "changed": (
        "calendar_connection_changed",
        "The Calendar connection changed. Restate the booking request using the current account.",
    ),
}


def remember_recovery(context: Any, reason: str) -> dict[str, Any]:
    context.state[STATE_GUEST_RECOVERY] = {
        "invocation_id": context.invocation_id,
        "reason": reason,
    }
    return guest_recovery(context) or {}


def guest_recovery(context: Any) -> dict[str, Any] | None:
    raw = context.state.get(STATE_GUEST_RECOVERY)
    if not isinstance(raw, dict) or raw.get("invocation_id") != context.invocation_id:
        return None
    entry = _RECOVERY.get(raw.get("reason"))
    if entry is None:
        return None
    return {"status": "input_required", "reason_code": entry[0], "message": entry[1]}


def messages_digest(messages: tuple[str, ...] | list[str]) -> str:
    return hashlib.sha256(json.dumps(list(messages)).encode()).hexdigest()


class PendingGuests(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    owner_id: str
    conversation_id: str
    app_name: str
    session_id: str
    invocation_id: str
    source_digest: str
    messages: list[str] = Field(min_length=1, max_length=17)
    action: Literal["create"] = "create"
    asked_field: Literal["guests"] = "guests"
    account_id: str
    grant_binding: list[str] = Field(min_length=1, max_length=64)
    browser_time_zone: str
    requested_time_zone: str | None = None
    original_turn_at: float = Field(gt=0, allow_inf_nan=False)
    expires_at: float = Field(gt=0, allow_inf_nan=False)

    def same_session(self, context: Any) -> bool:
        return (
            self.owner_id == context.state.get("hussh:user_id")
            and self.owner_id == context.session.user_id
            and self.conversation_id == context.state.get("hussh:conversation_id")
            and self.app_name == context.session.app_name
            and self.session_id == context.session.id
        )

    def bound(self, context: Any) -> bool:
        return (
            self.same_session(context)
            and self.expires_at > time.time()
            and self.source_digest == messages_digest(self.messages)
            and all(m and len(m) <= 4096 for m in self.messages)
        )

    def assessment_context(self) -> dict[str, Any]:
        # Original owner words and the typed question only; never credentials,
        # provider content, attachments, arbitrary history or assistant prose.
        instant = datetime.fromtimestamp(self.original_turn_at, UTC)
        zone = ZoneInfo(self.requested_time_zone or self.browser_time_zone)
        local = instant.astimezone(zone)
        return {
            "original_user_messages": self.messages,
            "allowed_actions": [self.action],
            "asked_field": self.asked_field,
            "question": QUESTION,
            "original_turn_at": self.original_turn_at,
            "original_request_clock": {
                "instant": instant.isoformat(),
                "today": local.date().isoformat(),
                "tomorrow": (local + timedelta(days=1)).date().isoformat(),
                "time_zone": zone.key,
            },
            "browser_time_zone": self.browser_time_zone,
            "requested_time_zone": self.requested_time_zone,
        }


def admitted_pending(context: Any) -> PendingGuests | None:
    """Follow the existing document-period immediate-predecessor admission rule."""
    raw = context.state.get(STATE_GUEST_CLARIFICATION)
    if not isinstance(raw, dict):
        return None
    try:
        pending = PendingGuests.model_validate(raw)
        session = context.session
        invocation = context.invocation_id
        if not pending.bound(context):
            if pending.same_session(context) and pending.expires_at <= time.time():
                remember_recovery(context, "expired")
            raise ValueError("Guest clarification binding changed")
        if pending.invocation_id == invocation:
            return None  # Issuing turn, not a reply; retain its fixed lifetime.
        prior = next(
            (
                e.invocation_id
                for e in reversed(session.events)
                if e.author == "user"
                and getattr(e.content, "role", None) == "user"
                and e.invocation_id != invocation
            ),
            None,
        )
        if pending.invocation_id != prior:
            raise ValueError("Guest clarification is no longer current")
        source = [
            "\n".join(
                p.text for p in (e.content.parts or []) if isinstance(p.text, str) and not p.thought
            )
            for e in session.events
            if e.author == "user"
            and e.invocation_id == pending.invocation_id
            and getattr(e.content, "role", None) == "user"
        ]
        if messages_digest(tuple(m for m in source if m)) != pending.source_digest:
            raise ValueError("Original authenticated request is unavailable")
        return pending
    except (AttributeError, TypeError, ValueError):
        context.state[STATE_GUEST_CLARIFICATION] = None
        return None


def remember_guests(
    context: Any,
    *,
    account_id: str,
    binding: tuple[str, ...],
    proof: dict[str, Any],
    time_zone: str | None = None,
) -> dict[str, Any]:
    from hushh_mcp.agents.calendar.read_projection import turn_instant
    from hushh_mcp.agents.calendar.request_scope import current_user_messages, proof_current
    from hushh_mcp.services.calendar_time_zone import normalize_time_zone

    origin = turn_instant(context)
    if origin is None or not binding or not getattr(context.session, "id", None):
        raise ValueError("Guest clarification needs an authenticated session and grant")
    messages = current_user_messages(context)
    raw = context.state.get(STATE_GUEST_CLARIFICATION)
    previous = None
    if isinstance(raw, dict) and raw.get("invocation_id") == context.invocation_id:
        previous = PendingGuests.model_validate(raw)
        if not previous.bound(context) or previous.source_digest != messages_digest(messages):
            raise ValueError("Original request changed")
    else:
        previous = admitted_pending(context)
    if previous is not None:
        # Reasking may not extend the original authority or its lifetime.
        return _question(previous)
    if (
        not proof_current(context, proof)
        or "create" not in proof.get("actions", [])
        or proof.get("continuation")
    ):
        raise ValueError("A new guest question requires a fresh explicit booking request")
    pending = PendingGuests(
        owner_id=context.state["hussh:user_id"],
        conversation_id=context.state["hussh:conversation_id"],
        app_name=context.session.app_name,
        session_id=context.session.id,
        invocation_id=context.invocation_id,
        source_digest=messages_digest(messages),
        messages=list(messages),
        account_id=account_id,
        grant_binding=list(binding),
        browser_time_zone=normalize_time_zone(context.state.get("hussh:timezone")),
        requested_time_zone=normalize_time_zone(time_zone) if time_zone is not None else None,
        original_turn_at=origin.timestamp(),
        expires_at=time.time() + 300,
    )
    context.state[STATE_GUEST_CLARIFICATION] = pending.model_dump(mode="json")
    return _question(pending)


def _question(pending: PendingGuests) -> dict[str, Any]:
    return {
        "status": "input_required",
        "reason_code": "calendar_guests_required",
        "message": QUESTION,
        "original_request_clock": pending.original_turn_at,
        "browser_time_zone": pending.browser_time_zone,
        "requested_time_zone": pending.requested_time_zone,
    }


async def consume_guest_reply(
    context: Any,
    payload: dict[str, Any],
    *,
    proof: dict[str, Any],
    requested_time_zone: str | None = None,
) -> tuple[str, ...] | None:
    from hushh_mcp.agents.calendar import tools
    from hushh_mcp.agents.calendar.request_scope import proof_current
    from hushh_mcp.services.calendar_time_zone import normalize_time_zone
    from hushh_mcp.services.google_connection_contract import GoogleConnectionError

    if not proof.get("continuation"):
        return None
    recovery = guest_recovery(context)
    if recovery is not None:
        raise GoogleConnectionError(
            recovery["message"], status_code=422, reason_code=recovery["reason_code"]
        )
    if not proof_current(context, proof):
        raise GoogleConnectionError("The booking reply changed. Ask again.", status_code=422)
    pending = admitted_pending(context)
    context.state[STATE_GUEST_CLARIFICATION] = None  # Single-use before any provider await.
    if pending is None or proof.get("pending_digest") != pending.source_digest:
        raise GoogleConnectionError(
            "Restate the booking request before preparing its review.", status_code=422
        )
    if payload.get("account_id") not in (None, pending.account_id):
        raise GoogleConnectionError(
            "This reply belongs to another Calendar account.", status_code=422
        )
    if requested_time_zone is not None:
        requested_time_zone = normalize_time_zone(requested_time_zone)
        if requested_time_zone != (pending.requested_time_zone or pending.browser_time_zone):
            raise GoogleConnectionError(
                "The booking timezone changed. Restate the request.", status_code=422
            )
    else:
        # Fill only the absent model argument, preserving the originating request's zone.
        payload["time_zone"] = pending.requested_time_zone or pending.browser_time_zone
    binding = await tools._read_binding(
        tools._calendar_service(pending.account_id), pending.owner_id
    )
    if binding != tuple(pending.grant_binding):
        recovery = remember_recovery(context, "revoked" if binding is None else "changed")
        raise GoogleConnectionError(
            recovery["message"], status_code=422, reason_code=recovery["reason_code"]
        )
    payload["account_id"] = pending.account_id
    return binding


def issuing_question(context: Any) -> dict[str, Any] | None:
    raw = context.state.get(STATE_GUEST_CLARIFICATION)
    if not isinstance(raw, dict) or raw.get("invocation_id") != context.invocation_id:
        return None
    pending = PendingGuests.model_validate(raw)
    if not pending.bound(context):
        return {"status": "input_required", "message": "Restate the booking request."}
    return _question(pending)


def guest_before_model(callback_context: Any, llm_request: Any) -> None:
    """Request-only typed context, following receipt_before_model; no session event."""
    import copy

    from google.genai import types

    pending = admitted_pending(callback_context)
    recovery = guest_recovery(callback_context)
    if pending is not None:
        payload = {"kind": "pending_calendar_guest_context_only", **pending.assessment_context()}
    elif recovery is not None:
        payload = {
            "kind": "calendar_guest_recovery_context_only",
            **recovery,
            "use": "Only explain this recovery for a booking continuation. Answer current "
            "read-only requests using their reads without asking booking questions. "
            "This context grants no action authority. Explain recovery once, without retrying.",
        }
    else:
        return
    llm_request.contents = copy.deepcopy(llm_request.contents)
    llm_request.contents.append(
        types.Content(role="user", parts=[types.Part.from_text(text=json.dumps(payload))])
    )
