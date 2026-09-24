"""Turn timing for the private agent's canonical AG-UI transport.

``ADKAgent`` streams AG-UI protocol events straight to the client and records
nothing about how long a turn took. ``TimedADKAgent`` wraps ``run`` and logs one
line per turn in the same shape as ``one_text_turn_complete`` in
``text_runtime``. The line carries only timing counters, a head label and the
first eight characters of the client-random ``run_id``. It never carries the
user id, the thread id, the state projection or any message text.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import re
import time
from collections.abc import AsyncGenerator
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any, cast

from ag_ui.core import BaseEvent, EventType, RunAgentInput
from ag_ui_adk import ADKAgent

from hushh_mcp.one_adk.drive_result_privacy import redact_drive_wire_event
from hushh_mcp.one_adk.external_read_boundary import before_external_read_model
from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope
from hushh_mcp.one_adk.output_privacy import public_event

logger = logging.getLogger(__name__)


class _NoModelTextPreview(logging.Filter):
    """The installed AG-UI adapter logs model text previews at INFO."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.getMessage().startswith("[ADK_EVENT]"):
            record.msg = "[ADK_EVENT] content=[redacted]"
            record.args = ()
        return True


_bridge_logger = logging.getLogger("ag_ui_adk.adk_agent")
if not any(isinstance(item, _NoModelTextPreview) for item in _bridge_logger.filters):
    _bridge_logger.addFilter(_NoModelTextPreview())

HEAD_ONE = "one"
HEAD_INTRO = "intro"
HEAD_UNLABELED = "unlabeled"

OUTCOME_FINISHED = "finished"
OUTCOME_ERROR = "error"
OUTCOME_CLIENT_DISCONNECT = "client_disconnect"

_FIRST_VISIBLE_EVENT_TYPES = frozenset(
    {EventType.TEXT_MESSAGE_CONTENT, EventType.TOOL_CALL_START, EventType.CUSTOM}
)
_SPECIALIST_TOOL_PREFIX = "ask_"
_RUN_LABEL_LENGTH = 8
_DETAILED_TIMING_ENV = "HUSHH_ONE_CHAT_TIMING_DETAIL"
_MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_CURRENT_TURN: contextvars.ContextVar[TurnTiming | None] = contextvars.ContextVar(
    "one_chat_turn_timing", default=None
)


def run_label(input_data: RunAgentInput) -> str:
    """Return the short, client-random run label used in the timing line."""
    return str(getattr(input_data, "run_id", "") or "")[:_RUN_LABEL_LENGTH]


def _ms_since(started_at: float, at: float | None) -> int | None:
    if at is None:
        return None
    return round((at - started_at) * 1000)


@dataclass
class TurnTiming:
    """Counters for one AG-UI run. Holds no identifying records by construction."""

    head: str
    run: str
    started_at: float
    first_visible_at: float | None = None
    first_activity_at: float | None = None
    first_answer_token_at: float | None = None
    first_tool_call_at: float | None = None
    events: int = 0
    tool_calls: int = 0
    specialist_calls: int = 0
    model_calls: int = 0
    model_call_total_ms: float = 0.0
    first_model_call_ms: float | None = None
    model_id: str = "unavailable"
    thinking_level: str = "unavailable"
    pending_model_call_starts: list[float] | None = None
    prompt_chars_peak: int | None = None
    tool_schema_chars_peak: int | None = None
    history_items_peak: int | None = None
    outcome: str = OUTCOME_FINISHED
    terminal_observed: bool = False

    def begin_model_call(self, request: Any) -> None:
        now = time.perf_counter()
        if self.first_model_call_ms is None:
            self.first_model_call_ms = _ms_since(self.started_at, now)
        self.model_calls += 1
        if self.model_id == "unavailable":
            candidate_model_id = str(getattr(request, "model", "") or "").strip()
            if _MODEL_ID_PATTERN.fullmatch(candidate_model_id):
                self.model_id = candidate_model_id
        if self.thinking_level == "unavailable":
            config = getattr(request, "config", None)
            thinking_config = getattr(config, "thinking_config", None)
            level = getattr(thinking_config, "thinking_level", None)
            level = getattr(level, "value", level)
            self.thinking_level = str(level or "provider_default").upper()
        if self.pending_model_call_starts is None:
            self.pending_model_call_starts = []
        self.pending_model_call_starts.append(now)
        if os.getenv(_DETAILED_TIMING_ENV) != "1":
            return

        config = getattr(request, "config", None)
        contents = getattr(request, "contents", None) or []
        system_instruction = getattr(config, "system_instruction", None)
        instruction_chars = len(_request_text(system_instruction))
        history_chars = sum(
            len(_request_text(part))
            for content in contents
            for part in (getattr(content, "parts", None) or [])
        )
        tool_schemas = getattr(config, "tools", None) or []
        # Tool declarations contain authored schemas only; repr length avoids
        # serializing request contents or retaining any private text.
        schema_chars = len(repr(tool_schemas))
        self.prompt_chars_peak = max(self.prompt_chars_peak or 0, instruction_chars + history_chars)
        self.tool_schema_chars_peak = max(self.tool_schema_chars_peak or 0, schema_chars)
        self.history_items_peak = max(self.history_items_peak or 0, len(contents))

    def finish_model_call(self) -> None:
        starts = self.pending_model_call_starts
        if not starts:
            return
        started_at = starts.pop(0)
        self.model_call_total_ms += (time.perf_counter() - started_at) * 1000

    def observe(self, event: BaseEvent) -> None:
        self.events += 1
        event_type = getattr(event, "type", None)
        if self.first_visible_at is None and event_type in _FIRST_VISIBLE_EVENT_TYPES:
            self.first_visible_at = time.perf_counter()
        if self.first_activity_at is None and event_type in {
            EventType.ACTIVITY_SNAPSHOT,
            EventType.ACTIVITY_DELTA,
        }:
            self.first_activity_at = time.perf_counter()
        if self.first_answer_token_at is None and event_type == EventType.TEXT_MESSAGE_CONTENT:
            self.first_answer_token_at = time.perf_counter()
        if event_type == EventType.RUN_ERROR:
            self.terminal_observed = True
            self.outcome = OUTCOME_ERROR
        elif event_type == EventType.RUN_FINISHED:
            self.terminal_observed = True
        if event_type != EventType.TOOL_CALL_START:
            return
        if self.first_tool_call_at is None:
            self.first_tool_call_at = time.perf_counter()
        self.tool_calls += 1
        tool_name = str(getattr(event, "tool_call_name", "") or "")
        if tool_name.startswith(_SPECIALIST_TOOL_PREFIX):
            self.specialist_calls += 1

    def log(self) -> None:
        logger.info(
            "one_agent_chat_turn_complete head=%s run=%s first_visible_ms=%s "
            "first_activity_ms=%s first_answer_token_ms=%s first_tool_call_ms=%s elapsed_ms=%s "
            "first_model_call_ms=%s model_calls=%s model_call_total_ms=%s "
            "model_id=%s thinking_level=%s "
            "prompt_chars_peak=%s tool_schema_chars_peak=%s history_items_peak=%s "
            "events=%s tool_calls=%s specialist_calls=%s outcome=%s",
            self.head,
            self.run,
            _ms_since(self.started_at, self.first_visible_at),
            _ms_since(self.started_at, self.first_activity_at),
            _ms_since(self.started_at, self.first_answer_token_at),
            _ms_since(self.started_at, self.first_tool_call_at),
            _ms_since(self.started_at, time.perf_counter()),
            self.first_model_call_ms,
            self.model_calls,
            round(self.model_call_total_ms),
            self.model_id,
            self.thinking_level,
            self.prompt_chars_peak,
            self.tool_schema_chars_peak,
            self.history_items_peak,
            self.events,
            self.tool_calls,
            self.specialist_calls,
            self.outcome,
        )


class TimedADKAgent(ADKAgent):
    """``ADKAgent`` that logs one timing line per run for the labelled head."""

    head: str = HEAD_UNLABELED

    def _default_run_config(self, input: RunAgentInput):
        from hushh_mcp.hushh_adk.telemetry import private_telemetry

        config = super()._default_run_config(input)
        config.telemetry = private_telemetry()
        return config

    @classmethod
    def from_app(cls, app: Any, *, head: str, **kwargs: Any) -> TimedADKAgent:
        """Build the agent from an ADK ``App`` and label it with ``head``.

        ``ADKAgent.from_app`` constructs through ``cls(...)``, so the instance is
        already a ``TimedADKAgent``. The label is set right after construction
        because ``ADKAgent`` is a plain class, not a frozen model.
        """
        instance = cast("TimedADKAgent", super().from_app(app, **kwargs))
        instance.head = head
        return instance

    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        timing = TurnTiming(head=self.head, run=run_label(input), started_at=time.perf_counter())
        timing_context = _CURRENT_TURN.set(timing)
        interrupted = False
        private_call_ids: set[str] = set()
        try:
            async with mcp_turn_scope(input.thread_id), aclosing(super().run(input)) as run:
                async for event in run:
                    if self.head == HEAD_ONE:
                        event = redact_drive_wire_event(event, private_call_ids)
                        if event is None:
                            continue
                    timing.observe(event)
                    projected = (
                        public_event(event) if self.head in (HEAD_ONE, HEAD_INTRO) else event
                    )
                    if projected is not None:
                        yield projected
        except (asyncio.CancelledError, GeneratorExit):
            interrupted = True
            # Consumers commonly close immediately after the terminal event.
            # observe() runs before yield so that normal closure cannot replace
            # an emitted finish or error with a disconnect diagnosis.
            if not timing.terminal_observed:
                timing.outcome = OUTCOME_CLIENT_DISCONNECT
            raise
        except BaseException:
            timing.outcome = OUTCOME_ERROR
            raise
        finally:
            if interrupted or timing.outcome in (OUTCOME_ERROR, OUTCOME_CLIENT_DISCONNECT):
                await self._release_execution(input)
            timing.log()
            _CURRENT_TURN.reset(timing_context)

    async def _release_execution(self, input: RunAgentInput) -> None:
        """Drop the bridge's execution entry for a run that ended in error or disconnect.

        The bridge keeps an execution registered after a run when the session
        still shows a pending tool call, so a resume can find it. A run that
        died between a function call and its response (a provider 504 mid
        tool loop, a client that went away) leaves exactly that shape behind and
        would hold one of the process-wide execution slots until it is stale
        (600 s by default). Nothing can resume such a run, so the slot is
        released here. Measured 2026-09-14: a handful of these locked the whole
        route with "Maximum concurrent executions (10) reached".
        """
        registry = getattr(self, "_active_executions", None)
        lock = getattr(self, "_execution_lock", None)
        if not isinstance(registry, dict) or lock is None:
            return
        try:
            user_id = self._get_user_id(input)
        except Exception:  # noqa: BLE001 - a run that never resolved its user holds no slot
            return
        key = (input.thread_id, user_id)
        try:
            async with lock:
                registry.pop(key, None)
        except Exception:  # noqa: BLE001 - never let slot release mask the run outcome
            logger.debug("one_agent_chat_execution_release_failed", exc_info=True)


def _request_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    text = getattr(value, "text", None)
    if isinstance(text, str):
        return text
    parts = getattr(value, "parts", None)
    if not isinstance(parts, list):
        return ""
    return "".join(
        part_text for part in parts if isinstance((part_text := getattr(part, "text", None)), str)
    )


def timed_one_before_model(callback_context: Any, llm_request: Any) -> None:
    """Preserve the external-read barrier and record privacy-safe request sizes."""
    before_external_read_model(callback_context, llm_request)
    timing = _CURRENT_TURN.get()
    if timing is not None:
        timing.begin_model_call(llm_request)


def timed_one_after_model(_callback_context: Any, _llm_response: Any) -> None:
    """Record provider-call duration without logging prompts or response data."""
    timing = _CURRENT_TURN.get()
    if timing is not None:
        timing.finish_model_call()
