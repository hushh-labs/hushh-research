"""Isolated, consent-context-aware execution for specialist ADK turns."""

from __future__ import annotations

import asyncio
import copy
import logging
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig
from google.adk.apps import App
from google.adk.events import Event
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.events import bounded_adk_events
from hushh_mcp.hushh_adk.telemetry import private_telemetry

logger = logging.getLogger(__name__)
_MAX_HISTORY = 12
_HISTORY_CHARS = 2000
_CLOSE_TIMEOUT_S = 1.0


@dataclass(frozen=True)
class SpecialistAdkTurn:
    final_text: str
    tool_calls: tuple[types.FunctionCall, ...]
    tool_results: tuple[types.FunctionResponse, ...]
    state: dict[str, Any]
    llm_calls: int
    elapsed_ms: int


class SpecialistAdkCallLimitError(RuntimeError):
    """The turn's model-call budget was exhausted, including nested agents."""


class SpecialistAdkTurnError(RuntimeError):
    """A failed turn with completed tool receipts; original error is __cause__."""

    def __init__(self, partial_turn: SpecialistAdkTurn):
        super().__init__("Specialist turn failed; completed tool results remain available")
        self.partial_turn = partial_turn


def hushh_tool_error_callback(
    *, tool: Any, args: dict[str, Any], tool_context: Any, error: Exception
) -> dict[str, str] | None:
    """Safe expected tool failures; return None so ADK propagates other errors."""
    if isinstance(error, PermissionError):
        return {"error": "consent_denied"}
    if isinstance(error, ValueError):
        return {"error": "invalid_argument"}
    return None


class _CallBudget(BasePlugin):
    def __init__(self, limit: int):
        super().__init__(name="hushh_specialist_call_budget")
        self.limit = limit
        self.calls = 0
        self.last_progress: float | None = None
        self.tool_calls: list[types.FunctionCall] = []
        self.tool_results: list[types.FunctionResponse] = []

    async def before_model_callback(self, *, callback_context: Any, llm_request: Any):
        # AgentTool defaults to sharing the parent's plugins. This same instance
        # therefore counts nested calls too, unlike per-invocation RunConfig.
        if self.calls >= self.limit:
            raise SpecialistAdkCallLimitError("Specialist model-call budget exhausted")
        self.calls += 1
        return None

    async def before_tool_callback(self, *, tool: Any, tool_args: dict, tool_context: Any):
        self.tool_calls.append(
            types.FunctionCall(
                id=tool_context.function_call_id, name=tool.name, args=copy.deepcopy(tool_args)
            )
        )
        return None

    async def after_model_callback(self, *, callback_context: Any, llm_response: Any):
        # A received response is actual request progress; merely starting a
        # request (or retrying one) does not refresh the inactivity deadline.
        self.last_progress = asyncio.get_running_loop().time()
        return None

    async def after_tool_callback(
        self, *, tool: Any, tool_args: dict, tool_context: Any, result: Any
    ):
        self.tool_results.append(
            types.FunctionResponse(
                id=tool_context.function_call_id,
                name=tool.name,
                response=copy.deepcopy(result if isinstance(result, dict) else {"result": result}),
            )
        )
        self.last_progress = asyncio.get_running_loop().time()
        return None


def _history_content(prior: Any) -> types.Content | None:
    def field(name: str):
        return prior.get(name) if isinstance(prior, Mapping) else getattr(prior, name, None)

    role = field("role")
    content = field("content")
    if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip():
        return None
    return types.Content(
        role="user" if role == "user" else "model",
        parts=[types.Part.from_text(text=content.strip()[:_HISTORY_CHARS])],
    )


async def _close_runner(runner: Runner) -> None:
    closing = asyncio.create_task(runner.close())
    done, _ = await asyncio.wait({closing}, timeout=_CLOSE_TIMEOUT_S)
    if not done:
        closing.cancel()
        closing.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        raise RuntimeError("Specialist runner termination unconfirmed")
    closing.result()


async def run_specialist_adk_turn(
    *,
    agent: LlmAgent,
    app_name: str,
    user_id: str,
    consent_token: str,
    message: str | types.Content,
    history: Sequence[Any] = (),
    state: Mapping[str, Any] | None = None,
    vault_keys: Mapping[str, str] | None = None,
    scope_tokens: Mapping[str, str] | None = None,
    service_ports: Mapping[str, Any] | None = None,
    max_llm_calls: int = 5,
    first_event_timeout_s: float = 20,
    between_event_timeout_s: float = 20,
    total_timeout_s: float = 60,
) -> SpecialistAdkTurn:
    """Run once with caller-built model/transport and fresh turn-local storage.

    Agent builders own model configuration and the shared tool-error callback.
    This helper does not replay a whole turn on provider failure, because a
    completed tool may have external side effects. Credentials remain solely
    in HushhContext; callers supply only consented model-visible state/history.
    AgentTool children must retain include_plugins=True for shared call limits.
    ADK 2.9 Runner requires root mode chat or task; callers author that mode.
    Failed turns expose completed results on SpecialistAdkTurnError.partial_turn.
    """
    if not app_name.strip() or not user_id.strip():
        raise ValueError("Specialist app, user, and message are required")
    if isinstance(message, str):
        if not message.strip():
            raise ValueError("Specialist app, user, and message are required")
        user_message = types.Content(
            role="user", parts=[types.Part.from_text(text=message.strip())]
        )
    elif isinstance(message, types.Content):
        if not message.parts:
            raise ValueError("Specialist message content must contain parts")
        user_message = message
    else:  # pragma: no cover - guarded by the public type contract
        raise TypeError("Specialist message must be text or google.genai.types.Content")
    if isinstance(max_llm_calls, bool) or not isinstance(max_llm_calls, int) or max_llm_calls < 1:
        raise ValueError("Specialist model-call budget must be a positive integer")
    started = time.perf_counter()
    store = InMemorySessionService()
    session = await store.create_session(
        app_name=app_name,
        user_id=user_id,
        session_id=f"turn_{uuid.uuid4().hex}",
        state=copy.deepcopy(dict(state or {})),
    )
    for index, prior in enumerate(history[-_MAX_HISTORY:]):
        content = _history_content(prior)
        if content is not None:
            await store.append_event(
                session,
                Event(
                    author="user" if content.role == "user" else agent.name,
                    invocation_id=f"history_{index}",
                    content=content,
                ),
            )
    budget = _CallBudget(max_llm_calls)
    runner = Runner(
        app=App(name=app_name, root_agent=agent, plugins=[budget]), session_service=store
    )
    final_text = ""
    reported_failure = False

    async def snapshot():
        current = await store.get_session(app_name=app_name, user_id=user_id, session_id=session.id)
        return SpecialistAdkTurn(
            final_text=final_text,
            tool_calls=tuple(budget.tool_calls),
            tool_results=tuple(budget.tool_results),
            state=copy.deepcopy(current.state if current is not None else session.state),
            llm_calls=budget.calls,
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )

    with HushhContext(
        user_id=user_id,
        consent_token=consent_token,
        vault_keys=dict(vault_keys or {}),
        scope_tokens=dict(scope_tokens or {}),
        service_ports=dict(service_ports or {}),
    ):
        try:
            source = runner.run_async(
                user_id=user_id,
                session_id=session.id,
                new_message=user_message,
                run_config=RunConfig(max_llm_calls=max_llm_calls, telemetry=private_telemetry()),
            )
            async for event in bounded_adk_events(
                source,
                first_event_timeout_s=first_event_timeout_s,
                between_event_timeout_s=between_event_timeout_s,
                total_timeout_s=total_timeout_s,
                progress_timestamp=lambda: budget.last_progress,
            ):
                if event.error_code or event.error_message:
                    # ADK emits an error event before raising the original cause.
                    # Drain to that cause rather than replacing it prematurely.
                    reported_failure = True
                if event.author == agent.name and event.is_final_response() and event.content:
                    text = "".join(
                        part.text
                        for part in event.content.parts or []
                        if isinstance(part.text, str) and not part.thought
                    )
                    if text:
                        final_text = text
            if reported_failure:
                raise RuntimeError("Specialist model reported a turn failure")
        except Exception as exc:
            raise SpecialistAdkTurnError(await snapshot()) from exc
        finally:
            try:
                await _close_runner(runner)
            except Exception as exc:
                logger.warning("specialist_runner.close_failed error_type=%s", type(exc).__name__)
                raise SpecialistAdkTurnError(await snapshot()) from exc
    return await snapshot()


__all__ = [
    "SpecialistAdkTurn",
    "SpecialistAdkCallLimitError",
    "SpecialistAdkTurnError",
    "hushh_tool_error_callback",
    "run_specialist_adk_turn",
]
