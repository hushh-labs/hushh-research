"""Compose one standard LangChain graph and project its existing turn lifecycle."""

import asyncio
import logging
import time
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from langchain.agents import create_agent
from langchain.agents.middleware import ModelCallLimitMiddleware
from langchain_core.messages import AIMessage, HumanMessage
from langsmith.run_helpers import tracing_context

from .history import sanitize_email_history
from .prompts import build_email_instruction
from .protocol import _AccessMiddleware, _await, _text

logger = logging.getLogger("hushh_mcp.services.email_oss.runtime")


@dataclass
class _Turn:
    context: Any
    counts: dict = field(default_factory=lambda: {"model_calls": 0, "tool_calls": 0})
    directives: list = field(default_factory=list)
    effects: list = field(default_factory=list)
    read_receipt: dict = field(
        default_factory=lambda: {
            "sources": [],
            "truncated": False,
            "metadata_only": True,
            "status": "ok",
        }
    )
    uncertain_effects: list = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)
    trace_id: str = field(default_factory=lambda: uuid4().hex[:12])
    first_model_text_ms: float | None = None
    public_text: list = field(default_factory=list)
    public_bytes: int = 0
    public_message_id: Any = None
    status: str = "ok"
    code: str | None = None
    final: Any = None
    execution: Any = None


async def _prepare_graph(
    runtime, turn, message, history, current_memory_md, pending_email_draft, page_context
):
    model = await _await(runtime.model_factory(turn.context))
    turn.execution = await _await(runtime.execution_factory(turn.context))
    tools = runtime._tools(
        turn.context,
        turn.execution,
        turn.counts,
        turn.directives,
        turn.effects,
        turn.uncertain_effects,
        turn.read_receipt,
    )
    if runtime.router is not None:
        selection = await _await(runtime.router(message))
        selected = set(selection.tool_names)
        if "\nSource mail reference: rs1." in pending_email_draft:
            selected.add("reply_to_thread")
        tools = [tool for tool in tools if tool.name in selected]
        if not tools:
            raise ValueError("Email router returned no admitted tools")
    if not runtime.supports_email_reviews:
        tools = [
            tool
            for tool in tools
            if tool.name
            not in {
                "send_email",
                "reply_to_thread",
                "batch_modify_messages",
                "trash_message",
                "save_to_memory_md",
            }
        ]
    instruction = build_email_instruction(
        current_memory_md=current_memory_md,
        now_utc=turn.context.now_utc,
        timezone=turn.context.timezone,
        pending_email_draft=pending_email_draft,
        page_context=page_context,
        selected_messages=list(getattr(turn.execution, "observed_messages", {}).values()),
        supports_email_reviews=runtime.supports_email_reviews,
    )
    names = runtime._tool_names()
    messages = sanitize_email_history(history, names)
    messages.append(HumanMessage(content=message))
    graph = create_agent(
        model=model,
        tools=tools,
        system_prompt=instruction,
        middleware=[
            ModelCallLimitMiddleware(run_limit=runtime.max_model_calls, exit_behavior="error"),
            _AccessMiddleware(turn.context, turn.counts, runtime.max_tool_calls),
        ],
        name="email",
    )
    return (graph, messages)


async def _graph_events(runtime, turn, graph, messages):
    config = {"recursion_limit": runtime.recursion_limit, "callbacks": []}
    with tracing_context(enabled=False):
        async with aclosing(
            graph.astream(
                {"messages": messages}, config=config, stream_mode=["messages", "updates"]
            )
        ) as events:
            async for mode, value in events:
                if mode == "messages":
                    chunk, _metadata = value
                    if isinstance(chunk, AIMessage):
                        text = _text(chunk.content)
                        if text:
                            message_id = getattr(chunk, "id", None) or turn.counts["model_calls"]
                            if message_id != turn.public_message_id:
                                await turn.context.require_access()
                            if turn.public_text and message_id != turn.public_message_id:
                                turn.public_text.append("\n\n")
                                yield {"type": "text", "text": "\n\n"}
                            turn.public_message_id = message_id
                            turn.public_bytes += len(text.encode())
                            if turn.public_bytes > 128 * 1024:
                                raise ValueError("Email visible response exceeded its byte budget")
                            turn.public_text.append(text)
                            if turn.first_model_text_ms is None:
                                turn.first_model_text_ms = round(
                                    (time.monotonic() - turn.started) * 1000, 2
                                )
                            yield {"type": "text", "text": text}
                else:
                    for update in value.values():
                        if not isinstance(update, dict):
                            continue
                        rows = update.get("messages") or []
                        if not isinstance(rows, list):
                            rows = [rows]
                        for row in rows:
                            if (
                                isinstance(row, AIMessage)
                                and (not row.tool_calls)
                                and _text(row.content).strip()
                            ):
                                turn.final = row
    await turn.context.require_access()
    if turn.final is None:
        raise RuntimeError("Email graph ended without an assistant answer")
    if turn.public_text and (not "".join(turn.public_text).endswith(_text(turn.final.content))):
        raise ValueError("Email final answer did not match its stream")


def _finish_turn(runtime, turn):
    elapsed_ms = round((time.monotonic() - turn.started) * 1000, 2)
    if turn.status != "ok":
        turn.directives.clear()
        turn.read_receipt = {
            "sources": [],
            "truncated": False,
            "metadata_only": True,
            "status": turn.status,
        }
    logger.info(
        "email_oss.turn_completed trace=%s status=%s model_calls=%d tool_calls=%d elapsed_ms=%.2f",
        turn.trace_id,
        turn.status,
        turn.counts["model_calls"],
        turn.counts["tool_calls"],
        elapsed_ms,
    )
    result = {
        "conversationId": turn.context.conversation_id,
        "response": "".join(turn.public_text) or _text(turn.final.content)
        if turn.status == "ok" and turn.final is not None
        else "An attempted Gmail change has an unknown outcome. Check Gmail before trying it again."
        if turn.uncertain_effects
        else "I couldn't complete this Email request.",
        "isComplete": True,
        "stateChanged": bool(turn.effects),
        "status": turn.status,
        "structured": {"connector": "mail", **turn.read_receipt},
        "directives": turn.directives,
        "effects": turn.effects,
        "uncertainEffects": turn.uncertain_effects,
        "email_page": getattr(turn.execution, "page_context", None)
        if turn.execution is not None
        else None,
        "email_selection": {
            "owner_id": turn.context.user_id,
            "grant_binding": list(turn.execution.grant_binding),
            "messages": list(turn.execution.observed_messages.values())[:50],
        }
        if turn.execution is not None and getattr(turn.execution, "grant_binding", None)
        else None,
        "performance": {
            "trace_id": turn.trace_id,
            "first_model_text_ms": turn.first_model_text_ms,
            **turn.counts,
            **(getattr(turn.execution, "telemetry", {}) if turn.execution is not None else {}),
            "elapsed_ms": elapsed_ms,
            "max_model_calls": runtime.max_model_calls,
            "max_tool_calls": runtime.max_tool_calls,
            "deadline_seconds": runtime.deadline_seconds,
        },
    }
    if turn.code:
        result["code"] = turn.code
    if turn.directives:
        result["directive"] = turn.directives[0]
    return result


async def run_turn(
    runtime, context, message, history, current_memory_md, pending_email_draft, page_context
):
    turn = _Turn(context)
    try:
        async with asyncio.timeout(runtime.deadline_seconds):
            await context.require_access()
            graph, messages = await _prepare_graph(
                runtime,
                turn,
                message,
                history,
                current_memory_md,
                pending_email_draft,
                page_context,
            )
            async with aclosing(_graph_events(runtime, turn, graph, messages)) as events:
                async for event in events:
                    yield event
    except asyncio.CancelledError:
        raise
    except PermissionError:
        turn.status, turn.code = ("unavailable", "email_authority_changed")
    except TimeoutError:
        turn.status, turn.code = (
            "unavailable",
            "email_effect_outcome_unknown" if turn.uncertain_effects else "email_deadline_exceeded",
        )
    except Exception as error:
        turn.status, turn.code = (
            "unavailable",
            "email_effect_outcome_unknown" if turn.uncertain_effects else "email_runtime_failed",
        )
        logger.warning("email_oss.turn_failed reason=%s", type(error).__name__)
    yield {"type": "result", "result": _finish_turn(runtime, turn)}
