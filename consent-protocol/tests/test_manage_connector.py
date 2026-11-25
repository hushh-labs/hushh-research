"""Tests for Chat manage_connector tool, history restore, and prefix-cache split."""

from __future__ import annotations

import sys
import types as py_types
from types import SimpleNamespace
from unittest.mock import AsyncMock

from google.genai import types as genai_types

from hushh_mcp.one_adk import agent_tree, agui_factory, connector_chat_tools, history_projection
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.workspace_mcp_tools import WORKSPACE_CHAT_ADMISSION_STATE


def _hub_ctx(
    *,
    owner: str = "owner_1",
    surface: str = "typed_chat",
    admitted: bool = True,
    screen_state: dict | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        user_id=owner,
        state={
            WORKSPACE_CHAT_ADMISSION_STATE: admitted,
            STATE_EXECUTION_SURFACE: surface,
            "hussh:user_id": owner,
            "hussh:consent_token": "tok_owner",
            "hussh:voice_context": {"screen": "chat", "screen_state": screen_state or {}},
        },
    )


async def test_manage_connector_refuses_unauthenticated_and_non_chat(monkeypatch):
    monkeypatch.setattr(connector_chat_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(
        connector_chat_tools, "validate_first_party_owner_token", AsyncMock(return_value=True)
    )

    bad_surface = _hub_ctx(surface="voice")
    assert (await connector_chat_tools.manage_connector("plaid", bad_surface))[
        "status"
    ] == "blocked"

    not_admitted = _hub_ctx(admitted=False)
    assert (await connector_chat_tools.manage_connector("plaid", not_admitted))[
        "status"
    ] == "blocked"

    monkeypatch.setattr(
        connector_chat_tools, "validate_first_party_owner_token", AsyncMock(return_value=False)
    )
    assert (await connector_chat_tools.manage_connector("plaid", _hub_ctx()))["status"] == "blocked"


async def test_manage_connector_plaid_posture_hub_and_pod(monkeypatch):
    monkeypatch.setattr(connector_chat_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(
        connector_chat_tools, "validate_first_party_owner_token", AsyncMock(return_value=True)
    )

    disconnected = await connector_chat_tools.manage_connector("plaid", _hub_ctx())
    assert disconnected["status"] == "connect_required"
    assert disconnected["provider"] == "plaid"
    assert disconnected["connected"] is False

    connected = await connector_chat_tools.manage_connector(
        "plaid",
        _hub_ctx(screen_state={"plaid_connected": True, "plaid_institution_count": 2}),
        operation="refresh",
    )
    assert connected["status"] == "manage_available"
    assert connected["provider"] == "plaid"
    assert connected["operation"] == "refresh"
    assert connected["connected"] is True
    assert connected["institution_count"] == 2

    monkeypatch.setattr(connector_chat_tools, "pod_mode", lambda: True)
    pod_owner_mock = AsyncMock(return_value="pod_owner_1")
    monkeypatch.setattr(connector_chat_tools, "pod_tool_owner", pod_owner_mock)
    pod_res = await connector_chat_tools.manage_connector("plaid", _hub_ctx(owner="pod_owner_1"))
    assert pod_res["status"] == "connect_required"
    pod_owner_mock.assert_awaited_once()


async def test_manage_connector_stripe_never_leaks_account_ids(monkeypatch):
    monkeypatch.setattr(connector_chat_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(
        connector_chat_tools, "validate_first_party_owner_token", AsyncMock(return_value=True)
    )

    class _FakePayoutService:
        async def account_status(self, *, user_id: str, force_refresh: bool = False):
            assert user_id == "owner_1"
            assert force_refresh is False
            return {
                "account": {
                    "stripe_account_id": "acct_secret_1234",
                    "payoutsEnabled": True,
                    "detailsSubmitted": True,
                }
            }

    monkeypatch.setitem(
        sys.modules,
        "hushh_mcp.services.pkm_payout_service",
        py_types.SimpleNamespace(PkmPayoutService=_FakePayoutService),
    )

    res = await connector_chat_tools.manage_connector("stripe", _hub_ctx())
    assert res["status"] == "manage_available"
    assert res["provider"] == "stripe"
    assert res["connected"] is True
    assert res["payouts_enabled"] is True
    assert "acct_secret_1234" not in str(res)


async def test_manage_connector_delegates_workspace_and_custom(monkeypatch):
    monkeypatch.setattr(connector_chat_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(
        connector_chat_tools, "validate_first_party_owner_token", AsyncMock(return_value=True)
    )

    workspace_mock = AsyncMock(return_value={"status": "permission_required", "provider": "drive"})
    custom_mock = AsyncMock(return_value={"status": "setup_available", "provider": "custom"})
    monkeypatch.setattr(
        "hushh_mcp.one_adk.workspace_mcp_tools.discover_workspace_tools",
        workspace_mock,
    )
    monkeypatch.setattr(
        "hushh_mcp.one_adk.registered_mcp_toolset.inspect_private_connectors",
        custom_mock,
    )

    ctx = _hub_ctx()
    drive_res = await connector_chat_tools.manage_connector("drive", ctx)
    assert drive_res["status"] == "permission_required"
    assert drive_res["provider"] == "drive"
    workspace_mock.assert_awaited_once_with("drive", ctx)

    custom_res = await connector_chat_tools.manage_connector("custom", ctx)
    assert custom_res["status"] == "setup_available"
    assert custom_res["provider"] == "custom"
    custom_mock.assert_awaited_once_with(ctx)


def test_history_projection_restores_plaid_and_stripe_and_rejects_unknown():
    def _resp(call_id: str, response: dict) -> SimpleNamespace:
        return SimpleNamespace(
            content=SimpleNamespace(
                parts=[
                    SimpleNamespace(
                        function_response=SimpleNamespace(
                            id=call_id, name="manage_connector", response=response
                        )
                    )
                ]
            )
        )

    plaid_event = _resp("c1", {"status": "connect_required", "provider": "plaid"})
    assert history_projection._safe_workspace_connector_setup_descriptor(
        plaid_event, call_providers={"c1": "plaid"}
    ) == {
        "activityType": "one.workspace_connector_setup.v1",
        "content": {"provider": "plaid", "status": "connect_required"},
    }

    stripe_event = _resp("c2", {"status": "manage_available", "provider": "stripe"})
    assert history_projection._safe_workspace_connector_setup_descriptor(
        stripe_event, call_providers={"c2": "stripe"}
    ) == {
        "activityType": "one.workspace_connector_setup.v1",
        "content": {"provider": "stripe", "status": "manage_available"},
    }

    unknown = _resp("c3", {"status": "connect_required", "provider": "venmo"})
    assert (
        history_projection._safe_workspace_connector_setup_descriptor(
            unknown, call_providers={"c3": "venmo"}
        )
        is None
    )

    mismatch = _resp("c4", {"status": "connect_required", "provider": "plaid"})
    assert (
        history_projection._safe_workspace_connector_setup_descriptor(
            mismatch, call_providers={"c4": "stripe"}
        )
        is None
    )


def test_capabilities_and_split_dynamic_context_prefix_cache():
    assert agui_factory._authenticated_capabilities["tools"]["parallelCalls"] is True
    assert agui_factory._authenticated_capabilities["features"]["connectorSetupVersion"] == 2

    def make_ctx(screen_state: dict) -> SimpleNamespace:
        return SimpleNamespace(
            state={
                "temp:one_execution_surface": "typed_chat",
                "temp:hussh:split_dynamic_context": True,
                "hussh:user_id": "owner_1",
                "hussh:timezone": "America/Los_Angeles",
                "hussh:voice_context": {"screen": "chat", "screen_state": screen_state},
            }
        )

    ctx_one = make_ctx({"plaid_connected": False, "plaid_institution_count": 0})
    ctx_two = make_ctx({"plaid_connected": True, "plaid_institution_count": 3})

    sys_one = agent_tree._one_runtime_instruction(ctx_one)
    sys_two = agent_tree._one_runtime_instruction(ctx_two)
    assert sys_one == sys_two
    assert "plaid_institution_count" not in sys_one

    turn_one = genai_types.Content(role="user", parts=[genai_types.Part.from_text(text="hi")])
    req = SimpleNamespace(contents=[turn_one])
    agent_tree.inject_dynamic_turn_context_before_model(ctx_one, req)
    assert len(req.contents) == 1
    assert any(
        (p.text or "").startswith(agent_tree._DYNAMIC_TURN_CONTEXT_MARKER)
        for p in req.contents[0].parts
    )

    # Multi-step tool iteration replaces stale context rather than duplicating it.
    agent_tree.inject_dynamic_turn_context_before_model(ctx_two, req)
    markers = [
        p.text
        for p in req.contents[0].parts
        if (p.text or "").startswith(agent_tree._DYNAMIC_TURN_CONTEXT_MARKER)
    ]
    assert len(markers) == 1
    assert "plaid_institution_count=3" in markers[0]
