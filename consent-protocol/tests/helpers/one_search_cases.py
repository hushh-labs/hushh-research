"""Shared synthetic Azure/One builders; collection owners retain fixture scope."""

import json
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.adk_bridge import delegation
from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.agent_tree import build_one_text_agent
from hushh_mcp.one_adk.registered_mcp_toolset import RegisteredMcpToolset
from hushh_mcp.runtime_providers import managed_text as managed
from tests.services.test_azure_adk import Stream, call, message, model, response
from tests.test_azure_web_receipts import response as search_response

ANSWER = "Public team page confirms the owner [1]. https://example.test/team/owner"


@pytest.fixture(autouse=True)
def _azure_uat(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")


def _provider_case(monkeypatch, control):
    from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding

    monkeypatch.setattr(RegisteredMcpToolset, "get_tools", AsyncMock(return_value=[]))
    authority = {"valid": True}

    async def validate(*args, **kwargs):
        return object() if authority["valid"] else None

    monkeypatch.setattr(delegation, "validate_first_party_owner_token", validate)
    monkeypatch.setattr(queued_input, "registry", queued_input.QueuedInputRegistry())
    raw = search_response()
    raw["output"][2]["content"][0]["text"] = ANSWER
    finish = control != "ordinary"
    first = response(
        call(
            json.dumps({"request": "Find the public source", "finish_turn": finish}),
            name="google_search",
        )
    )
    outputs = [first, response(message(ANSWER)) if control == "ungrounded" else raw]
    if control == "prior_tool":
        outputs = [
            response(call("{}", name="get_current_time", identity="earlier")),
            response(message("time")),
            *outputs,
        ]
        # get_current_time is a host tool: it does not consume a model response.
        outputs.pop(1)
    outputs.append(response(message("Normal synthesis.")))
    adapter, client, factory, token = model(outputs)
    fallback = Mock(side_effect=AssertionError("One must stay Azure-only"))
    wrapped = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        client_factory=factory,
        token_supplier=token,
        fallback_factory=fallback,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        runtime_binding=ManagedAzureBinding.from_environment(),
    )
    return wrapped, adapter, client, fallback, authority


def _root_case(monkeypatch, control, wrapped, adapter, client, authority):
    create = client.create

    async def observe_create(**kwargs):
        if control == "queued" and any(t["type"] == "web_search" for t in kwargs.get("tools", [])):
            assert (
                queued_input.registry.enqueue(
                    "owner", "thread", "queued-msg-0001", "Also explain the result."
                ).status
                == "queued"
            )
        value = await create(**kwargs)
        if control == "stopped" and any(t["type"] == "web_search" for t in kwargs.get("tools", [])):
            queued_input.registry.request_stop("owner", "thread")
        return (
            Stream([{"type": "response.completed", "response": value}])
            if kwargs.get("stream")
            else value
        )

    monkeypatch.setattr(client, "create", observe_create)
    root = build_one_text_agent(
        model=wrapped,
        google_search_model=adapter.model_copy(update={"allow_web_search": True})
        if control == "external_search_override"
        else None,
    )
    original_after = root.after_tool_callback

    async def revoke_after_tool(tool, args, tool_context, tool_response):
        result = original_after(tool, args, tool_context, tool_response)
        authority["valid"] = False
        return result

    if control == "revoked":
        root.after_tool_callback = revoke_after_tool
    return root
