"""The model a turn runs on is resolved at call time, with the person above the lane.

The regression these guard is a real one: the fleet model was a module-level constant
read from ``HUSSH_GEMINI_TEXT_MODEL`` at import, consumed by a process-wide singleton, so
changing it meant a redeploy and every person on a lane shared one answer.
"""

from __future__ import annotations

import pytest

from hushh_mcp import constants
from hushh_mcp.runtime_providers import model_catalog
from hushh_mcp.services import model_preference_service as prefs


def test_catalog_comes_from_the_registry_not_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HUSSH_GEMINI_TEXT_MODEL", raising=False)
    choices = model_catalog.selectable_text_models()
    assert [choice.model_id for choice in choices][:3] == [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
    ], "the catalog is the registry-backed Flash family, newest first"
    assert all(choice.label.startswith("Gemini ") for choice in choices)
    assert model_catalog.is_selectable_text_model("gemini-3.8-flash")
    assert not model_catalog.is_selectable_text_model("gemini-3.1-pro-preview")
    assert not model_catalog.is_selectable_text_model("not-a-model")
    assert not model_catalog.is_selectable_text_model("")


def test_lane_default_is_read_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """No copy is frozen into the catalog module when it is first imported."""
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.6-flash")
    assert model_catalog.deployment_default_text_model() == "gemini-3.6-flash"
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.8-flash")
    assert model_catalog.deployment_default_text_model() == "gemini-3.8-flash"
    assert any(
        choice.is_default and choice.model_id == "gemini-3.8-flash"
        for choice in model_catalog.selectable_text_models()
    )


@pytest.mark.asyncio
async def test_person_choice_outranks_the_lane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")

    async def _stored(user_id: str) -> str | None:
        return "gemini-3.8-flash" if user_id == "chooser" else None

    monkeypatch.setattr(prefs, "_stored_choice", _stored)

    chosen = await prefs.resolve_text_model("chooser")
    assert (chosen.model_id, chosen.source) == ("gemini-3.8-flash", prefs.SOURCE_USER)

    followed = await prefs.resolve_text_model("someone-else")
    assert (followed.model_id, followed.source) == ("gemini-3.7-flash", prefs.SOURCE_DEPLOYMENT)

    anonymous = await prefs.resolve_text_model(None)
    assert anonymous.model_id == "gemini-3.7-flash"
    assert anonymous.selected is None


@pytest.mark.asyncio
async def test_a_withdrawn_choice_degrades_instead_of_failing_the_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")

    async def _stored(user_id: str) -> str | None:
        return "gemini-2.0-retired"

    monkeypatch.setattr(prefs, "_stored_choice", _stored)
    resolved = await prefs.resolve_text_model("chooser")
    assert resolved.model_id == "gemini-3.7-flash", "a stale choice never reaches the provider"
    assert resolved.source == prefs.SOURCE_DEPLOYMENT
    assert resolved.selected == "gemini-2.0-retired", "the stale choice stays visible"


@pytest.mark.asyncio
async def test_an_empty_lane_falls_back_to_the_proven_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "")

    async def _stored(user_id: str) -> str | None:
        return None

    monkeypatch.setattr(prefs, "_stored_choice", _stored)
    resolved = await prefs.resolve_text_model("someone")
    assert resolved.model_id == constants.FLEET_TEXT_MODEL_DEFAULT
    assert resolved.source == prefs.SOURCE_FALLBACK


@pytest.mark.asyncio
async def test_a_preference_read_failure_never_breaks_a_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The store is unreachable; the agent still answers on the lane default."""
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")

    async def _boom() -> None:
        raise RuntimeError("pool down")

    monkeypatch.setattr(prefs, "get_pool", _boom)
    assert await prefs.resolve_text_model_name("someone") == "gemini-3.7-flash"


@pytest.mark.asyncio
async def test_an_unavailable_model_is_refused_with_the_list_that_is() -> None:
    with pytest.raises(prefs.ModelPreferenceError) as caught:
        await prefs.set_preference(user_id="someone", model_id="gemini-3.1-pro-preview")
    assert caught.value.code == "MODEL_NOT_SELECTABLE"
    assert "gemini-3.8-flash" in str(caught.value)

    with pytest.raises(prefs.ModelPreferenceError) as missing_user:
        await prefs.set_preference(user_id="  ", model_id="gemini-3.8-flash")
    assert missing_user.value.code == "USER_REQUIRED"
