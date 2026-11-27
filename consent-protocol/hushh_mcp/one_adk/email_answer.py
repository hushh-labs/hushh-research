"""Native Email deltas and final answer on One's existing publication queue."""

from __future__ import annotations

import asyncio
from typing import Any

from google.adk.events import Event
from google.genai import types

from hushh_mcp.one_adk.queued_input import current_run
from hushh_mcp.runtime_providers.managed_text import ManagedPrimaryTextModel, ManagedTextAgent


async def publish_email_preview(tool_context: Any, text: str) -> bool:
    """Relay one native Email text delta through One's existing publication queue."""
    from hushh_mcp.one_adk import queued_input
    from hushh_mcp.one_adk.search_answer import (
        _ANSWER,
        _MAX_PREVIEW_BYTES,
        _Publication,
        _sole_search,
    )

    handoff = _ANSWER.get()
    invocation = getattr(tool_context, "_invocation_context", None)
    agent = getattr(invocation, "agent", None)
    if not isinstance(text, str) or not text:
        return False
    if (
        handoff is None
        or invocation is None
        or handoff.invocation_id != invocation.invocation_id
        or handoff.queue is None
        or handoff.relay_refused
        or not isinstance(agent, ManagedTextAgent)
        or not isinstance(agent.model, ManagedPrimaryTextModel)
        or not _sole_search(invocation, "ask_email_agent")
        or not queued_input.clubbing_admitted(tool_context.state, resuming=False)
    ):
        if handoff is not None and handoff.email_preview:
            raise PermissionError("Email publication context changed")
        return False
    owner = str(tool_context.state.get("hussh:user_id") or "")
    call_id = str(tool_context.function_call_id or "")
    if handoff.email_preview and (owner != handoff.email_owner_id or call_id != handoff.call_id):
        raise PermissionError("Email publication owner or call changed")
    bound = await agent.canonical_model_async(tool_context)
    await bound._require_current()
    if str(tool_context.state.get("hussh:user_id") or "") != owner:
        raise PermissionError("Email publication owner changed")
    key = current_run()
    if key is not None and queued_input.registry.stop_requested(
        key.owner_id, key.conversation_id, key.run_id
    ):
        raise asyncio.CancelledError("Email answer stopped")
    if not handoff.reserved:
        if key is not None and not queued_input.registry.try_finish_run(
            key.owner_id, key.conversation_id, key.run_id
        ):
            handoff.relay_refused = True
            return False
        handoff.reserved = True
    handoff.email_preview, handoff.email_owner_id, handoff.call_id = True, owner, call_id
    handoff.preview_bytes += len(text.encode())
    if handoff.preview_bytes > _MAX_PREVIEW_BYTES:
        raise ValueError("Streamed Email answer exceeded its preview budget")
    handoff.preview.append(text)
    await handoff.queue.put(
        _Publication(
            Event(
                invocation_id=invocation.invocation_id,
                author=agent.name,
                branch=invocation.branch,
                partial=True,
                turn_complete=False,
                content=types.Content(role="model", parts=[types.Part(text=text)]),
                custom_metadata={"kind": "one_email_preview_v1"},
            )
        )
    )
    return True


def email_answer_events(name, ctx, event, handoff, answer):
    from hushh_mcp.one_adk.search_answer import _MAX_PREVIEW_BYTES

    # The standard Email graph already emitted its final
    # AIMessage. Publish that exact answer durably; another
    # root model call would add latency and rewrite evidence.
    if handoff.email_preview:
        emitted = "".join(handoff.preview)
        if not answer.startswith(emitted):
            raise ValueError("Streamed Email answer changed before publication")
        if len(answer.encode()) > _MAX_PREVIEW_BYTES:
            raise ValueError("Streamed Email answer exceeded its preview budget")
        # AG-UI suppresses the consolidated final text after a
        # partial stream, so any unstreamed suffix needs a delta.
        if answer[len(emitted) :]:
            yield Event(
                invocation_id=ctx.invocation_id,
                author=name,
                branch=ctx.branch,
                partial=True,
                turn_complete=False,
                content=types.Content(
                    role="model",
                    parts=[types.Part(text=answer[len(emitted) :])],
                ),
                custom_metadata={"kind": "one_email_preview_v1"},
            )
    publication = event.model_copy(deep=True)
    publication.content.parts = [p for p in event.content.parts if not p.text]
    publication.actions.skip_summarization = False
    yield publication
    yield Event(
        invocation_id=ctx.invocation_id,
        author=name,
        branch=ctx.branch,
        content=types.Content(role="model", parts=[types.Part(text=answer)]),
        custom_metadata={"kind": "one_delegated_email_answer_v1"},
    )
