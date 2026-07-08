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
        assert "finance" in tool_names
        assert "ria" in tool_names
        assert {
            "ask_email_agent",
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
        result = await _specialist_turn("agent_email", "what needs a reply", _tool_context({}))
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
                "agent_email", "what needs a reply", _tool_context(state)
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
                "agent_email",
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
