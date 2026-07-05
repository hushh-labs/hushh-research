from __future__ import annotations

import json

import pytest

from hushh_mcp.adk_bridge.connected_systems_agent import ConnectedSystemsAgentA2A
from hushh_mcp.adk_bridge.contract import A2ATask


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
async def test_connected_systems_a2a_proposes_crm_update_inline_directive():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            message=(
                "update the CRM record 003ABCDEF123456 city to New York "
                "for kushal@example.com phone 415-555-1212"
            ),
        )
    )

    assert result.conversation_id == "thread_crm"
    assert result.model == "one+connected-systems"
    assert result.directive is not None
    assert result.directive.kind == "action"
    assert result.directive.payload["type"] == "connected_system.crm.update.propose"
    assert result.directive.payload["actionId"] == "connected_system.crm.update.propose"
    assert result.directive.payload["confirmLabel"] == "Update"
    assert result.directive.payload["execution"] == "frontend"
    slots = result.directive.payload["slots"]
    assert slots["systemId"] == "salesforce-fsc-customer0"
    assert slots["id"] == "003ABCDEF123456"
    assert slots["email"] == "kushal@example.com"
    assert slots["phone"] == "415-555-1212"
    assert json.loads(slots["additionalFieldsJson"]) == {"MailingCity": "New York"}


@pytest.mark.asyncio
async def test_connected_systems_a2a_marks_all_brand_updates():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
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
async def test_connected_systems_a2a_asks_for_missing_city_before_update():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            message="can I update my city in Macy's CRM",
        )
    )

    assert result.directive is not None
    assert result.directive.kind == "prompt"
    assert result.directive.payload["kind"] == "free_text"
    assert result.directive.payload["fieldName"] == "MailingCity"
    assert "What city" in result.directive.payload["question"]


@pytest.mark.asyncio
async def test_connected_systems_a2a_asks_for_missing_city_across_brands():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            message="can I update my city across all brands",
            planned_action=_planned_crm_update(slots={"scope": "all_connected_crm_systems"}),
        )
    )

    assert result.directive is not None
    assert result.directive.kind == "prompt"
    assert result.directive.payload["kind"] == "free_text"
    assert result.directive.payload["slots"]["scope"] == "all_connected_crm_systems"
    assert "connected CRM brands" in result.directive.payload["question"]


@pytest.mark.asyncio
async def test_connected_systems_a2a_turns_all_brand_city_answer_into_update_directive():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
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

    assert result.directive is not None
    assert result.directive.kind == "action"
    slots = result.directive.payload["slots"]
    assert slots["scope"] == "all_connected_crm_systems"
    assert json.loads(slots["additionalFieldsJson"]) == {"MailingCity": "New York"}
    assert result.directive.payload["confirmLabel"] == "Update all"


@pytest.mark.asyncio
async def test_connected_systems_a2a_turns_city_answer_into_update_directive():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
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

    assert result.directive is not None
    assert result.directive.kind == "action"
    slots = result.directive.payload["slots"]
    assert json.loads(slots["additionalFieldsJson"]) == {"MailingCity": "New York"}
    assert result.directive.payload["confirmLabel"] == "Update"


@pytest.mark.asyncio
async def test_connected_systems_a2a_blocks_crm_delete():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="",
            conversation_id="thread_crm",
            message="delete the CRM contact record",
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
