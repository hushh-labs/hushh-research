"""In-process A2A handler for Connected Systems CRM actions.

Agent One delegates connected CRM requests here, but execution remains on the
existing Connected Systems approval workflow. The specialist only emits the same
frontend action plan that the central chat planner already supports.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import uuid4

from hushh_mcp.adk_bridge.contract import (
    A2ADirective,
    A2ATask,
    SpecialistTurnResult,
    require_attenuated_authority,
)
from hushh_mcp.services.agent_chat_service import (
    AgentActionExecution,
    AgentChatActionPlan,
)

DELEGATED_MODEL = "one+connected-systems"
CONNECTED_SYSTEMS_A2A_AGENT_ID = "agent_connected_systems"
ALL_CONNECTED_CRM_SYSTEMS_SCOPE = "all_connected_crm_systems"


class ConnectedSystemsAgentA2A:
    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        require_attenuated_authority(task, information=True, action=True)
        if task.delegate_result is not None:
            return _delegate_result(task)

        message = " ".join(str(task.message or "").split())
        if not message:
            return _result(
                task,
                text=("Tell me which CRM Contact record you want to read, create, or update."),
                directive=None,
                is_complete=True,
            )

        plan = _plan_from_task(task)
        if plan is None or not str(plan.action_id or "").startswith("connected_system.crm."):
            return _result(
                task,
                text=(
                    "I can help after One supplies a validated Connected Systems action. "
                    "Open the CRM field table to choose the record and fields."
                ),
                directive=None,
                is_complete=True,
            )

        enriched_plan = _enrich_crm_plan(plan, message)
        clarification = _clarification_prompt(enriched_plan, message)
        if clarification is not None:
            return _result(
                task,
                text=str(clarification.payload.get("question") or "I need one more detail."),
                directive=clarification,
                is_complete=False,
            )
        directive = A2ADirective(
            kind="action",
            payload=_directive_payload(enriched_plan),
        )
        return _result(
            task,
            text=enriched_plan.message,
            directive=directive,
            is_complete=enriched_plan.execution == "blocked",
        )


def _result(
    task: A2ATask,
    *,
    text: str,
    directive: A2ADirective | None,
    is_complete: bool,
) -> SpecialistTurnResult:
    return SpecialistTurnResult(
        conversation_id=str(task.conversation_id or ""),
        text=text,
        directive=directive,
        is_complete=is_complete,
        state_changed=False,
        model=DELEGATED_MODEL,
    )


def _enrich_crm_plan(plan: AgentChatActionPlan, message: str) -> AgentChatActionPlan:
    _ = message
    # CRM IDs and verified lookup values are server-resolved, never harvested
    # from chat. Schema-specific field edits are staged through the dynamic UI
    # after the private agent's public-schema mapping has been validated.
    return plan


def _clarification_prompt(plan: AgentChatActionPlan, message: str) -> A2ADirective | None:
    _ = (plan, message)
    return None


def _directive_payload(plan: AgentChatActionPlan) -> dict[str, Any]:
    payload = plan.to_event_payload()
    action_id = str(payload.get("action_id") or "")
    slots = payload.get("slots") if isinstance(payload.get("slots"), dict) else {}
    summary = str(payload.get("message") or "Review this CRM action before it runs.")
    confirm_label = "Continue"
    if action_id == "connected_system.crm.update.propose":
        confirm_label = "Update all" if _is_all_crm_scope(slots) else "Update"
    elif action_id == "connected_system.crm.create.propose":
        confirm_label = "Create"
    elif action_id == "connected_system.crm.read":
        confirm_label = "Read"
    return {
        "id": str(payload.get("call_id") or ""),
        "type": action_id,
        "summary": (
            "Review and confirm this update across your connected CRM brands."
            if action_id == "connected_system.crm.update.propose" and _is_all_crm_scope(slots)
            else summary
        ),
        "confirmLabel": confirm_label,
        "actionId": action_id,
        "execution": payload.get("execution"),
        "slots": slots,
        "message": payload.get("message"),
        "reason": payload.get("reason"),
    }


def _delegate_result(task: A2ATask) -> SpecialistTurnResult:
    result = dict(task.delegate_result or {})
    status = str(result.get("status") or "").strip().lower()
    detail = str(result.get("detail") or "").strip()
    display = str(result.get("display") or "").strip()
    action_type = str(result.get("type") or "").strip()
    if status == "answered" and action_type.startswith("connected_system.crm."):
        next_result = _answered_prompt_result(task, result)
        if next_result is not None:
            return next_result
    if status == "completed":
        text = display or detail or "Done. The CRM update was approved and applied."
    elif status == "cancelled":
        text = "Cancelled. I did not update the CRM record."
    else:
        text = detail or "The CRM action did not complete."
    return _result(
        task,
        text=text,
        directive=None,
        is_complete=True,
    )


def _answered_prompt_result(task: A2ATask, result: dict[str, Any]) -> SpecialistTurnResult | None:
    _ = result
    return _result(
        task,
        text="Open the CRM field table, stage the field change, then review it before approval.",
        directive=None,
        is_complete=True,
    )


def _plan_from_task(task: A2ATask) -> AgentChatActionPlan | None:
    payload = task.planned_action if isinstance(task.planned_action, dict) else None
    if not payload:
        return None
    action_id = str(payload.get("action_id") or "").strip()
    if not action_id.startswith("connected_system.crm."):
        return None
    slots = payload.get("slots") if isinstance(payload.get("slots"), dict) else {}
    execution = str(payload.get("execution") or "frontend").strip()
    if execution not in {"frontend", "blocked"}:
        execution = "frontend"
    return AgentChatActionPlan(
        call_id=str(payload.get("call_id") or f"crm_{uuid4().hex[:10]}"),
        action_id=action_id,
        label=str(payload.get("label") or "Connected Systems CRM"),
        execution=cast(AgentActionExecution, execution),
        slots=dict(slots or {}),
        message=str(
            payload.get("message")
            or "Opening Connected Systems so you can review and approve the CRM update."
        ),
        reason=str(payload.get("reason") or "").strip() or None,
    )


def _is_all_crm_scope(slots: dict[str, Any]) -> bool:
    return str(slots.get("scope") or "") == ALL_CONNECTED_CRM_SYSTEMS_SCOPE


_singleton: ConnectedSystemsAgentA2A | None = None


def get_connected_systems_a2a() -> ConnectedSystemsAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = ConnectedSystemsAgentA2A()
    return _singleton
