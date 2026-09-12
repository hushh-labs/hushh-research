import base64
import io
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from hushh_mcp.agents.location.command_brain import LocationCommandBrain, SemanticAssessment
from hushh_mcp.operons.location.capabilities import compile_location_capabilities, semantic_catalog
from hushh_mcp.operons.location.plan import CommandCapsule, LocationAssessment, validate_assessment
from hushh_mcp.services.action_gateway import list_action_gateway_actions


def catalog():
    return compile_location_capabilities(list_action_gateway_actions())


def test_all_current_location_capabilities_have_an_authored_destination():
    revision, actions = catalog()
    assert len(actions) >= 54
    assert len(semantic_catalog(actions)) == len(actions)
    assert all(a["command"]["review_route"].startswith("/one/") for a in actions.values())
    altered = list(actions.values())
    altered[0] = {**altered[0], "meaning": "changed owning contract"}
    assert compile_location_capabilities(altered)[0] != revision


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
async def test_transcription_is_bounded_whole_recording_without_live_or_tools():
    generate = AsyncMock(return_value=SimpleNamespace(text="मेरी location चालू करो"))
    brain = LocationCommandBrain(
        client=SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        )
    )
    assert await brain.transcribe(wav()) == "मेरी location चालू करो"
    config = generate.call_args.kwargs["config"]
    assert not config.tools and not config.speech_config
    for invalid in ("!invalid", wav(0), wav(rate=44100), wav(960001)):
        with pytest.raises(ValueError):
            await brain.transcribe(invalid)
    assert await brain.transcribe(wav(silence=True)) == ""
    assert generate.await_count == 1


@pytest.mark.asyncio
async def test_semantic_agent_returns_typed_proposal_only():
    generate = AsyncMock(
        return_value=SimpleNamespace(
            parsed=SemanticAssessment(
                steps=[{"action_id": "location.open_now", "inputs": []}],
                clarification=None,
                unsupported=False,
                intent_summary="Open Location.",
            ),
            text="",
        )
    )
    brain = LocationCommandBrain(
        client=SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        )
    )
    _, actions = catalog()
    result = await brain.assess(
        query="meri location dikhao", context={"vault_ready": True}, catalog=actions
    )
    assert result.steps[0].action_id == "location.open_now"
    config = generate.call_args.kwargs["config"]
    assert isinstance(config.response_schema, dict) and not config.tools


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
    response = SimpleNamespace(parsed=None, text=assessment.model_dump_json())
    generate = AsyncMock(return_value=response)
    brain = LocationCommandBrain(
        client=SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        )
    )
    _, actions = catalog()
    result = await brain.assess(query="Create a circle.", context={}, catalog=actions)
    assert result.steps[0].slots == {"name": "Command Test Circle"}
    # The provider's simpler generation schema is not our acceptance boundary.
    assessment.steps[0].inputs[0].value = "x" * 2001
    response.text = assessment.model_dump_json()
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
