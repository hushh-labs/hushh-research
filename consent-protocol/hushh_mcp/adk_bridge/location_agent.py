"""In-process A2A handler for the Location specialist.

Wraps the EXISTING LocationChatService.handle_turn loop unchanged and adapts its
dict output into the generic SpecialistTurnResult. Consent is enforced exactly as
today — per-@hushh_tool scope validation inside HushhContext during the loop.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult

# The label surfaced to the client for delegated turns (SSE start/complete "model").
DELEGATED_MODEL = "one+location"

# Keys the location action_result contract accepts (see ActionResultModel).
_ACTION_RESULT_KEYS = ("id", "type", "status", "publicUrl", "detail")
# Keys the location selection_result contract accepts (see SelectionResultModel).
_SELECTION_RESULT_KEYS = ("id", "kind", "selected", "confirmed", "freeText", "status")


def _pick(source: dict, keys: tuple[str, ...]) -> dict:
    return {k: source[k] for k in keys if k in source and source[k] is not None}


class LocationAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.location_chat_service import LocationChatService

            self._service = LocationChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        action_result: dict | None = None
        selection_result: dict | None = None
        if task.delegate_result is not None:
            dr = dict(task.delegate_result)
            if str(dr.get("kind")) == "selection":
                selection_result = _pick(dr, _SELECTION_RESULT_KEYS)
            else:
                action_result = _pick(dr, _ACTION_RESULT_KEYS)

        out: dict = await self._service.handle_turn(
            user_id=task.user_id,
            message=task.message,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
            action_result=action_result,
            selection_result=selection_result,
        )

        directive: A2ADirective | None = None
        if isinstance(out.get("clientPrompt"), dict):
            directive = A2ADirective(kind="prompt", payload=out["clientPrompt"])
        elif isinstance(out.get("clientAction"), dict):
            directive = A2ADirective(kind="action", payload=out["clientAction"])

        return SpecialistTurnResult(
            conversation_id=str(out.get("conversationId") or task.conversation_id or ""),
            text=str(out.get("response") or ""),
            directive=directive,
            is_complete=bool(out.get("isComplete", True)),
            state_changed=bool(out.get("stateChanged", False)),
            model=DELEGATED_MODEL,
        )


_singleton: LocationAgentA2A | None = None


def get_location_a2a() -> LocationAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = LocationAgentA2A()
    return _singleton
