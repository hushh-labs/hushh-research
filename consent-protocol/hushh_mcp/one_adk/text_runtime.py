"""Typed-chat adapter for One's existing ADK semantic head.

The browser-facing Agent Chat route keeps its durable conversation store and
SSE wire contract. This module only replaces the old keyword router plus
separate action planner with the same One agent/tool tree used by voice.

Each turn uses an ephemeral ADK session seeded from encrypted durable chat
history. That keeps BYOK credentials and decrypted PKM context turn-bounded,
while avoiding process-local session loss as a second source of chat truth.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.events import Event
from google.adk.models import Gemini
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import types as genai_types

from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_CONVERSATION_ID,
    STATE_PKM_CONTEXT,
    STATE_SCREEN,
    STATE_TIMEZONE,
    STATE_USER_ID,
    STATE_VOICE_CONTEXT,
    build_one_text_agent,
)
from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action

OneTextEventKind = Literal["token", "directive"]


@dataclass(frozen=True)
class OneTextDirective:
    kind: Literal["action", "prompt"]
    payload: dict[str, Any]
    delegate_agent_id: str | None = None


@dataclass(frozen=True)
class OneTextStreamEvent:
    kind: OneTextEventKind
    text: str = ""
    directive: OneTextDirective | None = None


def _runtime_model(
    *,
    runtime_model: str,
    runtime_mode: str,
    runtime_credential: str | None,
) -> str | Gemini:
    """Build a turn-local ADK model without persisting a BYOK secret."""
    model = str(runtime_model or "").strip()
    if not model:
        raise ValueError("One text runtime model is missing")
    credential = str(runtime_credential or "").strip()
    if runtime_mode == "byok" and not credential:
        raise ValueError("One text BYOK credential is missing")
    if runtime_mode == "byok":
        return Gemini(model=model, client_kwargs={"api_key": credential})
    if credential:
        # Mirror the existing managed Agent Chat transport: Vertex mode with
        # the platform-managed key, held only by this turn-local model object.
        return Gemini(
            model=model,
            client_kwargs={"vertexai": True, "api_key": credential},
        )
    # Compatibility for deployments where Vertex ADC is the configured
    # managed credential source rather than an explicit platform key.
    return model


def _history_content(message: Any) -> genai_types.Content | None:
    role = str(getattr(message, "role", "") or "").strip()
    if role not in {"user", "assistant"}:
        return None
    text = str(getattr(message, "content", "") or "").strip()[:4000]
    if not text:
        return None
    return genai_types.Content(
        role="user" if role == "user" else "model",
        parts=[genai_types.Part.from_text(text=text)],
    )


def _event_text(event: Any) -> str:
    if str(getattr(event, "author", "") or "") != "one":
        return ""
    content = getattr(event, "content", None)
    parts = getattr(content, "parts", None) or []
    return "".join(
        str(part.text)
        for part in parts
        if isinstance(getattr(part, "text", None), str)
        and not bool(getattr(part, "thought", False))
    )


def _directive_from_value(value: Any) -> OneTextDirective | None:
    if not isinstance(value, dict):
        return None
    raw_kind = str(value.get("kind") or "").strip()
    payload = value.get("payload")
    if raw_kind == "action":
        kind: Literal["action", "prompt"] = "action"
    elif raw_kind == "prompt":
        kind = "prompt"
    else:
        return None
    if not isinstance(payload, dict):
        return None
    delegate_agent_id = str(value.get("delegateAgentId") or "").strip() or None
    if kind == "action" and delegate_agent_id is None:
        action_id = str(payload.get("actionId") or "").strip()
        if not action_id or get_voice_manifest_action(action_id) is None:
            return None
    return OneTextDirective(
        kind=kind,
        payload=dict(payload),
        delegate_agent_id=delegate_agent_id,
    )


def _event_directives(event: Any) -> list[OneTextDirective]:
    actions = getattr(event, "actions", None)
    state_delta = getattr(actions, "state_delta", None)
    if not isinstance(state_delta, dict):
        return []
    directives: list[OneTextDirective] = []
    for key, value in state_delta.items():
        if not str(key).startswith("hussh:pending_directive:"):
            continue
        directive = _directive_from_value(value)
        if directive is not None:
            directives.append(directive)
    return directives


def _directive_fingerprint(directive: OneTextDirective) -> str:
    return json.dumps(
        {
            "kind": directive.kind,
            "payload": directive.payload,
            "delegate_agent_id": directive.delegate_agent_id,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


async def stream_one_text_turn(
    *,
    user_id: str,
    consent_token: str,
    conversation_id: str,
    message: str,
    history: Sequence[Any],
    timezone: str | None,
    screen_context: dict[str, Any] | None,
    pkm_context: str | None,
    runtime_provider: str,
    runtime_model: str,
    runtime_mode: str,
    runtime_credential: str | None,
) -> AsyncGenerator[OneTextStreamEvent, None]:
    """Run one typed turn through One and expose text/directive deltas."""
    if str(runtime_provider or "").strip().lower() != "gemini":
        raise ValueError("One text ADK currently requires the Gemini provider")

    clean_user_id = str(user_id or "").strip()
    clean_conversation_id = str(conversation_id or "").strip()
    if not clean_user_id or not clean_conversation_id:
        raise ValueError("One text session identity is missing")

    session_service = InMemorySessionService()
    runner = Runner(
        app_name=ONE_APP_NAME,
        agent=build_one_text_agent(
            model=_runtime_model(
                runtime_model=runtime_model,
                runtime_mode=runtime_mode,
                runtime_credential=runtime_credential,
            )
        ),
        session_service=session_service,
    )
    sanitized_context = dict(screen_context or {})
    session = await session_service.create_session(
        app_name=ONE_APP_NAME,
        user_id=clean_user_id,
        session_id=f"chat_{uuid.uuid4().hex}",
        state={
            STATE_USER_ID: clean_user_id,
            STATE_CONSENT_TOKEN: str(consent_token or "").strip(),
            STATE_CONVERSATION_ID: clean_conversation_id,
            STATE_TIMEZONE: str(timezone or "").strip()[:64],
            STATE_SCREEN: str(sanitized_context.get("screen") or "").strip()[:64],
            STATE_VOICE_CONTEXT: sanitized_context,
            STATE_PKM_CONTEXT: str(pkm_context or "").strip()[:20000],
        },
    )

    for index, prior in enumerate(history[-20:]):
        content = _history_content(prior)
        if content is None:
            continue
        await session_service.append_event(
            session,
            Event(
                author="user" if content.role == "user" else "one",
                invocation_id=f"history_{index}",
                content=content,
            ),
        )

    new_message = genai_types.Content(
        role="user",
        parts=[genai_types.Part.from_text(text=str(message or "").strip()[:8000])],
    )
    emitted_directives: set[str] = set()
    saw_partial_text = False
    async for event in runner.run_async(
        user_id=clean_user_id,
        session_id=session.id,
        new_message=new_message,
        run_config=RunConfig(streaming_mode=StreamingMode.SSE),
    ):
        for directive in _event_directives(event):
            fingerprint = _directive_fingerprint(directive)
            if fingerprint in emitted_directives:
                continue
            emitted_directives.add(fingerprint)
            yield OneTextStreamEvent(kind="directive", directive=directive)

        text = _event_text(event)
        if not text:
            continue
        if bool(getattr(event, "partial", False)):
            saw_partial_text = True
            yield OneTextStreamEvent(kind="token", text=text)
            continue
        is_final_response = getattr(event, "is_final_response", None)
        if not saw_partial_text and callable(is_final_response) and is_final_response():
            yield OneTextStreamEvent(kind="token", text=text)
