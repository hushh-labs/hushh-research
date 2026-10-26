import asyncio
import base64
import io
import json
import wave
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import Field, ValidationError

from hushh_mcp.agents.location.command_brain import LocationCommandBrain, SemanticAssessment
from hushh_mcp.operons.location.capabilities import compile_location_capabilities, semantic_catalog
from hushh_mcp.operons.location.plan import CommandCapsule, LocationAssessment, validate_assessment
from hushh_mcp.services.action_gateway import list_action_gateway_actions


def catalog():
    return compile_location_capabilities(list_action_gateway_actions())


class FakeCommandModel(BaseLlm):
    model: str = "synthetic-command-model"
    responses: list[Any] = Field(default_factory=list)
    requests: list[Any] = Field(default_factory=list)

    async def generate_content_async(self, llm_request, stream=False):
        assert stream is False
        self.requests.append(llm_request)
        value = self.responses.pop(0)
        part = types.Part.from_text(text=value) if isinstance(value, str) else value
        yield LlmResponse(content=types.Content(role="model", parts=[part]))


class StalledCommandModel(BaseLlm):
    model: str = "stalled-command-model"
    cancelled: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled = True
        yield LlmResponse()


def test_all_current_location_capabilities_have_an_authored_destination():
    revision, actions = catalog()
    assert len(actions) >= 54
    assert len(semantic_catalog(actions)) == len(actions)
    assert all(
        a["command"]["review_route"].startswith("/one/")
        for a in actions.values()
        if a["action_id"].startswith("location.")
    )
    altered = list(actions.values())
    altered[0] = {**altered[0], "meaning": "changed owning contract"}
    assert compile_location_capabilities(altered)[0] != revision


def test_semantic_catalog_preserves_all_authored_choices_after_compaction():
    from api.routes.one.command_proposals import _catalog

    _, actions = _catalog("location.plan.v2")
    projected = semantic_catalog(actions)
    indexed = {item.get("action_id") or item.get("workflow_id"): item for item in projected}
    assert set(indexed) == set(actions)
    for action_id, owner in actions.items():
        if "workflow_id" in owner:
            assert (
                indexed[action_id]["workflow"]["entry_action_id"]
                == owner["workflow"]["entry_action_id"]
            )
            continue
        item = indexed[action_id]
        assert item["meaning"] == (owner.get("meaning") or owner.get("label"))
        assert item.get("inputs", []) == owner["goal"]["required_inputs"]
        assert item["command"] == (owner.get("command") or {})
        assert item["policy"] == owner["execution_policy"]
        if owner.get("semantic_boundaries") is not None:
            assert item["boundaries"] == owner["semantic_boundaries"]
    calendar = indexed["calendar.invitation.review"]
    assert calendar["workflow"] == actions["calendar.invitation.review"]["goal"]["workflow_steps"]
    assert calendar["execution_target"] == actions["calendar.invitation.review"]["execution_target"]
    assert len(json.dumps(projected, ensure_ascii=False)) < 40_000


def test_semantic_catalog_does_not_crash_on_nonstandard_workflow_shape():
    _, actions = catalog()
    action = next(item for item in actions.values() if "action_id" in item)
    malformed = {**action, "goal": {**action["goal"], "workflow_steps": [None]}}
    projected = semantic_catalog({action["action_id"]: malformed})
    assert projected[0]["workflow"] == [None]


def test_workflow_prompt_preserves_owning_semantics_without_execution_internals():
    from api.routes.one.command_proposals import _catalog

    revision, actions = _catalog("location.plan.v2")
    before = json.dumps(actions, sort_keys=True)
    projected = semantic_catalog(actions)
    assert len(projected) == len(actions)
    workflow = next(item for item in projected if "workflow_id" in item)
    owner = actions[workflow["workflow_id"]]["workflow"]
    semantic = workflow["workflow"]
    assert semantic["knowledge_projection"] == owner["knowledge_projection"]
    assert semantic["command_completion_action_ids"] == ["location.resume_updates"]
    assert semantic["completion"] == owner["plan"]["completion"]
    assert semantic["entry_action_id"] == "setup.open_location"
    assert "api_endpoints" not in semantic
    assert "interaction_surfaces" not in semantic
    assert "execution" not in semantic
    assert len(json.dumps(workflow)) < len(json.dumps(owner)) / 5
    assert json.dumps(actions, sort_keys=True) == before
    # Projection cannot alter the full authority catalog or its revision.
    assert _catalog("location.plan.v2")[0] == revision


@pytest.mark.parametrize(
    "step",
    [
        {"action_id": "finance.trade", "slots": {}},
        {"action_id": "location.stop_share", "slots": {"person": "Alice", "confirmed": True}},
        {"action_id": "location.stop_share", "slots": {"__receipt": "forged"}},
        {"action_id": "location.open_now", "slots": {"unknown": "anything"}},
    ],
)
def test_semantic_proposals_cannot_invent_capabilities_or_authority(step):
    revision, actions = catalog()
    with pytest.raises(ValueError):
        validate_assessment(
            LocationAssessment(steps=[step]),
            actions,
            capability_revision=revision,
            context_revision="ctx",
        )


def test_missing_input_and_manual_screen_are_distinct_outcomes():
    revision, actions = catalog()
    missing = validate_assessment(
        LocationAssessment(steps=[{"action_id": "location.create_circle"}]),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert missing.mode == "needs_user_gate" and missing.gate.slot == "name"
    screen = validate_assessment(
        LocationAssessment(steps=[{"action_id": "location.trigger_sos"}]),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert screen.mode == "simulate" and screen.gate.route == "/one/location?action=sos"


@pytest.mark.parametrize(
    "action",
    ["location.find_contacts", "location.save_current_location", "location.delete_saved_location"],
)
def test_authored_manual_screens_own_their_inputs_without_an_extra_command_gate(action):
    revision, actions = catalog()
    plan = validate_assessment(
        LocationAssessment(steps=[{"action_id": action}]),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert plan.mode == "simulate" and plan.gate.kind == "navigation"
    assert plan.gate.route == actions[action]["command"]["review_route"]


def test_workflow_completion_comes_from_authored_tail_and_keeps_open_separate():
    from api.routes.one.command_proposals import _catalog

    revision, actions = _catalog("location.plan.v2")
    plan = validate_assessment(
        LocationAssessment(steps=[{"workflow_id": "workflow.setup.location"}]),
        actions,
        capability_revision=revision,
        context_revision="ctx",
        plan_version="location.plan.v2",
    )
    assert [step.model_dump() for step in plan.steps] == [
        {"workflow_id": "workflow.setup.location", "slots": {}},
        {"action_id": "location.resume_updates", "slots": {}, "dependencies": [], "references": []},
    ]
    opened = validate_assessment(
        LocationAssessment(steps=[{"action_id": "setup.open_location"}]),
        actions,
        capability_revision=revision,
        context_revision="ctx",
        plan_version="location.plan.v2",
    )
    assert len(opened.steps) == 1
    with pytest.raises(ValueError, match="workflow"):
        validate_assessment(
            LocationAssessment(steps=[{"workflow_id": "workflow.setup.location"}]),
            actions,
            capability_revision=revision,
            context_revision="ctx",
            plan_version="location.plan.v1",
        )


def test_capsule_rejects_plaintext_and_invalid_gcm_envelopes():
    valid = dict(
        ciphertext=base64.b64encode(b"opaque").decode(),
        iv=base64.b64encode(bytes(12)).decode(),
        tag=base64.b64encode(bytes(16)).decode(),
    )
    assert CommandCapsule(**valid).algorithm == "aes-256-gcm"
    with pytest.raises(ValidationError):
        CommandCapsule(**{**valid, "iv": base64.b64encode(bytes(16)).decode()})
    with pytest.raises(ValidationError):
        CommandCapsule(**{**valid, "transcript": "private words"})


def wav(frames=160, rate=16000, silence=False):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(bytes(frames * 2) if silence else b"\x00\x01" * frames)
    return base64.b64encode(output.getvalue()).decode()


@pytest.mark.asyncio
@pytest.mark.parametrize("managed_client", [False, True])
async def test_transcription_is_bounded_whole_recording_without_live_or_tools(
    monkeypatch, managed_client
):
    generate = AsyncMock(return_value=SimpleNamespace(text="मेरी location चालू करो"))
    if managed_client:
        from google.auth.credentials import AnonymousCredentials
        from google.genai import Client

        generate = AsyncMock(return_value={"transcript": "मेरी location चालू करो"})
        monkeypatch.setattr("hushh_mcp.hushh_adk.single_turn.run_single_turn", generate)
        client = Client(
            vertexai=True,
            project="synthetic-project",
            location="global",
            credentials=AnonymousCredentials(),
        )
    else:
        client = SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        )
    brain = LocationCommandBrain(client=client)
    assert await brain.transcribe(wav()) == "मेरी location चालू करो"
    config = (
        generate.call_args.args[0].generate_content_config
        if managed_client
        else generate.call_args.kwargs["config"]
    )
    assert not config.tools and not config.speech_config
    if managed_client:
        assert config.thinking_config.thinking_level == types.ThinkingLevel.LOW
        assert generate.call_args.kwargs["timeout_seconds"] == 30
    for invalid in ("!invalid", wav(0), wav(rate=44100), wav(960001)):
        with pytest.raises(ValueError):
            await brain.transcribe(invalid)
    assert await brain.transcribe(wav(silence=True)) == ""
    assert generate.await_count == 1


async def test_injected_model_uses_authored_transcriber_with_wrapped_client():
    model = FakeCommandModel(responses=['{"transcript":"Open Location"}'])
    brain = LocationCommandBrain(client=object(), transcriber_adk_model=model)
    assert await brain.transcribe(wav()) == "Open Location"
    assert len(model.requests) == 1
    assert model.requests[0].config.system_instruction
    assert not model.requests[0].config.tools


@pytest.mark.asyncio
async def test_semantic_agent_returns_typed_proposal_only(monkeypatch):
    model = FakeCommandModel(
        responses=[
            SemanticAssessment(
                steps=[{"action_id": "location.open_now", "inputs": []}],
                clarification=None,
                unsupported=False,
                intent_summary="Open Location.",
            ).model_dump_json()
        ]
    )
    options = []

    def managed_model(_name, *, http_options):
        options.append(http_options)
        return model

    monkeypatch.setattr("hushh_mcp.runtime_providers.build_managed_gemini_adk_model", managed_model)
    brain = LocationCommandBrain(client=object())
    _, actions = catalog()
    result = await brain.assess(
        query="meri location dikhao", context={"vault_ready": True}, catalog=actions
    )
    assert result.steps[0].action_id == "location.open_now"
    assert len(model.requests) == 1
    assert model.requests[0].config.response_schema is not None
    assert model.requests[0].config.thinking_config.thinking_level == types.ThinkingLevel.LOW
    assert not model.requests[0].config.speech_config
    assert len(options) == 1
    assert options[0].timeout == 60_000
    assert options[0].retry_options.attempts == 1


@pytest.mark.asyncio
async def test_semantic_agent_cancels_a_stalled_model_at_assessment_deadline(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.agents.location.command_brain._SEMANTIC_ASSESS_TIMEOUT_SECONDS",
        0.05,
    )
    model = StalledCommandModel()
    with pytest.raises(TimeoutError):
        await LocationCommandBrain(client=object(), adk_model=model).assess(
            query="show location", context={}, catalog=catalog()[1]
        )
    assert model.cancelled


@pytest.mark.asyncio
async def test_real_adk_read_loop_returns_structured_result_without_conversation():
    reads = []

    async def find_people(query: str) -> dict:
        """Read matching people; has no mutation authority."""
        reads.append(query)
        return {
            "items": [
                {"reference": "candidate_1", "displayName": "Abdul", "relationship": "connected"}
            ],
            "hasMore": False,
        }

    answer = SemanticAssessment(
        steps=[
            {
                "action_id": "location.add_to_circle",
                "inputs": [
                    {"name": "people", "value": "Abdul"},
                    {"name": "circle", "value": "Goa"},
                ],
            }
        ],
        clarification=None,
        unsupported=False,
        intent_summary="Add Abdul to Goa.",
    )
    model = FakeCommandModel(
        responses=[
            types.Part.from_function_call(name="find_people", args={"query": "Abdul"}),
            answer.model_dump_json(),
        ]
    )
    result = await LocationCommandBrain(client=object(), adk_model=model).assess(
        query="Goa mein Abdul ko add karo",
        context={},
        catalog=catalog()[1],
        read_tools=[find_people],
    )
    assert reads == ["Abdul"]
    assert len(model.requests) == 2
    assert result.steps[0].slots["people"] == "Abdul"
    assert any(
        part.function_response for content in model.requests[1].contents for part in content.parts
    )


@pytest.mark.asyncio
async def test_provider_json_keeps_inputs_but_cannot_bypass_local_bounds():
    assessment = SemanticAssessment(
        steps=[
            {
                "action_id": "location.create_circle",
                "inputs": [{"name": "name", "value": "Command Test Circle"}],
            }
        ],
        clarification=None,
        unsupported=False,
        intent_summary="Create the requested circle.",
    )
    model = FakeCommandModel(responses=[assessment.model_dump_json()])
    brain = LocationCommandBrain(client=object(), adk_model=model)
    _, actions = catalog()
    result = await brain.assess(query="Create a circle.", context={}, catalog=actions)
    assert result.steps[0].slots == {"name": "Command Test Circle"}
    # The provider's simpler generation schema is not our acceptance boundary.
    assessment.steps[0].inputs[0].value = "x" * 2001
    model.responses.append(assessment.model_dump_json())
    with pytest.raises(ValidationError):
        await brain.assess(query="Create a circle.", context={}, catalog=actions)


def test_zero_step_clarification_requires_recoverable_normalized_intent():
    revision, actions = catalog()
    with pytest.raises(ValueError):
        validate_assessment(
            LocationAssessment(clarification="Which person?"),
            actions,
            capability_revision=revision,
            context_revision="ctx",
        )
    plan = validate_assessment(
        LocationAssessment(
            clarification="Which person?",
            intent_summary="Stop sharing with an unresolved recipient.",
        ),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert not plan.steps and plan.intent_summary == "Stop sharing with an unresolved recipient."


def test_missing_input_gate_preserves_the_actual_step_position():
    revision, actions = catalog()
    plan = validate_assessment(
        LocationAssessment(
            steps=[{"action_id": "location.open_now"}, {"action_id": "location.create_circle"}]
        ),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert plan.gate_step == 1 and plan.gate.slot == "name"


def test_command_inputs_reject_unbounded_and_non_finite_values():
    for slots in (
        {"name": "a" * 2001},
        {"duration_hours": float("nan")},
        {"duration_hours": float("inf")},
    ):
        with pytest.raises(ValidationError):
            LocationAssessment(steps=[{"action_id": "location.create_circle", "slots": slots}])
    revision, actions = catalog()
    plan = validate_assessment(
        LocationAssessment(
            steps=[{"action_id": "location.create_circle", "slots": {"name": "   "}}]
        ),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert plan.gate.kind == "input"


def test_provider_inputs_preserve_values_and_reject_duplicate_names():
    assessment = SemanticAssessment(
        steps=[
            {
                "action_id": "location.create_circle",
                "inputs": [{"name": "name", "value": "Command Test Circle"}],
            }
        ],
        clarification=None,
        unsupported=False,
        intent_summary="Create the requested circle.",
    )
    assert assessment.proposal().steps[0].slots == {"name": "Command Test Circle"}
    assessment.steps[0].inputs.append(assessment.steps[0].inputs[0])
    with pytest.raises(ValueError, match="repeated"):
        assessment.proposal()


def test_dependencies_preserve_completed_prefix_across_clarification():
    from hushh_mcp.operons.location.plan import LocationCommandStep

    revision, actions = catalog()
    initial = validate_assessment(
        LocationAssessment(
            steps=[
                {"action_id": "location.create_circle", "slots": {"name": "Goa"}},
                {
                    "action_id": "location.add_to_circle",
                    "slots": {"person": "Abdul"},
                    "dependencies": [{"slot": "circle", "source_step": 0}],
                },
            ]
        ),
        actions,
        capability_revision=revision,
        context_revision="first",
        plan_version="location.plan.v2",
    )
    resumed = validate_assessment(
        LocationAssessment(
            steps=[
                {
                    "action_id": "location.add_to_circle",
                    "slots": {"person": "Abdul A"},
                    "dependencies": [{"slot": "circle", "source_step": 0}],
                },
            ]
        ),
        actions,
        capability_revision=revision,
        context_revision="second",
        plan_version="location.plan.v2",
        completed_steps=initial.steps[:1],
    )
    assert len(resumed.steps) == 2
    assert resumed.steps[0].model_dump() == initial.steps[0].model_dump()
    assert resumed.steps[1].dependencies[0].source_step == 0
    assert resumed.steps[1].slots == {"person": "Abdul A", "audience": "named"}
    # Legacy typed invocations still emit exactly the original action shape.
    legacy = LocationCommandStep(action_id="location.create_circle", slots={"name": "Goa"})
    plan = validate_assessment(
        LocationAssessment(steps=[legacy.model_dump()]),
        actions,
        capability_revision=revision,
        context_revision="typed",
    )
    assert plan.steps[0].model_dump() == legacy.model_dump()
    for invalid in (1, 2):
        with pytest.raises(ValueError, match="earlier step"):
            validate_assessment(
                LocationAssessment(
                    steps=[
                        {
                            "action_id": "location.add_to_circle",
                            "slots": {"person": "Abdul"},
                            "dependencies": [{"slot": "circle", "source_step": invalid}],
                        },
                    ]
                ),
                actions,
                capability_revision=revision,
                context_revision="second",
                plan_version="location.plan.v2",
                completed_steps=initial.steps[:1],
            )


def test_provider_shape_omits_unsupported_numeric_bounds_without_loosening_typed_result():
    import json

    schema = json.dumps(SemanticAssessment.provider_schema())
    assert "exclusiveMaximum" not in schema
    with pytest.raises(ValidationError):
        SemanticAssessment(
            steps=[
                {
                    "action_id": "location.add_to_circle",
                    "inputs": [],
                    "dependencies": [{"slot": "circle", "source_step": 12}],
                }
            ],
            clarification=None,
            unsupported=False,
            intent_summary="Add a person.",
        )


@pytest.mark.parametrize(
    "utterance",
    [
        "Show my pending invitations",
        "Accept tomorrow's client meeting",
        "Decline my 3 PM invitation",
        "I can't attend. Ask the organizer to choose another time",
    ],
)
def test_calendar_handoff_is_discoverable_without_admitting_provider_writes(utterance):
    revision, actions = catalog()
    assert {key for key in actions if key.startswith("calendar.")} == {"calendar.invitation.review"}
    action = actions["calendar.invitation.review"]
    assert action["execution_target"]["target"] == "continue_calendar_in_chat"
    assert not (action.get("command") or {}).get("backend_binding")
    plan = validate_assessment(
        LocationAssessment(
            steps=[{"action_id": "calendar.invitation.review", "slots": {"request": utterance}}]
        ),
        actions,
        capability_revision=revision,
        context_revision="ctx",
    )
    assert plan.mode == "end_to_end"
    assert plan.steps[0].slots == {"request": utterance}
