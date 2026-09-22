"""Connected Systems ADK parent invariants without CRM or Gemini calls."""

from __future__ import annotations

from typing import Any

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.adk_bridge.connected_systems_agent import ConnectedSystemsAgentA2A
from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2ATask
from hushh_mcp.agents.connected_systems.agent import (
    build_connected_systems_agent,
    validate_crm_plan,
)


class ScriptedLlm(BaseLlm):
    _steps: list[Any] = PrivateAttr(default_factory=list)

    def __init__(self, steps: list[Any]):
        super().__init__(model="gemini-3.7-flash")
        self._steps = list(steps)

    async def generate_content_async(self, llm_request, stream=False):
        step = self._steps.pop(0)
        part = (
            types.Part(function_call=types.FunctionCall(name=step[0], args=step[1]))
            if isinstance(step, tuple)
            else types.Part(text=step)
        )
        yield LlmResponse(content=types.Content(role="model", parts=[part]))


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


def _plan(*, action_id: str = "connected_system.crm.update.propose", **slots: Any) -> dict:
    return {
        "call_id": "crm_llm_plan",
        "action_id": action_id,
        "slots": {"systemId": "salesforce-fsc-customer0", "objectType": "Contact", **slots},
    }


@pytest.mark.asyncio
async def test_connected_systems_parent_uses_adk_and_emits_existing_directive_shape():
    result = await ConnectedSystemsAgentA2A(
        model=ScriptedLlm(
            [
                ("validate_crm_plan", {"planned_action": _plan(scope="all_connected_crm_systems")}),
                "I prepared a review card.",
            ]
        )
    ).handle(
        A2ATask(
            user_id="user_crm",
            consent_token="token",  # noqa: S106
            conversation_id="thread_crm",
            authority=_authority(),
            message="update my city across my connected brands",
        )
    )

    assert result.model == "one+connected-systems"
    assert result.directive is not None
    assert result.directive.payload["actionId"] == "connected_system.crm.update.propose"
    assert result.directive.payload["confirmLabel"] == "Update all"
    assert result.directive.payload["slots"] == {
        "systemId": "salesforce-fsc-customer0",
        "objectType": "Contact",
        "scope": "all_connected_crm_systems",
    }
    assert result.is_complete is False


@pytest.mark.asyncio
async def test_parent_requires_attenuated_information_and_action_authority():
    with pytest.raises(PermissionError):
        await ConnectedSystemsAgentA2A(model=ScriptedLlm([])).handle(
            A2ATask(
                user_id="user_crm",
                consent_token="token",  # noqa: S106
                conversation_id="thread_crm",
                message="read my CRM",
                authority=A2AAuthorityContext(
                    subject_user_id="user_crm",
                    tenant_id="tenant_crm",
                    task_id="task_crm",
                    caller_kind="first_party",
                    information_grant_refs=("grant_ref",),
                    encrypted_export_refs=("export_ref",),
                ),
            )
        )


def test_validate_crm_plan_rejects_chat_values_and_identifiers():
    class Context:
        state = {}

    result = validate_crm_plan(_plan(email="kushal@example.com", recordId="003ABC"), Context())
    assert result == {"status": "invalid", "error": "record_values_must_be_app_bound"}
    assert Context.state == {}


def test_validate_crm_plan_preserves_only_typed_field_metadata():
    class Context:
        state = {}

    result = validate_crm_plan(
        _plan(fieldNames=["MailingCity", "MailingStreet"], ignored="model text"), Context()
    )
    assert result["status"] == "validated"
    assert result["planned_action"]["slots"]["fieldNames"] == ["MailingCity", "MailingStreet"]
    assert "ignored" not in result["planned_action"]["slots"]
    assert Context.state["hussh:connected_systems_plan"] == result["planned_action"]


def test_validate_crm_plan_blocks_delete_without_executing_it():
    class Context:
        state = {}

    result = validate_crm_plan(_plan(action_id="connected_system.crm.delete"), Context())
    assert result["status"] == "validated"
    assert result["planned_action"]["execution"] == "blocked"
    assert result["planned_action"]["reason"] == "crm_delete_manual_only"


def test_connected_systems_builder_is_manifest_owned_and_has_schema_child():
    agent = build_connected_systems_agent(model="gemini-3.7-flash")
    assert agent.name == "connected_systems"
    names = {tool.name for tool in agent.tools}
    assert {"describe_crm_fields", "validate_crm_plan", "crm_schema_mapper"} <= names
    assert agent.instruction.startswith("You plan work against the owner's connected business")


@pytest.mark.asyncio
async def test_delegate_selection_never_turns_free_text_into_a_write():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="token",  # noqa: S106
            conversation_id="thread_crm",
            authority=_authority(),
            message="",
            delegate_result={
                "kind": "selection",
                "type": "connected_system.crm.update.propose",
                "status": "answered",
                "freeText": "New York",
            },
        )
    )
    assert result.directive is None
    assert result.is_complete is True
    assert "CRM field table" in result.text


@pytest.mark.asyncio
async def test_completed_delegate_result_is_reported_once():
    result = await ConnectedSystemsAgentA2A().handle(
        A2ATask(
            user_id="user_crm",
            consent_token="token",  # noqa: S106
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
    assert result.text == "Done. The CRM update was approved and applied."
    assert result.directive is None
