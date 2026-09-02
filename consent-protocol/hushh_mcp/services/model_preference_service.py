"""Resolve which text model runs a person's agent, at call time, with the person on top.

The precedence, highest first:

1. the person's own choice (``one_model_preferences``), validated against the catalog;
2. the lane default (``HUSSH_GEMINI_TEXT_MODEL``, read live, never frozen at import);
3. ``FLEET_TEXT_MODEL_DEFAULT``, the generation proven in every lane.

Every tier is validated the same way, so a model that was withdrawn from the catalog
degrades to the next tier instead of reaching a provider and failing the turn. Lookups
fail open for the same reason: a person's agent must answer even when the preference
store is unreachable, and the lane default is always a correct answer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from db.connection import get_pool
from hushh_mcp.constants import FLEET_TEXT_MODEL_DEFAULT
from hushh_mcp.runtime_providers.model_catalog import (
    TextModelChoice,
    deployment_default_text_model,
    is_selectable_text_model,
    selectable_text_models,
)

logger = logging.getLogger(__name__)

# Where an effective model came from. Reported to the caller so a person can be told
# "you chose this" rather than "this is what runs", which are different facts.
SOURCE_USER = "user"
SOURCE_DEPLOYMENT = "deployment"
SOURCE_FALLBACK = "fallback"


class ModelPreferenceError(ValueError):
    """A model a person asked for that the catalog does not offer."""

    def __init__(self, message: str, *, code: str = "MODEL_NOT_SELECTABLE") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ResolvedTextModel:
    """The model a turn will actually use, and why."""

    model_id: str
    source: str
    selected: str | None


def _deployment_tier() -> tuple[str, str]:
    """The lane default, or the proven fallback when the lane names something unusable."""
    # A lane may legitimately pin a model outside the selectable Flash set, so the lane
    # tier is honoured as deployed rather than filtered through the chooser's catalog.
    # Only an empty lane value falls through to the generation proven everywhere.
    lane = deployment_default_text_model().strip()
    if lane:
        return lane, SOURCE_DEPLOYMENT
    return FLEET_TEXT_MODEL_DEFAULT, SOURCE_FALLBACK


async def _stored_choice(user_id: str) -> str | None:
    """The person's stored choice, or None. Never raises: a read failure is not a turn failure."""
    normalized = str(user_id or "").strip()
    if not normalized:
        return None
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT text_model FROM one_model_preferences WHERE user_id = $1",
                normalized,
            )
    except Exception:
        logger.warning("one_model_preference_read_failed user=%s", normalized, exc_info=True)
        return None
    if not row:
        return None
    return str(row["text_model"] or "").strip() or None


async def resolve_text_model(user_id: str | None) -> ResolvedTextModel:
    """The model this person's next turn should use, resolved now rather than at import."""
    lane_model, lane_source = _deployment_tier()
    selected = await _stored_choice(user_id) if user_id else None
    if selected and is_selectable_text_model(selected):
        return ResolvedTextModel(model_id=selected, source=SOURCE_USER, selected=selected)
    if selected:
        # The choice outlived the catalog entry. Run the lane default and keep the stale
        # selection visible, so the surface can say what happened instead of pretending.
        logger.info(
            "one_model_preference_not_selectable user=%s model=%s -> %s",
            user_id,
            selected,
            lane_model,
        )
    return ResolvedTextModel(model_id=lane_model, source=lane_source, selected=selected)


async def resolve_text_model_name(user_id: str | None) -> str:
    """``resolve_text_model`` for callers that only need the identifier."""
    return (await resolve_text_model(user_id)).model_id


def _choice_payload(choice: TextModelChoice, effective: str) -> dict[str, Any]:
    return {
        "model_id": choice.model_id,
        "label": choice.label,
        "is_default": choice.is_default,
        "is_active": choice.model_id == effective,
    }


async def get_preference(*, user_id: str) -> dict[str, Any]:
    """What this person may choose, what they chose, and what actually runs."""
    resolved = await resolve_text_model(user_id)
    choices = selectable_text_models()
    return {
        "user_id": user_id,
        "selected_model": resolved.selected,
        "effective_model": resolved.model_id,
        "source": resolved.source,
        "choices": [_choice_payload(choice, resolved.model_id) for choice in choices],
    }


async def set_preference(*, user_id: str, model_id: str | None) -> dict[str, Any]:
    """Record this person's choice, or clear it with ``None`` to follow the lane again."""
    normalized_user = str(user_id or "").strip()
    if not normalized_user:
        raise ModelPreferenceError(
            "A user is required to set a model preference.", code="USER_REQUIRED"
        )

    normalized_model = str(model_id or "").strip()
    pool = await get_pool()
    if not normalized_model:
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM one_model_preferences WHERE user_id = $1", normalized_user
            )
        return await get_preference(user_id=normalized_user)

    if not is_selectable_text_model(normalized_model):
        offered = ", ".join(choice.model_id for choice in selectable_text_models())
        raise ModelPreferenceError(
            f"{normalized_model} is not one of the available models ({offered}).",
        )

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO one_model_preferences (user_id, text_model)
            VALUES ($1, $2)
            ON CONFLICT (user_id)
            DO UPDATE SET text_model = EXCLUDED.text_model, updated_at = NOW()
            """,
            normalized_user,
            normalized_model,
        )
    return await get_preference(user_id=normalized_user)
