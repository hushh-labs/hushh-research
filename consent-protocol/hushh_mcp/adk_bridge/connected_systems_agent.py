"""In-process A2A handler for Connected Systems CRM actions.

Agent One delegates connected CRM requests here, but execution remains on the
existing Connected Systems approval workflow. The specialist only emits the same
frontend action plan that the central chat planner already supports.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any
from uuid import uuid4

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult
from hushh_mcp.services.agent_chat_service import AgentChatActionPlan, AgentChatService

DELEGATED_MODEL = "one+connected-systems"
CONNECTED_SYSTEMS_A2A_AGENT_ID = "agent_connected_systems"
_FIELD_UPDATE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bmailing\s+city\s+(?:to|=|as)\s+(?P<value>[^,.]+)", re.I), "MailingCity"),
    (re.compile(r"\bcity\s+(?:to|=|as)\s+(?P<value>[^,.]+)", re.I), "MailingCity"),
    (re.compile(r"\btitle\s+(?:to|=|as)\s+(?P<value>[^,.]+)", re.I), "Title"),
    (re.compile(r"\bphone\s+(?:to|=|as)\s+(?P<value>[^,.]+)", re.I), "Phone"),
    (re.compile(r"\bemail\s+(?:to|=|as)\s+(?P<value>[^,\s]+)", re.I), "Email"),
    (re.compile(r"\bfirst\s+name\s+(?:to|=|as)\s+(?P<value>[^,.]+)", re.I), "FirstName"),
    (re.compile(r"\blast\s+name\s+(?:to|=|as)\s+(?P<value>[^,.]+)", re.I), "LastName"),
)


class ConnectedSystemsAgentA2A:
    def __init__(self, chat_service: AgentChatService | None = None) -> None:
        self._chat_service = chat_service or AgentChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
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

        plan = self._chat_service.plan_action(message)
        if plan is None or not str(plan.action_id or "").startswith("connected_system.crm."):
            return _result(
                task,
                text=(
                    "I can help with CRM read, create, and update requests. "
                    "Tell me the record and the field change you want."
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
    slots = dict(plan.slots)
    email = _email_from_message(message)
    phone = _phone_from_message(message)
    if email and not slots.get("email"):
        slots["email"] = email
    if phone and not slots.get("phone"):
        slots["phone"] = phone

    if plan.action_id != "connected_system.crm.update.propose":
        return replace(plan, slots=slots) if slots != plan.slots else plan

    record_id = _record_id_from_message(message)
    if record_id and not slots.get("id"):
        slots["id"] = record_id

    fields = _field_updates_from_message(message)
    if fields and not slots.get("additionalFieldsJson"):
        slots["additionalFieldsJson"] = json.dumps(fields, sort_keys=True)

    if slots == plan.slots:
        return plan
    return replace(plan, slots=slots)


def _clarification_prompt(plan: AgentChatActionPlan, message: str) -> A2ADirective | None:
    if plan.action_id != "connected_system.crm.update.propose":
        return None
    slots = dict(plan.slots)
    if slots.get("additionalFieldsJson"):
        return None
    text = message.lower()
    if "city" not in text:
        return A2ADirective(
            kind="prompt",
            payload={
                "id": plan.call_id or f"crm_{uuid4().hex[:10]}",
                "kind": "free_text",
                "purpose": "crm_update_missing_change",
                "type": plan.action_id,
                "question": "What CRM field and value should I update?",
                "placeholder": "Example: city to New York",
                "confirmLabel": "Continue",
                "cancelLabel": "Cancel",
                "slots": slots,
            },
        )
    return A2ADirective(
        kind="prompt",
        payload={
            "id": plan.call_id or f"crm_{uuid4().hex[:10]}",
            "kind": "free_text",
            "purpose": "crm_update_missing_city",
            "type": plan.action_id,
            "question": "Yes. What city should I set for your Macy's CRM record?",
            "placeholder": "New York",
            "confirmLabel": "Use this city",
            "cancelLabel": "Cancel",
            "fieldName": "MailingCity",
            "slots": slots,
        },
    )


def _directive_payload(plan: AgentChatActionPlan) -> dict[str, Any]:
    payload = plan.to_event_payload()
    action_id = str(payload.get("action_id") or "")
    slots = payload.get("slots") if isinstance(payload.get("slots"), dict) else {}
    summary = str(payload.get("message") or "Review this CRM action before it runs.")
    confirm_label = "Continue"
    if action_id == "connected_system.crm.update.propose":
        confirm_label = "Update"
    elif action_id == "connected_system.crm.create.propose":
        confirm_label = "Create"
    elif action_id == "connected_system.crm.read":
        confirm_label = "Read"
    return {
        "id": str(payload.get("call_id") or ""),
        "type": action_id,
        "summary": summary,
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
    selected = result.get("selected")
    selected_ref = selected[0] if isinstance(selected, list) and selected else {}
    if not isinstance(selected_ref, dict):
        selected_ref = {}
    slots = selected_ref.get("slots") if isinstance(selected_ref.get("slots"), dict) else {}
    slots = dict(slots or {})
    free_text = str(result.get("freeText") or "").strip()
    field_name = str(selected_ref.get("fieldName") or "").strip()
    if field_name and free_text:
        slots["additionalFieldsJson"] = json.dumps({field_name: free_text}, sort_keys=True)
    elif free_text:
        fields = _field_updates_from_message(free_text)
        if fields:
            slots["additionalFieldsJson"] = json.dumps(fields, sort_keys=True)
    if not slots.get("additionalFieldsJson"):
        return _result(
            task,
            text="I still need the CRM field value before I can prepare the update.",
            directive=None,
            is_complete=True,
        )
    action_type = str(result.get("type") or "connected_system.crm.update.propose")
    plan = AgentChatActionPlan(
        call_id=str(result.get("id") or f"crm_{uuid4().hex[:10]}"),
        action_id=action_type,
        label="Propose CRM Update",
        execution="frontend",
        slots=slots,
        message="Got it. Review and confirm the CRM update before I apply it.",
    )
    return _result(
        task,
        text=plan.message,
        directive=A2ADirective(kind="action", payload=_directive_payload(plan)),
        is_complete=False,
    )


def _email_from_message(message: str) -> str | None:
    match = re.search(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", message, flags=re.I)
    return match.group(0).strip() if match else None


def _phone_from_message(message: str) -> str | None:
    match = re.search(
        r"(?:\+?\d[\d\s().-]{7,}\d)",
        message,
    )
    if not match:
        return None
    phone = match.group(0).strip()
    digits = re.sub(r"\D", "", phone)
    return phone if len(digits) >= 8 else None


def _record_id_from_message(message: str) -> str | None:
    match = re.search(
        r"\b(?:record\s+id|record|id)\s*(?:is|to|=|:)?\s*(?P<id>[A-Za-z0-9_-]{8,32})",
        message,
        flags=re.I,
    )
    if not match:
        return None
    candidate = match.group("id").strip()
    if candidate.lower() in {"city", "title", "phone", "email", "first", "last"}:
        return None
    return candidate


def _field_updates_from_message(message: str) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for pattern, field_name in _FIELD_UPDATE_PATTERNS:
        match = pattern.search(message)
        if not match:
            continue
        value = _clean_field_value(match.group("value"))
        if value:
            fields[field_name] = value
    return fields


def _clean_field_value(value: str) -> str:
    cleaned = re.split(
        r"\b(?:for|on|in|and then|then|please)\b",
        str(value or "").strip(),
        maxsplit=1,
        flags=re.I,
    )[0]
    return cleaned.strip(" .,'\"")


_singleton: ConnectedSystemsAgentA2A | None = None


def get_connected_systems_a2a() -> ConnectedSystemsAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = ConnectedSystemsAgentA2A()
    return _singleton
