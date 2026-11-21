# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract tests for Plaid in-turn client-continuation tools and Private Pod parity."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from ag_ui.core import Tool, ToolMessage
from google.adk.events import Event, EventActions
from google.adk.sessions import Session
from google.genai import types

from hushh_mcp.one_adk.connector_chat_tools import manage_connector
from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
from hushh_mcp.one_adk.plaid_connector_tools import (
    PLAID_TOOL_NAMES,
    STATE_PLAID_CLIENT_READY,
    STATE_PLAID_PENDING,
    STATE_PLAID_POSTURE,
    STATE_PLAID_RESULT,
    before_plaid_connector_tool,
    plaid_after_model,
    plaid_before_model,
    plaid_posture_instruction,
    plaid_tool_declaration,
    validate_plaid_tool_result,
)
from hushh_mcp.one_adk.plaid_turn_admission import (
    admit_plaid_continuation,
    admit_plaid_posture,
    admit_plaid_tool,
)
from hushh_mcp.one_adk.pod_chat_tool_admission import (
    PodChatToolAdmissionError,
    admit_pod_chat_tools,
)
from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret
from hushh_mcp.one_adk.wiki_recall_tools import WIKI_TOOL_NAMES, wiki_tool_declaration


def _tool_from_decl(decl: dict) -> Tool:
    return Tool(
        name=decl["name"],
        description=decl["description"],
        parameters=decl["parameters"],
    )


def test_pod_chat_tool_admission_accepts_plaid_and_client_wiki_when_pod_files_disabled(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "true")
    monkeypatch.delenv("POD_FILES_ENABLED", raising=False)

    tools = [_tool_from_decl(plaid_tool_declaration(name)) for name in sorted(PLAID_TOOL_NAMES)] + [
        _tool_from_decl(wiki_tool_declaration(name)) for name in sorted(WIKI_TOOL_NAMES)
    ]
    admitted = admit_pod_chat_tools(tools)
    assert {t.name for t in admitted} == set(PLAID_TOOL_NAMES) | set(WIKI_TOOL_NAMES)

    # When POD_FILES_ENABLED=true, Pod mounts server-side wiki tools and refuses client wiki tools.
    monkeypatch.setenv("POD_FILES_ENABLED", "true")
    plaid_only = [
        _tool_from_decl(plaid_tool_declaration(name)) for name in sorted(PLAID_TOOL_NAMES)
    ]
    assert {t.name for t in admit_pod_chat_tools(plaid_only)} == set(PLAID_TOOL_NAMES)
    with pytest.raises(PodChatToolAdmissionError):
        admit_pod_chat_tools(tools)


def test_plaid_tool_rejects_tampered_schema():
    bad = Tool(
        name="sync_plaid_connector",
        description="tampered",
        parameters={"type": "OBJECT", "properties": {"user_id": {"type": "STRING"}}},
    )
    with pytest.raises(ValueError, match="Plaid tool contract is invalid"):
        admit_plaid_tool(bad)


def test_plaid_posture_admission_and_number_scrubbing():
    forwarded = {
        "plaidPosture": (
            "3 linked institutions (First Platypus Bank, Tartan Bank, Houndstooth Bank) · "
            "42 accounts · Net worth -$231,492 · Account 123456789012"
        ),
        "plaidClientReady": True,
    }
    ref, ready = admit_plaid_posture(forwarded, owner_admitted=True)
    assert ready is True
    assert "plaidPosture" not in forwarded
    assert "plaidClientReady" not in forwarded

    resolved = resolve_request_secret(ref, preserve_whitespace=True)
    assert "<connected_plaid_posture" in resolved
    assert "123456789012" not in resolved
    assert "[redacted-number]" in resolved

    rendered = plaid_posture_instruction(ref, tools_available=True)
    assert "CONNECTED PLAID FINANCIAL POSTURE" in rendered
    assert "sync_plaid_connector" in rendered
    assert "read_plaid_mirror" in rendered
    assert "Never claim no bank or portfolio holdings are imported" in rendered


@pytest.mark.asyncio
async def test_plaid_client_continuation_round_trip_and_redaction():
    owner_id = "owner_plaid_1"
    conv_id = "conv_plaid_1"
    call_id = "call_plaid_sync_1"

    session = Session(
        id=conv_id,
        app_name="one",
        user_id=owner_id,
        state={
            "hussh:user_id": owner_id,
            "hussh:conversation_id": conv_id,
            "hussh:consent_token": store_request_secret("pod-session:test"),
            STATE_PLAID_CLIENT_READY: True,
            "pending_tool_calls": [call_id],
            "lro_tool_call_id_remap": {},
        },
        events=[
            Event(
                author="one",
                invocation_id="inv_1",
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id=call_id,
                                name="sync_plaid_connector",
                                args={},
                            )
                        )
                    ],
                ),
            )
        ],
    )

    # Bind pending call via plaid_after_model
    cb_ctx = SimpleNamespace(state=session.state)
    llm_resp = SimpleNamespace(
        partial=False,
        content=session.events[0].content,
    )
    plaid_after_model(cb_ctx, llm_resp)
    assert call_id in session.state[STATE_PLAID_PENDING]

    # Pre-tool guard also succeeds for unlocked owner turns
    tool_ctx = SimpleNamespace(state=session.state, function_call_id=call_id)
    guard = before_plaid_connector_tool(
        SimpleNamespace(name="sync_plaid_connector"),
        {},
        tool_ctx,
    )
    assert guard is None

    wire_msg = ToolMessage(
        id="msg_tool_1",
        role="tool",
        tool_call_id=call_id,
        content=json.dumps(
            {
                "schema": "plaid_result.v1",
                "operation": "sync_plaid_connector",
                "ephemeral_result": True,
            }
        ),
    )
    messages = [wire_msg]
    forwarded = {
        "plaidToolResults": [
            {
                "toolCallId": call_id,
                "toolName": "sync_plaid_connector",
                "request": {},
                "result": {
                    "status": "ok",
                    "operation": "sync_plaid_connector",
                    "refreshed": True,
                    "connected": True,
                    "institution_count": 3,
                    "account_count": 42,
                    "headline": {
                        "net_worth": "-$231,492",
                        "liquid_cash": "$184,767",
                        "investable_assets": "$71,858",
                    },
                    "institutions": [
                        {"name": "First Platypus Bank", "account_count": 14},
                        {"name": "Tartan Bank", "account_count": 14},
                        {"name": "Houndstooth Bank", "account_count": 14},
                    ],
                    "mirrors": {
                        "accounts": {
                            "summary": "$187,767 across 12 accounts (raw acct 987654321098)",
                        }
                    },
                },
            }
        ]
    }

    async def _load_session():
        return session

    ref = await admit_plaid_continuation(
        forwarded,
        owner_id=owner_id,
        conversation_id=conv_id,
        messages=messages,
        execution_head=lambda: None,
        load_session=_load_session,
    )
    assert ref
    session.state[STATE_PLAID_RESULT] = ref

    llm_req = SimpleNamespace(
        contents=[types.Content(role="user", parts=[types.Part.from_text(text="fetch plaid")])],
        config=types.GenerateContentConfig(),
    )
    plaid_before_model(cb_ctx, llm_req)
    injected_text = llm_req.contents[-1].parts[0].text
    assert "First Platypus Bank" in injected_text
    assert "-$231,492" in injected_text
    assert "987654321098" not in injected_text
    assert "[redacted-number]" in injected_text

    # Durable session projection strips ephemeral state & redacts function responses
    session.events.append(
        Event(
            author="user",
            invocation_id="inv_1",
            actions=EventActions(state_delta={STATE_PLAID_POSTURE: "secret_posture"}),
            content=types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            id=call_id,
                            name="sync_plaid_connector",
                            response={"status": "ok", "secret_balance": 184767},
                        )
                    )
                ],
            ),
        )
    )
    projected = durable_external_read_projection(session)
    assert STATE_PLAID_POSTURE not in projected.state
    assert STATE_PLAID_RESULT not in projected.state
    assert STATE_PLAID_CLIENT_READY not in projected.state
    resp_part = projected.events[-1].content.parts[0].function_response
    assert resp_part.response == {"content_redacted": True, "status": "ok"}


@pytest.mark.asyncio
async def test_manage_connector_plaid_admits_hosted_and_pooled_pod_owner(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "true")
    monkeypatch.setenv("HUSSH_OWNER_USER_ID", "owner_hosted_pod")
    # Hosted / pooled pods are NOT owner_cloud_agent(), which previously blocked Plaid!
    monkeypatch.setattr("hushh_mcp.services.pod_owner_cloud.owner_cloud_agent", lambda: False)
    monkeypatch.setattr(
        "hushh_mcp.services.pod_owner_cloud.pod_owner_user_id",
        lambda: "owner_hosted_pod",
    )

    token_ref = store_request_secret("pod-session:valid-local-token")
    ctx = SimpleNamespace(
        user_id="owner_hosted_pod",
        state={
            "temp:one_execution_surface": "typed_chat",
            "hussh:user_id": "owner_hosted_pod",
            "hussh:consent_token": token_ref,
            "hussh:voice_context": {
                "screen_state": {"plaid_connected": False, "plaid_institution_count": 0}
            },
        },
    )
    result = await manage_connector("plaid", ctx, operation="connect")
    assert result["status"] == "connect_required"
    assert result["provider"] == "plaid"


def test_validate_plaid_result_enforces_size_budget():
    huge = {
        "status": "ok",
        "headline": {"net_worth": "$100,000"},
        "mirrors": {
            "accounts": {
                "items": [{"name": f"Checking {i}", "detail": "x" * 400} for i in range(60)]
            }
        },
    }
    validated = validate_plaid_tool_result("read_plaid_mirror", huge)
    assert validated["truncated"] is True
    assert validated["untrusted_data"] is True
    assert len(json.dumps(validated)) <= 12_000


@pytest.mark.asyncio
async def test_request_state_session_service_preserves_temp_client_ready_across_turns():
    from ag_ui_adk.request_state_service import RequestStateSessionService
    from google.adk.sessions import InMemorySessionService

    from hushh_mcp.one_adk.wiki_recall_tools import STATE_WIKI_CLIENT_READY

    assert STATE_PLAID_CLIENT_READY.startswith("temp:")
    assert STATE_WIKI_CLIENT_READY.startswith("temp:")

    inner = InMemorySessionService()
    wrapper = RequestStateSessionService(inner)
    created = await wrapper.create_session(
        app_name="one",
        user_id="owner_multi_turn",
        session_id="conv_multi_turn",
        state={"hussh:user_id": "owner_multi_turn"},
    )
    projected = durable_external_read_projection(created)
    assert STATE_PLAID_CLIENT_READY not in projected.state
    assert STATE_WIKI_CLIENT_READY not in projected.state

    wrapper.set_pending_temp_state(
        app_name="one",
        user_id="owner_multi_turn",
        session_id="conv_multi_turn",
        temp_state={
            STATE_PLAID_CLIENT_READY: True,
            STATE_WIKI_CLIENT_READY: True,
        },
    )
    turn2_session = await wrapper.get_session(
        app_name="one",
        user_id="owner_multi_turn",
        session_id="conv_multi_turn",
    )
    assert turn2_session is not None
    assert turn2_session.state.get(STATE_PLAID_CLIENT_READY) is True
    assert turn2_session.state.get(STATE_WIKI_CLIENT_READY) is True
