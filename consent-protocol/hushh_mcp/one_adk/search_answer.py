"""One may explicitly delegate a complete public answer to its isolated search child.

The child still receives only the authored request. The invocation-local handoff
never enters session state; the completed answer is one ordinary assistant event
so live streams and recovered conversations agree.
"""

from __future__ import annotations

import contextvars
import logging
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.events import Event
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from hushh_mcp.one_adk.queued_input import current_run
from hushh_mcp.runtime_providers.managed_text import ManagedPrimaryTextModel, ManagedTextAgent

logger = logging.getLogger(__name__)


@dataclass
class _Answer:
    invocation_id: str
    call_id: str = ""
    text: str = ""
    grounding: Any = None


_ANSWER: contextvars.ContextVar[_Answer | None] = contextvars.ContextVar(
    "one_search_answer", default=None
)


def _sole_search(invocation: Any, name: str) -> bool:
    events = [
        event
        for event in invocation.session.events
        if event.invocation_id == invocation.invocation_id
    ]
    calls = [
        call for event in events if not event.partial for call in event.get_function_calls() or []
    ]
    return (
        len(calls) == 1
        and calls[0].name == name
        and not any(
            part.text and not part.thought
            for event in events
            if event.author == "one"
            for part in (event.content.parts if event.content else [])
        )
    )


class SearchAnswerTool(AgentTool):
    """An explicit model-owned finish decision, with ordinary continuation by default."""

    def _get_declaration(self) -> types.FunctionDeclaration:
        declaration = super()._get_declaration()
        description = (
            "True selects compact search context for a short, complete public answer. "
            "Use false for deeper research or when the entire request needs "
            "private information, further tools, actions, or follow-up work. "
            "The child's complete cited answer becomes your final answer unchanged."
        )
        if declaration.parameters_json_schema is not None:
            declaration.parameters_json_schema["properties"]["finish_turn"] = {
                "type": "boolean",
                "description": description,
            }
        else:
            parameters = declaration.parameters
            if parameters is None or parameters.properties is None:
                raise ValueError("Search tool request declaration is unavailable")
            parameters.properties["finish_turn"] = types.Schema(
                type=types.Type.BOOLEAN, description=description
            )
        return declaration

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> Any:
        from hushh_mcp.one_adk import queued_input

        finish = args.get("finish_turn") is True
        invocation = tool_context._invocation_context
        handoff = _ANSWER.get()
        search_agent = self.agent
        if (
            finish
            and handoff is not None
            and handoff.invocation_id == invocation.invocation_id
            and isinstance(search_agent, ManagedTextAgent)
            and isinstance(search_agent.model, ManagedPrimaryTextModel)
            and _sole_search(invocation, self.name)
            and queued_input.clubbing_admitted(tool_context.state, resuming=False)
        ):
            # Invocation-local configuration; ordinary/deeper searches keep their budget.
            search_agent = search_agent.model_copy(
                update={
                    "model": search_agent.model.model_copy(
                        update={"web_search_context_size": "low"}
                    )
                }
            )
        tool_context.state["temp:_adk_grounding_metadata"] = None
        # Keep control metadata out of the isolated child's public request.
        dispatch = AgentTool(agent=search_agent, propagate_grounding_metadata=True)
        result = await dispatch.run_async(
            args={key: value for key, value in args.items() if key != "finish_turn"},
            tool_context=tool_context,
        )
        grounding = tool_context.state.get("temp:_adk_grounding_metadata")
        if not isinstance(search_agent, ManagedTextAgent):
            return result
        if not (
            finish
            and isinstance(search_agent.model, ManagedPrimaryTextModel)
            and handoff is not None
            and handoff.invocation_id == invocation.invocation_id
            and _sole_search(invocation, self.name)
            and isinstance(result, str)
            and result.strip()
            and grounding is not None
            and grounding.grounding_chunks
            and queued_input.clubbing_admitted(tool_context.state, resuming=False)
        ):
            return result
        bound = await search_agent.canonical_model_async(tool_context)
        await bound._require_current()
        key = queued_input.current_run()
        if key is not None and not queued_input.registry.try_finish_run(
            key.owner_id, key.conversation_id, key.run_id
        ):
            return result
        # No await between the empty-inbox cutover and the committed handoff.
        handoff.text, handoff.grounding = result, grounding
        handoff.call_id = tool_context.function_call_id
        tool_context.state["temp:_adk_grounding_metadata"] = None
        tool_context.actions.skip_summarization = True
        return result


class OneSearchAnswerAgent(ManagedTextAgent):
    """Project ADK's final tool output as a durable, grounded assistant answer."""

    async def _run_async_impl(self, ctx):
        handoff = _Answer(ctx.invocation_id)
        token = _ANSWER.set(handoff)
        try:
            async with aclosing(super()._run_async_impl(ctx)) as stream:
                async for event in stream:
                    responses = event.get_function_responses() or []
                    if not (
                        handoff.text
                        and event.invocation_id == handoff.invocation_id
                        and event.actions.skip_summarization
                        and len(responses) == 1
                        and responses[0].name == "google_search"
                        and responses[0].id == handoff.call_id
                        and responses[0].response == {"result": handoff.text}
                        and not event.error_code
                        and not event.interrupted
                    ):
                        yield event
                        continue
                    # ADK appends the AgentTool result as text on its function-response
                    # event. Live AG-UI renders it, but recovered history drops that
                    # text. Move that exact text into its own assistant event once.
                    publication = event.model_copy(deep=True)
                    publication.content.parts = [p for p in event.content.parts if not p.text]
                    # The SDK needs the original flag to stop its model loop.
                    # History must remain pending until the assistant event exists.
                    publication.actions.skip_summarization = False
                    await self._require_publication(ctx)
                    yield publication
                    await self._require_publication(ctx)
                    yield Event(
                        invocation_id=ctx.invocation_id,
                        author=self.name,
                        branch=ctx.branch,
                        content=types.Content(role="model", parts=[types.Part(text=handoff.text)]),
                        grounding_metadata=handoff.grounding,
                        custom_metadata={"kind": "one_delegated_search_answer_v1"},
                    )
                    run = current_run()
                    logger.info(
                        "one.search_answer_delegated run=%s invocation=%s model_calls_saved=1",
                        run.run_id[:8] if run else "unbound",
                        ctx.invocation_id,
                    )
                    handoff.text = ""
        finally:
            _ANSWER.reset(token)

    async def _require_publication(self, ctx) -> None:
        import asyncio

        from hushh_mcp.one_adk import queued_input

        bound = await self.canonical_model_async(ReadonlyContext(ctx))
        await bound._require_current()
        key = queued_input.current_run()
        if key is not None and queued_input.registry.stop_requested(
            key.owner_id, key.conversation_id, key.run_id
        ):
            raise asyncio.CancelledError("Search answer stopped")


def one_text_agent(**kwargs: Any) -> LlmAgent:
    """Admit the optional delegation port only on managed chat's existing search tool."""
    from hushh_mcp.runtime_providers.managed_text import managed_text_agent

    if not isinstance(kwargs.get("model"), ManagedPrimaryTextModel) or kwargs.get("mode") != "chat":
        return managed_text_agent(**kwargs)
    kwargs["tools"] = [
        SearchAnswerTool(agent=tool.agent, propagate_grounding_metadata=True)
        if isinstance(tool, AgentTool)
        and tool.name == "google_search"
        and isinstance(tool.agent, ManagedTextAgent)
        and isinstance(tool.agent.model, ManagedPrimaryTextModel)
        else tool
        for tool in kwargs["tools"]
    ]
    return OneSearchAnswerAgent(**kwargs)
