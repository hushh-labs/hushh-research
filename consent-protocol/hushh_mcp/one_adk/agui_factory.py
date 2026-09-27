"""Shared AG-UI construction with explicit session and runtime ownership."""

from __future__ import annotations

from typing import Any

from ag_ui_adk.request_state_service import RequestStateSessionService
from ag_ui_adk.session_manager import SessionManager
from google.adk.apps import App, ResumabilityConfig

from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent


class _DurableSessionManager(SessionManager):
    """ag_ui_adk session manager without its idle-session sweeper.

    The library default re-reads every tracked session every five minutes from a
    background task, copies idle ones into an in-memory memory service, and then
    deletes them from storage twenty minutes after their last turn. For durable,
    person-key history that is both a background reader with no person present and
    a silent deletion of the person's history, so it never starts here.
    """

    def _start_cleanup_task(self) -> None:
        return None


_authenticated_capabilities = {
    "identity": {
        "name": "Agent One",
        "type": "google-adk",
        "description": "Hussh private agent",
        "version": "1.0.0",
        "provider": "Hussh",
    },
    "transport": {"streaming": True, "websocket": False, "httpBinary": False, "resumable": True},
    "tools": {"supported": True, "parallelCalls": False, "clientProvided": True},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": True},
    "multiAgent": {"supported": True, "delegation": True, "handoffs": False},
    "reasoning": {"supported": True, "streaming": True, "encrypted": False},
    "humanInTheLoop": {
        "supported": True,
        "approvals": True,
        "interventions": True,
        "feedback": False,
        "interrupts": True,
        "approveWithEdits": False,
    },
}


def build_authenticated_agui(
    root_agent: Any,
    session_service: Any,
    *,
    app_name: str,
    user_id_extractor: Any,
    agent_class: type[TimedADKAgent] = TimedADKAgent,
    max_concurrent_executions: int = 64,
    memory_service: Any = None,
    plugins: list | None = None,
) -> TimedADKAgent:
    return agent_class.from_app(
        App(
            name=app_name,
            root_agent=root_agent,
            plugins=plugins or [],
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        head=HEAD_ONE,
        user_id_extractor=user_id_extractor,
        max_concurrent_executions=max_concurrent_executions,
        execution_timeout_seconds=200,
        session_manager=_DurableSessionManager(
            session_service=RequestStateSessionService(session_service),
            delete_session_on_cleanup=False,
            save_session_to_memory_on_cleanup=False,
            use_thread_id_as_session_id=True,
        ),
        use_in_memory_services=True,
        **({"memory_service": memory_service} if memory_service is not None else {}),
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
        capabilities=_authenticated_capabilities,
    )
