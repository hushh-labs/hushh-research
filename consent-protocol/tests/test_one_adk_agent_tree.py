# tests/test_one_adk_agent_tree.py
"""
Unit tests for One's ADK agent tree (hushh_mcp/one_adk/agent_tree.py).

Contract under test:
- One is the root LlmAgent, named "one", with the full /one roster wired as
  tools (google_search + Finance/RIA AgentTools + 6 dispatch-backed
  specialist turn functions).
- The identity instruction answers "what is your name" explicitly with One
  and forbids competing names.
- Specialist turn tools fail closed without session auth state and route
  through the governed adk_bridge dispatch when state is present.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.adk_bridge.contract import A2ADirective, SpecialistTurnResult
from hushh_mcp.one_adk import agent_tree as _tree
from hushh_mcp.one_adk.action_tools import (
    _STATE_PENDING_DIRECTIVE,
    _STATE_SCREEN,
    list_app_actions,
    run_app_action,
)
from hushh_mcp.one_adk.agent_tree import (
    APP_ROUTES,
    ONE_IDENTITY_INSTRUCTION,
    STATE_CONSENT_TOKEN,
    STATE_PENDING_DIRECTIVE,
    STATE_USER_ID,
    _specialist_turn,
    build_one_root_agent,
    get_one_runner,
    open_screen,
)


class TestAgentTreeShape:
    def test_root_agent_is_one_with_full_roster(self):
        agent = build_one_root_agent()
        assert agent.name == "one"
        tool_names = {
            getattr(t, "name", getattr(t, "__name__", type(t).__name__)) for t in agent.tools
        }
        assert "google_search" in tool_names
        assert "open_screen" in tool_names
        assert "run_app_action" in tool_names
        assert "list_app_actions" in tool_names
        assert "finance" in tool_names
        # RIA and Investor are Finance subagents, not One-level siblings.
        assert "ria" not in tool_names
        finance_tool = next(t for t in agent.tools if getattr(t, "name", "") == "finance")
        finance_sub_names = {
            getattr(t, "name", getattr(t, "__name__", type(t).__name__))
            for t in finance_tool.agent.tools
        }
        assert {"ria", "investor"} <= finance_sub_names
        assert {
            "ask_email_agent",
            "ask_gmail_agent",
            "ask_location_agent",
            "ask_connections_agent",
            "ask_marketplace_agent",
            "ask_connected_systems_agent",
            "ask_consent_agent",
        } <= tool_names

    def test_identity_instruction_answers_name_question(self):
        assert "I'm One" in ONE_IDENTITY_INSTRUCTION
        assert "Never call yourself Kai" in ONE_IDENTITY_INSTRUCTION

    def test_runner_is_singleton(self):
        assert get_one_runner() is get_one_runner()


def _tool_context(state: dict) -> SimpleNamespace:
    return SimpleNamespace(state=state)


class TestSpecialistTurn:
    @pytest.mark.asyncio
    async def test_fails_closed_without_auth_state(self):
        result = await _specialist_turn("agent_location", "what needs a reply", _tool_context({}))
        assert result["status"] == "needs_auth"

    @pytest.mark.asyncio
    async def test_unknown_specialist_reports_unavailable(self):
        result = await _specialist_turn(
            "agent_nonexistent",
            "hello",
            _tool_context({STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "t1"}),
        )
        assert result["status"] == "unavailable"

    @pytest.mark.asyncio
    async def test_dispatches_with_session_credentials(self):
        turn = SpecialistTurnResult(
            conversation_id="conv_1",
            text="Two threads need replies.",
            directive=None,
            is_complete=True,
            state_changed=False,
            model="test",
        )
        with patch(
            "hushh_mcp.one_adk.agent_tree.dispatch", new=AsyncMock(return_value=turn)
        ) as mock_dispatch:
            state = {STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "tok"}
            result = await _specialist_turn(
                "agent_location", "what needs a reply", _tool_context(state)
            )
        assert result["status"] == "ok"
        assert result["text"] == "Two threads need replies."
        task = mock_dispatch.call_args.args[1]
        assert task.user_id == "u1"
        assert task.consent_token == "tok"
        # Conversation continuity is written back for the next turn.
        assert state["hussh:conversation_id"] == "conv_1"

    @pytest.mark.asyncio
    async def test_directive_is_forwarded(self):
        turn = SpecialistTurnResult(
            conversation_id="conv_2",
            text="Opening the share sheet.",
            directive=A2ADirective(kind="action", payload={"clientAction": "share"}),
            is_complete=True,
            state_changed=True,
            model="test",
        )
        with patch("hushh_mcp.one_adk.agent_tree.dispatch", new=AsyncMock(return_value=turn)):
            state = {STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "tok"}
            result = await _specialist_turn(
                "agent_location",
                "share my location",
                _tool_context(state),
            )
        assert result["directive"] == {
            "kind": "action",
            "payload": {"clientAction": "share"},
            "delegateAgentId": "agent_location",
        }
        # Parked in state so the relay forwards it to the client.
        assert state[STATE_PENDING_DIRECTIVE] == result["directive"]

    @pytest.mark.asyncio
    async def test_specialist_exception_is_contained(self):
        with patch(
            "hushh_mcp.one_adk.agent_tree.dispatch",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            result = await _specialist_turn(
                "agent_location",
                "hello",
                _tool_context({STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "tok"}),
            )
        assert result["status"] == "error"
        assert "boom" not in result["message"]


class TestOpenScreen:
    @pytest.mark.asyncio
    async def test_navigates_to_known_screen(self):
        state: dict = {}
        result = await open_screen("profile", _tool_context(state))
        assert result["status"] == "ok"
        assert result["route"] == "/profile"
        assert state[STATE_PENDING_DIRECTIVE] == {
            "kind": "navigate",
            "payload": {"route": "/profile", "screen": "profile"},
        }

    @pytest.mark.asyncio
    async def test_normalizes_screen_names(self):
        state: dict = {}
        result = await open_screen("Connected Systems", _tool_context(state))
        assert result["status"] == "ok"
        assert result["route"] == APP_ROUTES["connected_systems"]

    @pytest.mark.asyncio
    async def test_refuses_unknown_screen(self):
        state: dict = {}
        result = await open_screen("admin_panel", _tool_context(state))
        assert result["status"] == "unknown_screen"
        assert STATE_PENDING_DIRECTIVE not in state
        assert "valid_screens" in result


class TestRunAppAction:
    def test_state_keys_stay_in_sync_with_agent_tree(self):
        assert _STATE_PENDING_DIRECTIVE == _tree.STATE_PENDING_DIRECTIVE
        assert _STATE_SCREEN == _tree.STATE_SCREEN

    @pytest.mark.asyncio
    async def test_unknown_action_returns_suggestions(self):
        state: dict = {}
        result = await run_app_action("totally.bogus.action", {}, _tool_context(state))
        assert result["status"] == "unknown_action"
        assert isinstance(result["suggestions"], list)
        assert _STATE_PENDING_DIRECTIVE not in state

    @pytest.mark.asyncio
    async def test_specialist_owned_action_redirects_not_executes(self):
        # email.chat.turn belongs to agent_email; ownership is contract-enforced.
        state: dict = {}
        result = await run_app_action("email.chat.turn", {}, _tool_context(state))
        assert result["status"] == "delegated"
        assert result["use_tool"] == "ask_email_agent"
        assert _STATE_PENDING_DIRECTIVE not in state

    @pytest.mark.asyncio
    async def test_kyc_manual_only_action_is_refused(self):
        # KYC draft approval stays a human action in the app (agent chat lane
        # continues to own the KYC card flow; voice must not trigger it).
        state: dict = {}
        result = await run_app_action("kyc.draft.approve_send", {}, _tool_context(state))
        assert result["status"] == "manual_only"
        assert _STATE_PENDING_DIRECTIVE not in state

    @pytest.mark.asyncio
    async def test_kyc_confirm_required_parks_confirmation_directive(self):
        state: dict = {}
        result = await run_app_action("kyc.draft.reject", {}, _tool_context(state))
        assert result["status"] == "confirm_pending"
        directive = state[_STATE_PENDING_DIRECTIVE]
        assert directive["kind"] == "action"
        assert directive["payload"]["needsConfirmation"] is True

    @pytest.mark.asyncio
    async def test_allow_direct_missing_slot_asks_exactly_one_input(self):
        state: dict = {}
        result = await run_app_action("analysis.start", {}, _tool_context(state))
        assert result["status"] == "input_needed"
        assert result["missing_slot"] == "symbol"
        assert _STATE_PENDING_DIRECTIVE not in state

    @pytest.mark.asyncio
    async def test_allow_direct_with_slots_parks_action_directive(self):
        state: dict = {}
        result = await run_app_action("analysis.start", {"symbol": "NVDA"}, _tool_context(state))
        assert result["status"] == "ok"
        directive = state[_STATE_PENDING_DIRECTIVE]
        assert directive == {
            "kind": "action",
            "payload": {"actionId": "analysis.start", "slots": {"symbol": "NVDA"}},
        }

    @pytest.mark.asyncio
    async def test_route_action_is_direct(self):
        state: dict = {}
        result = await run_app_action("route.consents", {}, _tool_context(state))
        assert result["status"] == "ok"
        assert state[_STATE_PENDING_DIRECTIVE]["payload"]["actionId"] == "route.consents"


class TestListAppActions:
    @pytest.mark.asyncio
    async def test_ranked_results_are_bounded_and_marked(self):
        state = {_STATE_SCREEN: "one_agents"}
        result = await list_app_actions("check my email", _tool_context(state))
        assert result["status"] == "ok"
        assert result["total_actions"] >= 90
        assert 0 < len(result["results"]) <= 10
        by_id = {r["action_id"]: r for r in result["results"]}
        if "email.chat.turn" in by_id:
            assert by_id["email.chat.turn"]["use_tool"] == "ask_email_agent"
