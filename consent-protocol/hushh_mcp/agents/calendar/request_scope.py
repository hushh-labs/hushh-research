"""Invocation-bound Calendar review authority from authenticated owner messages.

Calendar's existing manifest assesses meaning without tools, history or provider
content. The host enforces that ceiling; OAuth and exact confirmation still own
information access and provider effects.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret

STATE_REQUEST_SCOPE = "temp:hussh:calendar_request_scope"
Action = Literal["create", "reschedule", "cancel", "respond"]
logger = logging.getLogger(__name__)


def _request_key(context: Any, messages: tuple[str, ...]) -> str:
    return hashlib.sha256(
        json.dumps(
            [
                context.state.get("hussh:user_id"),
                context.state.get("hussh:conversation_id"),
                getattr(context, "invocation_id", None),
                messages,
            ]
        ).encode()
    ).hexdigest()


class ScopeEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    message_index: int = Field(ge=0, le=16)
    quote: str = Field(min_length=1, max_length=4096)
    source: Literal["current", "pending"] = "current"


class CalendarRequestScope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    read_only: bool
    allowed_actions: list[Action] = Field(max_length=4)
    evidence: list[ScopeEvidence] = Field(min_length=1, max_length=8)
    continuation: bool = False

    @model_validator(mode="after")
    def coherent(self):
        if self.read_only != (not self.allowed_actions):
            raise ValueError("Read-only requests cannot authorize reviews")
        if len(set(self.allowed_actions)) != len(self.allowed_actions):
            raise ValueError("Repeated action")
        if self.continuation and self.allowed_actions != ["create"]:
            raise ValueError("A guest reply can complete only its original create review")
        return self


def current_user_messages(context: Any) -> tuple[str, ...]:
    from hushh_mcp.one_adk.queued_input import QUEUED_INPUT_KIND

    def text(content):
        if getattr(content, "role", None) != "user":
            return ""
        return "\n".join(
            part.text
            for part in getattr(content, "parts", None) or []
            if isinstance(getattr(part, "text", None), str) and not part.thought
        )

    pieces = [text(getattr(context, "user_content", None))]
    for event in getattr(getattr(context, "session", None), "events", None) or []:
        if (
            getattr(event, "invocation_id", None) == getattr(context, "invocation_id", None)
            and getattr(event, "author", None) == "user"
            and (getattr(event, "custom_metadata", None) or {}).get("kind") == QUEUED_INPUT_KIND
        ):
            pieces.append(text(event.content))
    return tuple(piece for piece in pieces if piece)


async def assess_scope(context: Any, messages: tuple[str, ...]) -> CalendarRequestScope:
    from hushh_mcp.agents.calendar.guest_clarification import admitted_pending

    pending = admitted_pending(context)
    # Preserve the admitted owner's provider/model; never choose a shared fallback.
    agent = context._invocation_context.agent
    model = await agent.canonical_model_async(context)
    manifest = ManifestLoader.load(str(Path(__file__).with_name("agent.yaml")))
    assessor = build_single_turn_agent(manifest, output_schema=CalendarRequestScope, model=model)
    result = await run_single_turn(
        assessor,
        prompt_parts=json.dumps(
            {
                "mode": "request_scope",
                "authenticated_user_messages": messages,
                "pending_clarification": pending.assessment_context() if pending else None,
            }
        ),
        user_id=context.state["hussh:user_id"],
        consent_token=resolve_request_secret(context.state.get("hussh:consent_token")),
        timeout_seconds=12,
    )
    return CalendarRequestScope.model_validate(result)


async def request_scope(context: Any) -> tuple[Action, ...]:
    from hushh_mcp.agents.calendar.guest_clarification import (
        STATE_GUEST_CLARIFICATION,
        admitted_pending,
    )

    messages = current_user_messages(context)
    invocation = getattr(context, "invocation_id", None)
    owner = context.state.get("hussh:user_id")
    conversation = context.state.get("hussh:conversation_id")
    if not invocation or not owner or not conversation or not messages:
        return ()
    if len(messages) > 17 or any(len(message) > 4096 for message in messages):
        return ()
    key = _request_key(context, messages)
    pointer = context.state.get(STATE_REQUEST_SCOPE)
    if isinstance(pointer, str) and pointer.startswith("one_secret_ref:"):
        try:
            resolved = resolve_request_secret(pointer)
            if not resolved:
                return ()
            cached = json.loads(resolved)
            if cached["key"] == key:
                return tuple(cached["actions"])
        except (ValueError, KeyError, TypeError):
            return ()
    # Publish a deny receipt before awaiting: parallel calls cannot independently
    # widen scope while the first assessment is pending. Failures remain denied.
    context.state[STATE_REQUEST_SCOPE] = store_request_secret(
        json.dumps({"key": key, "actions": []}), ttl_seconds=180
    )
    try:
        pending = admitted_pending(context)
        scope = await assess_scope(context, messages)
        if messages != current_user_messages(context):
            raise ValueError("Authenticated input changed during assessment")
        sources = {"current": messages, "pending": tuple(pending.messages) if pending else ()}
        if any(
            item.message_index >= len(sources[item.source])
            or item.quote not in sources[item.source][item.message_index]
            or not item.quote.strip()
            for item in scope.evidence
        ):
            raise ValueError("Scope evidence does not match authenticated input")
        evidence_sources = {item.source for item in scope.evidence}
        if scope.continuation:
            if pending is None or evidence_sources != {"current", "pending"}:
                raise ValueError("Guest continuation needs both authenticated sources")
        elif "pending" in evidence_sources:
            raise ValueError("Prior input cannot authorize a fresh request")
    except Exception:  # model failure never grants proposal authority
        context.state[STATE_GUEST_CLARIFICATION] = None
        logger.info("calendar.request_scope outcome=unavailable")
        return ()
    if not scope.continuation:
        context.state[STATE_GUEST_CLARIFICATION] = None
    context.state[STATE_REQUEST_SCOPE] = store_request_secret(
        json.dumps(
            {
                "key": key,
                "actions": scope.allowed_actions,
                "continuation": scope.continuation,
                "pending_digest": pending.source_digest if scope.continuation else None,
            }
        ),
        ttl_seconds=180,
    )
    logger.info("calendar.request_scope outcome=%s", "read_only" if scope.read_only else "review")
    return tuple(scope.allowed_actions)


def scope_receipt(context: Any) -> dict[str, Any] | None:
    try:
        value = resolve_request_secret(context.state.get(STATE_REQUEST_SCOPE))
        receipt = json.loads(value) if value else None
        return receipt if isinstance(receipt, dict) and proof_current(context, receipt) else None
    except (TypeError, ValueError):
        return None


def proof_current(context: Any, proof: dict[str, Any]) -> bool:
    return proof.get("key") == _request_key(context, current_user_messages(context))


async def require_action(context: Any, action: Action) -> dict[str, Any] | None:
    if action in await request_scope(context):
        return None
    return scope_refusal(action)


def scope_refusal(action: Action) -> dict[str, Any]:
    logger.info("calendar.proposal_refused reason=request_scope action=%s", action)
    return {
        "status": "blocked",
        "reason_code": "calendar_request_read_only",
        "message": "No Calendar change was prepared. Use Calendar read results to answer; "
        "a booking or invitation review requires the owner's explicit request.",
    }
