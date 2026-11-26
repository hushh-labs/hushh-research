"""Run a previously admitted private chat turn through native ADK."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.apps import App
from google.adk.events import Event
from google.adk.runners import Runner
from google.genai import types

from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.mcp_call_approval import STATE_MCP_APPROVAL, supersede_unanswered_reviews
from hushh_mcp.one_adk.mcp_pending_call import current_pending_handle, pending_resume_scope
from hushh_mcp.one_adk.mcp_turn_scope import (
    bind_mcp_turn,
    consume_turn_configurations,
    private_chat_mcp_resources,
)
from hushh_mcp.one_adk.native_chat_stream import native_chat_frames
from hushh_mcp.one_adk.pod_mcp_restore import resolve_pending_mcp_reviews
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.pod_upgrade_admission import ADMISSION, PodUpgradeAdmission

if TYPE_CHECKING:
    from google.adk.memory.base_memory_service import BaseMemoryService

    from hushh_mcp.one_adk.pod_agui_context import PodChatContext


@dataclass(frozen=True)
class NativeMcpDecision:
    interrupt_id: str
    confirmed: bool


@dataclass(frozen=True)
class AdmittedNativePodTurn:
    thread_id: str
    run_id: str
    state: dict[str, Any]
    text: str | None = None
    decision: NativeMcpDecision | None = None


async def run_native_pod_chat(
    owner: PodChatContext,
    turn: AdmittedNativePodTurn,
    *,
    prepare: Callable[
        [],
        Awaitable[
            tuple[App, BaseMemoryService | None, Callable[[AdmittedNativePodTurn], Awaitable[None]]]
        ],
    ],
    settle: Callable[[BaseMemoryService | None, AdmittedNativePodTurn], Awaitable[None]],
    admission: PodUpgradeAdmission = ADMISSION,
    incarnation: str | None = None,
) -> AsyncGenerator[bytes, None]:
    """Hold the owner, chat key, update permit, and connector resources for one turn."""
    memory: BaseMemoryService | None = None

    async def open_source() -> AsyncGenerator[Event, None]:
        nonlocal memory
        if (
            turn.state.get("hussh:user_id") != owner.owner
            or turn.state.get("hussh:conversation_id") != turn.thread_id
            or (turn.text is None) == (turn.decision is None)
        ):
            raise PermissionError("Unadmitted private chat turn.")

        resuming = turn.decision is not None
        approval = turn.state.get(STATE_MCP_APPROVAL)
        if bool(approval) != (turn.decision is not None and turn.decision.confirmed):
            raise ActionDirectiveAuthorityError("Connector approval does not match this turn.")
        app, memory, prepare_memory = await prepare()
        configurations = consume_turn_configurations(
            turn.state, owner_id=owner.owner, conversation_id=turn.thread_id
        )
        session_key = {"app_name": app.name, "user_id": owner.owner, "session_id": turn.thread_id}
        invocation_id = None
        expected_handle = None
        with owner.runtime_scope():
            resources = await private_chat_mcp_resources(
                turn.thread_id,
                owner_id=owner.owner,
                configurations=configurations,
                require_access=owner.require_access,
                owner_admission=owner._mcp_owner_admission,
            )
            try:
                if turn.decision is None:
                    await supersede_unanswered_reviews(owner.owner, turn.thread_id)
                    await prepare_memory(turn)
                    if await owner.sessions.get_session(**session_key) is None:
                        await owner.sessions.create_session(**session_key)
                    message = types.Content(role="user", parts=[types.Part(text=turn.text)])
                else:
                    (review,) = await resolve_pending_mcp_reviews(
                        owner, turn.thread_id, [turn.decision.interrupt_id], use_native_ids=True
                    )
                    invocation_id = review.invocation_id
                    expected_handle = review.reference["pendingHandle"]
                    message = review.confirmation_message(confirmed=turn.decision.confirmed)
                    await prepare_memory(turn)
                async with (
                    pending_resume_scope(approval),
                    queued_input.run_scope(
                        owner.owner,
                        turn.thread_id,
                        turn.run_id,
                        accepting=queued_input.clubbing_admitted(turn.state, resuming=resuming),
                    ) as queued,
                    Runner(
                        app=app, session_service=owner.sessions, memory_service=memory
                    ) as runner,
                ):
                    try:
                        if (
                            turn.decision
                            and turn.decision.confirmed
                            and (current_pending_handle() != expected_handle)
                        ):
                            raise ActionDirectiveAuthorityError("Connector review changed.")
                        with bind_mcp_turn(resources):
                            async with aclosing(
                                runner.run_async(
                                    user_id=owner.owner,
                                    session_id=turn.thread_id,
                                    invocation_id=invocation_id,
                                    new_message=message,
                                    state_delta=turn.state,
                                    run_config=RunConfig(streaming_mode=StreamingMode.SSE),
                                )
                            ) as events:
                                async for event in events:
                                    yield event
                    finally:
                        queued_input.settle(queued)
            finally:
                await resources.close()

    async def settle_owner_session() -> None:
        with owner.runtime_scope():
            await settle(memory, turn)

    async with aclosing(
        native_chat_frames(
            open_source,
            owner_id=owner.owner,
            conversation_id=turn.thread_id,
            require_access=owner.require_access,
            settle=settle_owner_session,
            admission=admission,
            incarnation=incarnation,
        )
    ) as frames:
        async for frame in frames:
            yield frame
