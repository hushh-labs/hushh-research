"""Nav's public gate, real ADK tool loop and directive parity without cloud calls."""

import inspect
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.adk_bridge.nav_agent import NavAgent
from hushh_mcp.agents.nav.agent import build_nav_agent
from hushh_mcp.agents.nav.tools import _friendly_expiry, _parse_datetime
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService


class ScriptedLlm(BaseLlm):
    _steps: list = PrivateAttr(default_factory=list)
    _instructions: list = PrivateAttr(default_factory=list)
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self, steps):
        super().__init__(model="gemini-3.7-flash")
        self._steps = list(steps)

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request)
        self._instructions.append(llm_request.config.system_instruction)
        step = self._steps.pop(0)
        if isinstance(step, Exception):
            raise step
        part = (
            types.Part(function_call=types.FunctionCall(name=step[0], args=step[1]))
            if isinstance(step, tuple)
            else types.Part(text=step)
        )
        yield LlmResponse(content=types.Content(role="model", parts=[part]))


@pytest.fixture(autouse=True)
def active_token(monkeypatch):
    async def active(self, user_id, scope, agent_id=None, *, token_id=None):
        return True

    monkeypatch.setattr(ConsentDBService, "is_token_active", active)


def task(message):
    return A2ATask(
        user_id="user_nav",
        consent_token=issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token,
        conversation_id="thread_nav",
        message=message,
        timezone="UTC",
    )


@pytest.fixture
def center(monkeypatch):
    surfaces = []

    async def listing(self, user_id, **kwargs):
        assert user_id == "user_nav"
        assert kwargs["actor"] == "investor" and kwargs["top"] == 10
        surfaces.append(kwargs["surface"])
        return {
            "total": 1,
            "items": [
                {
                    "id": "one_location_grant:grant-1",
                    "counterpart_label": "Alex",
                    "scope": "cap.location.live.view",
                    "expires_at": "1785283200000",
                    "status": "active",
                    "metadata": {"grant_id": "grant-1"},
                }
            ],
        }

    monkeypatch.setattr(ConsentCenterService, "list_center", listing)
    return surfaces


def scripted(tool, text="Alex can view your live location. The Stop sharing card is there."):
    return ScriptedLlm([("consent", {"request": "Review sharing"}), (tool, {}), text])


def test_parse_datetime_accepts_iso_strings():
    assert _parse_datetime("2026-08-11T10:00:00Z") == datetime(2026, 8, 11, 10, tzinfo=UTC)


def test_parse_datetime_accepts_epoch_milliseconds():
    assert _parse_datetime("1785283200000") == datetime.fromtimestamp(1785283200, tz=UTC)


def test_parse_datetime_rejects_garbage():
    assert _parse_datetime("not a date") is None


def test_friendly_expiry_never_speaks_a_raw_epoch_number():
    text = _friendly_expiry({"expires_at": "1785283200000"}, timezone=ZoneInfo("UTC"))
    assert "1785283200000" not in text and "until" in text


@pytest.mark.asyncio
async def test_nav_agent_returns_consent_required_directive_without_review_scope():
    result = await NavAgent().handle(
        A2ATask(
            user_id="user_nav",
            consent_token="",
            conversation_id="thread_nav",
            message="Who has access?",
        )
    )
    assert result.directive.payload["requiredScope"] == ConsentScope.AGENT_NAV_REVIEW.value
    assert result.model == "one+nav" and result.conversation_id == "thread_nav"
    assert "allow the consent assistant" in result.text


@pytest.mark.asyncio
async def test_other_owner_token_is_rejected_before_model_or_tools(center):
    model = ScriptedLlm([])
    other_token = issue_token("other_owner", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await NavAgent(model=model).handle(
        A2ATask(
            user_id="user_nav",
            consent_token=other_token,
            conversation_id="thread_nav",
            message="Explain sharing",
        )
    )
    assert result.directive.kind == "prompt"
    assert result.directive.payload == {
        "kind": "consent_required",
        "agentId": "agent_nav",
        "requiredScope": ConsentScope.AGENT_NAV_REVIEW.value,
        "reason": "owner_mismatch",
    }
    assert not model._instructions and not center
    assert result.is_complete and not result.state_changed


@pytest.mark.asyncio
async def test_active_grants_preserve_exact_directive(center):
    result = await NavAgent(model=scripted("list_active_consent_grants")).handle(
        task("Who sees my location?")
    )
    assert center == ["active"]
    assert not result.state_changed and result.is_complete
    assert result.directive.kind == "prompt"
    assert result.directive.payload == {
        "kind": "consent_actions",
        "items": [
            {
                "id": "one_location_grant:grant-1",
                "label": "Alex",
                "summary": "Alex can view your live location",
                "scope": "cap.location.live.view",
                "expiresAt": "1785283200000",
                "metadata": {"grant_id": "grant-1", "request_source": "one_location_share_grant"},
                "actions": ["revoke", "details"],
            }
        ],
    }


@pytest.mark.asyncio
async def test_previous_grants_have_no_directive(center):
    result = await NavAgent(
        model=scripted("list_previous_consent_grants", "Alex previously had access.")
    ).handle(task("Who did I share with before?"))
    assert center == ["previous"] and result.directive is None


@pytest.mark.asyncio
async def test_both_lists_keep_current_grant_card(center):
    model = ScriptedLlm(
        [
            ("consent", {"request": "Show current and previous sharing"}),
            ("list_active_consent_grants", {}),
            ("list_previous_consent_grants", {}),
            "Alex has current and previous sharing.",
        ]
    )
    result = await NavAgent(model=model).handle(task("Show all sharing, now and before."))
    assert center == ["active", "previous"]
    assert result.directive.payload["items"][0]["id"] == "one_location_grant:grant-1"


@pytest.mark.asyncio
async def test_empty_active_list_has_no_card(monkeypatch):
    async def empty(*args, **kwargs):
        return {"items": [], "total": 0}

    monkeypatch.setattr(ConsentCenterService, "list_center", empty)
    result = await NavAgent(
        model=scripted("list_active_consent_grants", "No one has access.")
    ).handle(task("Who sees my information?"))
    assert result.directive is None and result.text == "No one has access."


@pytest.mark.asyncio
async def test_service_failure_narrated(monkeypatch):
    async def fail(*args, **kwargs):
        raise RuntimeError("service unavailable")

    monkeypatch.setattr(ConsentCenterService, "list_center", fail)
    result = await NavAgent(
        model=scripted(
            "list_active_consent_grants", "The list could not be loaded. Please try again."
        )
    ).handle(task("Who sees my information?"))
    assert "could not be loaded" in result.text and result.directive is None


@pytest.mark.asyncio
async def test_empty_message_does_not_call_model(center):
    model = ScriptedLlm([])
    result = await NavAgent(model=model).handle(task(" "))
    assert result.text.startswith("Nav is ready") and not model._instructions and not center


@pytest.mark.asyncio
async def test_manifest_instruction_is_sent_without_forcing_a_read(center):
    model = ScriptedLlm(["Sharing is limited to what you allow."])
    agent = NavAgent(model=model)
    result = await agent.handle(task("How does sharing work?"))
    assert result.text == "Sharing is limited to what you allow." and not center
    assert agent._manifest.system_instruction.strip().replace("{nav_target?}", "consent") in str(
        model._instructions[0]
    )


@pytest.mark.asyncio
async def test_model_failure_propagates(center):
    with pytest.raises(RuntimeError, match="Specialist turn failed"):
        await NavAgent(model=ScriptedLlm([RuntimeError("model unavailable")])).handle(
            task("Explain sharing")
        )


def test_nav_never_lexically_routes_to_connections():
    source = inspect.getsource(NavAgent.handle)
    assert "get_connections_a2a" not in source and "_is_connections_query" not in source
    assert "_is_active_consent_query" not in source
    built = build_nav_agent(model="gemini-3.7-flash")
    assert [tool.agent.name for tool in built.tools] == ["consent"]
    assert built.mode == built.tools[0].agent.mode == "chat"
    assert built.tools[0].skip_summarization is True
    for agent in (built, built.tools[0].agent):
        assert (
            str(agent.generate_content_config.thinking_config.thinking_level)
            .lower()
            .endswith("low")
        )


def test_nav_is_registered_without_replacing_location():
    assert is_wired_specialist("agent_nav") and is_wired_specialist("agent_location")


@pytest.mark.asyncio
async def test_ambiguous_question_can_clarify_without_reads(center):
    # Scripted response proves the runtime permits this path; live evaluation
    # determines whether the model chooses it for the preserved ambiguous case.
    answer = "Do you mean who can see your information, or how sharing works?"
    model = ScriptedLlm([answer])
    agent = NavAgent(model=model)
    result = await agent.handle(task("What about access?"))
    assert result.text == answer and result.directive is None and not center
    assert len(model._instructions) == 1
    assert "ask one brief clarifying question" in agent._manifest.system_instruction


@pytest.mark.asyncio
async def test_failure_after_read_does_not_replay(center):
    model = ScriptedLlm(
        [
            ("consent", {"request": "Show sharing"}),
            ("list_active_consent_grants", {}),
            RuntimeError("provider failure"),
            RuntimeError("parent failure"),
        ]
    )
    with pytest.raises(RuntimeError):
        await NavAgent(model=model).handle(task("Who has access?"))
    assert center == ["active"]


@pytest.mark.asyncio
async def test_directives_do_not_survive_a_new_turn(center):
    model = scripted("list_active_consent_grants")
    model._steps.append("Sharing requires your approval.")
    agent = NavAgent(model=model)
    first = await agent.handle(task("Who sees my location?"))
    second = await agent.handle(task("Explain sharing."))
    assert first.directive is not None and second.directive is None
    assert center == ["active"]


@pytest.mark.asyncio
async def test_parent_honors_caller_supplied_history():
    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn

    model = ScriptedLlm(["Alex is the person you mentioned."])
    turn = await run_specialist_adk_turn(
        agent=build_nav_agent(model=model),
        app_name="nav_history_test",
        user_id="user_nav",
        consent_token=task("history").consent_token,
        message="Who was that?",
        history=[{"role": "user", "content": "I was discussing Alex."}],
    )
    assert "Alex" in str(model._requests[0].contents)
    assert turn.final_text == "Alex is the person you mentioned."


@pytest.mark.asyncio
async def test_child_answer_is_returned_verbatim_in_three_calls(center):
    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn

    answer = "Alex can view your live location. The Stop sharing card is there."
    model = scripted("list_active_consent_grants", answer)
    request = task("Who sees my location?")
    turn = await run_specialist_adk_turn(
        agent=build_nav_agent(model=model),
        app_name="nav_no_summary",
        user_id=request.user_id,
        consent_token=request.consent_token,
        message=request.message,
    )
    assert turn.llm_calls == len(model._instructions) == 3
    assert turn.final_text == answer
    assert center == ["active"]
    assert turn.state["hussh:specialist_directive"]["payload"]["kind"] == "consent_actions"


def _connections_task():
    import time

    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext

    return A2ATask(
        user_id="user_nav",
        consent_token=issue_token("user_nav", "self", ConsentScope.VAULT_OWNER).token,
        conversation_id="thread_nav",
        message="Review a connection request",
        specialist_target="connections",
        expected_tenant_id="user_nav",
        expected_task_id="turn:call",
        authority=A2AAuthorityContext(
            subject_user_id="user_nav",
            tenant_id="user_nav",
            task_id="turn:call",
            caller_kind="first_party",
            invocation_capabilities=("agent.nav.review", "agent.one.orchestrate"),
            expires_at_ms=int(time.time() * 1000) + 60000,
        ),
    )


@pytest.mark.asyncio
async def test_connections_child_returns_exact_proposal_without_mutation():
    from types import SimpleNamespace

    from hushh_mcp.services.connections_chat_service import ConnectionsChatService

    # No graph methods exist: proposing must not execute any of them.
    service = ConnectionsChatService(service=SimpleNamespace(), chat_store=SimpleNamespace())
    model = ScriptedLlm(
        [
            ("connections", {"request": "Propose the resolved person"}),
            ("propose_send_request", {"addressee_user_id": "person-7", "label": "Alex"}),
        ]
    )
    result = await NavAgent(model=model, connections_service=service).handle(_connections_task())
    assert result.state_changed is False
    assert result.directive.kind == "action"
    assert result.directive.payload == {
        "type": "connections_proposal",
        "actionId": "connect.send_request",
        "slots": {"person": "Alex", "userId": "person-7"},
    }
    assert "person-7" not in result.text
    assert "Send a connection request to Alex" in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"authority": None},
        {"expected_tenant_id": "another-owner"},
        {"expected_task_id": "another-call"},
        {"delegate_result": {"kind": "selection", "selected": [{"op": "send_request"}]}},
    ],
)
async def test_connections_invalid_hop_never_calls_model(change):
    from dataclasses import replace

    model = ScriptedLlm([])
    with pytest.raises(PermissionError):
        await NavAgent(model=model).handle(replace(_connections_task(), **change))
    assert model._requests == []


@pytest.mark.asyncio
async def test_connections_requires_strict_owner_token_even_with_invocation_envelope():
    from dataclasses import replace

    scoped = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    model = ScriptedLlm([])
    with pytest.raises(PermissionError):
        await NavAgent(model=model).handle(replace(_connections_task(), consent_token=scoped))
    assert model._requests == []


@pytest.mark.asyncio
async def test_connections_revocation_rechecked_before_child_tool(monkeypatch):
    from types import SimpleNamespace

    import hushh_mcp.adk_bridge.nav_agent as module
    from hushh_mcp.services.connections_chat_service import ConnectionsChatService

    checks = []

    async def owner(user_id, token):
        checks.append(user_id)
        return SimpleNamespace() if len(checks) == 1 else None

    monkeypatch.setattr(module, "validate_first_party_owner_token", owner)
    service = ConnectionsChatService(service=SimpleNamespace(), chat_store=SimpleNamespace())
    model = ScriptedLlm(
        [
            ("connections", {"request": "List connections"}),
            ("list_my_connections", {}),
            "Access is no longer available.",
        ]
    )
    result = await NavAgent(model=model, connections_service=service).handle(_connections_task())
    assert checks == ["user_nav", "user_nav"]
    assert result.directive is None and not result.state_changed
    assert "no longer available" in result.text


@pytest.mark.asyncio
async def test_connections_ambiguity_preserves_choices_without_legacy_mutation_refs():
    from types import SimpleNamespace

    from hushh_mcp.services.connections_chat_service import ConnectionsChatService

    records = {
        "items": [
            {"userId": "alex-1", "displayName": "Alex"},
            {"userId": "alex-2", "displayName": "Alex"},
        ]
    }
    service = ConnectionsChatService(
        service=SimpleNamespace(search_directory=lambda *args, **kwargs: records),
        chat_store=SimpleNamespace(),
    )
    model = ScriptedLlm(
        [
            ("connections", {"request": "Find Alex"}),
            ("request_person_choice", {"name": "Alex"}),
        ]
    )
    result = await NavAgent(model=model, connections_service=service).handle(_connections_task())
    assert result.is_complete is False and not result.state_changed
    assert result.directive.payload == {
        "type": "connections_choice",
        "question": 'Which "Alex"?',
        "candidates": records["items"],
    }
    assert "alex-1" not in result.text and "alex-2" not in result.text
    assert "selected" not in result.directive.payload and "op" not in result.directive.payload
