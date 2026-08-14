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
    _STATE_GOAL_RUN,
    _STATE_PENDING_DIRECTIVE,
    _STATE_SCREEN,
    _directive_flags,
    _is_journey_startable,
    _journey_slots,
    _navigation_journey_definition,
    continue_app_goal,
    list_app_actions,
    run_app_action,
    start_app_goal,
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
    ask_consent_agent,
    build_one_intro_text_agent,
    build_one_root_agent,
    build_one_text_agent,
    get_one_runner,
    open_screen,
)
from hushh_mcp.services.action_gateway import get_action_gateway_action, list_action_gateway_actions
from hushh_mcp.services.live_voice_context import (
    clear_live_voice_context,
    publish_live_voice_context,
    read_live_voice_context,
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
            "ask_location_agent",
            "ask_connected_systems_agent",
            "ask_consent_agent",
            "calendar_summary",
            "calendar_events",
            "calendar_availability",
            "calendar_free_slots",
            "propose_calendar_event",
            "propose_calendar_reschedule",
            "propose_calendar_cancellation",
        } <= tool_names
        assert "ask_connections_agent" not in tool_names
        assert "ask_gmail_agent" not in tool_names

    def test_pre_vault_head_has_only_semantic_navigation_authority(self):
        agent = build_one_intro_text_agent()
        tool_names = {
            getattr(tool, "name", getattr(tool, "__name__", type(tool).__name__))
            for tool in agent.tools
        }

        assert agent.name == "one_intro"
        assert tool_names == {"run_intro_navigation_action", "list_intro_navigation_actions"}
        assert "do not force a workflow" in agent.instruction

    def test_isolated_google_search_uses_the_text_model(self):
        agent = build_one_root_agent()
        search_tool = next(
            tool for tool in agent.tools if getattr(tool, "name", "") == "google_search"
        )
        # ADK executes bypassed Google Search in a nested text GenerateContent
        # turn. It must never inherit One's native-audio Live model.
        assert search_tool.agent.model.model == _tree._SPECIALIST_MODEL
        assert search_tool.propagate_grounding_metadata is True

    def test_text_runtime_propagates_turn_model_to_finance_and_investor(self):
        from google.adk.models import Gemini

        turn_model = Gemini(
            model="gemini-turn-local",
            client_kwargs={"api_key": "turn-local-test-key"},
        )

        agent = build_one_text_agent(model=turn_model)
        finance_tool = next(tool for tool in agent.tools if getattr(tool, "name", "") == "finance")
        investor_tool = next(
            tool for tool in finance_tool.agent.tools if getattr(tool, "name", "") == "investor"
        )

        assert agent.model is turn_model
        assert finance_tool.agent.model is turn_model
        assert investor_tool.agent.model is turn_model

    def test_byok_live_registry_rejects_models_without_mid_session_content(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("HUSHH_GEMINI_BYOK_LIVE_ENABLED", "true")
        monkeypatch.setattr(_tree, "_BYOK_LIVE_MODEL", "gemini-3.1-flash-live-preview")
        with pytest.raises(ValueError, match="byok_live_unsupported"):
            _tree.build_one_live_runner(
                runtime_mode="byok",
                runtime_credential="test-key",
            )

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
        assert "KYC app surface" in ONE_IDENTITY_INSTRUCTION
        assert "Gmail receipt sync is paused" in ONE_IDENTITY_INSTRUCTION
        assert "named CRM" in ONE_IDENTITY_INSTRUCTION
        assert "summon that specialist" in ONE_IDENTITY_INSTRUCTION

    def test_identity_instruction_carries_persona_grounding(self):
        # Durable north-star + principle grounding is folded into the shared
        # identity string, so it reaches BOTH the text and Live heads.
        assert "Hussh Principle" in ONE_IDENTITY_INSTRUCTION
        assert "work for the person whose life it touches" in ONE_IDENTITY_INSTRUCTION
        assert "Your four motions" in ONE_IDENTITY_INSTRUCTION
        for motion in ("Listen:", "Remember:", "Decide:", "Act:"):
            assert motion in ONE_IDENTITY_INSTRUCTION
        # Four non-negotiables.
        assert "BYOK" in ONE_IDENTITY_INSTRUCTION
        assert "Consent-first" in ONE_IDENTITY_INSTRUCTION
        assert "Tri-flow parity" in ONE_IDENTITY_INSTRUCTION
        # Authoritative registry-sourced roster catalog.
        assert "YOUR SPECIALISTS" in ONE_IDENTITY_INSTRUCTION
        assert "Kai Financial Agent" in ONE_IDENTITY_INSTRUCTION
        assert "agent.kai.analyze" in ONE_IDENTITY_INSTRUCTION

    def test_persona_grounding_reaches_both_heads(self):
        # The persona reaches a head iff that head's instruction provider is the
        # shared _one_runtime_instruction, which always begins from
        # ONE_IDENTITY_INSTRUCTION. Assert both heads wire that provider (via
        # source, so this does not depend on constructing the Live model) and
        # that the provider carries the persona on a bare context.
        marker = "YOUR SPECIALISTS"
        assert marker in _one_runtime_instruction(SimpleNamespace(state={}))
        for builder in (build_one_root_agent, build_one_text_agent):
            assert "instruction=_one_runtime_instruction" in inspect.getsource(builder)

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

    def test_finance_instruction_distinguishes_an_unlocked_empty_portfolio(self):
        token = "owner-token-must-never-reach-the-model"
        instruction = _tree._finance_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_CONSENT_TOKEN: token,
                    STATE_VOICE_CONTEXT: {
                        "vault_ready": True,
                        "portfolio_ready": False,
                    },
                }
            )
        )

        assert "no portfolio has been configured or imported" in instruction
        assert "Do not ask the user to unlock" in instruction
        assert token not in instruction

    def test_finance_instruction_requires_unlock_only_when_runtime_reports_locked(self):
        instruction = _tree._finance_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_VOICE_CONTEXT: {
                        "vault_ready": False,
                        "portfolio_ready": False,
                    }
                }
            )
        )

        assert "unlocking is required for protected information" in instruction

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
    async def test_connected_systems_unavailable_result_is_user_grounded(self):
        result = await _specialist_turn(
            "agent_connected_systems",
            "take me to xyz CRM",
            _tool_context({STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "t1"}),
        )
        assert result["status"] == "authority_required"
        assert result["reason"] == "exact_a2a_authority_required"
        assert result["availability"] == {
            "schema_version": "specialist_availability.v1",
            "specialist_id": "agent_connected_systems",
            "state": "authority_required",
            "reason_code": "exact_a2a_authority_required",
            "context_revision": None,
            "admitted_action_ids": [],
        }
        assert "task-specific authority" in result["message"]

    @pytest.mark.asyncio
    async def test_consent_tool_uses_ones_typed_selection_for_navs_connections_child(self):
        # An OPEN question, deliberately. "Please show my trusted people" sat
        # here and now redirects to `connect.open_people`, which is the better
        # outcome -- someone asking to see their people wants the list, not a
        # description of it. This phrase keeps the typed-selection contract
        # under test without also pinning the old lane for a request that has
        # an authored action.
        context = _tool_context({STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "tok"})
        with patch(
            "hushh_mcp.one_adk.agent_tree._specialist_turn",
            new=AsyncMock(return_value={"status": "authority_required"}),
        ) as specialist_turn:
            result = await ask_consent_agent(
                "How does trust work here?",
                context,
                target="connections",
            )

        assert result["status"] == "authority_required"
        assert specialist_turn.await_args.args[:2] == (
            "agent_connections",
            "How does trust work here?",
        )

    @pytest.mark.asyncio
    async def test_a_named_request_never_reaches_the_specialist_at_all(self):
        """The redirect is a hard block, not advice the model may decline.

        Guidance was tried first and did not hold: One was told specialists
        validate consent, obeyed, and turned a doable request into a
        permissions refusal. `_specialist_turn` must not even be awaited.
        """
        context = _tool_context({STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "tok"})
        with patch(
            "hushh_mcp.one_adk.agent_tree._specialist_turn",
            new=AsyncMock(return_value={"status": "authority_required"}),
        ) as specialist_turn:
            result = await ask_consent_agent(
                "can you connect me with ankit",
                context,
                target="connections",
            )

        specialist_turn.assert_not_awaited()
        assert result["status"] == "use_journey"
        assert result["action_id"] == "connect.send_request"
        assert result["goal_id"] == "goal.connect.send_request"
        # Tells One what to call instead. A refusal with no next step is one it
        # answers by apologising about permissions, which is the whole bug.
        assert "start_app_goal" in result["message"]

    @pytest.mark.asyncio
    async def test_the_redirect_cannot_reroute_between_specialists(self):
        """Words decide the LANE, never which specialist gets the request.

        `consent` must keep reaching Nav even when the words look like
        connections work, or this becomes exactly the word-sniffing subagent
        selection the typed-target design exists to prevent.
        """
        context = _tool_context({STATE_USER_ID: "u1", STATE_CONSENT_TOKEN: "tok"})
        with patch(
            "hushh_mcp.one_adk.agent_tree._specialist_turn",
            new=AsyncMock(return_value={"status": "ok"}),
        ) as specialist_turn:
            await ask_consent_agent(
                "connect me with ankit",
                context,
                target="consent",
            )

        # agent_nav declares no authored action surfaces, so it is never
        # redirected and never swapped for agent_connections.
        assert specialist_turn.await_args.args[0] == "agent_nav"

    @pytest.mark.asyncio
    async def test_location_setup_returns_recovery_without_specialist_dispatch(self):
        result = await _specialist_turn(
            "agent_location",
            "share my location",
            _tool_context(
                {
                    STATE_USER_ID: "u1",
                    STATE_CONSENT_TOKEN: "t1",
                    STATE_VOICE_CONTEXT: {
                        "screen": "one_setup_location",
                        "route_family": "/one/setup/location",
                        "context_revision": "setup:1",
                        "onboarding": {
                            "phase": "capability_setup",
                            "active_capability": "location",
                        },
                    },
                }
            ),
        )
        assert result["status"] == "setup_required"
        assert result["reason"] == "location_setup_incomplete"
        assert result["availability"]["context_revision"] == "setup:1"

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
    async def test_route_admission_allows_intent_routing_from_any_route(self):
        # One is the single routing authority: a wired, consent-bearing
        # specialist is admitted from any conversational screen, even one that
        # does not declare it (here /profile). Consent + TrustLink still gate the
        # call inside the specialist.
        turn = SpecialistTurnResult(
            conversation_id="conv_admit",
            text="Location is ready.",
            directive=None,
            is_complete=True,
            state_changed=False,
            model="test",
        )
        state = {
            STATE_USER_ID: "u1",
            STATE_CONSENT_TOKEN: "tok",
            "hussh:voice_context": {"route_family": "/profile"},
        }
        with patch("hushh_mcp.one_adk.agent_tree.dispatch", new=AsyncMock(return_value=turn)):
            result = await _specialist_turn(
                "agent_location", "share location", _tool_context(state)
            )
        assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_route_admission_blocks_only_transitional_redirect_stubs(self):
        # Redirect/OAuth-return/logout stubs are the sole explicit opt-out; the
        # user is mid-flow there and never actually converses.
        state = {
            STATE_USER_ID: "u1",
            STATE_CONSENT_TOKEN: "tok",
            "hussh:voice_context": {"route_family": "/logout"},
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
        assert state[f"{STATE_PENDING_DIRECTIVE}:agent_location_specialist"] == result["directive"]

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
        assert result["status"] == "runtime_unavailable"
        assert result["reason"] == "specialist_runtime_failed"
        assert "boom" not in result["message"]


class TestOpenScreen:
    @pytest.mark.asyncio
    async def test_navigates_to_known_screen(self):
        state: dict = {}
        result = await open_screen("profile", _tool_context(state))
        assert result["status"] == "ok"
        assert result["route"] == "/profile"
        assert state[f"{STATE_PENDING_DIRECTIVE}:profile"] == {
            "kind": "navigate",
            "payload": {"route": "/profile", "screen": "profile"},
        }

    @pytest.mark.asyncio
    async def test_normalizes_screen_names(self):
        state: dict = {}
        result = await open_screen("Connected Systems", _tool_context(state))
        assert result["status"] == "ok"
        assert result["route"] == APP_ROUTES["connected_systems"]
        assert state[f"{STATE_PENDING_DIRECTIVE}:connected_systems"] == {
            "kind": "navigate",
            "payload": {
                "route": APP_ROUTES["connected_systems"],
                "screen": "connected_systems",
            },
        }

    @pytest.mark.asyncio
    async def test_refuses_unknown_screen(self):
        state: dict = {}
        result = await open_screen("admin_panel", _tool_context(state))
        assert result["status"] == "unknown_screen"
        assert not any(k.startswith(f"{STATE_PENDING_DIRECTIVE}:") for k in state)
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
        assert not any(k.startswith(f"{STATE_PENDING_DIRECTIVE}:") for k in state)


class TestRunAppAction:
    def test_state_keys_stay_in_sync_with_agent_tree(self):
        assert _STATE_PENDING_DIRECTIVE == _tree.STATE_PENDING_DIRECTIVE
        assert _STATE_SCREEN == _tree.STATE_SCREEN

    @pytest.mark.asyncio
    async def test_unknown_action_never_infers_a_fallback(self):
        state: dict = {}
        result = await run_app_action("totally.bogus.action", {}, _tool_context(state))
        assert result["status"] == "unknown_action"
        assert "suggestions" not in result
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_unwired_specialist_action_is_not_advertised_as_executable(self):
        # Email requires task-bound information authority at ingress. Until
        # that broker exists, the generated contract must fail closed instead
        # of redirecting One into an unavailable specialist tool.
        state: dict = {}
        result = await run_app_action("email.chat.turn", {}, _tool_context(state))
        assert result["status"] == "unwired"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_kyc_manual_only_action_is_refused(self):
        # KYC draft approval stays a human action in the app (agent chat lane
        # continues to own the KYC card flow; voice must not trigger it).
        state: dict = {}
        result = await run_app_action("kyc.draft.approve_send", {}, _tool_context(state))
        assert result["status"] == "manual_only"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_kyc_confirm_required_stays_unwired_without_selected_workflow(self):
        state: dict = {}
        result = await run_app_action("kyc.draft.reject", {}, _tool_context(state))
        assert result["status"] == "unwired"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

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
        directive = state[f"{_STATE_PENDING_DIRECTIVE}:auth.sign_in_apple"]
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
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_live_context_refuses_action_not_declared_available(self):
        # A non-journey control that is not on the current screen stays a hard
        # refusal: run_app_action must never execute an unmounted control.
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["route.profile"],
            }
        }
        result = await run_app_action("analysis.open_debate_tab", {}, _tool_context(state))
        assert result["status"] == "action_unavailable"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_offscreen_journey_entry_redirects_to_start_app_goal(self):
        # A journey entry action is off-screen but NOT out of reach:
        # start_app_goal navigates to its authored destination first. It still
        # must not execute anything here -- only name the tool that can.
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["route.profile"],
            }
        }
        result = await run_app_action("analysis.start", {"symbol": "NVDA"}, _tool_context(state))
        assert result["status"] == "use_start_app_goal"
        assert "start_app_goal" in result["message"]
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_navigation_action_is_parked_even_when_not_in_screen_inventory(self):
        # Cross-screen navigation ("go to profile") must work from any
        # screen; the per-screen inventory does not bound route.* actions.
        #
        # It parks READY TO RUN now rather than awaiting a confirmation. The
        # confirmation was never this test's subject -- reachability was --
        # and route.profile is allow_direct, so asking before moving a tab was
        # the blanket policy talking, not the contract.
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["analysis.start"],
            }
        }
        result = await run_app_action("route.profile", {}, _tool_context(state))
        assert result["status"] == "ready_to_run"
        assert (
            state[f"{_STATE_PENDING_DIRECTIVE}:route.profile"]["payload"]["actionId"]
            == "route.profile"
        )

    @pytest.mark.asyncio
    async def test_pending_settlement_holds_the_next_action(self):
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["analysis.start"],
                "pending_settlement": True,
            }
        }
        result = await run_app_action("analysis.start", {"symbol": "NVDA"}, _tool_context(state))
        assert result["status"] == "settling"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_context_pending_marker_reports_recoverable_not_ready(self):
        # The live relay seeds this marker before the first app_context frame
        # arrives; the tool must report a retryable status, not a refusal.
        state = {"hussh:voice_context": {"context_pending": True}}
        result = await run_app_action("analysis.start", {"symbol": "NVDA"}, _tool_context(state))
        assert result["status"] == "context_not_ready"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_root_claim_is_available_only_on_the_public_intro_screen(self):
        state = {
            _STATE_SCREEN: "one_intro",
            "hussh:voice_context": {
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        result = await run_app_action("onboarding.claim_one", {}, _tool_context(state))
        # allow_direct, so it parks ready. The screen guard below is what this
        # test is actually about, and it is unchanged.
        assert result["status"] == "ready_to_run"
        assert (
            state[f"{_STATE_PENDING_DIRECTIVE}:onboarding.claim_one"]["payload"]["actionId"]
            == "onboarding.claim_one"
        )

        state = {
            _STATE_SCREEN: "login",
            "hussh:voice_context": {
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        result = await run_app_action("onboarding.claim_one", {}, _tool_context(state))
        assert result["status"] == "wrong_screen"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_allow_direct_with_slots_parks_action_directive(self):
        state: dict = {}
        result = await run_app_action("analysis.start", {"symbol": "NVDA"}, _tool_context(state))
        assert result["status"] == "ready_to_run"
        directive = state[f"{_STATE_PENDING_DIRECTIVE}:analysis.start"]
        # The stamped flags are the contract's answer, not a constant. This is
        # the value the browser reads to decide whether to raise a card, so the
        # two halves of the invariant meet here: if this pair stops matching
        # `execution_policy`, an action runs that should have been confirmed,
        # or settles against a confirmation that never came.
        assert directive == {
            "kind": "action",
            "payload": {
                "actionId": "analysis.start",
                "slots": {"symbol": "NVDA"},
                "needsConfirmation": False,
                "trustedActivationRequired": False,
            },
        }

    @pytest.mark.asyncio
    async def test_route_action_parks_ready_to_run(self):
        # Renamed from ..._requires_confirmation. Opening the consent centre is
        # allow_direct; asking "allow access to run this" before moving to a
        # screen taught people to approve without reading, which is how a
        # confirmation stops being consent.
        state: dict = {}
        result = await run_app_action("route.consents", {}, _tool_context(state))
        assert result["status"] == "ready_to_run"
        assert (
            state[f"{_STATE_PENDING_DIRECTIVE}:route.consents"]["payload"]["actionId"]
            == "route.consents"
        )


class TestSettledActionJourneys:
    def test_every_generated_action_has_one_consistent_voice_boundary(self):
        """All journeys consume these flags, never their own local policy.

        Confirmation is off. Voice does not ask, because being asked "are you
        sure?" after saying the thing out loud is what people find most tiring
        about talking to this app, and a spoken yes to a question One just
        asked carries nothing the original sentence did not. That is a product
        decision, made explicitly.

        `trusted_activation_required` is the one survivor and is a different
        kind of thing entirely: those four actions open a browser popup, which
        platforms allow only during a fresh user gesture. Dropping it would
        break sign-in rather than streamline it.
        """
        confirming = 0
        for entry in list_action_gateway_actions():
            flags = _directive_flags(entry)
            trusted = entry.get("activation_policy") == "trusted_activation_required"
            assert flags["needsConfirmation"] is trusted, entry["action_id"]
            assert flags["trustedActivationRequired"] is trusted, entry["action_id"]
            confirming += 1 if flags["needsConfirmation"] else 0
        # Small and deliberate: the two account sign-ins plus the two Google
        # service connection flows. If this grows, someone has reintroduced
        # asking by authoring an activation policy rather than by deciding to.
        assert confirming == 4

    @pytest.mark.asyncio
    async def test_high_risk_location_share_runs_without_asking(self):
        """Even the highest-risk share no longer stops to ask.

        This test asserted the opposite until confirmation was removed
        product-wide. Renamed rather than deleted, because the change of mind
        is the interesting part: sharing a live location is the most
        consequential thing this surface does, and it now runs on the sentence
        alone.

        What carries the safety instead is one step earlier and narrower.
        `location.select_share_recipient` resolves exactly one named person or
        refuses, naming the candidates when a name is ambiguous, and speaks
        the MATCHED name back before anything is sent. The check moved from
        "are you sure?" to "did I hear the right person?", which is the
        question that was ever actually load-bearing.
        """
        state = {
            _STATE_SCREEN: "one_location",
            "hussh:voice_context": {
                "route_pattern": "/one/location",
                "screen": "one_location",
                "context_revision": "location-2",
                "available_action_ids": ["location.share_selected"],
            },
        }

        result = await run_app_action(
            "location.share_selected",
            {"duration_hours": "0.25"},
            _tool_context(state),
        )

        assert result["status"] == "ready_to_run"
        payload = state[f"{_STATE_PENDING_DIRECTIVE}:location.share_selected"]["payload"]
        assert payload["needsConfirmation"] is False
        assert payload["trustedActivationRequired"] is False

    @pytest.mark.asyncio
    async def test_location_named_share_journey_stamps_safe_flags_on_both_steps(self):
        state = {
            _STATE_SCREEN: "one_agents",
            "hussh:voice_context": {
                "route_pattern": "/one",
                "screen": "one_agents",
                "context_revision": "source-1",
                "available_action_ids": ["route.profile"],
            },
        }

        started = await start_app_goal(
            "location.select_share_recipient",
            {"person": "Sarah"},
            _tool_context(state),
        )

        assert started["status"] == "navigation_started"
        escort = state[f"{_STATE_PENDING_DIRECTIVE}:goal:{started['goal_id']}"]["payload"]
        # The COMPOSER, not Location's front door. `location.open_now` opens
        # /one/location, where the recipient search box is not mounted -- so
        # the journey arrived somewhere the handler had nothing to act on and
        # the match never ran. Observed live: One opened Location home, then
        # spoke about a recipient it had never resolved.
        assert escort["actionId"] == "location.open_share"
        assert escort["needsConfirmation"] is False
        assert escort["trustedActivationRequired"] is False

        state[_STATE_SCREEN] = "one_location"
        state["hussh:voice_context"] = {
            "route_pattern": "/one/location",
            "screen": "one_location",
            "context_revision": "location-2",
            "available_action_ids": ["location.select_share_recipient"],
        }
        continued = await continue_app_goal(_tool_context(state))

        assert continued["status"] == "preview_started"
        select = state[f"{_STATE_PENDING_DIRECTIVE}:goal:{started['goal_id']}:preview"]["payload"]
        assert select["actionId"] == "location.select_share_recipient"
        assert select["needsConfirmation"] is False
        assert select["trustedActivationRequired"] is False

    @pytest.mark.asyncio
    async def test_connect_spoken_search_navigates_then_runs_hands_free(self):
        """A spoken name remains attached through the fresh Connect context."""
        state = {
            _STATE_SCREEN: "one_agents",
            "hussh:voice_context": {
                "route_pattern": "/one",
                "screen": "one_agents",
                "context_revision": "source-1",
                "available_action_ids": ["route.profile"],
            },
        }

        started = await start_app_goal(
            "connect.search_people",
            {"person": "Avery"},
            _tool_context(state),
        )

        assert started["status"] == "navigation_started"
        escort = state[f"{_STATE_PENDING_DIRECTIVE}:goal:{started['goal_id']}"]["payload"]
        assert escort["needsConfirmation"] is False
        assert escort["trustedActivationRequired"] is False

        state[_STATE_SCREEN] = "connect"
        state["hussh:voice_context"] = {
            "route_pattern": "/one/connect",
            "screen": "connect",
            "context_revision": "connect-2",
            "available_action_ids": ["connect.search_people"],
        }
        continued = await continue_app_goal(_tool_context(state))

        assert continued["status"] == "preview_started"
        search = state[f"{_STATE_PENDING_DIRECTIVE}:goal:{started['goal_id']}:preview"]["payload"]
        assert search["actionId"] == "connect.search_people"
        assert search["slots"] == {"person": "Avery"}
        assert search["needsConfirmation"] is False
        assert search["trustedActivationRequired"] is False

    @pytest.mark.asyncio
    async def test_connect_request_runs_on_arrival_without_asking(self):
        """The escort still navigates first; it just no longer stops to ask.

        Asserted a confirmation until confirmation was removed product-wide.
        The half worth keeping is the ORDER: the escort step carries no
        confirmation and the request step is minted only after arriving on
        Connect, so a request is never issued from a screen that cannot show
        who it is going to.
        """
        state = {
            _STATE_SCREEN: "one_agents",
            "hussh:voice_context": {
                "route_pattern": "/one",
                "screen": "one_agents",
                "context_revision": "source-1",
                "available_action_ids": ["route.profile"],
            },
        }

        started = await start_app_goal(
            "connect.send_request",
            {"person": "Avery"},
            _tool_context(state),
        )
        escort = state[f"{_STATE_PENDING_DIRECTIVE}:goal:{started['goal_id']}"]["payload"]
        assert escort["needsConfirmation"] is False

        state[_STATE_SCREEN] = "connect"
        state["hussh:voice_context"] = {
            "route_pattern": "/one/connect",
            "screen": "connect",
            "context_revision": "connect-2",
            "available_action_ids": ["connect.send_request"],
        }
        continued = await continue_app_goal(_tool_context(state))

        assert continued["status"] == "preview_started"
        request = state[f"{_STATE_PENDING_DIRECTIVE}:goal:{started['goal_id']}:preview"]["payload"]
        assert request["actionId"] == "connect.send_request"
        assert request["needsConfirmation"] is False
        assert request["trustedActivationRequired"] is False

    @pytest.mark.asyncio
    async def test_same_context_revision_cannot_continue_a_claim_journey(self):
        state = {
            _STATE_SCREEN: "one_intro",
            "hussh:voice_context": {
                "route_pattern": "/",
                "screen": "one_intro",
                "context_revision": "root-1",
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        await start_app_goal(
            "onboarding.claim_one",
            {"deferred_action_id": "auth.sign_in_google"},
            _tool_context(state),
        )
        state[_STATE_SCREEN] = "login"
        state["hussh:voice_context"] = {
            "route_pattern": "/login",
            "screen": "login",
            "context_revision": "root-1",
            "available_action_ids": ["auth.sign_in_google", "auth.sign_in_apple"],
        }

        result = await continue_app_goal(_tool_context(state))

        assert result["status"] == "settling"
        assert state[_STATE_GOAL_RUN]["deferred_action_id"] == "auth.sign_in_google"
        assert f"{_STATE_PENDING_DIRECTIVE}:auth.sign_in_google" not in state

    @pytest.mark.asyncio
    async def test_plain_claim_asks_for_provider_only_after_login_context(self):
        state = {
            _STATE_SCREEN: "one_intro",
            "hussh:voice_context": {
                "route_pattern": "/",
                "screen": "one_intro",
                "context_revision": "root-1",
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        started = await start_app_goal("onboarding.claim_one", {}, _tool_context(state))
        assert started["status"] == "journey_started"
        assert state[_STATE_GOAL_RUN]["deferred_action_id"] is None

        state[_STATE_SCREEN] = "login"
        state["hussh:voice_context"] = {
            "route_pattern": "/login",
            "screen": "login",
            "context_revision": "login-2",
            "available_action_ids": ["auth.sign_in_google", "auth.sign_in_apple"],
        }
        continued = await continue_app_goal(_tool_context(state))

        assert continued == {
            "status": "choice_needed",
            "message": "The destination is ready. Ask the person to choose one available option.",
            "action_ids": ["auth.sign_in_apple", "auth.sign_in_google"],
        }
        assert state[_STATE_GOAL_RUN] is None

    @pytest.mark.asyncio
    async def test_claim_one_defers_google_until_login_context_is_fresh(self):
        state = {
            _STATE_SCREEN: "one_intro",
            "hussh:voice_context": {
                "route_pattern": "/",
                "screen": "one_intro",
                "context_revision": "root-1",
                "available_action_ids": ["onboarding.claim_one"],
            },
        }

        started = await start_app_goal(
            "onboarding.claim_one",
            {"deferred_action_id": "auth.sign_in_google"},
            _tool_context(state),
        )

        assert started["status"] == "journey_started"
        directive = state[f"{_STATE_PENDING_DIRECTIVE}:onboarding.claim_one"]
        assert directive["payload"]["actionId"] == "onboarding.claim_one"
        assert directive["payload"]["goalRun"]["deferred_action_id"] == "auth.sign_in_google"
        assert "auth.sign_in_google" not in directive["payload"]["slots"]

        state[_STATE_SCREEN] = "login"
        state["hussh:voice_context"] = {
            "route_pattern": "/login",
            "screen": "login",
            "context_revision": "login-2",
            "available_action_ids": ["auth.sign_in_google", "auth.sign_in_apple"],
        }
        continued = await continue_app_goal(_tool_context(state))

        assert continued["status"] == "confirm_pending"
        assert state[_STATE_GOAL_RUN] is None
        provider_directive = state[f"{_STATE_PENDING_DIRECTIVE}:auth.sign_in_google"]
        assert provider_directive["payload"] == {
            "actionId": "auth.sign_in_google",
            "slots": {},
            "needsConfirmation": True,
            "trustedActivationRequired": True,
        }

    @pytest.mark.asyncio
    async def test_destination_mismatch_clears_a_carried_choice(self):
        state = {
            _STATE_SCREEN: "one_intro",
            "hussh:voice_context": {
                "route_pattern": "/",
                "screen": "one_intro",
                "context_revision": "root-1",
                "available_action_ids": ["onboarding.claim_one"],
            },
        }
        await start_app_goal(
            "onboarding.claim_one",
            {"deferred_action_id": "auth.sign_in_google"},
            _tool_context(state),
        )
        state[_STATE_SCREEN] = "one_intro"
        state["hussh:voice_context"] = {
            "route_pattern": "/",
            "screen": "one_intro",
            "context_revision": "root-2",
            "available_action_ids": ["onboarding.claim_one"],
        }

        result = await continue_app_goal(_tool_context(state))

        assert result["status"] == "journey_interrupted"
        assert state[_STATE_GOAL_RUN] is None
        assert f"{_STATE_PENDING_DIRECTIVE}:auth.sign_in_google" not in state


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


class TestContractDrivenNavigationJourneys:
    """The navigate-then-execute journey must be authored, not hardcoded.

    This path used to be a literal ``if action_id != "analysis.start"``, so the
    app could hold exactly one cross-screen journey no matter how many the
    contracts declared. These pin the shape that replaced it.
    """

    def test_analysis_journey_is_resolved_entirely_from_its_contract(self):
        entry = get_action_gateway_action("analysis.start")
        journey = _navigation_journey_definition(entry, "analysis.start")

        assert journey == {
            "goal_id": "goal.analysis.start_debate",
            "destination_route": "/one/kai?tab=analysis",
            "destination_screen": "kai_analysis",
            "navigation_action_id": "route.kai_analysis",
            "label": "Open stock analysis preview",
        }

    def test_a_second_journey_needs_no_code_change(self):
        # Same authored shape, entirely different feature. Nothing about this
        # action exists in the runtime -- if it resolves, the path is generic.
        entry = {
            "action_id": "pkm.capture_note",
            "goal": {
                "goal_id": "goal.pkm.capture_note",
                "workflow_steps": [
                    {
                        "type": "action",
                        "label": "Open the capture sheet",
                        "action_id": "pkm.capture_note",
                        "settlement_target": {"route": "/one/pkm", "screen": "pkm"},
                    }
                ],
            },
        }

        journey = _navigation_journey_definition(entry, "pkm.capture_note")

        assert journey is not None
        assert journey["goal_id"] == "goal.pkm.capture_note"
        assert journey["destination_screen"] == "pkm"
        # Resolved from the gateway, never named in code.
        assert journey["navigation_action_id"] == "route.one_pkm"
        assert _is_journey_startable(entry) is True

    def test_location_pause_and_resume_are_escorted_to_their_screen(self):
        """The first journeys whose destination changes state, not a preview.

        Both are ``local_handler`` actions, so they can only run while Location
        is mounted. Without an authored destination, "hide my location" from
        any other screen could only ever answer "open Location first" -- and
        that is the one Location request with real urgency behind it. The
        browser half asserts the same two ids in ``navigation-journey.test.ts``.
        """
        for action_id in ("location.pause_updates", "location.resume_updates"):
            entry = get_action_gateway_action(action_id)
            journey = _navigation_journey_definition(entry, action_id)

            assert journey is not None, action_id
            assert journey["destination_route"] == "/one/location"
            assert journey["destination_screen"] == "one_location"
            # Resolved from the gateway, never named in code, and preferring
            # the `route.*` escort over `location.open_now`: both open
            # /one/location, but only `route.one_location` is in the browser's
            # global-navigation set, so it is the one guaranteed to be offered
            # from whatever screen the person is standing on.
            assert journey["navigation_action_id"] == "route.one_location"
            assert _is_journey_startable(entry) is True

    def test_a_share_is_never_escorted_to_the_composer(self):
        # The same treatment for a share would mean arriving at the composer
        # and firing it at whoever was still selected in it. A share has to
        # begin where the person can already see who it is going to, so this
        # action is authored without a settlement_target on purpose.
        entry = get_action_gateway_action("location.share_selected")

        assert _navigation_journey_definition(entry, "location.share_selected") is None
        assert _is_journey_startable(entry) is False

    def test_a_route_action_never_becomes_a_journey_to_itself(self):
        entry = get_action_gateway_action("route.kai_analysis")

        assert _navigation_journey_definition(entry, "route.kai_analysis") is None

    def test_a_destination_with_no_navigation_action_is_not_a_journey(self):
        entry = {
            "action_id": "setup.open_email",
            "goal": {
                "goal_id": "goal.setup.open_email",
                "workflow_steps": [
                    {
                        "type": "action",
                        "action_id": "setup.open_email",
                        "settlement_target": {
                            "route": "/one/setup/email",
                            "screen": "one_setup_hub",
                        },
                    }
                ],
            },
        }

        # `setup.open_email` opens /one/setup/email itself, so the only
        # candidate escort for this destination is the action being escorted.
        # A journey to itself is not a journey. (This used to pass for a
        # different reason -- the resolver required a `route.` name prefix and
        # therefore found no escort at all -- which also made every genuine
        # setup destination look unreachable.)
        assert _navigation_journey_definition(entry, "setup.open_email") is None
        assert _is_journey_startable(entry) is False

    def test_journey_slots_keep_only_contract_declared_values(self):
        entry = get_action_gateway_action("analysis.start")

        resolved = _journey_slots(
            entry,
            {"symbol": " nvda ", "smuggled": "ignore me"},
        )

        # Normalized by the contract's own resolver, defaulted per the
        # contract, and stripped of anything the contract never declared.
        assert resolved == {"symbol": "NVDA", "pickSource": "default"}


def _screen_context(screen: str, available_action_ids: list[str]) -> dict:
    return {
        _STATE_SCREEN: screen,
        "hussh:voice_context": {
            "route_pattern": "/one",
            "screen": screen,
            "context_revision": "probe-1",
            "available_action_ids": available_action_ids,
        },
    }


class TestCatalogDiscovery:
    """One could only ever see an alphabetical slice of the current screen.

    The result list is bounded, so without ranking most of the app was not
    merely unreachable -- it was invisible, and One answered "I can't" for
    things it could have walked to.
    """

    @pytest.mark.asyncio
    async def test_an_unqueried_call_still_answers_only_for_this_screen(self):
        state = _screen_context("kai_market", ["route.kai_home"])

        result = await list_app_actions("", _tool_context(state))

        # "What can I do here" must not turn into a tour of the whole app.
        assert result["results"]
        assert {item["availability"] for item in result["results"]} == {"on_screen"}

    @pytest.mark.asyncio
    async def test_a_query_ranks_the_matching_action_first(self):
        state = _screen_context("kai_market", ["route.kai_home"])

        result = await list_app_actions("analyse nvidia stock", _tool_context(state))

        assert result["results"][0]["action_id"] == "analysis.start"
        # Discovery names the tool that can actually start it from here.
        assert result["results"][0]["use_tool"] == "start_app_goal"

    @pytest.mark.asyncio
    async def test_an_offscreen_match_carries_how_to_reach_it(self):
        state = _screen_context("kai_market", ["route.kai_home"])

        result = await list_app_actions("analyse nvidia stock", _tool_context(state))
        by_id = {item["action_id"]: item for item in result["results"]}

        # Off-screen is reported as a next step, not a dead end.
        assert by_id["analysis.confirm_preview"]["availability"] == "navigate_first"
        assert by_id["analysis.confirm_preview"]["open_first_action_id"] == "route.kai_analysis"

    @pytest.mark.asyncio
    async def test_policy_is_reported_from_the_action_not_a_dead_field(self):
        # This read a `risk` object that is null on every generated action, so
        # all 117 reported allow_direct -- One was told 8 confirm_required and
        # 23 manual_only actions needed no confirmation.
        state = _screen_context("kai_market", ["route.kai_home"])

        result = await list_app_actions("analyse nvidia stock", _tool_context(state))
        by_id = {item["action_id"]: item for item in result["results"]}

        assert by_id["analysis.confirm_preview"]["policy"] == "confirm_required"

    @pytest.mark.asyncio
    async def test_discovery_never_lists_what_one_cannot_execute(self):
        state = _screen_context("kai_market", ["route.kai_home"])

        for query in ["", "check my email", "analyse nvidia stock", "set up my email"]:
            result = await list_app_actions(query, _tool_context(state))
            listed = {item["action_id"] for item in result["results"]}

            # Unwired: declared but not built. Listing it invents a capability.
            assert "email.chat.turn" not in listed
            assert len(result["results"]) <= 10

    @pytest.mark.asyncio
    async def test_a_self_navigating_action_needs_no_escort_to_be_reachable(self):
        # This used to assert the OPPOSITE -- that `setup.open_email` must never
        # be listed, on the grounds that no `route.*` action opens
        # /one/setup/email so One would have no way to walk there. The premise
        # was wrong. The action's own execution_target IS
        # `route -> /one/setup/email`, so running it performs the navigation; it
        # never needed an escort. It was judged unreachable only because
        # navigation membership was decided by the `route.` NAME PREFIX rather
        # than by what the action does, which is the same defect that refused
        # `location.open_join_circle` on Location.
        state = _screen_context("kai_market", ["route.kai_home"])

        result = await list_app_actions("set up my email", _tool_context(state))
        by_id = {item["action_id"]: item for item in result["results"]}

        assert "setup.open_email" in by_id
        assert by_id["setup.open_email"]["availability"] == "on_screen"
        # Offered as something to run, not as somewhere to be taken first.
        assert not by_id["setup.open_email"].get("open_first_action_id")


class TestLiveContextFreshness:
    """run_live holds one invocation per socket, so session state freezes.

    After a navigation the relay knows the new screen while the tools were
    still reading the screen the person started on -- so a cross-screen
    journey could never continue, and every retry re-read the same stale
    value instead of converging.
    """

    def teardown_method(self):
        clear_live_voice_context("voice_test_session")

    def _ctx(self, frozen_screen: str):
        return SimpleNamespace(
            state={
                _STATE_SCREEN: frozen_screen,
                "hussh:voice_context": {
                    "route_pattern": "/one",
                    "screen": frozen_screen,
                    "context_revision": "frozen",
                    "available_action_ids": ["route.kai_analysis"],
                },
            },
            session=SimpleNamespace(id="voice_test_session"),
        )

    @pytest.mark.asyncio
    async def test_tools_read_the_relay_publication_over_frozen_state(self):
        tool_context = self._ctx("one_agents")
        # What the relay saw after the browser actually navigated.
        publish_live_voice_context(
            "voice_test_session",
            {
                "route_pattern": "/one/kai?tab=analysis",
                "screen": "kai_analysis",
                "context_revision": "fresh",
                "available_action_ids": ["analysis.start", "analysis.confirm_preview"],
            },
        )

        result = await list_app_actions("analyse nvidia stock", tool_context)
        by_id = {item["action_id"]: item for item in result["results"]}

        # Resolved against the destination, not the screen frozen at connect:
        # analysis.confirm_preview is on_screen ONLY in the published context.
        assert by_id["analysis.confirm_preview"]["availability"] == "on_screen"
        assert by_id["analysis.start"]["availability"] == "on_screen"

    @pytest.mark.asyncio
    async def test_execution_uses_the_relay_screen_over_frozen_state(self):
        tool_context = self._ctx("one_agents")
        publish_live_voice_context(
            "voice_test_session",
            {
                "route_pattern": "/one/kai?tab=analysis",
                "screen": "kai_analysis",
                "context_revision": "fresh",
                "available_action_ids": ["analysis.start"],
            },
        )

        result = await run_app_action(
            "analysis.start",
            {"symbol": "NVDA"},
            tool_context,
        )

        assert result["status"] == "ready_to_run"

    @pytest.mark.asyncio
    async def test_session_state_still_answers_when_nothing_is_published(self):
        # Typed chat and tests have no socket, so there is no staleness to
        # correct and the existing path must keep working unchanged.
        tool_context = self._ctx("one_agents")

        result = await list_app_actions("", tool_context)

        assert result["status"] == "ok"
        assert {item["action_id"] for item in result["results"]}

    def test_a_closed_socket_leaves_nothing_behind(self):
        publish_live_voice_context("voice_test_session", {"screen": "kai_analysis"})
        assert read_live_voice_context("voice_test_session") is not None

        clear_live_voice_context("voice_test_session")

        assert read_live_voice_context("voice_test_session") is None


class TestDiscoveryNamesItsTool:
    @pytest.mark.asyncio
    async def test_every_result_says_which_tool_runs_it(self):
        # An action id is not a tool name. Leaving use_tool unset let One guess
        # the id WAS the tool; ADK then raised "Tool 'x' not found", which
        # escaped the live flow and killed the relay pump -- one bad guess
        # ended the call. Every result now names the tool that runs it.
        state = _screen_context("kai_market", ["route.kai_home"])

        for query in ["", "analyse nvidia stock", "open my portfolio"]:
            result = await list_app_actions(query, _tool_context(state))
            assert result["results"], f"no results for {query!r}"
            for item in result["results"]:
                assert item.get("use_tool"), f"{item['action_id']} does not name a tool"
                assert item["use_tool"] in {
                    "run_app_action",
                    "start_app_goal",
                    "ask_email_agent",
                    "ask_location_agent",
                    "ask_consent_agent",
                    "ask_connected_systems_agent",
                }


class TestNavigationActionMembership:
    """Which contracts may be proposed from a screen that never declared them.

    Navigation is the one class admitted from anywhere -- it is how "go to
    profile" stays reachable from a tab that has never heard of the profile.
    Membership used to be decided by the ``route.`` NAME PREFIX alone, which is
    only a proxy for the real property, and the proxy is wrong in both
    directions. That broke "join a circle": Location grew past the capped
    ``available_action_ids`` list, and every id the cap dropped was refused as
    action_unavailable because a surface-scoped navigation was not recognised
    as navigation.
    """

    def test_navigation_by_behaviour_not_by_name(self):
        from hushh_mcp.services.action_gateway import (
            get_action_gateway_action,
            is_navigation_action,
        )

        # Navigates, but is named for the surface that owns it. This is the
        # family the old prefix test excluded, and the observed failure.
        for action_id in (
            "location.open_join_circle",
            "location.open_share",
            "setup.open_finance",
        ):
            entry = get_action_gateway_action(action_id)
            assert entry is not None, f"{action_id} missing from the gateway"
            assert entry["execution_target"]["path"] == "route"
            assert is_navigation_action(entry), f"{action_id} must be navigation"

    def test_prefixed_navigation_survives_a_non_route_path(self):
        from hushh_mcp.services.action_gateway import (
            get_action_gateway_action,
            is_navigation_action,
        )

        # The other direction: these ARE cross-screen navigation but do not run
        # through a route target. Judging purely by path would have silently
        # un-navigated them -- exactly the ids the reserved global-navigation
        # segment exists to keep proposable.
        for action_id in ("route.profile", "route.consents", "route.back"):
            entry = get_action_gateway_action(action_id)
            assert entry is not None, f"{action_id} missing from the gateway"
            assert entry["execution_target"]["path"] != "route"
            assert is_navigation_action(entry), f"{action_id} must stay navigation"

    def test_screen_work_is_still_screen_work(self):
        from hushh_mcp.services.action_gateway import (
            get_action_gateway_action,
            is_navigation_action,
        )

        # Widening navigation must not turn every action into a global one. A
        # local handler only runs where it is mounted, and analysis.start is a
        # real piece of work rather than a way to move between screens.
        for action_id in (
            "location.refresh",
            "kai.setup.answer_horizon",
            "analysis.start",
        ):
            entry = get_action_gateway_action(action_id)
            assert entry is not None, f"{action_id} missing from the gateway"
            assert not is_navigation_action(entry), f"{action_id} must not be navigation"


class TestNamedShareChain:
    """The named location-share journey is navigate-first, ask-second.

    The single question exists to catch a MIS-HEARD name, so it is worth
    nothing unless it says the name the app matched. One does not have that
    name when the journey starts: ``start_app_goal`` issues the route step and
    answers ``navigation_started``, and the pick only runs later, under
    ``continue_app_goal``. An instruction that promised the match up front left
    One with nothing to ask from but the word it heard -- so it asked "which
    Sarah did you mean?", from a screen showing no Sarahs at all.
    """

    def test_the_start_of_the_chain_is_not_treated_as_a_match(self):
        instruction = ONE_IDENTITY_INSTRUCTION

        assert "navigate first, then ask" in instruction
        assert "NOTHING has been matched yet" in instruction
        # The two beats, in order, both named.
        start = instruction.index("location.select_share_recipient")
        assert instruction.index("continue_app_goal", start) < instruction.index(
            "location.share_selected", start
        )

    def test_every_required_slot_one_must_fill_is_spelled_out(self):
        """Name the slot key, never imply it.

        "call it with the name you heard" left the model to guess the key. It
        guessed wrong, the journey answered ``input_needed slot=person``, and
        One asked "who do you want to share with?" at someone who had just
        said the name -- twice, because nothing about the retry differed.
        analysis.start has always spelled out {'symbol': <ticker>}; this asserts
        the same for every action the instruction tells One to start by name.
        """
        for action_id in ("location.select_share_recipient", "analysis.start"):
            entry = get_action_gateway_action(action_id)
            assert action_id in ONE_IDENTITY_INSTRUCTION, action_id
            required = [
                str(spec.get("slot"))
                for spec in (entry.get("goal") or {}).get("required_inputs") or []
                if spec.get("required") and not spec.get("default_value")
            ]
            assert required, action_id
            for slot in required:
                assert f"'{slot}':" in ONE_IDENTITY_INSTRUCTION, f"{action_id} slot {slot}"

    def test_the_question_is_forbidden_before_the_pick_settles(self):
        instruction = ONE_IDENTITY_INSTRUCTION

        assert "ask no question" in instruction
        assert "never the" in instruction and "name you heard" in instruction
        # The matched name has exactly one source, and it is not a tool return.
        assert "settlement report is the first and only place" in instruction


def test_a_named_request_goes_to_its_journey_not_to_a_specialist():
    """The refusal that had no business happening.

    One was told "you never execute sensitive actions directly: specialists
    validate consent", written before journeys existed. Obeying it, One sent
    "connect me with Ankit" to the connections specialist, the specialist hit a
    consent boundary, and One relayed it honestly -- so a request the app can
    satisfy end to end came back as "I don't have the right permissions",
    pointing at the consent screen.

    Nothing was broken underneath: the action outranks the specialist 182 to 80
    on the spoken phrase, and is journey-reachable from 55 of 56 screens. Only
    the decision was wrong, which is why the instruction alone was not trusted
    to fix it.
    """
    from hushh_mcp.one_adk.action_tools import journey_for_specialist_request

    for phrase in (
        "send a connection request to ankit",
        "connect me with ankit",
        "can you connect me with ankit",
    ):
        journey = journey_for_specialist_request("agent_connections", phrase)
        assert journey is not None, phrase
        assert journey["action_id"] == "connect.send_request", phrase
        assert journey["goal_id"] == "goal.connect.send_request", phrase

    # Scoped to the specialist's own surface, not the whole gateway. Scored
    # across everything, "connect me with ankit" ties three actions at 77 and
    # `setup.connect_gmail` takes it on an alphabetical tiebreak -- a wrong
    # answer that looks like a confident one.
    assert (
        journey_for_specialist_request("agent_connections", "remove my connection with rashid")
        or {}
    ).get("action_id") == "connect.remove_connection"


def test_an_open_question_still_reaches_the_specialist():
    """The redirect must not swallow what specialists are actually for.

    Thresholds measured against the live gateway rather than picked: inside the
    connections surface, concrete requests score 77-182 while open-ended ones
    top out at 32. Anything here scoring above the cut would mean a person can
    no longer ask a question without being navigated somewhere.
    """
    from hushh_mcp.one_adk.action_tools import journey_for_specialist_request

    for phrase in (
        "who do i trust",
        "what are my consents",
        "how does trust work here",
        "what can you do",
        "explain trusted connections",
    ):
        assert journey_for_specialist_request("agent_connections", phrase) is None, phrase

    # A specialist with no authored surfaces is never redirected at all.
    assert journey_for_specialist_request("agent_email", "send a connection request") is None
    assert journey_for_specialist_request("", "connect me with ankit") is None


def test_sending_a_connection_request_is_reachable_from_every_screen():
    """You can ask for this from anywhere, so it has to be reachable anywhere.

    A journey is what carries someone from where they are standing to where the
    action lives. If a later edit narrows `reachability.screens`, this action
    silently becomes a dead end on 55 screens and the failure looks like One
    being unhelpful rather than a contract change.
    """
    from collections import defaultdict

    from hushh_mcp.one_adk.action_tools import _reachability
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    entries = list(list_action_gateway_actions())
    by_id = {entry["action_id"]: entry for entry in entries}
    on_screen: dict[str, set[str]] = defaultdict(set)
    for entry in entries:
        for screen in (entry.get("reachability") or {}).get("screens") or []:
            on_screen[screen].add(entry["action_id"])

    assert len(on_screen) > 40, "screen inventory collapsed; the rest of this test is vacuous"

    target = "connect.send_request"
    unreachable = [
        screen
        for screen in on_screen
        if _reachability(by_id[target], target, on_screen[screen])[0] == "unreachable_from_here"
    ]
    assert unreachable == [], f"{target} is a dead end on: {unreachable}"


def test_no_wired_action_is_a_dead_end_from_a_foreign_screen():
    """Asking for something from the wrong screen must never be a refusal.

    Reported twice from the Connect surface, and the second time with the fair
    complaint that nobody should have to discover this one action at a time.
    So this checks every wired action at once rather than waiting for the next
    one to be found by hand.

    "Reachable" here means One can at least BEGIN: either the action is
    navigation, or it has an authored journey that carries the person to it, or
    discovery can name the route action to open first. Anything else is a dead
    end -- One has nothing to offer and says so, which reads as the app
    refusing to do something it can plainly do.

    The allowlist is the OTP flow, and it is correct: a verification code
    belongs to the screen showing it, and "start the code journey from
    somewhere else" is not a thing anyone can mean.
    """
    from hushh_mcp.one_adk.action_tools import _reachability
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    SCREEN_BOUND_BY_DESIGN = {
        "phone_mandate.close_country_picker",
        "phone_mandate.select_country",
        "phone_mandate.submit_code",
        "phone_mandate.submit_number",
    }

    wired = [
        entry
        for entry in list_action_gateway_actions()
        if (entry.get("execution_target") or {}).get("status") == "wired"
    ]
    assert len(wired) > 100, "wired inventory collapsed; the rest of this test is vacuous"

    # An inventory with nothing mounted: the honest worst case, and exactly
    # what standing on an unrelated screen looks like to the relay.
    dead_ends = sorted(
        entry["action_id"]
        for entry in wired
        if _reachability(entry, entry["action_id"], set())[0] == "unreachable_from_here"
    )

    assert set(dead_ends) <= SCREEN_BOUND_BY_DESIGN, (
        "These wired actions cannot be started from another screen, so asking "
        f"for one there is answered with a refusal: {sorted(set(dead_ends) - SCREEN_BOUND_BY_DESIGN)}"
    )


def test_the_actions_people_ask_for_by_name_carry_their_own_journey():
    """A journey is what lets "remove Rashid" work from anywhere.

    `navigate_first` is not the same promise: it tells One to open a screen and
    try again, which is two turns and a hand-off it can drop. These are the
    actions someone names directly, mid-sentence, from wherever they are
    standing -- so each one carries an authored journey rather than relying on
    One to chain two steps correctly.
    """
    from hushh_mcp.one_adk.action_tools import _is_journey_startable
    from hushh_mcp.services.action_gateway import get_action_gateway_action

    NAMED_DIRECTLY = (
        "connect.send_request",
        "connect.cancel_request",
        "connect.remove_connection",
        "location.remove_from_circle",
        "location.remove_emergency_contact",
        "location.add_to_circle",
        "location.create_circle",
    )
    missing = [
        action_id
        for action_id in NAMED_DIRECTLY
        if not _is_journey_startable(get_action_gateway_action(action_id) or {})
    ]
    assert missing == [], (
        "These are asked for by name from any screen and would need One to "
        f"chain a navigation itself, which is where it breaks: {missing}"
    )
