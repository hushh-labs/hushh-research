"""In-process A2A handler for the Information Marketplace specialist.

Wraps the EXISTING InformationChatService.handle_turn loop unchanged and adapts
its dict output into the generic SpecialistTurnResult. Consent is enforced
exactly as on the direct chat — per-@hushh_tool scope validation inside
HushhContext during the loop.

Full parity with the direct chat: query/explain (what's published, what it's
worth, show-math) AND request management (list/approve/deny). Because marketplace
access requests are now durable server-side records, One can approve/deny them
over A2A exactly the way it approves a Location grant — the agent looks the
request up and updates it server-side, no browser round-trip. ``stateChanged``
flows back so One's client refetches the inbox.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult

# Label surfaced to the client for delegated turns (SSE start/complete "model").
DELEGATED_MODEL = "one+marketplace"


class PersonalInformationAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.information_chat_service import InformationChatService

            self._service = InformationChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        out: dict = await self._service.handle_turn(
            user_id=task.user_id,
            message=task.message,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
        )

        # A publish card (propose_publish) surfaces in One's chat via the directive
        # channel — the same path Location uses to render its cards in central chat.
        directive: A2ADirective | None = None
        if isinstance(out.get("clientAction"), dict):
            directive = A2ADirective(kind="action", payload=out["clientAction"])

        return SpecialistTurnResult(
            conversation_id=str(out.get("conversationId") or task.conversation_id or ""),
            text=str(out.get("response") or ""),
            directive=directive,
            is_complete=bool(out.get("isComplete", True)),
            state_changed=bool(out.get("stateChanged", False)),
            model=DELEGATED_MODEL,
        )


_singleton: PersonalInformationAgentA2A | None = None


def get_personal_information_a2a() -> PersonalInformationAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = PersonalInformationAgentA2A()
    return _singleton
