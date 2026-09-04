"""Typed-chat adapter for One's existing ADK semantic head.

The browser-facing Agent Chat route keeps its durable conversation store and
SSE wire contract. This module only replaces the old keyword router plus
separate action planner with the same One agent/tool tree used by voice.

Each turn uses an ephemeral ADK session seeded from encrypted durable chat
history. That keeps BYOK credentials and decrypted PKM context turn-bounded,
while avoiding process-local session loss as a second source of chat truth.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.events import Event
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
    build_one_intro_text_agent,
    build_one_text_agent,
)
from hushh_mcp.runtime_providers import (
    ManagedGeminiRuntimeBinding,
    build_gemini_byok_adk_model,
    build_managed_gemini_adk_model,
)
from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error
from hushh_mcp.services.action_gateway import get_action_gateway_action

logger = logging.getLogger(__name__)

OneTextEventKind = Literal["token", "thought", "source", "directive", "boundary"]
_FIRST_EVENT_TIMEOUT_SECONDS = 20.0
_BETWEEN_EVENT_TIMEOUT_SECONDS = 30.0
_TOTAL_TURN_TIMEOUT_SECONDS = 90.0


@dataclass(frozen=True)
class OneTextDirective:
    kind: Literal["action", "prompt"]
    payload: dict[str, Any]
    delegate_agent_id: str | None = None


@dataclass(frozen=True)
class OneTextSource:
    """A subagent (specialist) One consulted this turn, surfaced as a source."""

    agent_id: str
    label: str
    reason: str = ""


@dataclass(frozen=True)
class OneTextStreamEvent:
    kind: OneTextEventKind
    text: str = ""
    directive: OneTextDirective | None = None
    source: OneTextSource | None = None


class OneTextEmptyResponseError(RuntimeError):
    """Raised when the model turn produces neither user-visible text nor a directive."""


async def _bounded_adk_events(source: Any) -> AsyncGenerator[Any, None]:
    """Bound ADK startup, idle gaps, and total turn time without changing events."""
    iterator = source.__aiter__()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _TOTAL_TURN_TIMEOUT_SECONDS
    saw_event = False
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            timeout = min(
                _BETWEEN_EVENT_TIMEOUT_SECONDS if saw_event else _FIRST_EVENT_TIMEOUT_SECONDS,
                remaining,
            )
            try:
                event = await asyncio.wait_for(anext(iterator), timeout=timeout)
            except StopAsyncIteration:
                return
            saw_event = True
            yield event
    finally:
        close = getattr(iterator, "aclose", None)
        if callable(close):
            try:
                await asyncio.wait_for(close(), timeout=1.0)
            except Exception:
                logger.debug("one_text_stream_close_failed", exc_info=True)


def _runtime_model(
    *,
    runtime_model: str,
    runtime_mode: str,
    runtime_credential: str | None,
    runtime_credential_transport: Literal["developer_api", "vertex_api_key"] = "developer_api",
    runtime_vertex_project: str | None = None,
    runtime_vertex_location: str | None = None,
    managed_location: str | None = None,
) -> Any:
    """Build a turn-local ADK model without persisting a BYOK secret."""
    model = str(runtime_model or "").strip()
    if not model:
        raise ValueError("One text runtime model is missing")
    credential = str(runtime_credential or "").strip()
    if runtime_mode == "byok" and not credential:
        raise ValueError("One text BYOK credential is missing")
    if runtime_mode == "byok":
        return build_gemini_byok_adk_model(
            model,
            credential,
            transport=runtime_credential_transport,
            vertex_project=runtime_vertex_project,
            vertex_location=runtime_vertex_location,
        )
    if runtime_mode != "hushh_managed_vertex":
        # Closed set, and closed is the point. hussh's own Vertex identity used to
        # be the DEFAULT branch: any mode string that was not exactly "byok" landed
        # here. That is how a vocabulary drift between two files turned into "route
        # this person's prompts and their grounded holdings through hussh's
        # identity, billed to hussh" rather than into an error.
        #
        # A credential mode nobody recognises must refuse, never fall back to the
        # most privileged option available.
        raise ValueError(f"One text runtime mode is not recognised: {runtime_mode!r}")
    if credential:
        # Mirror the existing managed Agent Chat transport: Vertex mode with
        # the platform-managed key, held only by this turn-local model object.
        raise ValueError("Managed Vertex cannot be constructed from an API key")
    return build_managed_gemini_adk_model(model, vertex_location=managed_location)


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


def _event_thought(event: Any) -> str:
    """Extract only Gemini thought-summary parts (the visible reasoning trace)."""
    if str(getattr(event, "author", "") or "") != "one":
        return ""
    content = getattr(event, "content", None)
    parts = getattr(content, "parts", None) or []
    return "".join(
        str(part.text)
        for part in parts
        if isinstance(getattr(part, "text", None), str) and bool(getattr(part, "thought", False))
    )


# Specialist/tool function-call name -> (agent_id, human label). Only true
# subagents (and web search) become sources; app-action tools do not.
_SPECIALIST_TOOL_SOURCES: dict[str, tuple[str, str]] = {
    "ask_email_agent": ("agent_email", "Email"),
    "ask_location_agent": ("agent_location", "Location"),
    "ask_connected_systems_agent": ("agent_connected_systems", "Connected Systems"),
    "ask_consent_agent": ("agent_nav", "Consent Center"),
    "ask_compute_agent": ("agent_compute", "Compute"),
    "finance": ("agent_kai", "Finance"),
    "google_search": ("web", "Web search"),
}


def _event_sources(event: Any) -> list[OneTextSource]:
    """Map One's specialist/tool function-calls to subagent source records."""
    if str(getattr(event, "author", "") or "") != "one":
        return []
    get_calls = getattr(event, "get_function_calls", None)
    if not callable(get_calls):
        return []
    sources: list[OneTextSource] = []
    for call in get_calls() or []:
        name = str(getattr(call, "name", "") or "")
        mapped = _SPECIALIST_TOOL_SOURCES.get(name)
        if mapped is None:
            continue
        agent_id, label = mapped
        args = getattr(call, "args", None)
        # Nav's Consent Center vs its Connections child is selected by `target`.
        if (
            name == "ask_consent_agent"
            and isinstance(args, dict)
            and args.get("target") == "connections"
        ):
            agent_id, label = "agent_connections", "Connections"
        reason = ""
        if isinstance(args, dict):
            reason = str(args.get("request") or args.get("query") or "").strip()[:160]
        sources.append(OneTextSource(agent_id=agent_id, label=label, reason=reason))
    return sources


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
        if not action_id or get_action_gateway_action(action_id) is None:
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


def _event_crosses_replay_boundary(event: Any) -> bool:
    """Detect provider/tool events after which a regional replay is unsafe."""
    actions = getattr(event, "actions", None)
    state_delta = getattr(actions, "state_delta", None)
    if isinstance(state_delta, dict) and state_delta:
        return True
    content = getattr(event, "content", None)
    for part in getattr(content, "parts", None) or []:
        if getattr(part, "function_call", None) is not None:
            return True
        if getattr(part, "function_response", None) is not None:
            return True
    return False


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


async def _stream_one_text_turn_once(
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
    runtime_credential_transport: Literal["developer_api", "vertex_api_key"] = "developer_api",
    runtime_vertex_project: str | None = None,
    runtime_vertex_location: str | None = None,
    managed_location: str | None = None,
) -> AsyncGenerator[OneTextStreamEvent, None]:
    """Run one typed turn in one endpoint and expose replay boundaries."""
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
                runtime_credential_transport=runtime_credential_transport,
                runtime_vertex_project=runtime_vertex_project,
                runtime_vertex_location=runtime_vertex_location,
                managed_location=managed_location,
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
    emitted_visible_output = False
    started_at = time.perf_counter()
    first_visible_at: float | None = None
    source = runner.run_async(
        user_id=clean_user_id,
        session_id=session.id,
        new_message=new_message,
        run_config=RunConfig(streaming_mode=StreamingMode.SSE),
    )
    async for event in _bounded_adk_events(source):
        if _event_crosses_replay_boundary(event):
            yield OneTextStreamEvent(kind="boundary")
        for directive in _event_directives(event):
            fingerprint = _directive_fingerprint(directive)
            if fingerprint in emitted_directives:
                continue
            emitted_directives.add(fingerprint)
            emitted_visible_output = True
            if first_visible_at is None:
                first_visible_at = time.perf_counter()
            yield OneTextStreamEvent(kind="directive", directive=directive)

        thought = _event_thought(event)
        if thought:
            yield OneTextStreamEvent(kind="thought", text=thought)

        for text_source in _event_sources(event):
            yield OneTextStreamEvent(kind="source", source=text_source)

        text = _event_text(event)
        if not text:
            continue
        if bool(getattr(event, "partial", False)):
            saw_partial_text = True
            emitted_visible_output = True
            if first_visible_at is None:
                first_visible_at = time.perf_counter()
            yield OneTextStreamEvent(kind="token", text=text)
            continue
        is_final_response = getattr(event, "is_final_response", None)
        if not saw_partial_text and callable(is_final_response) and is_final_response():
            emitted_visible_output = True
            if first_visible_at is None:
                first_visible_at = time.perf_counter()
            yield OneTextStreamEvent(kind="token", text=text)

    if not emitted_visible_output:
        raise OneTextEmptyResponseError(
            "One text runtime completed without visible text or a directive"
        )
    logger.info(
        "one_text_turn_complete model=%s first_visible_ms=%s elapsed_ms=%s directives=%s",
        runtime_model,
        (round((first_visible_at - started_at) * 1000) if first_visible_at is not None else None),
        round((time.perf_counter() - started_at) * 1000),
        len(emitted_directives),
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
    runtime_credential_transport: Literal["developer_api", "vertex_api_key"] = "developer_api",
    runtime_vertex_project: str | None = None,
    runtime_vertex_location: str | None = None,
) -> AsyncGenerator[OneTextStreamEvent, None]:
    """Run One with same-model regional failover before any observable event."""
    locations: tuple[str | None, ...] = (None,)
    if runtime_mode == "hushh_managed_vertex":
        binding = ManagedGeminiRuntimeBinding.from_environment()
        locations = tuple(binding.locations_for_model(runtime_model))

    last_index = len(locations) - 1
    for index, location in enumerate(locations):
        replay_boundary_crossed = False
        try:
            async for event in _stream_one_text_turn_once(
                user_id=user_id,
                consent_token=consent_token,
                conversation_id=conversation_id,
                message=message,
                history=history,
                timezone=timezone,
                screen_context=screen_context,
                pkm_context=pkm_context,
                runtime_provider=runtime_provider,
                runtime_model=runtime_model,
                runtime_mode=runtime_mode,
                runtime_credential=runtime_credential,
                runtime_credential_transport=runtime_credential_transport,
                runtime_vertex_project=runtime_vertex_project,
                runtime_vertex_location=runtime_vertex_location,
                managed_location=location,
            ):
                if event.kind == "boundary":
                    replay_boundary_crossed = True
                    continue
                if event.kind in ("thought", "source"):
                    # Reasoning + source records stream around the answer; forward
                    # them but keep the turn replay-safe so a pre-answer failover
                    # can still retry without duplicating visible answer output.
                    yield event
                    continue
                replay_boundary_crossed = True
                yield event
            return
        except Exception as error:  # noqa: BLE001 - provider boundary
            if (
                replay_boundary_crossed
                or index == last_index
                or not is_retryable_vertex_error(error)
            ):
                raise
            logger.warning(
                "one_text_vertex_failover from_location=%s error_type=%s",
                location,
                error.__class__.__name__,
            )


async def stream_one_intro_text_turn(
    *,
    user_id: str,
    message: str,
    screen_context: dict[str, Any] | None,
    runtime_provider: str,
    runtime_model: str,
    runtime_mode: str,
    runtime_credential: str | None,
) -> AsyncGenerator[OneTextStreamEvent, None]:
    """Run One's anonymous informational turn through the semantic ADK head.

    The lower-privilege agent has a navigation-only roster. It deliberately
    carries no consent token, history, or PKM context, so this is not a
    shortcut into unlocked Agent Chat.
    """
    if str(runtime_provider or "").strip().lower() != "gemini":
        raise ValueError("One intro text runtime currently requires the Gemini provider")

    clean_user_id = str(user_id or "").strip() or "anonymous"
    session_service = InMemorySessionService()
    runner = Runner(
        app_name=ONE_APP_NAME,
        agent=build_one_intro_text_agent(
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
        session_id=f"intro_{uuid.uuid4().hex}",
        state={
            STATE_USER_ID: clean_user_id,
            STATE_SCREEN: str(sanitized_context.get("screen") or "").strip()[:64],
            STATE_VOICE_CONTEXT: sanitized_context,
        },
    )
    new_message = genai_types.Content(
        role="user",
        parts=[genai_types.Part.from_text(text=str(message or "").strip()[:4000])],
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

        thought = _event_thought(event)
        if thought:
            yield OneTextStreamEvent(kind="thought", text=thought)

        for text_source in _event_sources(event):
            yield OneTextStreamEvent(kind="source", source=text_source)

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
