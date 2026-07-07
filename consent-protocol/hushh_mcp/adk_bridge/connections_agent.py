"""In-process A2A handler for the Trusted Connections specialist.

Wraps ConnectionsChatService.handle_turn and adapts its dict output into the
generic SpecialistTurnResult. Deterministic + write-capable (add/remove) plus a
read (list). Consent is validated by the One route against AGENT_ONE_ORCHESTRATE
before dispatch, exactly like the email agent.

Disambiguation uses the same selection round-trip as the Location specialist:
an ambiguous add/remove returns a ``clientPrompt`` (mapped to an
``A2ADirective(kind="prompt")``); the frontend's pick is delivered back as a
``delegate_result`` selection, which we translate into a ``selection_result`` for
ConnectionsChatService to complete the action.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult

DELEGATED_MODEL = "one+connections"


class ConnectionsAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.connections_chat_service import ConnectionsChatService

            self._service = ConnectionsChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        selection_result: dict | None = None
        dr = task.delegate_result
        if isinstance(dr, dict) and str(dr.get("kind")) == "selection":
            selection_result = {
                "status": dr.get("status"),
                "selected": dr.get("selected") or [],
                "display": dr.get("display"),
            }

        out: dict = await self._service.handle_turn(
            user_id=task.user_id,
            message=task.message,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
            selection_result=selection_result,
        )

        directive: A2ADirective | None = None
        client_prompt = out.get("clientPrompt")
        if isinstance(client_prompt, dict):
            directive = A2ADirective(kind="prompt", payload=client_prompt)

        return SpecialistTurnResult(
            conversation_id=str(out.get("conversationId") or task.conversation_id or ""),
            text=str(out.get("response") or ""),
            directive=directive,
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
