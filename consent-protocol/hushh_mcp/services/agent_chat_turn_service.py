"""Transport-neutral Agent chat turn orchestration.

HTTP SSE routes and internal MCP tools both use this module so the A2A
delegation branch stays one implementation.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult
from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    AgentChatMessage,
    AgentRuntimeProviderError,
    PreparedAgentChatTurn,
    get_agent_chat_service,
)

logger = logging.getLogger(__name__)

DisconnectChecker = Callable[[], Awaitable[bool]]
DelegateResolver = Callable[[str], str | None]
WiredSpecialistChecker = Callable[[str], bool]

_NAV_INTENT_RE = re.compile(
    r"\b(?:open|go to|take me to|navigate to|launch|bring up)\b", re.IGNORECASE
)
_BARE_MARKETPLACE_RE = re.compile(r"\bmarketplace\b", re.IGNORECASE)
_MARKETPLACE_QUALIFIER_RE = re.compile(
    r"\b(?:information marketplace|data marketplace|kai|market home)\b", re.IGNORECASE
)
_MARKETPLACE_CLARIFICATION = (
    "Which marketplace do you mean — your **Information Marketplace** (your "
    "personal data slices and potential earnings) or **Kai's Market Home** "
    "(markets and investing)?"
)


@dataclass(frozen=True)
class AgentChatTurnInput:
    user_id: str
    message: str = ""
    conversation_id: str | None = None
    pkm_context: str | None = None
    screen_context: dict[str, Any] | None = None
    timezone: str | None = None
    runtime_credential: str | None = None
    runtime_credential_mode: str | None = None
    delegate_result: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentChatTurnEvent:
    name: str
    data: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {"event": self.name, "data": self.data}


@dataclass(frozen=True)
class PreparedAgentChatStream:
    conversation_id: str | None
    model: str | None
    delegate_agent_id: str | None
    iter_events: Callable[[], AsyncIterator[AgentChatTurnEvent]]


@dataclass(frozen=True)
class CollectedAgentChatTurn:
    conversation_id: str | None
    model: str | None
    delegate_agent_id: str | None
    text: str
    events: list[AgentChatTurnEvent]
    specialist_directives: list[dict[str, Any]]
    tool_events: list[dict[str, Any]]
    error: dict[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": "error" if self.error else "success",
            "conversation_id": self.conversation_id,
            "model": self.model,
            "delegate_agent_id": self.delegate_agent_id,
            "text": self.text,
            "events": [event.to_payload() for event in self.events],
            "specialist_directives": self.specialist_directives,
            "tool_events": self.tool_events,
            "error": self.error,
        }


def _is_bare_marketplace(message: str | None) -> bool:
    text = message or ""
    return bool(_BARE_MARKETPLACE_RE.search(text) and not _MARKETPLACE_QUALIFIER_RE.search(text))


def resolve_delegate_target(message: str) -> str | None:
    """Return a wired specialist agent id for this message, else None."""

    classified = classify_specialist_domain(message or "")
    if classified is None:
        return None
    domain, target_agent = classified
    if domain == "information_marketplace" and _NAV_INTENT_RE.search(message or ""):
        return None
    import hushh_mcp.adk_bridge  # noqa: F401  (ensures specialists are registered)

    return target_agent if is_wired_specialist(target_agent) else None


def specialist_result_to_frames(
    result: SpecialistTurnResult, delegate_agent_id: str, *, include_start: bool = True
) -> list[tuple[str, dict[str, Any]]]:
    """Format a specialist turn as ordered additive stream event tuples."""

    frames: list[tuple[str, dict[str, Any]]] = []
    if include_start:
        frames.append(("start", {"conversation_id": result.conversation_id, "model": result.model}))
    frames.append(("token", {"token": result.text}))
    if result.directive is not None:
        frontend_tool_payload = _frontend_tool_payload(result.directive.payload)
        if frontend_tool_payload is not None:
            frames.append(("tool_start", frontend_tool_payload))
            if str(frontend_tool_payload.get("execution") or "") == "frontend":
                frames.append(
                    (
                        "tool_waiting",
                        {
                            **frontend_tool_payload,
                            "message": result.text,
                            "status": "waiting_for_frontend",
                        },
                    )
                )
            else:
                frames.append(
                    (
                        "tool_result",
                        {
                            **frontend_tool_payload,
                            "message": result.text,
                            "status": "blocked",
                        },
                    )
                )
        else:
            frames.append(
                (
                    "specialist_directive",
                    {
                        "delegate_agent_id": delegate_agent_id,
                        "directive": {
                            "kind": result.directive.kind,
                            "payload": result.directive.payload,
                        },
                        "message": result.text,
                        "state_changed": result.state_changed,
                    },
                )
            )
    frames.append(
        (
            "complete",
            {
                "conversation_id": result.conversation_id,
                "status": "complete",
                "model": result.model,
            },
        )
    )
    return frames


def _frontend_tool_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    if str(payload.get("kind") or "") != "frontend_tool":
        return None
    return {key: value for key, value in payload.items() if key != "kind"}


async def _save_assistant_message(
    *,
    service: Any,
    turn: PreparedAgentChatTurn,
    user_id: str,
    text: str,
    status_value: Literal["complete", "interrupted", "error"],
    error_code: str | None = None,
) -> None:
    message_text = text.strip()
    if not message_text and status_value == "error":
        message_text = "Agent chat failed. Please try again."
    if not message_text and status_value == "interrupted":
        message_text = "Agent response was interrupted before it could finish."
    if not message_text:
        return
    await service.add_message(
        conversation_id=turn.conversation_id,
        user_id=user_id,
        role="assistant",
        content=message_text,
        status=status_value,
        model=turn.model,
        error_code=error_code,
    )


def _method_accepts_kwarg(method: Any, name: str) -> bool:
    try:
        return name in inspect.signature(method).parameters
    except (TypeError, ValueError):
        return True


async def _plan_action_with_gemini(
    service: Any,
    *,
    user_message: str,
    history: list[AgentChatMessage],
    runtime_client: Any,
    runtime_model: str,
    pkm_context: str | None,
    screen_context: dict[str, Any] | None,
    deterministic_crm_first: bool,
) -> AgentChatActionPlan | None:
    kwargs: dict[str, Any] = {
        "user_message": user_message,
        "history": history,
        "runtime_client": runtime_client,
        "runtime_model": runtime_model,
        "pkm_context": pkm_context,
        "screen_context": screen_context,
    }
    if _method_accepts_kwarg(service.plan_action_with_gemini, "deterministic_crm_first"):
        kwargs["deterministic_crm_first"] = deterministic_crm_first
    return await service.plan_action_with_gemini(**kwargs)


def _event(name: str, data: dict[str, Any]) -> AgentChatTurnEvent:
    return AgentChatTurnEvent(name=name, data=data)


def _events_from_frames(frames: list[tuple[str, dict[str, Any]]]) -> list[AgentChatTurnEvent]:
    return [_event(name, data) for name, data in frames]


async def prepare_agent_chat_turn_stream(
    body: AgentChatTurnInput,
    *,
    consent_token: str,
    service: Any | None = None,
    is_disconnected: DisconnectChecker | None = None,
    delegate_target_resolver: DelegateResolver = resolve_delegate_target,
    wired_specialist_checker: WiredSpecialistChecker = is_wired_specialist,
) -> PreparedAgentChatStream:
    """Prepare one Agent chat stream, independent of HTTP or MCP transport."""

    service = service or get_agent_chat_service()
    import hushh_mcp.adk_bridge  # noqa: F401  (ensures specialists are registered)

    delegate_agent_id: str | None = None
    delegate_result_payload: dict[str, Any] | None = None
    if body.delegate_result is not None:
        delegate_result_payload = dict(body.delegate_result)
        delegate_agent_id = (
            str(delegate_result_payload.get("delegate_agent_id") or "").strip() or None
        )
    elif body.message:
        delegate_agent_id = delegate_target_resolver(body.message)

    if delegate_agent_id is not None and wired_specialist_checker(delegate_agent_id):
        return await _prepare_delegated_stream(
            body,
            consent_token=consent_token,
            service=service,
            delegate_agent_id=delegate_agent_id,
            delegate_result_payload=delegate_result_payload,
        )

    if body.delegate_result is None and _is_bare_marketplace(body.message):
        conv_id = body.conversation_id or ""

        async def generate_clarification() -> AsyncIterator[AgentChatTurnEvent]:
            yield _event("start", {"conversation_id": conv_id, "model": "one"})
            yield _event("token", {"token": _MARKETPLACE_CLARIFICATION})
            yield _event("complete", {"conversation_id": conv_id, "status": "complete"})

        return PreparedAgentChatStream(
            conversation_id=conv_id,
            model="one",
            delegate_agent_id=None,
            iter_events=generate_clarification,
        )

    runtime = await service.prepare_agent_runtime(
        runtime_credential=body.runtime_credential,
        runtime_credential_mode=body.runtime_credential_mode,
    )
    turn = await service.prepare_turn(
        user_id=body.user_id,
        message=body.message,
        conversation_id=body.conversation_id,
    )
    action_plan = await _plan_action_with_gemini(
        service,
        user_message=body.message,
        history=turn.history,
        runtime_client=runtime.client,
        runtime_model=runtime.model,
        pkm_context=body.pkm_context,
        screen_context=body.screen_context,
        deterministic_crm_first=False,
    )

    if (
        action_plan is not None
        and str(action_plan.action_id or "").startswith("connected_system.crm.")
        and wired_specialist_checker("agent_connected_systems")
    ):
        return _prepare_planned_delegated_stream(
            body,
            consent_token=consent_token,
            service=service,
            turn=turn,
            action_plan=action_plan,
        )

    return _prepare_standard_stream(
        body,
        service=service,
        runtime=runtime,
        turn=turn,
        action_plan=action_plan,
        is_disconnected=is_disconnected,
    )


async def _prepare_delegated_stream(
    body: AgentChatTurnInput,
    *,
    consent_token: str,
    service: Any,
    delegate_agent_id: str,
    delegate_result_payload: dict[str, Any] | None,
) -> PreparedAgentChatStream:
    from hushh_mcp.adk_bridge import dispatch as dispatch_module

    delegated_turn: PreparedAgentChatTurn | None = None
    delegated_conversation_id = body.conversation_id
    planned_action_payload: dict[str, Any] | None = None
    prepare_started = time.perf_counter()
    prepare_ms = 0.0
    if body.message.strip():
        delegated_turn = await service.prepare_turn(
            user_id=body.user_id,
            message=body.message,
            conversation_id=body.conversation_id,
        )
        delegated_conversation_id = delegated_turn.conversation_id
        prepare_ms = (time.perf_counter() - prepare_started) * 1000
        if delegate_agent_id == "agent_connected_systems":
            try:
                runtime = await service.prepare_agent_runtime(
                    runtime_credential=body.runtime_credential,
                    runtime_credential_mode=body.runtime_credential_mode,
                )
                planned_action = await _plan_action_with_gemini(
                    service,
                    user_message=body.message,
                    history=delegated_turn.history,
                    runtime_client=runtime.client,
                    runtime_model=runtime.model,
                    pkm_context=body.pkm_context,
                    screen_context=body.screen_context,
                    deterministic_crm_first=False,
                )
                if planned_action is not None:
                    planned_action_payload = planned_action.to_event_payload()
            except Exception as error:  # noqa: BLE001
                logger.warning(
                    "agent_chat.delegation_planner_failed user_id=%s delegate_agent_id=%s: %s",
                    body.user_id,
                    delegate_agent_id,
                    error,
                )

    task = A2ATask(
        user_id=body.user_id,
        consent_token=consent_token,
        conversation_id=delegated_conversation_id,
        message=body.message or None,
        delegate_result=delegate_result_payload,
        timezone=body.timezone,
        planned_action=planned_action_payload,
    )

    async def generate_delegated() -> AsyncIterator[AgentChatTurnEvent]:
        yield _event(
            "start",
            {
                "conversation_id": delegated_conversation_id or "",
                "model": "delegated",
                "delegate_agent_id": delegate_agent_id,
            },
        )
        dispatch_started = time.perf_counter()
        try:
            result = await dispatch_module.dispatch(delegate_agent_id, task)
        except Exception as error:  # noqa: BLE001
            dispatch_ms = (time.perf_counter() - dispatch_started) * 1000
            logger.exception(
                "agent_chat.delegation_failed user_id=%s delegate_agent_id=%s prepare_ms=%.1f dispatch_ms=%.1f: %s",
                body.user_id,
                delegate_agent_id,
                prepare_ms,
                dispatch_ms,
                error,
            )
            yield _event(
                "error",
                {
                    "message": "Agent chat failed. Please try again.",
                    "conversation_id": body.conversation_id or "",
                },
            )
            return
        dispatch_ms = (time.perf_counter() - dispatch_started) * 1000
        conversation_id = result.conversation_id or delegated_conversation_id
        save_ms = 0.0
        if conversation_id:
            save_turn = PreparedAgentChatTurn(
                conversation_id=conversation_id,
                user_message_id=delegated_turn.user_message_id if delegated_turn else "",
                history=delegated_turn.history if delegated_turn else [],
                model=result.model,
            )
            save_started = time.perf_counter()
            await _save_assistant_message(
                service=service,
                turn=save_turn,
                user_id=body.user_id,
                text=result.text,
                status_value="complete",
            )
            save_ms = (time.perf_counter() - save_started) * 1000
        logger.info(
            "agent_chat.delegation_timing user_id=%s conversation_id=%s delegate_agent_id=%s prepare_ms=%.1f dispatch_ms=%.1f save_ms=%.1f total_ms=%.1f",
            body.user_id,
            conversation_id or "",
            delegate_agent_id,
            prepare_ms,
            dispatch_ms,
            save_ms,
            prepare_ms + dispatch_ms + save_ms,
        )
        for event in _events_from_frames(
            specialist_result_to_frames(result, delegate_agent_id, include_start=False)
        ):
            yield event

    return PreparedAgentChatStream(
        conversation_id=delegated_conversation_id,
        model="delegated",
        delegate_agent_id=delegate_agent_id,
        iter_events=generate_delegated,
    )


def _prepare_planned_delegated_stream(
    body: AgentChatTurnInput,
    *,
    consent_token: str,
    service: Any,
    turn: PreparedAgentChatTurn,
    action_plan: AgentChatActionPlan,
) -> PreparedAgentChatStream:
    from hushh_mcp.adk_bridge import dispatch as dispatch_module

    task = A2ATask(
        user_id=body.user_id,
        consent_token=consent_token,
        conversation_id=turn.conversation_id,
        message=body.message or None,
        timezone=body.timezone,
        planned_action=action_plan.to_event_payload(),
    )

    async def generate_planned_delegated() -> AsyncIterator[AgentChatTurnEvent]:
        yield _event(
            "start",
            {
                "conversation_id": turn.conversation_id,
                "model": "delegated",
                "delegate_agent_id": "agent_connected_systems",
            },
        )
        dispatch_started = time.perf_counter()
        try:
            result = await dispatch_module.dispatch("agent_connected_systems", task)
        except Exception as error:  # noqa: BLE001
            dispatch_ms = (time.perf_counter() - dispatch_started) * 1000
            logger.exception(
                "agent_chat.planned_delegation_failed user_id=%s delegate_agent_id=%s dispatch_ms=%.1f: %s",
                body.user_id,
                "agent_connected_systems",
                dispatch_ms,
                error,
            )
            yield _event(
                "error",
                {
                    "message": "Agent chat failed. Please try again.",
                    "conversation_id": turn.conversation_id,
                },
            )
            return
        await _save_assistant_message(
            service=service,
            turn=turn,
            user_id=body.user_id,
            text=result.text,
            status_value="complete",
        )
        for event in _events_from_frames(
            specialist_result_to_frames(result, "agent_connected_systems", include_start=False)
        ):
            yield event

    return PreparedAgentChatStream(
        conversation_id=turn.conversation_id,
        model="delegated",
        delegate_agent_id="agent_connected_systems",
        iter_events=generate_planned_delegated,
    )


def _prepare_standard_stream(
    body: AgentChatTurnInput,
    *,
    service: Any,
    runtime: Any,
    turn: PreparedAgentChatTurn,
    action_plan: AgentChatActionPlan | None,
    is_disconnected: DisconnectChecker | None,
) -> PreparedAgentChatStream:
    async def generate() -> AsyncIterator[AgentChatTurnEvent]:
        chunks: list[str] = []
        saved = False
        try:
            yield _event(
                "start",
                {
                    "conversation_id": turn.conversation_id,
                    "model": turn.model,
                },
            )
            if action_plan is not None:
                payload = action_plan.to_event_payload()
                yield _event("tool_start", payload)
                if action_plan.execution == "frontend":
                    receipt_text = action_plan.message.strip() or "Working on that in Kai."
                    await _save_assistant_message(
                        service=service,
                        turn=turn,
                        user_id=body.user_id,
                        text=receipt_text,
                        status_value="complete",
                    )
                    chunks.append(receipt_text)
                    saved = True
                    yield _event("token", {"token": receipt_text})
                    yield _event(
                        "tool_waiting",
                        {
                            **payload,
                            "message": receipt_text,
                            "status": "waiting_for_frontend",
                        },
                    )
                    yield _event(
                        "complete",
                        {
                            "conversation_id": turn.conversation_id,
                            "status": "complete",
                            "model": turn.model,
                        },
                    )
                    return
                receipt_text = action_plan.message.strip() or "That action is blocked in Agent."
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text=receipt_text,
                    status_value="complete",
                )
                chunks.append(receipt_text)
                saved = True
                yield _event(
                    "tool_result",
                    {
                        **payload,
                        "status": "blocked",
                    },
                )
                yield _event("token", {"token": receipt_text})
                yield _event(
                    "complete",
                    {
                        "conversation_id": turn.conversation_id,
                        "status": "complete",
                        "model": turn.model,
                    },
                )
                return
            async for token in service.stream_response(
                user_message=body.message,
                history=turn.history,
                runtime_client=runtime.client,
                runtime_model=runtime.model,
                action_plan=action_plan,
                pkm_context=body.pkm_context,
            ):
                if is_disconnected is not None and await is_disconnected():
                    text = "".join(chunks)
                    await _save_assistant_message(
                        service=service,
                        turn=turn,
                        user_id=body.user_id,
                        text=text,
                        status_value="interrupted",
                    )
                    saved = True
                    return
                chunks.append(token)
                yield _event("token", {"token": token})

            text = "".join(chunks)
            await _save_assistant_message(
                service=service,
                turn=turn,
                user_id=body.user_id,
                text=text,
                status_value="complete",
            )
            saved = True
            yield _event(
                "complete",
                {
                    "conversation_id": turn.conversation_id,
                    "status": "complete",
                    "model": turn.model,
                },
            )
        except asyncio.CancelledError:
            if not saved:
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text="".join(chunks),
                    status_value="interrupted",
                )
            raise
        except AgentRuntimeProviderError as error:
            logger.warning(
                "agent_chat.stream_provider_failed user_id=%s error_code=%s detail=%s",
                body.user_id,
                error.error_code,
                error.detail,
            )
            if not saved:
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text=error.message,
                    status_value="error",
                    error_code=error.error_code,
                )
                saved = True
            yield _event(
                "error",
                {
                    "code": error.error_code,
                    "message": error.message,
                    "conversation_id": turn.conversation_id,
                },
            )
        except Exception as error:
            logger.exception("agent_chat.stream_failed user_id=%s: %s", body.user_id, error)
            if not saved:
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text="".join(chunks),
                    status_value="error",
                    error_code="AGENT_CHAT_STREAM_FAILED",
                )
                saved = True
            yield _event(
                "error",
                {
                    "message": "Agent chat failed. Please try again.",
                    "conversation_id": turn.conversation_id,
                },
            )

    return PreparedAgentChatStream(
        conversation_id=turn.conversation_id,
        model=turn.model,
        delegate_agent_id=None,
        iter_events=generate,
    )


async def collect_agent_chat_turn(
    body: AgentChatTurnInput,
    *,
    consent_token: str,
    service: Any | None = None,
    delegate_target_resolver: DelegateResolver = resolve_delegate_target,
    wired_specialist_checker: WiredSpecialistChecker = is_wired_specialist,
) -> CollectedAgentChatTurn:
    prepared = await prepare_agent_chat_turn_stream(
        body,
        consent_token=consent_token,
        service=service,
        delegate_target_resolver=delegate_target_resolver,
        wired_specialist_checker=wired_specialist_checker,
    )
    events: list[AgentChatTurnEvent] = []
    text_chunks: list[str] = []
    specialist_directives: list[dict[str, Any]] = []
    tool_events: list[dict[str, Any]] = []
    error: dict[str, Any] | None = None
    conversation_id = prepared.conversation_id
    model = prepared.model

    async for event in prepared.iter_events():
        events.append(event)
        if event.name == "token":
            token = event.data.get("token")
            if isinstance(token, str):
                text_chunks.append(token)
        elif event.name == "specialist_directive":
            specialist_directives.append(event.data)
        elif event.name in {"tool_start", "tool_waiting", "tool_result"}:
            tool_events.append({"event": event.name, **event.data})
        elif event.name == "start":
            conversation_id = (
                str(event.data.get("conversation_id") or conversation_id or "") or None
            )
            model = str(event.data.get("model") or model or "") or None
        elif event.name == "complete":
            conversation_id = (
                str(event.data.get("conversation_id") or conversation_id or "") or None
            )
            model = str(event.data.get("model") or model or "") or None
        elif event.name == "error":
            error = dict(event.data)

    return CollectedAgentChatTurn(
        conversation_id=conversation_id,
        model=model,
        delegate_agent_id=prepared.delegate_agent_id,
        text="".join(text_chunks),
        events=events,
        specialist_directives=specialist_directives,
        tool_events=tool_events,
        error=error,
    )
