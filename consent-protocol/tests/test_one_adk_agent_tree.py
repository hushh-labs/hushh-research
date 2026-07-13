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

import inspect
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
    STATE_VOICE_CONTEXT,
    _one_runtime_instruction,
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
            "ask_marketplace_agent",
            "ask_connected_systems_agent",
            "ask_consent_agent",
        } <= tool_names
        assert "ask_connections_agent" not in tool_names

    def test_isolated_google_search_uses_the_text_model(self):
        agent = build_one_root_agent()
        search_tool = next(
            tool for tool in agent.tools if getattr(tool, "name", "") == "google_search"
        )
        # ADK executes bypassed Google Search in a nested text GenerateContent
        # turn. It must never inherit One's native-audio Live model.
        assert search_tool.model == _tree._SPECIALIST_MODEL

    def test_identity_instruction_answers_name_question(self):
        assert "I'm One" in ONE_IDENTITY_INSTRUCTION
        assert "Never call yourself Kai" in ONE_IDENTITY_INSTRUCTION
        assert "Visible controls take priority over introductions" in ONE_IDENTITY_INSTRUCTION
        assert "list_app_actions" in ONE_IDENTITY_INSTRUCTION
        assert "correlated app action settlement" in ONE_IDENTITY_INSTRUCTION
        assert "Conversation comes before workflow" in ONE_IDENTITY_INSTRUCTION
        assert "so what?" in ONE_IDENTITY_INSTRUCTION
        assert "Use your intelligence in the current turn" in ONE_IDENTITY_INSTRUCTION
        assert "it is not semantic authority" in ONE_IDENTITY_INSTRUCTION
        assert "Deterministic policy may validate" in ONE_IDENTITY_INSTRUCTION

    def test_runtime_instruction_injects_only_the_active_route_playbook(self):
        instruction = _one_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_VOICE_CONTEXT: {
                        "route_playbook": {
                            "purpose": "Welcome the person on the current root screen.",
                            "entry_cue": "Say Claim your One.",
                            "primary_action_id": "onboarding.claim_one",
                            "completion_boundary": "Wait for browser settlement.",
                            "out_of_scope_behavior": "Answer naturally.",
                        },
                        "available_action_ids": ["auth.open_terms"],
                    }
                }
            )
        )

        assert ONE_IDENTITY_INSTRUCTION in instruction
        assert "onboarding.claim_one" in instruction
        assert "ACTIVE ROUTE PLAYBOOK" in instruction
        assert "Terms => auth.open_terms" in instruction
        assert "Do not call open_screen" in instruction
        assert "First assess meaning semantically" in instruction

    def test_runtime_instruction_prioritizes_top_modal_layer(self):
        instruction = _one_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_VOICE_CONTEXT: {
                        "route_playbook": {
                            "purpose": "Sign in with a verified provider.",
                            "primary_action_id": "auth.sign_in_apple",
                        },
                        "available_action_ids": [
                            "auth.sign_in_apple",
                            "auth.sign_in_google",
                            "auth.close_legal",
                        ],
                        "ui": {
                            "interaction_layer": {
                                "layer_id": "login_terms",
                                "kind": "legal",
                                "modality": "modal",
                                "lifecycle_state": "open",
                                "dismiss_action_id": "auth.close_legal",
                                "visible_action_ids": ["auth.close_legal"],
                                "visible_control_ids": ["auth_close_legal"],
                                "options": [],
                                "underlying_actions_available": False,
                                "agent_continuity": "interactive",
                            },
                        },
                    }
                }
            )
        )

        assert "ACTIVE INTERACTION LAYER" in instruction
        assert "strongest current context" in instruction
        assert "Close legal document => auth.close_legal" in instruction
        assert "Do not offer or execute controls behind this layer" in instruction
        assert "Continue with Apple => auth.sign_in_apple" not in instruction
        assert "Continue with Google => auth.sign_in_google" not in instruction
        assert "Never claim success until the correlated browser settlement" in instruction

    def test_runtime_instruction_keeps_exact_provider_actions_intelligence_driven(self):
        instruction = _one_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_VOICE_CONTEXT: {
                        "available_action_ids": [
                            "auth.sign_in_apple",
                            "auth.sign_in_google",
                        ],
                    }
                }
            )
        )

        assert "Continue with Apple => auth.sign_in_apple" in instruction
        assert "Continue with Google => auth.sign_in_google" in instruction
        assert "clear provider request selects its exact Apple or Google action" in instruction
        assert "list_app_actions only to retrieve bounded candidates" in instruction
        assert "genuinely ambiguous" in instruction

    def test_onboarding_tool_accepts_typed_assessment_not_raw_request(self):
        signature = inspect.signature(_tree.resolve_onboarding_goal)
        assert "request" not in signature.parameters
        assert {
            "intent",
            "candidate_action_id",
            "provider",
            "missing_input",
            "ambiguous",
            "confidence",
        } <= set(signature.parameters)

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
    async def test_route_admission_allows_only_the_declared_specialist(self):
        turn = SpecialistTurnResult(
            conversation_id="conv_route",
            text="Location is ready.",
            directive=None,
            is_complete=True,
            state_changed=False,
            model="test",
        )
        state = {
            STATE_USER_ID: "u1",
            STATE_CONSENT_TOKEN: "tok",
            "hussh:voice_context": {"route_family": "/one/location"},
        }
        with patch("hushh_mcp.one_adk.agent_tree.dispatch", new=AsyncMock(return_value=turn)):
            result = await _specialist_turn(
                "agent_location", "share location", _tool_context(state)
            )
        assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_route_admission_blocks_specialist_outside_declared_workspace(self):
        state = {
            STATE_USER_ID: "u1",
            STATE_CONSENT_TOKEN: "tok",
            "hussh:voice_context": {"route_family": "/profile"},
        }
        with patch("hushh_mcp.one_adk.agent_tree.dispatch", new=AsyncMock()) as dispatch:
            result = await _specialist_turn(
                "agent_location", "share location", _tool_context(state)
            )
        assert result["status"] == "route_not_admitted"
        dispatch.assert_not_awaited()

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

    @pytest.mark.asyncio
    async def test_refuses_legacy_navigation_during_a_live_setup_session(self):
        state = {
            STATE_VOICE_CONTEXT: {
                "route_family": "/one/setup/gmail",
                "available_action_ids": ["setup.connect_gmail"],
            }
        }
        result = await open_screen("profile", _tool_context(state))

        assert result["status"] == "action_required"
        assert STATE_PENDING_DIRECTIVE not in state


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
    async def test_provider_popup_requires_exact_trusted_activation_action(self):
        state = {
            _STATE_SCREEN: "login",
            "hussh:voice_context": {
                "available_action_ids": ["auth.sign_in_apple", "auth.sign_in_google"],
            },
        }
        result = await run_app_action("auth.sign_in_apple", {}, _tool_context(state))
        assert result["status"] == "confirm_pending"
        directive = state[_STATE_PENDING_DIRECTIVE]
        assert directive["payload"] == {
            "actionId": "auth.sign_in_apple",
            "slots": {},
            "needsConfirmation": True,
            "trustedActivationRequired": True,
        }

    @pytest.mark.asyncio
    async def test_allow_direct_missing_slot_asks_exactly_one_input(self):
        state: dict = {}
        result = await run_app_action("analysis.start", {}, _tool_context(state))
        assert result["status"] == "input_needed"
        assert result["missing_slot"] == "symbol"
        assert _STATE_PENDING_DIRECTIVE not in state

    @pytest.mark.asyncio
    async def test_live_context_refuses_action_not_declared_available(self):
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["route.profile"],
            }
        }
        result = await run_app_action("analysis.start", {"symbol": "NVDA"}, _tool_context(state))
        assert result["status"] == "action_unavailable"
        assert _STATE_PENDING_DIRECTIVE not in state

    @pytest.mark.asyncio
    async def test_root_claim_is_available_only_on_the_public_intro_screen(self):
        state = {
            _STATE_SCREEN: "one_intro",
            "hussh:voice_context": {
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        result = await run_app_action("onboarding.claim_one", {}, _tool_context(state))
        assert result["status"] == "ok"
        assert state[_STATE_PENDING_DIRECTIVE]["payload"]["actionId"] == "onboarding.claim_one"

        state = {
            _STATE_SCREEN: "login",
            "hussh:voice_context": {
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        result = await run_app_action("onboarding.claim_one", {}, _tool_context(state))
        assert result["status"] == "wrong_screen"
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
