"""Regression tests for conversation ownership enforcement in KaiChatService.

_get_or_create_conversation must verify that a caller-supplied conversation_id
belongs to the requesting user before returning it. Without this check a user
could supply another user's conversation_id and inject messages into, or read
context from, a conversation they do not own.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.chat_db_service import ChatDBService
from hushh_mcp.services.kai_chat_service import KaiChatService


async def _make_service() -> tuple[KaiChatService, ChatDBService]:
    """Return a KaiChatService wired to a fresh in-memory ChatDBService."""
    svc = object.__new__(KaiChatService)
    # Minimal init: only the fields used by _get_or_create_conversation
    chat_db = ChatDBService()
    svc._chat_db = chat_db
    svc._pkm_service = None
    svc._attribute_learner = None
    return svc, chat_db


@pytest.mark.asyncio
async def test_owner_can_resume_their_own_conversation() -> None:
    """A user can resume a conversation they created by providing its ID."""
    svc, chat_db = await _make_service()

    owner_conv = await chat_db.create_conversation(user_id="user-owner", title="my chat")
    assert owner_conv is not None

    resumed = await svc._get_or_create_conversation("user-owner", owner_conv.id)

    assert resumed.id == owner_conv.id
    assert resumed.user_id == "user-owner"


@pytest.mark.asyncio
async def test_non_owner_cannot_access_another_users_conversation() -> None:
    """Providing another user's conversation_id must result in a new conversation."""
    svc, chat_db = await _make_service()

    victim_conv = await chat_db.create_conversation(user_id="user-victim", title="victim chat")
    assert victim_conv is not None

    attacker_conv = await svc._get_or_create_conversation("user-attacker", victim_conv.id)

    # A new conversation must have been created for the attacker, not the victim's one
    assert attacker_conv.id != victim_conv.id, (
        "Attacker received the victim's conversation; ownership not enforced"
    )
    assert attacker_conv.user_id == "user-attacker"
    # The victim's conversation must remain untouched
    assert victim_conv.user_id == "user-victim"


@pytest.mark.asyncio
async def test_unknown_conversation_id_creates_new_conversation() -> None:
    """An ID that does not exist in the store creates a new conversation."""
    svc, _ = await _make_service()

    conv = await svc._get_or_create_conversation("user-1", "00000000-0000-0000-0000-000000000000")

    assert conv is not None
    assert conv.user_id == "user-1"
    assert conv.id != "00000000-0000-0000-0000-000000000000"


@pytest.mark.asyncio
async def test_none_conversation_id_creates_new_conversation() -> None:
    """When no conversation_id is supplied a new conversation is always created."""
    svc, _ = await _make_service()

    conv = await svc._get_or_create_conversation("user-new", None)

    assert conv is not None
    assert conv.user_id == "user-new"
