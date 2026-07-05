"""In-process A2A handler for the Trusted Connections specialist.

Wraps ConnectionsChatService.handle_turn and adapts its dict output into the
generic SpecialistTurnResult. Deterministic + write-capable (add/remove) plus a
read (list); emits no client directive. Consent is validated by the One route
against AGENT_ONE_ORCHESTRATE before dispatch, exactly like the email agent.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult

DELEGATED_MODEL = "one+connections"


class ConnectionsAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.connections_chat_service import ConnectionsChatService

            self._service = ConnectionsChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        out: dict = await self._service.handle_turn(
            user_id=task.user_id,
            message=task.message,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
        )
        return SpecialistTurnResult(
            conversation_id=str(out.get("conversationId") or task.conversation_id or ""),
            text=str(out.get("response") or ""),
            directive=None,
            is_complete=bool(out.get("isComplete", True)),
            state_changed=bool(out.get("stateChanged", False)),
            model=DELEGATED_MODEL,
        )


_singleton: ConnectionsAgentA2A | None = None


def get_connections_a2a() -> ConnectionsAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = ConnectionsAgentA2A()
    return _singleton
