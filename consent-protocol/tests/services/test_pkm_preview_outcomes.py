"""Empty model selections, rejected output, and retryable failures are distinct."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pkm_agent_lab_service import _PREVIEW_CACHE, PKMAgentLabService

EMPTY_SELECTION = {
    "segments": [],
    "source_agent": "memory_segmentation_agent",
    "contract_version": 1,
    "has_more_candidates": False,
}


@pytest.fixture(autouse=True)
def clear_preview_cache():
    _PREVIEW_CACHE.clear()
    yield
    _PREVIEW_CACHE.clear()


@pytest.mark.asyncio
async def test_explicit_empty_selection_is_a_successful_cacheable_noop(monkeypatch):
    service = PKMAgentLabService()
    run = AsyncMock(return_value=EMPTY_SELECTION)
    monkeypatch.setattr(service, "_run_agent_contract", run)
    args = {"user_id": "fixture-owner", "message": "Hello there."}

    first = await service.generate_structure_preview(**args)
    second = await service.generate_structure_preview(**args)

    assert first == second
    assert first["preview_cards"] == []
    assert first["write_mode"] == "do_not_save"
    assert first["candidate_payload"] == {}
    assert first["used_fallback"] is False
    assert first["error"] is None
    assert "preview_generation_failed" not in first["validation_hints"]
    assert run.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failed_output",
    [
        None,
        {},
        {"segments": []},
        {**EMPTY_SELECTION, "has_more_candidates": None},
        {**EMPTY_SELECTION, "has_more_candidates": "false"},
        {**EMPTY_SELECTION, "contract_version": True},
        {**EMPTY_SELECTION, "source_agent": ""},
        {**EMPTY_SELECTION, "segments": [{"source_text": "An invented claim."}]},
    ],
)
async def test_failure_is_not_cached_and_same_draft_can_retry(monkeypatch, failed_output):
    service = PKMAgentLabService()
    run = AsyncMock(side_effect=[failed_output, EMPTY_SELECTION])
    monkeypatch.setattr(service, "_run_agent_contract", run)
    args = {"user_id": "fixture-owner", "message": "Hello there."}

    failed = await service.generate_structure_preview(**args)
    assert failed["preview_cards"] == []
    assert failed["used_fallback"] is True
    assert "preview_generation_failed" in failed["validation_hints"]
    assert not _PREVIEW_CACHE

    recovered = await service.generate_structure_preview(**args)
    assert recovered["error"] is None
    assert recovered["used_fallback"] is False
    assert run.await_count == 2


@pytest.mark.parametrize("failure", [{"used_fallback": True}, {"error": "timeout"}])
def test_degraded_preview_cannot_replace_a_cached_success(failure):
    PKMAgentLabService._set_cached_structure_preview("fixture-key", {"used_fallback": False})
    PKMAgentLabService._set_cached_structure_preview("fixture-key", failure)
    assert PKMAgentLabService._get_cached_structure_preview("fixture-key") is None


@pytest.mark.asyncio
async def test_oversized_selected_quote_requests_split_without_losing_trailing_qualifier(
    monkeypatch,
):
    service = PKMAgentLabService()
    message = "Hypothetical project:\n" + "An example description. " * 180 + "It never happened."
    run = AsyncMock(
        return_value={
            **EMPTY_SELECTION,
            "segments": [{"source_text": message, "confidence": 0.9, "reason": "Context."}],
        }
    )
    downstream = AsyncMock()
    monkeypatch.setattr(service, "_run_agent_contract", run)
    monkeypatch.setattr(service, "_generate_single_structure_preview", downstream)
    result = await service.generate_structure_preview(user_id="fixture-owner", message=message)
    assert result["preview_cards"] == []
    assert result["preview_summary"]["split_recommended"] is True
    assert "preview_generation_failed" not in result["validation_hints"]
    assert result["used_fallback"] is False
    downstream.assert_not_awaited()


def test_segmentation_preserves_exact_multiline_context_without_rewriting():
    message = "Earlier role:\n- I led a team at Example Labs in 2020."
    actual = PKMAgentLabService._sanitize_segmented_messages(
        {
            "segments": [{"source_text": message, "confidence": 0.9, "reason": "History."}],
        },
        message=message,
    )
    assert actual[0]["source_text"] == message
    assert (
        PKMAgentLabService._sanitize_segmented_messages(
            {
                "segments": [{"source_text": message.upper()}],
            },
            message=message,
        )
        == []
    )


@pytest.mark.parametrize(
    "intent,mutation",
    [("profile_fact", "create"), ("correction", "correct"), ("financial_event", "extend")],
)
def test_successful_model_confirmation_cannot_be_relaxed_by_host_confidence(intent, mutation):
    fallback = {
        "save_class": "durable",
        "intent_class": intent,
        "mutation_intent": mutation,
        "requires_confirmation": False,
        "confirmation_reason": "",
        "confidence": 0.99,
        "candidate_domain_choices": [{"domain_key": "professional", "recommended": True}],
    }
    result = PKMAgentLabService._sanitize_intent_frame(
        raw={
            **fallback,
            "requires_confirmation": True,
            "confirmation_reason": "Sensitive compensation requires review.",
        },
        message="My proposed compensation needs review.",
        current_domains=["professional"],
        registry_choices=[
            {"domain_key": "professional", "display_name": "Professional", "description": "Work"}
        ],
        fallback=fallback,
    )
    assert result["requires_confirmation"] is True
    assert result["confirmation_reason"] == "Sensitive compensation requires review."


@pytest.mark.parametrize(
    "message,mutation",
    [
        ("Earlier employer: I actually led a team in 2020.", "correct"),
        ('Project instructions: "delete my old notes" is an example.', "delete"),
    ],
)
def test_quoted_history_does_not_override_successful_semantic_decision(message, mutation):
    model = {
        "save_class": "durable",
        "intent_class": "profile_fact",
        "mutation_intent": "create",
        "requires_confirmation": True,
        "confirmation_reason": "Review attribution.",
        "confidence": 0.9,
        "candidate_domain_choices": [{"domain_key": "professional", "recommended": True}],
    }
    result = PKMAgentLabService._sanitize_intent_frame(
        raw=model,
        message=message,
        current_domains=["professional"],
        registry_choices=[
            {"domain_key": "professional", "display_name": "Professional", "description": "Work"}
        ],
        fallback={**model, "mutation_intent": mutation, "requires_confirmation": False},
    )
    assert result["mutation_intent"] == "create"
    assert result["requires_confirmation"] is True


def test_explicit_integrity_guard_keeps_the_models_specific_confirmation_warning():
    model = {
        "save_class": "durable",
        "intent_class": "profile_fact",
        "mutation_intent": "create",
        "requires_confirmation": True,
        "confirmation_reason": "Review sensitive compensation.",
        "confidence": 0.9,
        "candidate_domain_choices": [{"domain_key": "professional", "recommended": True}],
    }
    result = PKMAgentLabService._sanitize_intent_frame(
        raw=model,
        message="Actually I have a different compensation package.",
        current_domains=["professional"],
        registry_choices=[
            {"domain_key": "professional", "display_name": "Professional", "description": "Work"}
        ],
        fallback={**model, "mutation_intent": "correct", "requires_confirmation": False},
    )
    assert result["mutation_intent"] == "correct"
    assert result["requires_confirmation"] is True
    assert result["confirmation_reason"] == "Review sensitive compensation."


@pytest.mark.asyncio
async def test_mixed_valid_and_invented_quotes_are_not_certified_as_complete(monkeypatch):
    service = PKMAgentLabService()
    run = AsyncMock(
        return_value={
            **EMPTY_SELECTION,
            "segments": [
                {"source_text": "I prefer tea."},
                {"source_text": "I own a yacht."},
            ],
        }
    )
    downstream = AsyncMock()
    monkeypatch.setattr(service, "_run_agent_contract", run)
    monkeypatch.setattr(service, "_generate_single_structure_preview", downstream)
    result = await service.generate_structure_preview(
        user_id="fixture-owner", message="I prefer tea."
    )
    assert result["used_fallback"] is True
    assert result["preview_cards"] == []
    downstream.assert_not_awaited()
