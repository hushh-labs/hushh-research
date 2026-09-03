"""What a person thought of one assistant turn.

The thumbs on an assistant message used to be local component state: it died
with the tab, survived no reload, and told the team nothing about the quality of
what people were actually getting. This stores the rating durably, keyed by the
conversation and the turn, and nothing else: no prompt, no answer, no content of
any kind. There is therefore no vault key here and no decrypt path.

Reads fail open. A rating is an opinion about a turn, not part of it, so a
feedback lookup must never stop a conversation from loading.
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg

from db.connection import get_pool

logger = logging.getLogger(__name__)

# The app namespace ADK sessions are written under. One value, matching
# hushh_mcp.one_adk.agent_tree.ONE_APP_NAME.
ONE_APP_NAME = "hussh_one"

VALID_RATINGS = ("up", "down")


class MessageFeedbackError(ValueError):
    """A rating that cannot be recorded, with the reason a caller can act on."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def _require(value: str | None, *, code: str, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise MessageFeedbackError(f"{label} is required.", code=code)
    return text


async def set_feedback(
    *,
    user_id: str,
    conversation_ref: str,
    message_ref: str,
    rating: str | None,
) -> dict[str, Any]:
    """Record a rating, or clear it by passing ``None``."""
    owner = _require(user_id, code="USER_REQUIRED", label="A user")
    conversation = _require(conversation_ref, code="CONVERSATION_REQUIRED", label="A conversation")
    message = _require(message_ref, code="MESSAGE_REQUIRED", label="A message")

    normalized = str(rating or "").strip().lower() or None
    if normalized is not None and normalized not in VALID_RATINGS:
        raise MessageFeedbackError(
            f"{normalized} is not a rating ({', '.join(VALID_RATINGS)}).",
            code="RATING_INVALID",
        )

    pool = await get_pool()
    if normalized is None:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                DELETE FROM one_agent_message_feedback
                WHERE user_id = $1 AND app_name = $2
                  AND conversation_ref = $3 AND message_ref = $4
                """,
                owner,
                ONE_APP_NAME,
                conversation,
                message,
            )
        return {"conversation_id": conversation, "message_id": message, "rating": None}

    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO one_agent_message_feedback
                    (user_id, app_name, conversation_ref, message_ref, rating)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (user_id, app_name, conversation_ref, message_ref)
                DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()
                """,
                owner,
                ONE_APP_NAME,
                conversation,
                message,
                normalized,
            )
    except asyncpg.ForeignKeyViolationError as exc:
        # The foreign key is scoped by user_id, so this is also the ownership
        # check: another person's conversation id simply does not resolve.
        raise MessageFeedbackError(
            "That conversation does not exist for this person.",
            code="CONVERSATION_NOT_FOUND",
        ) from exc

    return {
        "conversation_id": conversation,
        "message_id": message,
        "rating": normalized,
    }


async def get_feedback(*, user_id: str, conversation_ref: str) -> dict[str, Any]:
    """Every rating this person has given in one conversation."""
    owner = str(user_id or "").strip()
    conversation = str(conversation_ref or "").strip()
    if not owner or not conversation:
        return {"conversation_id": conversation, "ratings": {}}

    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT message_ref, rating
                FROM one_agent_message_feedback
                WHERE user_id = $1 AND app_name = $2 AND conversation_ref = $3
                """,
                owner,
                ONE_APP_NAME,
                conversation,
            )
    except Exception:
        # An opinion about a turn is not part of the turn: never let this stop
        # a conversation from loading.
        logger.warning(
            "one_agent_message_feedback_read_failed conversation=%s",
            conversation,
            exc_info=True,
        )
        return {"conversation_id": conversation, "ratings": {}}

    return {
        "conversation_id": conversation,
        "ratings": {str(row["message_ref"]): str(row["rating"]) for row in rows},
    }
