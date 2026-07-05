"""In-process A2A handler for the Email (Gmail inbox) specialist.

Wraps the EXISTING EmailChatService.handle_turn loop unchanged and adapts its
dict output into the generic SpecialistTurnResult. The email agent is read-only
(tools: list_needs_reply, search_inbox), so it emits no client directive.

Consent: EmailChatService reads Gmail via the user's connected gmail.readonly
OAuth connection; the delegation boundary in the One route additionally validates
the A2A consent token against AGENT_ONE_ORCHESTRATE before dispatch.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult

# The label surfaced to the client for delegated turns (SSE start/complete "model").
DELEGATED_MODEL = "one+email"


class EmailAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.email_chat_service import EmailChatService

            self._service = EmailChatService()

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


_singleton: EmailAgentA2A | None = None


def get_email_a2a() -> EmailAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = EmailAgentA2A()
    return _singleton
