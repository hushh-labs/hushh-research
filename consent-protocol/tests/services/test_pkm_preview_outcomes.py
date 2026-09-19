"""Empty model selections, rejected output, and retryable failures are distinct."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pkm_agent_lab_service import _PREVIEW_CACHE, PKMAgentLabService

EMPTY_SELECTION = {
    "segments": [],
    "source_agent": "memory_segmentation_agent",
    "contract_version": 1,
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
