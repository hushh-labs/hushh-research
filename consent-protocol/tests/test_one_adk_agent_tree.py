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
    _STATE_CONSENT_TOKEN,
    _STATE_GOAL_RUN,
    _STATE_PENDING_DIRECTIVE,
    _STATE_SCREEN,
    _STATE_USER_ID,
    BACKEND_DIRECT_ACTION_IDS,
    BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS,
    _directive_flags,
    _is_backend_direct,
    _is_journey_startable,
    _journey_slots,
    _navigation_journey_definition,
    continue_app_goal,
    discover_person_information,
    get_location_circle_members,
    list_app_actions,
    list_location_shared_with_me,
    list_my_connections,
    list_my_location_circles,
    list_my_location_shares,
    list_my_outgoing_location_requests,
    list_pending_connection_requests,
    list_pending_location_requests,
    read_my_pkm_domain_summary,
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
    _intro_navigable,
    _one_runtime_instruction,
    _specialist_turn,
    ask_consent_agent,
    build_one_intro_text_agent,
    build_one_root_agent,
    build_one_text_agent,
    get_one_runner,
    list_intro_navigation_actions,
    open_gmail_email_draft,
    open_screen,
)
from hushh_mcp.services.action_gateway import get_action_gateway_action, list_action_gateway_actions
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from hushh_mcp.services.live_voice_context import (
    clear_live_voice_context,
    publish_live_voice_context,
    read_live_voice_context,
)
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService


class TestAgentTreeShape:
    @pytest.fixture(autouse=True)
    def _managed_live_key(self, monkeypatch: pytest.MonkeyPatch):
        """The canonical live model rides the developer_api transport, so
        building the voice head requires the Hussh-managed live key; tests
        provide a dummy (no session is ever opened at build time)."""
        monkeypatch.setenv("HUSHH_MANAGED_GEMINI_LIVE_API_KEY", "test-managed-live-key")

    def test_voice_head_fails_closed_without_the_managed_live_key(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.delenv("HUSHH_MANAGED_GEMINI_LIVE_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="managed_live_key_missing"):
            _tree._build_one_live_model()

    def test_root_agent_is_one_with_full_roster(self):
        agent = build_one_root_agent()
        assert agent.name == "one"
        tool_names = {
            getattr(t, "name", getattr(t, "__name__", type(t).__name__)) for t in agent.tools
        }
        assert "google_search" in tool_names
        assert "open_screen" in tool_names
        assert "open_gmail_email_draft" in tool_names
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
        expected_tools = {
            "ask_email_agent",
            "ask_location_agent",
            "ask_consent_agent",
            "calendar_summary",
            "calendar_events",
            "calendar_availability",
            "calendar_free_slots",
            "propose_calendar_event",
            "propose_calendar_reschedule",
            "propose_calendar_cancellation",
            "discover_person_information",
            "list_pending_information_requests",
            "propose_information_request",
        }
        if _tree._CRM_PRODUCT_AVAILABLE:
            expected_tools.add("ask_connected_systems_agent")
        assert expected_tools <= tool_names
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

    def test_pre_vault_head_no_longer_uses_the_uncertain_self_assessment_gate(self):
        # Replaces #6087: "Call list_intro_navigation_actions only when the
        # action id is uncertain" -- the same brittle self-assessment gate
        # already fixed for list_app_actions in PR #6071, just in this
        # separate static instruction that fix didn't touch.
        agent = build_one_intro_text_agent()
        assert "when the action id is uncertain" not in agent.instruction
        assert (
            "Call list_intro_navigation_actions first unless their words are "
            "already a close match" in agent.instruction
        )

    @pytest.mark.asyncio
    async def test_every_listed_intro_route_is_accepted_by_the_executor(self):
        # #6086: list_intro_navigation_actions used to filter only by
        # is_navigation_action, a broader test than run_intro_navigation_action's
        # own predicate (route.* prefix + allow_direct + wired). 45 of 77 ids
        # were listed as candidates and then always rejected. Both functions
        # now share _intro_navigable, so this invariant holds by construction
        # -- asserted directly so a future regression fails here, not in UAT.
        listing = await list_intro_navigation_actions()
        assert listing["status"] == "ok"
        assert listing["results"], "expected at least one pre-vault route to be listed"
        for result in listing["results"]:
            entry = get_action_gateway_action(result["action_id"])
            assert _intro_navigable(entry, result["action_id"]), (
                f"{result['action_id']} is listed by list_intro_navigation_actions "
                "but would be rejected by run_intro_navigation_action"
            )

    def test_intro_navigable_rejects_a_route_shaped_id_missing_the_prefix(self):
        # The concrete casualty #6086 was filed against: onboarding.continue,
        # auth.sign_in_open, and vault.setup_open are all wired/allow_direct
        # and reachable via execution_target.path == "route" (the OTHER half
        # of is_navigation_action's union), but none starts with "route.".
        for action_id in ("onboarding.continue", "auth.sign_in_open", "vault.setup_open"):
            entry = get_action_gateway_action(action_id)
            assert entry is not None, f"{action_id} missing from the gateway"
            assert entry.get("execution_target", {}).get("path") == "route"
            assert not _intro_navigable(entry, action_id)

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

    def test_text_runtime_import_is_credential_independent_in_ci(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("TESTING", "true")
        monkeypatch.setattr(
            _tree,
            "build_managed_gemini_adk_model",
            lambda *_args, **_kwargs: pytest.fail("CI collection must not resolve Vertex ADC"),
        )

        agent = build_one_text_agent()
        intro_agent = _tree.build_one_intro_text_agent()

        assert agent.model == _tree._SPECIALIST_MODEL
        assert intro_agent.model == _tree._SPECIALIST_MODEL

    def test_byok_live_registry_rejects_models_outside_the_matrix(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Fail-closed contract: an unrehearsed model has no matrix entry."""
        monkeypatch.setenv("HUSHH_GEMINI_BYOK_LIVE_ENABLED", "true")
        monkeypatch.setattr(_tree, "_BYOK_LIVE_MODEL", "gemini-9.9-flash-live-preview")
        with pytest.raises(ValueError, match="byok_live_unsupported"):
            _tree.build_one_live_runner(
                runtime_mode="byok",
                runtime_credential="test-key",
            )

    def test_byok_live_registry_accepts_gemini_31_flash_live(self, monkeypatch: pytest.MonkeyPatch):
        """gemini-3.1-flash-live-preview passed its 2026-08-21 ADK rehearsal:
        mid-session injections reach the model (ADK transposes single-text-part
        send_content to send_realtime_input on 3.x names), so the matrix now
        declares it compatible and the BYOK gate must accept it."""
        monkeypatch.setenv("HUSHH_GEMINI_BYOK_LIVE_ENABLED", "true")
        monkeypatch.setattr(_tree, "_BYOK_LIVE_MODEL", "gemini-3.1-flash-live-preview")
        runner = _tree.build_one_live_runner(
            runtime_mode="byok",
            runtime_credential="test-key",
        )
        assert runner is not None

    def test_identity_instruction_answers_name_question(self):
        assert "I'm One" in ONE_IDENTITY_INSTRUCTION
        assert "Never call yourself Kai" in ONE_IDENTITY_INSTRUCTION
        assert "Visible controls take priority over introductions" in ONE_IDENTITY_INSTRUCTION
        assert "list_app_actions" in ONE_IDENTITY_INSTRUCTION
        # Replaces "call list_app_actions when the exact id is uncertain": a
        # confidence judgment that swung on wording, not a checkable rule.
        # Two-turn table-stakes regression: "save me" and "trigger sos"
        # should not diverge on whether the model felt certain about either.
        assert (
            "call list_app_actions first with their own words, every time, "
            "rather than judging whether you feel certain" in ONE_IDENTITY_INSTRUCTION
        )
        assert (
            "Call list_app_actions first unless their words are already a "
            "close match to one of the visible labels" in ONE_IDENTITY_INSTRUCTION
        )
        assert "correlated app action settlement" in ONE_IDENTITY_INSTRUCTION
        assert "Conversation comes before workflow" in ONE_IDENTITY_INSTRUCTION
        assert "so what?" in ONE_IDENTITY_INSTRUCTION
        assert "Use your intelligence in the current turn" in ONE_IDENTITY_INSTRUCTION
        assert "it is not semantic authority" in ONE_IDENTITY_INSTRUCTION
        assert "Deterministic policy may validate" in ONE_IDENTITY_INSTRUCTION
        assert "KYC app surface" in ONE_IDENTITY_INSTRUCTION
        assert "Gmail receipt sync and inbox search are paused" in ONE_IDENTITY_INSTRUCTION
        assert "named CRM" in ONE_IDENTITY_INSTRUCTION
        assert "summon that specialist" in ONE_IDENTITY_INSTRUCTION
        # Onboarding's own instance of the same rule (replaces "When the
        # exact generated id is uncertain, call list_app_actions").
        assert (
            "Whenever the person's own words are not a close match to one of "
            "the visible labels, call list_app_actions" in ONE_IDENTITY_INSTRUCTION
        )

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
        assert (
            "First check whether the person's own words closely echo one of the "
            "labels above" in instruction
        )
        assert (
            "call list_app_actions with their own words first, every time, "
            "rather than guessing from a label that only partly fits" in instruction
        )

    def test_runtime_instruction_warns_when_voice_control_is_off(self):
        # Gate 1/Gate 2 refuse every actual tool call while voice is off, but
        # a plain "what can you do" question never reaches a tool -- it is
        # answered straight from this instruction, so the off state must be
        # stated here or the model narrates capabilities as if nothing changed.
        instruction = _one_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_VOICE_CONTEXT: {
                        "available_action_ids": ["location.pause_updates"],
                        "voice_settings": {"voice_enabled": False},
                    }
                }
            )
        )

        assert "VOICE CONTROL IS OFF" in instruction
        assert "Do not describe, offer, or attempt any action" in instruction

    def test_runtime_instruction_has_no_voice_off_warning_when_voice_is_on(self):
        instruction = _one_runtime_instruction(
            SimpleNamespace(
                state={
                    STATE_VOICE_CONTEXT: {
                        "available_action_ids": ["location.pause_updates"],
                        "voice_settings": {"voice_enabled": True},
                    }
                }
            )
        )

        assert "VOICE CONTROL IS OFF" not in instruction

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
        assert "call list_app_actions with their own words first, every time" in instruction
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
    async def test_refuses_a_specialist_the_user_turned_off_in_voice_settings(self):
        result = await _specialist_turn(
            "agent_location",
            "share my location with Sarah",
            _tool_context(
                {
                    STATE_USER_ID: "u1",
                    STATE_CONSENT_TOKEN: "t1",
                    STATE_VOICE_CONTEXT: {
                        "voice_settings": {"disabled_domains": ["location"]},
                    },
                }
            ),
        )
        assert result["status"] == "domain_disabled"
        assert result["reason"] == "voice_domain_disabled_by_user"
        assert "Location" in result["message"]

    @pytest.mark.asyncio
    async def test_refuses_every_specialist_when_the_master_toggle_is_off(self):
        # The master Voice control switch, distinct from any per-domain
        # toggle: turning it off must refuse specialist delegation the same
        # way a domain-specific disable does, not just influence the model's
        # own conversational judgment.
        result = await _specialist_turn(
            "agent_location",
            "share my location with Sarah",
            _tool_context(
                {
                    STATE_USER_ID: "u1",
                    STATE_CONSENT_TOKEN: "t1",
                    STATE_VOICE_CONTEXT: {
                        "voice_settings": {"voice_enabled": False},
                    },
                }
            ),
        )
        assert result["status"] == "domain_disabled"
        assert result["reason"] == "voice_disabled_by_user"
        assert "Location" not in result["message"]

    @pytest.mark.asyncio
    async def test_domain_disabled_takes_priority_over_missing_auth(self):
        # The restriction is a fact about the request itself (which specialist,
        # which domain), not about the session -- it must refuse the same way
        # whether or not the person is signed in yet.
        result = await _specialist_turn(
            "agent_location",
            "share my location",
            _tool_context(
                {
                    STATE_VOICE_CONTEXT: {
                        "voice_settings": {"disabled_domains": ["location"]},
                    },
                }
            ),
        )
        assert result["status"] == "domain_disabled"

    @pytest.mark.asyncio
    async def test_does_not_restrict_a_domain_the_user_left_enabled(self):
        result = await _specialist_turn(
            "agent_location",
            "where am I sharing my location",
            _tool_context(
                {
                    STATE_USER_ID: "u1",
                    STATE_CONSENT_TOKEN: "t1",
                    STATE_VOICE_CONTEXT: {
                        "voice_settings": {"disabled_domains": ["kyc"]},
                    },
                }
            ),
        )
        assert result["status"] != "domain_disabled"

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


class TestGmailEmailDraftDirective:
    def test_gmail_receipt_pause_does_not_disable_personal_drafts(self):
        assert "This does not limit the open_gmail_email_draft tool" in ONE_IDENTITY_INSTRUCTION

    @pytest.mark.asyncio
    async def test_opens_only_an_editable_draft_directive(self):
        state = {STATE_USER_ID: "u1"}

        result = await open_gmail_email_draft(
            "Send a hello email to me",
            _tool_context(state),
        )

        assert result["status"] == "draft_opened"
        assert state[f"{STATE_PENDING_DIRECTIVE}:gmail_email_draft"] == {
            "kind": "prompt",
            "payload": {
                "kind": "gmail_email_draft",
                "instruction": "Send a hello email to me",
            },
        }

    @pytest.mark.asyncio
    async def test_requires_authenticated_user_before_opening_draft(self):
        state: dict = {}

        result = await open_gmail_email_draft("Send an email", _tool_context(state))

        assert result["status"] == "authentication_required"
        assert f"{STATE_PENDING_DIRECTIVE}:gmail_email_draft" not in state


class TestRunAppAction:
    def test_state_keys_stay_in_sync_with_agent_tree(self):
        assert _STATE_PENDING_DIRECTIVE == _tree.STATE_PENDING_DIRECTIVE
        assert _STATE_SCREEN == _tree.STATE_SCREEN
        assert _STATE_USER_ID == STATE_USER_ID
        assert _STATE_CONSENT_TOKEN == STATE_CONSENT_TOKEN

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
    async def test_run_app_action_refuses_when_domain_disabled_by_user(self):
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["location.pause_updates"],
                "voice_settings": {"disabled_domains": ["location"]},
            }
        }
        result = await run_app_action("location.pause_updates", {}, _tool_context(state))
        assert result["status"] == "domain_disabled"
        assert "Location" in result["message"]
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_run_app_action_refuses_when_voice_entirely_disabled(self):
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["location.pause_updates"],
                "voice_settings": {"voice_enabled": False},
            }
        }
        result = await run_app_action("location.pause_updates", {}, _tool_context(state))
        assert result["status"] == "domain_disabled"
        assert "Location" not in result["message"]
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_run_app_action_allows_when_domain_not_disabled(self):
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["location.pause_updates"],
                "voice_settings": {"disabled_domains": ["kyc"]},
            }
        }
        result = await run_app_action("location.pause_updates", {}, _tool_context(state))
        assert result["status"] != "domain_disabled"

    @pytest.mark.asyncio
    async def test_run_app_action_allows_when_voice_settings_absent(self):
        # No live context at all (a non-live caller) must behave exactly as it
        # did before this feature existed -- fail open, never "domain_disabled".
        state: dict = {}
        result = await run_app_action("location.pause_updates", {}, _tool_context(state))
        assert result["status"] != "domain_disabled"

    @pytest.mark.asyncio
    async def test_start_app_goal_refuses_when_domain_disabled_by_user(self):
        # start_app_goal must not let a settled-journey or navigation-journey
        # entry bypass the same restriction run_app_action enforces.
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["location.select_share_recipient"],
                "voice_settings": {"disabled_domains": ["location"]},
            }
        }
        result = await start_app_goal(
            "location.select_share_recipient", {"person": "Sarah"}, _tool_context(state)
        )
        assert result["status"] == "domain_disabled"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)
        assert _STATE_GOAL_RUN not in state

    @pytest.mark.asyncio
    async def test_start_app_goal_refuses_when_voice_entirely_disabled(self):
        state = {
            "hussh:voice_context": {
                "available_action_ids": ["location.select_share_recipient"],
                "voice_settings": {"voice_enabled": False},
            }
        }
        result = await start_app_goal(
            "location.select_share_recipient", {"person": "Sarah"}, _tool_context(state)
        )
        assert result["status"] == "domain_disabled"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)
        assert _STATE_GOAL_RUN not in state

    def test_directive_flags_ignores_the_opt_in_when_it_is_off(self):
        entry = get_action_gateway_action("location.share_selected")
        assert entry is not None
        assert entry.get("execution_policy") == "confirm_required"
        flags = _directive_flags(entry, require_tap_confirmation=False)
        assert flags == {"needsConfirmation": False, "trustedActivationRequired": False}

    def test_directive_flags_requires_confirmation_when_the_user_opted_in(self):
        entry = get_action_gateway_action("location.share_selected")
        assert entry is not None
        flags = _directive_flags(entry, require_tap_confirmation=True)
        assert flags == {"needsConfirmation": True, "trustedActivationRequired": False}

    def test_directive_flags_opt_in_does_not_touch_allow_direct_actions(self):
        # The opt-in only ever adds a confirmation to confirm_required actions.
        # An allow_direct action must stay hands-free regardless of the
        # person's tap-confirmation preference -- that setting is scoped to
        # actions the contract already calls risky, not to everything.
        entry = get_action_gateway_action("location.pause_updates")
        assert entry is not None
        assert entry.get("execution_policy") == "allow_direct"
        flags = _directive_flags(entry, require_tap_confirmation=True)
        assert flags == {"needsConfirmation": False, "trustedActivationRequired": False}

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


def test_every_backend_direct_action_id_still_exists_in_the_action_gateway() -> None:
    """A future manifest regen that drops or renames one of these ids would
    otherwise fail silently -- get_action_gateway_action() would start
    returning None and run_app_action would answer "unknown_action" with no
    test anywhere noticing. This is the one guard standing between a
    contract change and a voice action quietly going dark."""
    for action_id in BACKEND_DIRECT_ACTION_IDS:
        assert get_action_gateway_action(action_id) is not None, (
            f"{action_id} is in BACKEND_DIRECT_ACTION_IDS but missing from the "
            "generated action gateway manifest"
        )


class TestBackendDirectCircleActions:
    """location.leave_circle / location.delete_circle bypass the client
    directive entirely and mutate through OneLocationCircleService directly.
    The only directive parked for either is the terminal action_result kind
    (see _park_action_result_directive) -- there is no client_directive
    asking the browser to execute anything, since the mutation already
    happened here."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _valid_token(self, user_id: str = "user_1"):
        return (True, None, SimpleNamespace(user_id=user_id))

    @pytest.mark.asyncio
    async def test_leave_circle_executes_directly_and_parks_only_the_result(self):
        state = self._authorized_state()
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(OneLocationCircleService, "leave_circle", autospec=True) as leave_mock,
        ):
            result = await run_app_action(
                "location.leave_circle", {"circle": "family"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Family" in result["message"]
        # autospec'd instance methods record the instance as the first
        # positional arg -- assert on the keyword args a real caller used.
        leave_mock.assert_called_once()
        assert leave_mock.call_args.kwargs == {"user_id": "user_1", "circle_id": "c1"}
        # No {kind: "action"} directive asking the browser to execute
        # anything -- only the terminal result, so it never enters the
        # issue()/settlement/GC machinery a real "action" directive would.
        directive_keys = [k for k in state if k.startswith(f"{_STATE_PENDING_DIRECTIVE}:")]
        assert directive_keys == [f"{_STATE_PENDING_DIRECTIVE}:location.leave_circle:result"]
        parked = state[directive_keys[0]]
        assert parked["kind"] == "action_result"
        assert parked["payload"] == {
            "actionId": "location.leave_circle",
            "status": "completed",
            "message": result["message"],
        }

    @pytest.mark.asyncio
    async def test_delete_circle_executes_directly(self):
        state = self._authorized_state()
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Roommates"}],
            ),
            patch.object(OneLocationCircleService, "delete_circle", autospec=True) as delete_mock,
        ):
            result = await run_app_action(
                "location.delete_circle", {"circle": "roommates"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        delete_mock.assert_called_once()
        assert delete_mock.call_args.kwargs == {"owner_user_id": "user_1", "circle_id": "c1"}

    @pytest.mark.asyncio
    async def test_refuses_without_a_consent_token(self):
        state = {STATE_USER_ID: "user_1"}  # no STATE_CONSENT_TOKEN
        result = await run_app_action(
            "location.leave_circle", {"circle": "family"}, _tool_context(state)
        )
        assert result["status"] == "blocked"
        assert "locked" in result["message"].lower()
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)

    @pytest.mark.asyncio
    async def test_refuses_when_token_fails_revalidation(self):
        state = self._authorized_state()
        with patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(False, "expired", None)),
        ):
            result = await run_app_action(
                "location.leave_circle", {"circle": "family"}, _tool_context(state)
            )
        assert result["status"] == "blocked"

    @pytest.mark.asyncio
    async def test_refuses_when_token_belongs_to_a_different_user(self):
        # Structurally shouldn't happen, but must refuse rather than trust it.
        state = self._authorized_state()
        with patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=self._valid_token(user_id="someone_else")),
        ):
            result = await run_app_action(
                "location.leave_circle", {"circle": "family"}, _tool_context(state)
            )
        assert result["status"] == "blocked"

    @pytest.mark.asyncio
    async def test_ambiguous_circle_name_is_reported_not_guessed(self):
        state = self._authorized_state()
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[
                    {"id": "c1", "name": "Family Trip"},
                    {"id": "c2", "name": "Family Reunion"},
                ],
            ),
        ):
            result = await run_app_action(
                "location.leave_circle", {"circle": "family"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "more than one circle" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_unknown_circle_name_names_the_real_ones(self):
        state = self._authorized_state()
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
        ):
            result = await run_app_action(
                "location.leave_circle", {"circle": "coworkers"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "Family" in result["message"]

    @pytest.mark.asyncio
    async def test_service_failure_is_recorded_so_an_immediate_retry_is_refused(self):
        state = self._authorized_state()
        # The already_failed loop-guard is keyed by tool_context.session.id;
        # the shared _tool_context() helper doesn't set one, so build a
        # context with a real session id here to actually exercise it.
        ctx = SimpleNamespace(state=state, session=SimpleNamespace(id="session_1"))
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "leave_circle",
                autospec=True,
                side_effect=RuntimeError("db exploded"),
            ),
        ):
            first = await run_app_action("location.leave_circle", {"circle": "family"}, ctx)
            assert first["status"] == "failed"
            parked = state[f"{_STATE_PENDING_DIRECTIVE}:location.leave_circle:result"]
            assert parked["kind"] == "action_result"
            assert parked["payload"]["status"] == "failed"
            assert parked["payload"]["actionId"] == "location.leave_circle"
            second = await run_app_action("location.leave_circle", {"circle": "family"}, ctx)
        assert second["status"] == "already_failed"

    @pytest.mark.asyncio
    async def test_executes_from_a_completely_different_screen_no_navigation_needed(self):
        # The whole point of going backend-direct: the person can be looking
        # at Connect, Kai, anywhere -- there is no browser-side local handler
        # to be on-screen for, so neither the screen-reachability guard nor
        # the available_action_ids inventory check should apply here.
        state = self._authorized_state()
        state[_STATE_SCREEN] = "one_connect"
        state["hussh:voice_context"] = {
            "screen": "one_connect",
            "available_action_ids": ["connect.search_people", "route.one_location"],
        }
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(OneLocationCircleService, "leave_circle", autospec=True),
        ):
            result = await run_app_action(
                "location.leave_circle", {"circle": "family"}, _tool_context(state)
            )
        assert result["status"] == "completed"


class TestBackendDirectCheckoutNearby:
    """location.checkout_nearby has no slots and names no person or place --
    it only ever clears the caller's own Nearby Check-In presence row, so
    unlike the circle/grant actions above it needs no resolution step at
    all."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _valid_token(self, user_id: str = "user_1"):
        return (True, None, SimpleNamespace(user_id=user_id))

    @pytest.mark.asyncio
    async def test_checkout_nearby_executes_directly_with_no_slots(self):
        from hushh_mcp.services.one_location_nearby_presence_service import (
            OneLocationNearbyPresenceService,
        )

        state = self._authorized_state()
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=self._valid_token()),
            ),
            patch.object(
                OneLocationNearbyPresenceService, "checkout", autospec=True
            ) as checkout_mock,
        ):
            result = await run_app_action("location.checkout_nearby", {}, _tool_context(state))
        assert result["status"] == "completed"
        assert "checked you out" in result["message"].lower()
        checkout_mock.assert_called_once()
        assert checkout_mock.call_args.kwargs == {"user_id": "user_1"}
        directive_keys = [k for k in state if k.startswith(f"{_STATE_PENDING_DIRECTIVE}:")]
        assert directive_keys == [f"{_STATE_PENDING_DIRECTIVE}:location.checkout_nearby:result"]
        parked = state[directive_keys[0]]
        assert parked["kind"] == "action_result"
        assert parked["payload"] == {
            "actionId": "location.checkout_nearby",
            "status": "completed",
            "message": result["message"],
        }

    @pytest.mark.asyncio
    async def test_checkout_nearby_refuses_without_a_consent_token(self):
        state = {STATE_USER_ID: "user_1"}  # no STATE_CONSENT_TOKEN
        result = await run_app_action("location.checkout_nearby", {}, _tool_context(state))
        assert result["status"] == "blocked"
        assert not any(k.startswith(f"{_STATE_PENDING_DIRECTIVE}:") for k in state)


class TestBackendDirectGrantActions:
    """location.stop_share / approve_request / decline_request go straight
    through OneLocationAgentService, resolved against the owner's own narrow
    grant/request lists rather than the heavy list_state call."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _valid_token(self) -> tuple:
        return (True, None, SimpleNamespace(user_id="user_1"))

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=self._valid_token()),
        )

    @pytest.mark.asyncio
    async def test_stop_share_resolves_by_name_and_revokes_the_right_grant(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                return_value=[{"id": "g1", "recipientDisplayName": "Roopmann"}],
            ),
            patch.object(OneLocationAgentService, "revoke_grant", autospec=True) as revoke_mock,
        ):
            result = await run_app_action(
                "location.stop_share", {"person": "roopmann"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Roopmann" in result["message"]
        assert revoke_mock.call_args.kwargs == {"owner_user_id": "user_1", "grant_id": "g1"}

    @pytest.mark.asyncio
    async def test_stop_share_reports_ambiguous_matches_instead_of_guessing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                return_value=[
                    {"id": "g1", "recipientDisplayName": "Sarah Chen"},
                    {"id": "g2", "recipientDisplayName": "Sarah Lee"},
                ],
            ),
        ):
            result = await run_app_action(
                "location.stop_share", {"person": "sarah"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "more than one active share" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_stop_share_names_nobody_when_no_active_share_matches(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService, "list_active_owner_grants", autospec=True, return_value=[]
            ),
        ):
            result = await run_app_action(
                "location.stop_share", {"person": "nobody"}, _tool_context(state)
            )
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_approve_request_grants_exactly_what_was_asked(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_owner_requests",
                autospec=True,
                return_value=[{"id": "r1", "requesterDisplayName": "Asker"}],
            ),
            patch.object(OneLocationAgentService, "approve_request", autospec=True) as approve_mock,
        ):
            result = await run_app_action(
                "location.approve_request", {"person": "asker"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Asker" in result["message"]
        # None/None means "give them what they asked for" -- a voice approval
        # never renegotiates duration, unlike the browser's Approve control.
        assert approve_mock.call_args.kwargs == {
            "owner_user_id": "user_1",
            "request_id": "r1",
            "approval_mode": "manual",
            "duration_hours": None,
            "duration_mode": None,
        }

    @pytest.mark.asyncio
    async def test_decline_request_denies_the_matched_request(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_owner_requests",
                autospec=True,
                return_value=[{"id": "r1", "requesterDisplayName": "Asker"}],
            ),
            patch.object(OneLocationAgentService, "deny_request", autospec=True) as deny_mock,
        ):
            result = await run_app_action(
                "location.decline_request", {"person": "asker"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert deny_mock.call_args.kwargs == {"owner_user_id": "user_1", "request_id": "r1"}

    @pytest.mark.asyncio
    async def test_decline_request_names_nobody_waiting_when_unmatched(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_owner_requests",
                autospec=True,
                return_value=[],
            ),
        ):
            result = await run_app_action(
                "location.decline_request", {"person": "nobody"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "nobody is waiting" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_stop_share_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                return_value=[
                    {"id": "g1", "recipientDisplayName": "Sarah Chen"},
                    {"id": "g2", "recipientDisplayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(OneLocationAgentService, "revoke_grant", autospec=True) as revoke_mock,
        ):
            result = await run_app_action(
                "location.stop_share", {"person": "Sarah Chen and Abdul"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Abdul Gaffar" in result["message"]
        assert revoke_mock.call_count == 2
        called_grant_ids = {c.kwargs["grant_id"] for c in revoke_mock.call_args_list}
        assert called_grant_ids == {"g1", "g2"}

    @pytest.mark.asyncio
    async def test_stop_share_reports_names_it_could_not_match_alongside_the_ones_that_worked(
        self,
    ):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                return_value=[{"id": "g1", "recipientDisplayName": "Sarah Chen"}],
            ),
            patch.object(OneLocationAgentService, "revoke_grant", autospec=True) as revoke_mock,
        ):
            result = await run_app_action(
                "location.stop_share", {"person": "Sarah Chen and Zachary"}, _tool_context(state)
            )
        # Whoever DID resolve is still acted on -- a name that fails to
        # resolve must never silently withhold the ones that did.
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Zachary" in result["message"]
        revoke_mock.assert_called_once()
        assert revoke_mock.call_args.kwargs == {"owner_user_id": "user_1", "grant_id": "g1"}

    @pytest.mark.asyncio
    async def test_approve_request_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_owner_requests",
                autospec=True,
                return_value=[
                    {"id": "r1", "requesterDisplayName": "Sarah Chen"},
                    {"id": "r2", "requesterDisplayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(OneLocationAgentService, "approve_request", autospec=True) as approve_mock,
        ):
            result = await run_app_action(
                "location.approve_request",
                {"person": "Sarah Chen and Abdul"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Abdul Gaffar" in result["message"]
        assert approve_mock.call_count == 2
        called_request_ids = {c.kwargs["request_id"] for c in approve_mock.call_args_list}
        assert called_request_ids == {"r1", "r2"}

    @pytest.mark.asyncio
    async def test_decline_request_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_owner_requests",
                autospec=True,
                return_value=[
                    {"id": "r1", "requesterDisplayName": "Sarah Chen"},
                    {"id": "r2", "requesterDisplayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(OneLocationAgentService, "deny_request", autospec=True) as deny_mock,
        ):
            result = await run_app_action(
                "location.decline_request",
                {"person": "Sarah Chen and Abdul"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert deny_mock.call_count == 2
        called_request_ids = {c.kwargs["request_id"] for c in deny_mock.call_args_list}
        assert called_request_ids == {"r1", "r2"}


class TestIsBackendDirectPredicate:
    """_is_backend_direct is the one predicate every backend-direct
    eligibility check (available_action_ids guard, screen-reachability
    guard, final dispatch) must share -- covering it directly is cheaper
    than re-deriving its three call sites' agreement indirectly."""

    def test_unconditional_ids_are_always_eligible(self):
        for action_id in BACKEND_DIRECT_ACTION_IDS:
            assert _is_backend_direct(action_id, {}) is True
            assert _is_backend_direct(action_id, {"person": "Sarah"}) is True

    def test_conditional_ids_require_a_named_person(self):
        for action_id in BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS:
            assert _is_backend_direct(action_id, {"person": "Sarah"}) is True
            assert _is_backend_direct(action_id, {}) is False
            assert _is_backend_direct(action_id, {"person": ""}) is False
            assert _is_backend_direct(action_id, {"person": "   "}) is False

    def test_an_unrelated_action_id_is_never_eligible(self):
        assert _is_backend_direct("route.one_location", {"person": "Sarah"}) is False


class TestBackendDirectLocationShareSelected:
    """location.share_selected -- backend-direct only once a person is named,
    with the client-side coordinate encrypt-and-publish step handed off via
    a new publish_location_envelopes directive rather than attempted here."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_creates_a_grant_and_parks_a_publish_directive(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"}],
            ),
            patch.object(
                OneLocationAgentService,
                "create_grant",
                autospec=True,
                return_value={"id": "g1"},
            ) as create_mock,
        ):
            result = await run_app_action(
                "location.share_selected",
                {"person": "Sarah", "duration_hours": "2"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert create_mock.call_args.kwargs == {
            "owner_user_id": "user_1",
            "recipient_user_id": "u1",
            "recipient_key_id": "k1",
            "duration_hours": 2.0,
            "duration_mode": "timed",
            "enforce_connection": True,
        }
        publish_key = f"{_STATE_PENDING_DIRECTIVE}:location.share_selected:publish"
        assert publish_key in state
        directive = state[publish_key]
        assert directive["kind"] == "publish_location_envelopes"
        assert directive["payload"]["shares"] == [
            {
                "grantId": "g1",
                "recipientKeyId": "k1",
                "recipientUserId": "u1",
                "label": "Sarah Chen",
            }
        ]
        # The result directive is a SEPARATE key from the publish directive --
        # both must reach the browser, not just whichever key survives a
        # state_delta merge last.
        result_key = f"{_STATE_PENDING_DIRECTIVE}:location.share_selected:result"
        assert result_key in state
        assert state[result_key]["kind"] == "action_result"

    @pytest.mark.asyncio
    async def test_handles_multiple_people_and_parks_one_share_per_grant(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"},
                    {"userId": "u2", "displayName": "Abdul Gaffar", "keyId": "k2"},
                ],
            ),
            patch.object(
                OneLocationAgentService,
                "create_grant",
                autospec=True,
                side_effect=[{"id": "g1"}, {"id": "g2"}],
            ),
        ):
            result = await run_app_action(
                "location.share_selected",
                {"person": "Sarah Chen and Abdul", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        publish_key = f"{_STATE_PENDING_DIRECTIVE}:location.share_selected:publish"
        shares = state[publish_key]["payload"]["shares"]
        assert {s["grantId"] for s in shares} == {"g1", "g2"}

    @pytest.mark.asyncio
    async def test_asks_for_a_duration_before_ever_reaching_backend_direct(self):
        # duration_hours is a contract-required slot for this action (the
        # same generic _missing_required_slot check every action gets) --
        # omitting it must be refused before create_grant is ever attempted,
        # the same as it would be for the pre-existing frontend path.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(OneLocationAgentService, "create_grant", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "location.share_selected", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "input_needed"
        assert result["missing_slot"] == "duration_hours"
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_until_stopped_is_a_real_open_ended_share(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"}],
            ),
            patch.object(
                OneLocationAgentService, "create_grant", autospec=True, return_value={"id": "g1"}
            ) as create_mock,
        ):
            await run_app_action(
                "location.share_selected",
                {"person": "Sarah", "duration_hours": "until_stopped"},
                _tool_context(state),
            )
        assert create_mock.call_args.kwargs["duration_hours"] is None
        assert create_mock.call_args.kwargs["duration_mode"] == "until_stopped"

    @pytest.mark.asyncio
    async def test_refuses_a_duration_outside_the_real_bounds(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"}],
            ),
            patch.object(OneLocationAgentService, "create_grant", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "location.share_selected",
                {"person": "Sarah", "duration_hours": "48"},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_reports_ambiguous_matches_instead_of_guessing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"},
                    {"userId": "u2", "displayName": "Sarah Lee", "keyId": "k2"},
                ],
            ),
            patch.object(OneLocationAgentService, "create_grant", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "location.share_selected",
                {"person": "Sarah", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        assert "more than one connection" in result["message"].lower()
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_falls_through_to_the_normal_directive_when_no_person_is_named(self):
        # No person slot -- must NOT go backend-direct. The tap-then-voice
        # hybrid flow (select on screen, then say "share it") depends on
        # this: share_selected's own local handler still reads
        # selectedRecipientIds, not slots.person.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(OneLocationAgentService, "create_grant", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "location.share_selected", {"duration_hours": "1"}, _tool_context(state)
            )
        create_mock.assert_not_called()
        assert result["status"] in ("ready_to_run", "confirm_pending")
        directive_keys = [k for k in state if k.startswith(f"{_STATE_PENDING_DIRECTIVE}:")]
        assert directive_keys, "expected a normal directive to be parked"
        assert state[directive_keys[0]]["kind"] == "action"
        assert state[directive_keys[0]]["payload"]["actionId"] == "location.share_selected"


class TestBackendDirectLocationSendRequest:
    """location.send_request -- backend-direct only once a person is named;
    falls through to the existing composer-selection path otherwise, which
    location.send_request's own local handler (no slots param at all) keeps
    working exactly as before."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_resolves_against_the_same_pool_share_selected_uses_and_sends(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen"}],
            ),
            patch.object(OneLocationAgentService, "request_access", autospec=True) as request_mock,
        ):
            result = await run_app_action(
                "location.send_request",
                {"person": "Sarah", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert request_mock.call_args.kwargs == {
            "requester_user_id": "user_1",
            "owner_user_id": "u1",
            "requested_duration_hours": 1.0,
            "requested_duration_mode": "timed",
        }

    @pytest.mark.asyncio
    async def test_accepts_a_spoken_duration(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen"}],
            ),
            patch.object(OneLocationAgentService, "request_access", autospec=True) as request_mock,
        ):
            await run_app_action(
                "location.send_request",
                {"person": "Sarah", "duration_hours": "2"},
                _tool_context(state),
            )
        assert request_mock.call_args.kwargs["requested_duration_hours"] == 2.0

    @pytest.mark.asyncio
    async def test_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen"},
                    {"userId": "u2", "displayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(OneLocationAgentService, "request_access", autospec=True) as request_mock,
        ):
            result = await run_app_action(
                "location.send_request",
                {"person": "Sarah Chen and Abdul", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert request_mock.call_count == 2
        called_ids = {c.kwargs["owner_user_id"] for c in request_mock.call_args_list}
        assert called_ids == {"u1", "u2"}

    @pytest.mark.asyncio
    async def test_reports_ambiguous_matches_instead_of_guessing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen"},
                    {"userId": "u2", "displayName": "Sarah Lee"},
                ],
            ),
            patch.object(OneLocationAgentService, "request_access", autospec=True) as request_mock,
        ):
            result = await run_app_action(
                "location.send_request",
                {"person": "Sarah", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        assert "more than one connection" in result["message"].lower()
        request_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_falls_through_to_the_normal_directive_when_no_person_is_named(self):
        # No person slot -- must NOT go backend-direct. It parks the usual
        # {kind: "action"} directive so the browser's own send_request
        # handler (which reads selectedRequestOwners, not slots) still runs.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(OneLocationAgentService, "request_access", autospec=True) as request_mock,
        ):
            result = await run_app_action(
                "location.send_request",
                {"duration_hours": "1"},
                _tool_context(state),
            )
        request_mock.assert_not_called()
        assert result["status"] in ("ready_to_run", "confirm_pending")
        directive_keys = [k for k in state if k.startswith(f"{_STATE_PENDING_DIRECTIVE}:")]
        assert directive_keys, "expected a normal directive to be parked"
        assert state[directive_keys[0]]["kind"] == "action"
        assert state[directive_keys[0]]["payload"]["actionId"] == "location.send_request"


class TestBackendDirectCircleMembershipActions:
    """location.create_circle / add_to_circle / rename_circle."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_create_circle_creates_with_the_spoken_name_and_kind(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(OneLocationCircleService, "list_circles", autospec=True, return_value=[]),
            patch.object(
                OneLocationCircleService,
                "create_circle",
                autospec=True,
                return_value={"id": "c1", "name": "Book Club"},
            ) as create_mock,
        ):
            result = await run_app_action(
                "location.create_circle",
                {"name": "Book Club", "kind": "friends"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Book Club" in result["message"]
        assert create_mock.call_args.kwargs == {
            "owner_user_id": "user_1",
            "name": "Book Club",
            "kind": "friends",
        }

    @pytest.mark.asyncio
    async def test_create_circle_is_a_no_op_success_when_the_name_already_exists(self):
        # Exact name only, matching the browser handler: a duplicate is
        # answered, not silently merged into or re-created.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(OneLocationCircleService, "create_circle", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "location.create_circle", {"name": "family"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "already have a circle" in result["message"].lower()
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_add_to_circle_resolves_the_circle_and_the_people_then_invites_them(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "list_eligible_direct_connections",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Priya Singh"}],
            ),
            patch.object(
                OneLocationCircleService,
                "create_member_invites",
                autospec=True,
                return_value={"addedUserIds": ["u1"]},
            ) as invite_mock,
        ):
            result = await run_app_action(
                "location.add_to_circle",
                {"circle": "family", "person": "priya"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Priya Singh" in result["message"]
        assert invite_mock.call_args.kwargs == {
            "actor_user_id": "user_1",
            "circle_id": "c1",
            "invitee_user_ids": ["u1"],
        }

    @pytest.mark.asyncio
    async def test_add_to_circle_reports_ambiguous_people_instead_of_guessing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "list_eligible_direct_connections",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen"},
                    {"userId": "u2", "displayName": "Sarah Lee"},
                ],
            ),
            patch.object(
                OneLocationCircleService, "create_member_invites", autospec=True
            ) as invite_mock,
        ):
            result = await run_app_action(
                "location.add_to_circle",
                {"circle": "family", "person": "sarah"},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        assert "more than one person" in result["message"].lower()
        invite_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_rename_circle_renames_to_the_spoken_name(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "update_circle",
                autospec=True,
                return_value={"id": "c1", "name": "The Family"},
            ) as update_mock,
        ):
            result = await run_app_action(
                "location.rename_circle",
                {"circle": "family", "name": "The Family"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "The Family" in result["message"]
        assert update_mock.call_args.kwargs == {
            "owner_user_id": "user_1",
            "circle_id": "c1",
            "name": "The Family",
        }

    @pytest.mark.asyncio
    async def test_rename_circle_is_a_no_op_success_when_already_called_that(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(OneLocationCircleService, "update_circle", autospec=True) as update_mock,
        ):
            result = await run_app_action(
                "location.rename_circle",
                {"circle": "family", "name": "family"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "already called that" in result["message"].lower()
        update_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_rename_circle_refuses_a_name_already_used_by_another_circle(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[
                    {"id": "c1", "name": "Family"},
                    {"id": "c2", "name": "Roommates"},
                ],
            ),
            patch.object(OneLocationCircleService, "update_circle", autospec=True) as update_mock,
        ):
            result = await run_app_action(
                "location.rename_circle",
                {"circle": "family", "name": "roommates"},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        assert "already have a circle" in result["message"].lower()
        update_mock.assert_not_called()


class TestBackendDirectConnectionActions:
    """connect.remove_connection (two-step confirm) / connect.cancel_request."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_remove_connection_first_call_asks_and_touches_nothing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[{"connectionId": "cx1", "displayName": "Roopmann"}],
            ),
            patch.object(ConnectionsService, "remove_connection", autospec=True) as remove_mock,
        ):
            result = await run_app_action(
                "connect.remove_connection", {"person": "roopmann"}, _tool_context(state)
            )
        assert result["status"] == "blocked"
        assert "roopmann" in result["message"].lower()
        remove_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_remove_connection_unconfirmed_refusal_does_not_block_a_confirmed_retry(self):
        # The not-yet-confirmed response must not trip the already-failed
        # loop guard -- a real "yes" a moment later has to still go through.
        state = self._authorized_state()
        ctx = SimpleNamespace(state=state, session=SimpleNamespace(id="session_1"))
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[{"connectionId": "cx1", "displayName": "Roopmann"}],
            ),
            patch.object(ConnectionsService, "remove_connection", autospec=True) as remove_mock,
        ):
            first = await run_app_action("connect.remove_connection", {"person": "roopmann"}, ctx)
            assert first["status"] == "blocked"
            second = await run_app_action(
                "connect.remove_connection",
                {"person": "roopmann", "confirmed": True},
                ctx,
            )
        assert second["status"] == "completed"
        assert remove_mock.call_args.kwargs == {"user_id": "user_1", "connection_id": "cx1"}

    @pytest.mark.asyncio
    async def test_remove_connection_ambiguous_name_is_never_confirmed_or_removed(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[
                    {"connectionId": "cx1", "displayName": "Sarah Chen"},
                    {"connectionId": "cx2", "displayName": "Sarah Lee"},
                ],
            ),
            patch.object(ConnectionsService, "remove_connection", autospec=True) as remove_mock,
        ):
            result = await run_app_action(
                "connect.remove_connection",
                {"person": "sarah", "confirmed": True},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        assert "more than one connection" in result["message"].lower()
        remove_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_cancel_request_cancels_the_matched_outgoing_request(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                return_value=[{"id": "req1", "counterpartDisplayName": "Asker"}],
            ),
            patch.object(ConnectionsService, "cancel_request", autospec=True) as cancel_mock,
        ):
            result = await run_app_action(
                "connect.cancel_request", {"person": "asker"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Asker" in result["message"]
        assert cancel_mock.call_args.kwargs == {"user_id": "user_1", "request_id": "req1"}

    @pytest.mark.asyncio
    async def test_cancel_request_names_no_pending_request_when_unmatched(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(ConnectionsService, "list_requests", autospec=True, return_value=[]),
        ):
            result = await run_app_action(
                "connect.cancel_request", {"person": "nobody"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "no pending request" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_remove_connection_confirmation_names_every_resolved_person(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[
                    {"connectionId": "cx1", "displayName": "Sarah Chen"},
                    {"connectionId": "cx2", "displayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(ConnectionsService, "remove_connection", autospec=True) as remove_mock,
        ):
            result = await run_app_action(
                "connect.remove_connection",
                {"person": "Sarah Chen and Abdul"},
                _tool_context(state),
            )
        assert result["status"] == "blocked"
        assert "sarah chen" in result["message"].lower()
        assert "abdul gaffar" in result["message"].lower()
        remove_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_remove_connection_confirmed_removes_every_resolved_person(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[
                    {"connectionId": "cx1", "displayName": "Sarah Chen"},
                    {"connectionId": "cx2", "displayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(ConnectionsService, "remove_connection", autospec=True) as remove_mock,
        ):
            result = await run_app_action(
                "connect.remove_connection",
                {"person": "Sarah Chen and Abdul", "confirmed": True},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert remove_mock.call_count == 2
        called_connection_ids = {c.kwargs["connection_id"] for c in remove_mock.call_args_list}
        assert called_connection_ids == {"cx1", "cx2"}

    @pytest.mark.asyncio
    async def test_cancel_request_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                return_value=[
                    {"id": "req1", "counterpartDisplayName": "Sarah Chen"},
                    {"id": "req2", "counterpartDisplayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(ConnectionsService, "cancel_request", autospec=True) as cancel_mock,
        ):
            result = await run_app_action(
                "connect.cancel_request",
                {"person": "Sarah Chen and Abdul"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert cancel_mock.call_count == 2
        called_request_ids = {c.kwargs["request_id"] for c in cancel_mock.call_args_list}
        assert called_request_ids == {"req1", "req2"}

    @pytest.mark.asyncio
    async def test_accept_request_accepts_the_matched_incoming_request(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                return_value=[{"id": "req1", "counterpartDisplayName": "Sarah Chen"}],
            ),
            patch.object(ConnectionsService, "accept_request", autospec=True) as accept_mock,
        ):
            result = await run_app_action(
                "connect.accept_request", {"person": "sarah"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "connected" in result["message"].lower()
        assert accept_mock.call_args.kwargs == {"user_id": "user_1", "request_id": "req1"}

    @pytest.mark.asyncio
    async def test_accept_request_names_no_pending_request_when_unmatched(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(ConnectionsService, "list_requests", autospec=True, return_value=[]),
        ):
            result = await run_app_action(
                "connect.accept_request", {"person": "nobody"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "no pending request" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_reject_request_declines_the_matched_incoming_request(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                return_value=[{"id": "req1", "counterpartDisplayName": "Sarah Chen"}],
            ),
            patch.object(ConnectionsService, "reject_request", autospec=True) as reject_mock,
        ):
            result = await run_app_action(
                "connect.reject_request", {"person": "sarah"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "declined" in result["message"].lower()
        assert reject_mock.call_args.kwargs == {"user_id": "user_1", "request_id": "req1"}

    @pytest.mark.asyncio
    async def test_accept_request_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                return_value=[
                    {"id": "req1", "counterpartDisplayName": "Sarah Chen"},
                    {"id": "req2", "counterpartDisplayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(ConnectionsService, "accept_request", autospec=True) as accept_mock,
        ):
            result = await run_app_action(
                "connect.accept_request",
                {"person": "Sarah Chen and Abdul"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert accept_mock.call_count == 2
        called_request_ids = {c.kwargs["request_id"] for c in accept_mock.call_args_list}
        assert called_request_ids == {"req1", "req2"}

    @pytest.mark.asyncio
    async def test_accept_request_reports_who_succeeded_when_one_of_two_fails(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                return_value=[
                    {"id": "req1", "counterpartDisplayName": "Sarah Chen"},
                    {"id": "req2", "counterpartDisplayName": "Abdul Gaffar"},
                ],
            ),
            patch.object(
                ConnectionsService,
                "accept_request",
                autospec=True,
                side_effect=[None, RuntimeError("connection pool exhausted")],
            ),
        ):
            result = await run_app_action(
                "connect.accept_request",
                {"person": "Sarah Chen and Abdul"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Abdul Gaffar" in result["message"]

    @pytest.mark.asyncio
    async def test_send_request_names_the_accept_action_when_already_asked(self):
        # The exact bug a real session hit: the message told the person to
        # "accept theirs instead" with no action for the model to call for
        # it. Pin that the message now names the real action id.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {
                            "userId": "u1",
                            "displayName": "Sarah Chen",
                            "relationship": "pending_incoming",
                        }
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": False, "updatedAt": None},
            ),
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "connect.accept_request" in result["message"]

    @pytest.mark.asyncio
    async def test_send_request_resolves_via_directory_search_and_sends(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"}
                    ],
                    "hasMore": False,
                },
            ) as search_mock,
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": False, "updatedAt": None},
            ),
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert search_mock.call_args.kwargs["query"] == "Sarah"
        create_mock.assert_called_once()
        assert create_mock.call_args.args[1] == "user_1"
        # Default (no reuse) still passes both scope-handle kwargs, just as
        # None -- create_request already treats that identically to omitting
        # them, so today's always-empty behavior is unchanged.
        assert create_mock.call_args.kwargs == {
            "addressee_user_id": "u1",
            "requested_scope_handles": None,
            "offered_scope_handles": None,
        }

    @pytest.mark.asyncio
    async def test_send_request_handles_multiple_people_in_one_turn(self):
        state = self._authorized_state()

        def fake_search_directory(self, user_id, *, query, page, limit):
            people = {
                "Sarah": {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"},
                "Abdul": {"userId": "u2", "displayName": "Abdul Gaffar", "relationship": "none"},
            }
            return {"items": [people[query]], "hasMore": False}

        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                side_effect=fake_search_directory,
            ),
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": False, "updatedAt": None},
            ),
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah Chen and Abdul"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Abdul Gaffar" in result["message"]
        assert create_mock.call_count == 2
        called_ids = {c.kwargs["addressee_user_id"] for c in create_mock.call_args_list}
        assert called_ids == {"u1", "u2"}

    @pytest.mark.asyncio
    async def test_send_request_reuses_last_scopes_when_the_toggle_is_on_and_history_exists(
        self,
    ):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"}
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": True, "updatedAt": None},
            ),
            patch.object(
                ConnectionsService,
                "get_last_request_scope_handles",
                autospec=True,
                return_value={
                    "requestedScopeHandles": ["location.live"],
                    "offeredScopeHandles": ["calendar.busy"],
                },
            ) as history_mock,
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        history_mock.assert_called_once()
        assert history_mock.call_args.kwargs == {
            "requester_user_id": "user_1",
            "addressee_user_id": "u1",
        }
        assert create_mock.call_args.kwargs == {
            "addressee_user_id": "u1",
            "requested_scope_handles": ["location.live"],
            "offered_scope_handles": ["calendar.busy"],
        }

    @pytest.mark.asyncio
    async def test_send_request_never_guesses_scopes_for_a_first_time_recipient(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"}
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": True, "updatedAt": None},
            ),
            patch.object(
                ConnectionsService,
                "get_last_request_scope_handles",
                autospec=True,
                return_value={"requestedScopeHandles": [], "offeredScopeHandles": []},
            ),
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        # Empty history normalizes to None, identical to the toggle-off path --
        # never an empty list standing in for "definitely no scopes chosen".
        assert create_mock.call_args.kwargs == {
            "addressee_user_id": "u1",
            "requested_scope_handles": None,
            "offered_scope_handles": None,
        }

    @pytest.mark.asyncio
    async def test_send_request_reports_already_connected_as_success_not_failure(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {"userId": "u1", "displayName": "Sarah Chen", "relationship": "connected"}
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "already connected" in result["message"].lower()
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_request_blocks_a_pending_outgoing_request_without_resending(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {
                            "userId": "u1",
                            "displayName": "Sarah Chen",
                            "relationship": "pending_outgoing",
                        }
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "waiting on them" in result["message"].lower()
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_request_reports_ambiguous_matches_instead_of_guessing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"},
                        {"userId": "u2", "displayName": "Sarah Lee", "relationship": "none"},
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(ConnectionsService, "create_request", autospec=True) as create_mock,
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "more than one person" in result["message"].lower()
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_request_names_the_person_it_could_not_find(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={"items": [], "hasMore": False},
            ),
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Zachary"}, _tool_context(state)
            )
        assert result["status"] == "failed"
        assert "zachary" in result["message"].lower()


class TestBackendDirectActionResultSubject:
    """The action-result directive's `subject` field, so the browser's
    action card can show who a backend-direct action was about instead of
    just the spoken message text. Populated from the exact same resolved
    display names each branch already joins into its message -- see
    _execute_backend_direct_mutation's per-branch subject tuple element."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    def _parked_subject(self, state: dict, action_id: str):
        parked = state[f"{_STATE_PENDING_DIRECTIVE}:{action_id}:result"]
        return parked["payload"].get("subject")

    @pytest.mark.asyncio
    async def test_circle_only_actions_carry_no_subject(self):
        # No person is named -- leave_circle acts on a circle, not someone.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(OneLocationCircleService, "leave_circle", autospec=True),
        ):
            await run_app_action(
                "location.leave_circle", {"circle": "family"}, _tool_context(state)
            )
        assert self._parked_subject(state, "location.leave_circle") is None

    @pytest.mark.asyncio
    async def test_single_person_action_carries_their_resolved_name(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "list_eligible_direct_connections",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen"}],
            ),
            patch.object(
                OneLocationCircleService,
                "create_member_invites",
                autospec=True,
                return_value={"addedUserIds": ["u1"]},
            ),
        ):
            await run_app_action(
                "location.add_to_circle",
                {"circle": "family", "person": "Sarah"},
                _tool_context(state),
            )
        assert self._parked_subject(state, "location.add_to_circle") == {"name": "Sarah Chen"}

    @pytest.mark.asyncio
    async def test_multi_person_action_joins_every_resolved_name(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"},
                    {"userId": "u2", "displayName": "Abdul Gaffar", "keyId": "k2"},
                ],
            ),
            patch.object(
                OneLocationAgentService,
                "create_grant",
                autospec=True,
                side_effect=[{"id": "g1"}, {"id": "g2"}],
            ),
        ):
            await run_app_action(
                "location.share_selected",
                {"person": "Sarah Chen and Abdul", "duration_hours": "1"},
                _tool_context(state),
            )
        assert self._parked_subject(state, "location.share_selected") == {
            "name": "Sarah Chen and Abdul Gaffar"
        }

    @pytest.mark.asyncio
    async def test_connect_send_request_subject_names_who_it_actually_reached(self):
        # The most structurally different branch: outcomes are bucketed by
        # relationship (sent / already-connected / blocked / not-found), so
        # the subject must still name the people the action was about, not
        # just those it sent a fresh request to.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                return_value={
                    "items": [
                        {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"}
                    ],
                    "hasMore": False,
                },
            ),
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": False, "updatedAt": None},
            ),
            patch.object(ConnectionsService, "create_request", autospec=True),
        ):
            await run_app_action("connect.send_request", {"person": "Sarah"}, _tool_context(state))
        assert self._parked_subject(state, "connect.send_request") == {"name": "Sarah Chen"}

    @pytest.mark.asyncio
    async def test_remove_connection_subject_arrives_only_on_the_confirmed_completion(self):
        # The first, unconfirmed call is a "blocked" ask, not a completion --
        # no action_result directive exists yet for subject to attach to.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[{"connectionId": "cx1", "displayName": "Roopmann"}],
            ),
            patch.object(ConnectionsService, "remove_connection", autospec=True),
        ):
            await run_app_action(
                "connect.remove_connection", {"person": "roopmann"}, _tool_context(state)
            )
            assert f"{_STATE_PENDING_DIRECTIVE}:connect.remove_connection:result" not in state
            await run_app_action(
                "connect.remove_connection",
                {"person": "roopmann", "confirmed": True},
                _tool_context(state),
            )
        assert self._parked_subject(state, "connect.remove_connection") == {"name": "Roopmann"}


class TestBackendDirectPartialFailureResilience:
    """A multi-person mutation loop must never let one person's failure lose
    or hide what already happened to the others -- an unprotected loop that
    aborts on the first exception leaves earlier successes unreported (One
    says "that didn't go through" about something that actually did) and,
    worse for location.share_selected specifically, can leave an
    already-created grant with no publish directive: the recipient sees
    "waiting for location" forever with nothing left to retry."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_share_selected_reports_who_succeeded_and_publishes_only_their_envelope(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[
                    {"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"},
                    {"userId": "u2", "displayName": "Bob Diaz", "keyId": "k2"},
                ],
            ),
            patch.object(
                OneLocationAgentService,
                "create_grant",
                autospec=True,
                side_effect=[{"id": "g1"}, RuntimeError("stale recipient key")],
            ),
        ):
            result = await run_app_action(
                "location.share_selected",
                {"person": "Sarah Chen and Bob", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Bob Diaz" in result["message"]  # named in the "could not complete" note
        assert "try again" in result["message"].lower()
        publish_key = f"{_STATE_PENDING_DIRECTIVE}:location.share_selected:publish"
        shares = state[publish_key]["payload"]["shares"]
        # Only Sarah's grant was actually created -- Bob's failed recipient
        # must never get a publish directive parked for a grant that does
        # not exist, and Sarah's must not be lost because Bob failed after her.
        assert [s["grantId"] for s in shares] == ["g1"]
        assert self._parked_subject(state, "location.share_selected") == {"name": "Sarah Chen"}

    @pytest.mark.asyncio
    async def test_share_selected_reports_failed_when_everyone_fails(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_verified_recipients",
                autospec=True,
                return_value=[{"userId": "u1", "displayName": "Sarah Chen", "keyId": "k1"}],
            ),
            patch.object(
                OneLocationAgentService,
                "create_grant",
                autospec=True,
                side_effect=RuntimeError("stale recipient key"),
            ),
        ):
            result = await run_app_action(
                "location.share_selected",
                {"person": "Sarah", "duration_hours": "1"},
                _tool_context(state),
            )
        assert result["status"] == "failed"
        publish_key = f"{_STATE_PENDING_DIRECTIVE}:location.share_selected:publish"
        assert publish_key not in state

    @pytest.mark.asyncio
    async def test_stop_share_reports_who_succeeded_when_one_of_two_fails(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                return_value=[
                    {"id": "g1", "recipientDisplayName": "Sarah Chen"},
                    {"id": "g2", "recipientDisplayName": "Bob Diaz"},
                ],
            ),
            patch.object(
                OneLocationAgentService,
                "revoke_grant",
                autospec=True,
                side_effect=[None, RuntimeError("connection pool exhausted")],
            ),
        ):
            result = await run_app_action(
                "location.stop_share", {"person": "Sarah Chen and Bob"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Bob Diaz" in result["message"]
        assert "try again" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_remove_connection_reports_who_succeeded_when_one_of_two_fails(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[
                    {"connectionId": "cx1", "displayName": "Sarah Chen"},
                    {"connectionId": "cx2", "displayName": "Bob Diaz"},
                ],
            ),
            patch.object(
                ConnectionsService,
                "remove_connection",
                autospec=True,
                side_effect=[None, RuntimeError("connection pool exhausted")],
            ),
        ):
            result = await run_app_action(
                "connect.remove_connection",
                {"person": "Sarah Chen and Bob", "confirmed": True},
                _tool_context(state),
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Bob Diaz" in result["message"]
        assert "try again" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_connect_send_request_reports_who_succeeded_when_one_of_two_fails(self):
        state = self._authorized_state()

        def fake_search_directory(self, user_id, *, query, page, limit):
            people = {
                "Sarah": {"userId": "u1", "displayName": "Sarah Chen", "relationship": "none"},
                "Bob": {"userId": "u2", "displayName": "Bob Diaz", "relationship": "none"},
            }
            return {"items": [people[query]], "hasMore": False}

        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "search_directory",
                autospec=True,
                side_effect=fake_search_directory,
            ),
            patch.object(
                ConnectionsService,
                "get_voice_preferences",
                autospec=True,
                return_value={"shareScopesFromLastRequest": False, "updatedAt": None},
            ),
            patch.object(
                ConnectionsService,
                "create_request",
                autospec=True,
                side_effect=[None, RuntimeError("connection pool exhausted")],
            ),
        ):
            result = await run_app_action(
                "connect.send_request", {"person": "Sarah and Bob"}, _tool_context(state)
            )
        assert result["status"] == "completed"
        assert "Sarah Chen" in result["message"]
        assert "Bob Diaz" in result["message"]
        assert "try again" in result["message"].lower()

    def _parked_subject(self, state: dict, action_id: str):
        parked = state[f"{_STATE_PENDING_DIRECTIVE}:{action_id}:result"]
        return parked["payload"].get("subject")


class TestBackendDirectLocationReadTools:
    """list_my_location_circles / list_my_location_shares /
    list_location_shared_with_me / list_pending_location_requests -- plain
    root-agent tools, no specialist detour, no dependency on anything the
    frontend published. Each test's state carries only STATE_USER_ID/
    STATE_CONSENT_TOKEN -- no hussh:screen, no hussh:voice_context at all --
    which is itself the proof these tools need nothing from the frontend."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_list_my_location_circles_reads_live_from_the_service(self):
        state = self._authorized_state()
        assert _STATE_SCREEN not in state
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ) as list_mock,
        ):
            result = await list_my_location_circles(_tool_context(state))
        assert result["status"] == "ok"
        assert result["circles"] == [{"id": "c1", "name": "Family"}]
        assert list_mock.call_args.kwargs == {"user_id": "user_1"}

    @pytest.mark.asyncio
    async def test_list_my_location_shares_reads_active_owner_grants(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                return_value=[{"id": "g1", "recipientDisplayName": "Roopmann"}],
            ) as grants_mock,
        ):
            result = await list_my_location_shares(_tool_context(state))
        assert result["status"] == "ok"
        assert result["shares"][0]["recipientDisplayName"] == "Roopmann"
        assert grants_mock.call_args.kwargs == {"owner_user_id": "user_1"}

    @pytest.mark.asyncio
    async def test_list_location_shared_with_me_reads_active_recipient_grants(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_recipient_grants",
                autospec=True,
                return_value=[{"id": "g2", "ownerDisplayName": "Friend"}],
            ) as grants_mock,
        ):
            result = await list_location_shared_with_me(_tool_context(state))
        assert result["status"] == "ok"
        assert result["shares"][0]["ownerDisplayName"] == "Friend"
        assert grants_mock.call_args.kwargs == {"recipient_user_id": "user_1"}

    @pytest.mark.asyncio
    async def test_list_pending_location_requests_reads_pending_owner_requests(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_owner_requests",
                autospec=True,
                return_value=[{"id": "r1", "requesterDisplayName": "Asker"}],
            ) as requests_mock,
        ):
            result = await list_pending_location_requests(_tool_context(state))
        assert result["status"] == "ok"
        assert result["requests"][0]["requesterDisplayName"] == "Asker"
        assert requests_mock.call_args.kwargs == {"owner_user_id": "user_1"}

    @pytest.mark.asyncio
    async def test_list_my_outgoing_location_requests_reads_pending_requester_requests(self):
        """The mirror of list_pending_location_requests, other direction --
        without this, One had a tool for 'who is waiting on me' but none for
        'who am I waiting on', which is exactly the gap live testing found."""
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_pending_requester_requests",
                autospec=True,
                return_value=[{"id": "r2", "ownerDisplayName": "Sarah"}],
            ) as requests_mock,
        ):
            result = await list_my_outgoing_location_requests(_tool_context(state))
        assert result["status"] == "ok"
        assert result["requests"][0]["ownerDisplayName"] == "Sarah"
        assert requests_mock.call_args.kwargs == {"requester_user_id": "user_1"}

    @pytest.mark.asyncio
    async def test_get_location_circle_members_returns_names_not_just_a_count(self):
        """list_my_location_circles only ever returns member_count -- this is
        the tool for the actual names, which live testing found nothing
        answered "who is in my Family circle" with."""
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "get_circle",
                autospec=True,
                return_value={
                    "name": "Family",
                    "kind": "trusted",
                    "members": [
                        {
                            "displayName": "Sarah Chen",
                            "role": "owner",
                            "relationship": "self",
                            "keyId": "should-not-leak",
                            "publicKeyJwk": {"kty": "EC"},
                        },
                        {"displayName": "Alex Kim", "role": "member", "relationship": "connected"},
                    ],
                },
            ) as get_circle_mock,
        ):
            result = await get_location_circle_members("Family", _tool_context(state))
        assert result["status"] == "ok"
        assert result["circle"] == {"name": "Family", "kind": "trusted"}
        assert result["members"] == [
            {"displayName": "Sarah Chen", "role": "owner", "relationship": "self"},
            {"displayName": "Alex Kim", "role": "member", "relationship": "connected"},
        ]
        # Public key material never reaches the model, even though it is
        # cryptographically "public" -- a voice transcript has no business
        # carrying it.
        assert "keyId" not in result["members"][0]
        assert "publicKeyJwk" not in result["members"][0]
        assert get_circle_mock.call_args.kwargs == {"user_id": "user_1", "circle_id": "c1"}

    @pytest.mark.asyncio
    async def test_get_location_circle_members_reports_not_found_instead_of_raising(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
        ):
            result = await get_location_circle_members("Coworkers", _tool_context(state))
        assert result["status"] == "not_found"
        # _resolve_named_circle's not-found message names the circles that
        # DO exist, so One can offer them, rather than repeating the miss.
        assert "family" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_get_location_circle_members_reports_ambiguous_instead_of_guessing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[
                    {"id": "c1", "name": "Family Close"},
                    {"id": "c2", "name": "Family Extended"},
                ],
            ),
            patch.object(OneLocationCircleService, "get_circle", autospec=True) as get_circle_mock,
        ):
            result = await get_location_circle_members("Family", _tool_context(state))
        assert result["status"] == "not_found"
        assert "family" in result["message"].lower()
        get_circle_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_refuses_without_a_consent_token(self):
        state = {STATE_USER_ID: "user_1"}  # no STATE_CONSENT_TOKEN
        with patch.object(OneLocationCircleService, "list_circles", autospec=True) as list_mock:
            result = await list_my_location_circles(_tool_context(state))
        assert result["status"] == "blocked"
        list_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_refuses_when_token_fails_revalidation(self):
        state = self._authorized_state()
        with (
            patch(
                "hushh_mcp.one_adk.action_tools.validate_token_with_db",
                new=AsyncMock(return_value=(False, "expired", None)),
            ),
            patch.object(OneLocationCircleService, "list_circles", autospec=True) as list_mock,
        ):
            result = await list_my_location_circles(_tool_context(state))
        assert result["status"] == "blocked"
        list_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_db_hiccup_reading_circles_fails_clean_instead_of_killing_the_session(self):
        # A read tool with no exception boundary lets a raised error escape
        # straight into Gemini Live's tool-response serialization, which has
        # none of its own -- the whole live session dies with no error ever
        # reaching the user, the same way the datetime-serialization bug did.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                side_effect=RuntimeError("connection pool exhausted"),
            ),
        ):
            result = await list_my_location_circles(_tool_context(state))
        assert result["status"] == "failed"
        assert "try again" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_a_known_service_error_reading_shares_returns_its_own_message(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationAgentService,
                "list_active_owner_grants",
                autospec=True,
                side_effect=OneLocationAgentError(
                    "LOCATION_STATE_UNAVAILABLE", "Try again shortly."
                ),
            ),
        ):
            result = await list_my_location_shares(_tool_context(state))
        assert result == {"status": "failed", "message": "Try again shortly."}

    @pytest.mark.asyncio
    async def test_get_location_circle_members_fails_clean_on_an_unexpected_error(self):
        # Distinct from the not_found/ambiguous paths above, which are
        # OneLocationCircleError -- this is the catch-all for everything
        # else, e.g. a DB failure inside get_circle after the name resolved.
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                OneLocationCircleService,
                "list_circles",
                autospec=True,
                return_value=[{"id": "c1", "name": "Family"}],
            ),
            patch.object(
                OneLocationCircleService,
                "get_circle",
                autospec=True,
                side_effect=RuntimeError("connection pool exhausted"),
            ),
        ):
            result = await get_location_circle_members("Family", _tool_context(state))
        assert result["status"] == "failed"
        assert "try again" in result["message"].lower()


class TestBackendDirectConnectionReadTools:
    """list_my_connections / list_pending_connection_requests."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    @pytest.mark.asyncio
    async def test_list_my_connections_reads_live_from_the_service(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[{"connectionId": "cx1", "displayName": "Sarah"}],
            ) as list_mock,
        ):
            result = await list_my_connections(_tool_context(state))
        assert result["status"] == "ok"
        assert result["connections"][0]["displayName"] == "Sarah"
        assert list_mock.call_args.kwargs == {"user_id": "user_1"}

    @pytest.mark.asyncio
    async def test_discovers_exact_opaque_scopes_for_one_connected_person(self):
        state = self._authorized_state()
        profile = {
            "displayName": "Sarah Chen",
            "relationship": {"status": "connected"},
            "requestableScopes": [
                {
                    "scopeRef": "psr_opaque",
                    "label": "Employment status",
                    "description": "Current employment standing",
                    "domain": "professional",
                    "sensitivity": "confidential",
                },
                {
                    "scopeRef": "psr_other",
                    "label": "Favorite cuisine",
                    "domain": "food",
                    "sensitivity": "standard",
                },
            ],
        }
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[
                    {
                        "displayName": "Sarah Chen",
                        "publicPersonRef": "11111111-1111-4111-8111-111111111111",
                    }
                ],
            ),
            patch(
                "hushh_mcp.one_adk.action_tools.PersonProfileService.get_viewer_profile",
                new=AsyncMock(return_value=profile),
            ),
        ):
            result = await discover_person_information(
                "Sarah", _tool_context(state), "professional"
            )
        assert result["status"] == "ok"
        assert result["person"]["profilePath"].startswith("/people/")
        assert result["requestableScopes"] == [
            {
                "scopeRef": "psr_opaque",
                "label": "Employment status",
                "description": "Current employment standing",
                "domain": "professional",
                "sensitivity": "confidential",
            }
        ]
        assert "attr." not in str(result)

    @pytest.mark.asyncio
    async def test_information_discovery_requires_an_unambiguous_connection(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                return_value=[
                    {"displayName": "Alex Kim", "publicPersonRef": "ref-1"},
                    {"displayName": "Alex Singh", "publicPersonRef": "ref-2"},
                ],
            ),
            patch(
                "hushh_mcp.one_adk.action_tools.PersonProfileService.get_viewer_profile",
                new=AsyncMock(),
            ) as profile_mock,
        ):
            result = await discover_person_information("Alex", _tool_context(state))
        assert result["status"] == "needs_clarification"
        assert "Alex Kim" in result["message"]
        profile_mock.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_list_pending_connection_requests_defaults_to_incoming(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService, "list_requests", autospec=True, return_value=[]
            ) as requests_mock,
        ):
            result = await list_pending_connection_requests(_tool_context(state))
        assert result["status"] == "ok"
        assert requests_mock.call_args.kwargs == {"user_id": "user_1", "direction": "incoming"}

    @pytest.mark.asyncio
    async def test_list_pending_connection_requests_accepts_outgoing(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService, "list_requests", autospec=True, return_value=[]
            ) as requests_mock,
        ):
            result = await list_pending_connection_requests(_tool_context(state), "outgoing")
        assert result["status"] == "ok"
        assert requests_mock.call_args.kwargs == {"user_id": "user_1", "direction": "outgoing"}

    @pytest.mark.asyncio
    async def test_refuses_without_a_consent_token(self):
        state = {STATE_USER_ID: "user_1"}  # no STATE_CONSENT_TOKEN
        with patch.object(ConnectionsService, "list_connections", autospec=True) as list_mock:
            result = await list_my_connections(_tool_context(state))
        assert result["status"] == "blocked"
        list_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_db_hiccup_reading_connections_fails_clean_instead_of_killing_the_session(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_connections",
                autospec=True,
                side_effect=RuntimeError("connection pool exhausted"),
            ),
        ):
            result = await list_my_connections(_tool_context(state))
        assert result["status"] == "failed"
        assert "try again" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_a_known_service_error_reading_requests_returns_its_own_message(self):
        state = self._authorized_state()
        with (
            self._auth_patch(),
            patch.object(
                ConnectionsService,
                "list_requests",
                autospec=True,
                side_effect=ConnectionsError("CONNECTIONS_STATE_UNAVAILABLE", "Try again shortly."),
            ),
        ):
            result = await list_pending_connection_requests(_tool_context(state))
        assert result == {"status": "failed", "message": "Try again shortly."}


class _FakePkmIndex:
    def __init__(self, available_domains, domain_summaries):
        self.available_domains = available_domains
        self.domain_summaries = domain_summaries


class TestReadMyPkmDomainSummary:
    """read_my_pkm_domain_summary -- the general PKM domain-summary read tool."""

    def _authorized_state(self) -> dict:
        return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}

    def _auth_patch(self):
        return patch(
            "hushh_mcp.one_adk.action_tools.validate_token_with_db",
            new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
        )

    def _pkm_patch(self, index):
        fake_service = SimpleNamespace(get_index_v2=AsyncMock(return_value=index))
        return patch(
            "hushh_mcp.one_adk.action_tools.get_pkm_service",
            return_value=fake_service,
        )

    @pytest.mark.asyncio
    async def test_reads_the_summary_for_a_domain_the_person_has_data_in(self):
        state = self._authorized_state()
        index = _FakePkmIndex(
            available_domains=["financial", "identity"],
            domain_summaries={
                "financial": {"holdings_count": 12, "portfolio_value_bucket": "100k-250k"}
            },
        )
        with self._auth_patch(), self._pkm_patch(index):
            result = await read_my_pkm_domain_summary("financial", _tool_context(state))
        assert result == {
            "status": "ok",
            "result": {
                "has_data": True,
                "domain": "financial",
                "summary": {"holdings_count": 12, "portfolio_value_bucket": "100k-250k"},
            },
        }

    @pytest.mark.asyncio
    async def test_reports_no_data_rather_than_erroring_for_a_domain_with_none_yet(self):
        state = self._authorized_state()
        index = _FakePkmIndex(available_domains=["identity"], domain_summaries={})
        with self._auth_patch(), self._pkm_patch(index):
            result = await read_my_pkm_domain_summary("financial", _tool_context(state))
        assert result == {
            "status": "ok",
            "result": {"has_data": False, "domain": "financial", "summary": {}},
        }

    @pytest.mark.asyncio
    async def test_normalizes_case_and_whitespace_on_the_spoken_domain(self):
        state = self._authorized_state()
        index = _FakePkmIndex(
            available_domains=["health"], domain_summaries={"health": {"steps_tracked": True}}
        )
        with self._auth_patch(), self._pkm_patch(index):
            result = await read_my_pkm_domain_summary("  Health  ", _tool_context(state))
        assert result["result"]["domain"] == "health"
        assert result["result"]["has_data"] is True

    @pytest.mark.asyncio
    async def test_rejects_an_unknown_domain_and_lists_the_real_ones(self):
        state = self._authorized_state()
        with self._auth_patch():
            result = await read_my_pkm_domain_summary("crypto_wallets", _tool_context(state))
        assert result["status"] == "failed"
        assert "financial" in result["message"]
        assert "health" in result["message"]

    @pytest.mark.asyncio
    async def test_never_reads_back_runtime_secrets_even_if_asked_by_that_exact_key(self):
        # Credential-shaped domain: excluded regardless of what the model
        # passes, not filtered after the fact -- see the module-level
        # _VOICE_UNREADABLE_PKM_DOMAINS comment for why.
        state = self._authorized_state()
        with self._auth_patch():
            result = await read_my_pkm_domain_summary("runtime_secrets", _tool_context(state))
        assert result["status"] == "failed"
        assert "runtime_secrets" not in result["message"].split("Available domains: ")[-1]

    @pytest.mark.asyncio
    async def test_a_db_hiccup_fails_clean_instead_of_killing_the_session(self):
        state = self._authorized_state()
        fake_service = SimpleNamespace(
            get_index_v2=AsyncMock(side_effect=RuntimeError("connection pool exhausted"))
        )
        with (
            self._auth_patch(),
            patch(
                "hushh_mcp.one_adk.action_tools.get_pkm_service",
                return_value=fake_service,
            ),
        ):
            result = await read_my_pkm_domain_summary("financial", _tool_context(state))
        assert result["status"] == "failed"
        assert "try again" in result["message"].lower()


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

    @pytest.mark.asyncio
    async def test_a_shared_alias_resolves_to_the_action_on_this_screen(self):
        """Two actions can own the same alias if they live on different screens.

        "people tab" is the honest name for the People tab on BOTH Connect and
        Location, so neither should give it up -- taking it from one would just
        break that phrase on that surface. The generator's collision guard
        allows the pair for exactly this reason: their reachable screens do not
        overlap.

        What makes that safe is this ordering. Both score identically on an
        exact alias match, and the tie is broken by _AVAILABILITY_ORDER, so
        whichever one is reachable from the screen the person is actually on
        wins. Pinned here because it is the only thing standing between a
        deliberate shared alias and an arbitrary coin flip, and because the
        obvious "fix" for such a pair -- deleting one of the aliases -- would
        be a regression this test should make someone stop and reconsider.
        """
        location_state = {_STATE_SCREEN: "one_location"}
        location_state["hussh:voice_context"] = {
            "route_pattern": "/one/location",
            "screen": "one_location",
            "context_revision": "loc-1",
            "available_action_ids": ["location.open_people"],
        }
        result = await list_app_actions("people tab", _tool_context(location_state))
        ordered = [r["action_id"] for r in result["results"]]
        assert "location.open_people" in ordered
        if "connect.open_people" in ordered:
            assert ordered.index("location.open_people") < ordered.index("connect.open_people"), (
                "the on-screen action must outrank the identically-aliased one"
            )

        connect_state = {_STATE_SCREEN: "connect"}
        connect_state["hussh:voice_context"] = {
            "route_pattern": "/connect",
            "screen": "connect",
            "context_revision": "con-1",
            "available_action_ids": ["connect.open_people"],
        }
        result = await list_app_actions("people tab", _tool_context(connect_state))
        ordered = [r["action_id"] for r in result["results"]]
        assert "connect.open_people" in ordered
        if "location.open_people" in ordered:
            assert ordered.index("connect.open_people") < ordered.index("location.open_people"), (
                "the same phrase must resolve the other way on the other screen"
            )


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
    """The named location-share/ask/connect flows are one call, not a chain.

    Superseded a three-call navigate-then-pick-then-act journey
    (``location.select_share_recipient`` -> ``continue_app_goal`` ->
    ``location.share_selected``, and the mirror for ``send_request``) once
    those actions became backend-direct and multi-person: the app resolves
    every named person, checks ambiguity, and runs the action in the SAME
    call the model makes. An instruction that still described the old chain
    left One doing exactly what a live session showed: asking for one person
    at a time and waiting between names the backend pipeline already handled
    together. These assert the instruction actually tells One to call once
    with everyone named, not the retired multi-call shape.
    """

    NAMED_ACTIONS = ("location.share_selected", "location.send_request", "connect.send_request")

    def test_the_old_navigate_then_pick_chain_is_gone_for_named_requests(self):
        instruction = ONE_IDENTITY_INSTRUCTION

        # The retired escort actions/verb no longer appear anywhere in the
        # instruction -- they still exist as real, reachable actions for the
        # tap-driven composer, but nothing here should still be telling One
        # to call them for a named share/ask/connect request.
        assert "location.select_share_recipient" not in instruction
        assert "location.select_ask_recipient" not in instruction
        assert "navigate first, then ask" not in instruction
        assert "NOTHING has been matched yet" not in instruction

    def test_every_named_action_points_back_to_the_multi_person_rule(self):
        """Repeating "never ask who first" in every paragraph on its own was
        not enough -- live testing showed the model still asking it. The
        rule now lives in ONE place, stated first with a concrete worked
        example, and each action's own paragraph just points back to it
        rather than re-arguing it. If a paragraph stops pointing back, the
        model reading only that paragraph loses the rule entirely.
        """
        instruction = ONE_IDENTITY_INSTRUCTION

        assert instruction.count("MULTI-PERSON RULE") >= 5
        for action_id in self.NAMED_ACTIONS + ("location.add_to_circle",):
            assert action_id in instruction, action_id
            # `action id '<id>'` matches each paragraph's own reference, not
            # the worked example inside the rule itself (which spells the
            # call as run_app_action('<id>', ...) instead).
            start = instruction.rindex(f"'{action_id}'")
            # Governed by the shared rule within the same paragraph -- the
            # reference has to be close by, not just present somewhere in
            # the whole instruction.
            nearby = instruction[start : start + 400]
            assert "MULTI-PERSON RULE" in nearby, action_id

    def test_the_multi_person_rule_names_the_exact_wrong_question(self):
        """Naming the failure mode almost verbatim ('who first', 'which one
        first') is what actually held in testing -- a purely positive
        instruction ("one call handles everyone") did not stop the model
        asking it. This is the one place that wording is allowed to live;
        it must not quietly disappear in a future edit."""
        instruction = ONE_IDENTITY_INSTRUCTION

        rule_start = instruction.index("MULTI-PERSON RULE")
        rule = instruction[rule_start : rule_start + 1200]
        assert "who first" in rule
        assert "which one first" in rule
        assert "stop" in rule.lower()
        # The worked example: a real tool call with two names in one slot.
        assert "'person': 'Alex and Sam'" in rule

    def test_the_one_tool_per_turn_rule_is_disambiguated_at_its_source(self):
        """The likely root cause: 'at most ONE action-producing tool per
        turn' is stated early and authoritatively, long before any
        multi-person carve-out -- a model pattern-matching on it alone
        could reasonably read 'one tool' as 'one person'. Patching the
        carve-outs further down was not enough; this asserts the
        clarification sits at the rule's own source, not just later."""
        instruction = ONE_IDENTITY_INSTRUCTION

        rule_index = instruction.index("at most ONE action-producing tool per turn")
        nearby = instruction[rule_index : rule_index + 700]
        assert "it does not mean one person per call" in nearby
        assert "still exactly one call" in nearby

    def test_every_required_slot_one_must_fill_is_spelled_out(self):
        """Name the slot key, never imply it.

        "call it with the name you heard" left the model to guess the key. It
        guessed wrong, the journey answered ``input_needed slot=person``, and
        One asked "who do you want to share with?" at someone who had just
        said the name -- twice, because nothing about the retry differed.
        analysis.start has always spelled out {'symbol': <ticker>}; this asserts
        the same for every action the instruction tells One to start by name.
        """
        for action_id in ("location.share_selected", "connect.send_request", "analysis.start"):
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

    def test_a_wrong_or_ambiguous_name_is_relayed_not_guessed(self):
        instruction = ONE_IDENTITY_INSTRUCTION

        assert "never guess" in instruction
        # Each named-action paragraph tells One to ask again for just the
        # names that failed, not to re-run the whole request.
        assert "ask again for just those" in instruction or "ask again" in instruction

    def test_the_generic_confirm_rule_still_gates_every_named_action(self):
        """These three actions rely on the SAME 'ask out loud, then stop and
        wait' rule as every other confirm_required action -- there is no
        per-tool-call confirmation gate underneath backend-direct dispatch,
        so an instruction that stopped telling One to ask first would mean
        these fire on a bare mention with nothing said out loud at all."""
        instruction = ONE_IDENTITY_INSTRUCTION

        assert instruction.count("ASK FOR IT OUT LOUD") >= 3
        assert "then STOP and wait" in instruction

    def test_circle_creation_and_adding_do_not_navigate_first(self):
        """create_circle and add_to_circle are both backend-direct (unlike
        remove_from_circle, which genuinely still needs the browser round
        trip) -- the old instruction told One to start_app_goal and
        navigate to Location for all three alike, which meant One walked
        someone to a screen they never asked to see just to add a name to
        a circle. Live testing found exactly this."""
        instruction = ONE_IDENTITY_INSTRUCTION

        assert "do NOT navigate anywhere first" in instruction
        assert "location.create_circle" in instruction
        assert "location.add_to_circle" in instruction
        # remove_from_circle is the one real exception -- it is not in
        # BACKEND_DIRECT_ACTION_IDS, so it still needs the escort. The
        # instruction has to say so explicitly or a future edit could
        # "fix" it into looking like the other two by mistake.
        assert "'location.remove_from_circle' is NOT backend-direct" in instruction

    def test_only_actions_with_no_backend_direct_path_still_navigate(self):
        """Cross-check against the actual dispatch set rather than trust the
        prose alone: every action BACKEND_DIRECT_ACTION_IDS or
        BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS covers must not be
        instructed to start_app_goal for itself -- if the instruction still
        told One to navigate for an action the backend runs directly, the
        two would have drifted apart the same way the retired three-call
        chain did."""
        from hushh_mcp.one_adk.action_tools import (
            BACKEND_DIRECT_ACTION_IDS,
            BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS,
        )

        instruction = ONE_IDENTITY_INSTRUCTION
        backend_direct_ids = BACKEND_DIRECT_ACTION_IDS | BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS
        for action_id in backend_direct_ids:
            if action_id not in instruction:
                continue  # not every backend-direct action gets its own paragraph
            marker = f"start_app_goal with action id '{action_id}'"
            assert marker not in instruction, action_id
            marker_no_id = "start_app_goal and let it open Location"
            # Only remove_from_circle is allowed to sit near that phrase.
            if marker_no_id in instruction and action_id != "location.remove_from_circle":
                nearby = instruction[
                    max(0, instruction.index(marker_no_id) - 200) : instruction.index(marker_no_id)
                    + 200
                ]
                assert action_id not in nearby, action_id


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

    The allowlist contains controls whose subject exists only in the mounted
    screen context: OTP fields and actions phrased around "this person" on an
    already-open profile. Cross-screen person requests use the named-person
    Connect and information-discovery journeys instead; guessing a profile
    reference here would be an authority bug.
    """
    from hushh_mcp.one_adk.action_tools import _reachability
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    SCREEN_BOUND_BY_DESIGN = {
        "people.profile.cancel_connection_request",
        "people.profile.connect",
        "people.profile.manage_consent",
        "people.profile.remove_connection",
        "people.profile.review_information_request",
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
