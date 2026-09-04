from __future__ import annotations

import json

import pytest

from hushh_mcp.adk_bridge.connected_systems_agent import ConnectedSystemsAgentA2A
from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2ATask


def _authority() -> A2AAuthorityContext:
    return A2AAuthorityContext(
        subject_user_id="user_crm",
        tenant_id="tenant_crm",
        task_id="task_crm",
        caller_kind="first_party",
        information_grant_refs=("grant_ref",),
        encrypted_export_refs=("export_ref",),
        action_capabilities=("connected_system.crm.manage",),
        confirmation_receipt="confirmation_ref",
    )


def _planned_crm_update(*, slots: dict) -> dict:
    return {
        "call_id": "crm_llm_plan",
        "action_id": "connected_system.crm.update.propose",
        "label": "Propose CRM Update",
        "execution": "frontend",
        "slots": {
            "systemId": "salesforce-fsc-customer0",
            "objectType": "Contact",
            **slots,
        },
        "message": "Opening Connected Systems so you can review and approve the CRM update.",
        "reason": None,
    }


@pytest.mark.asyncio
async def test_connected_systems_a2a_requires_validated_plan_and_does_not_harvest_chat_pii():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message=(
                "update the CRM record 003ABCDEF123456 city to New York "
                "for kushal@example.com phone 415-555-1212"
            ),
        )
    )

    assert result.conversation_id == "thread_crm"
    assert result.model == "one+connected-systems"
    assert result.directive is None
    assert "validated Connected Systems action" in result.text


@pytest.mark.asyncio
async def test_connected_systems_a2a_marks_all_brand_updates():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message=(
                "update my new city to New York across all brands for "
                "kushal@example.com phone 415-555-1212"
            ),
            planned_action=_planned_crm_update(
                slots={
                    "scope": "all_connected_crm_systems",
                    "email": "kushal@example.com",
                    "phone": "415-555-1212",
                    "additionalFieldsJson": json.dumps({"MailingCity": "New York"}),
                }
            ),
        )
    )

    assert result.directive is not None
    assert result.directive.kind == "action"
    assert result.directive.payload["confirmLabel"] == "Update all"
    slots = result.directive.payload["slots"]
    assert slots["scope"] == "all_connected_crm_systems"
    assert json.loads(slots["additionalFieldsJson"]) == {"MailingCity": "New York"}


@pytest.mark.asyncio
async def test_connected_systems_a2a_does_not_lexically_infer_missing_city_prompt():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message="can I update my city in Macy's CRM",
        )
    )

    assert result.directive is None
    assert result.is_complete is True


@pytest.mark.asyncio
async def test_connected_systems_a2a_opens_dynamic_field_table_for_validated_scope():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message="can I update my city across all brands",
            planned_action=_planned_crm_update(slots={"scope": "all_connected_crm_systems"}),
        )
    )

    assert result.directive is not None
    assert result.directive.kind == "action"
    assert result.directive.payload["slots"]["scope"] == "all_connected_crm_systems"
    assert result.directive.payload["confirmLabel"] == "Update all"


@pytest.mark.asyncio
async def test_connected_systems_a2a_does_not_turn_prompt_text_into_update_directive():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message="",
            delegate_result={
                "kind": "selection",
                "id": "crm_prompt",
                "type": "connected_system.crm.update.propose",
                "status": "answered",
                "freeText": "New York",
                "selected": [
                    {
                        "fieldName": "MailingCity",
                        "slots": {
                            "systemId": "salesforce-fsc-customer0",
                            "objectType": "Contact",
                            "scope": "all_connected_crm_systems",
                        },
                    }
                ],
            },
        )
    )

    assert result.directive is None
    assert result.is_complete is True
    assert "CRM field table" in result.text


@pytest.mark.asyncio
async def test_connected_systems_a2a_keeps_answered_prompt_in_manual_field_table():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message="",
            delegate_result={
                "kind": "selection",
                "id": "crm_prompt",
                "type": "connected_system.crm.update.propose",
                "status": "answered",
                "freeText": "New York",
                "selected": [
                    {
                        "fieldName": "MailingCity",
                        "slots": {
                            "systemId": "salesforce-fsc-customer0",
                            "objectType": "Contact",
                        },
                    }
                ],
            },
        )
    )

    assert result.directive is None
    assert result.is_complete is True
    assert "CRM field table" in result.text


@pytest.mark.asyncio
async def test_connected_systems_a2a_blocks_crm_delete():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message="delete the CRM contact record",
            planned_action={
                "call_id": "crm_delete_plan",
                "action_id": "connected_system.crm.delete",
                "label": "Delete CRM Record",
                "execution": "blocked",
                "slots": {},
                "message": "CRM deletion must be completed manually.",
                "reason": "crm_delete_manual_only",
            },
        )
    )

    assert result.directive is not None
    assert result.directive.payload["type"] == "connected_system.crm.delete"
    assert result.directive.payload["actionId"] == "connected_system.crm.delete"
    assert result.directive.payload["execution"] == "blocked"
    assert result.directive.payload["reason"] == "crm_delete_manual_only"
    assert result.is_complete is True


@pytest.mark.asyncio
async def test_connected_systems_a2a_reports_inline_delegate_result():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            authority=_authority(),
            message="",
            delegate_result={
                "kind": "action",
                "status": "completed",
                "display": "Done. The CRM update was approved and applied.",
            },
        )
    )

    assert result.directive is None
    assert result.text == "Done. The CRM update was approved and applied."
