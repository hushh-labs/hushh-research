"""Test-only chat key providers. Production code has no static key path."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from hushh_mcp.services.chat_key import (
    ChatCipher,
    ChatKeyUnavailableError,
    RequestChatKey,
    bind_request_chat_key,
)

TEST_CHAT_KEY = bytes.fromhex("5a" * 32)
OTHER_CHAT_KEY = bytes.fromhex("a5" * 32)


class StaticChatKeyProvider:
    """Answers with one fixed key, optionally for one owner only."""

    def __init__(self, key: bytes = TEST_CHAT_KEY, *, owner_id: str | None = None) -> None:
        self._key = key
        self._owner_id = owner_id

    def current_key(self, owner_id: str) -> bytes:
        if self._owner_id is not None and owner_id != self._owner_id:
            raise ChatKeyUnavailableError("Unlock your vault to open chat history.")
        return self._key


def static_chat_cipher(key: bytes | str = TEST_CHAT_KEY) -> ChatCipher:
    raw = bytes.fromhex(key) if isinstance(key, str) else key
    return ChatCipher(StaticChatKeyProvider(raw))


@contextmanager
def bound_request_chat_key(owner_id: str, key: bytes = TEST_CHAT_KEY) -> Iterator[RequestChatKey]:
    """Bind a request key for ``owner_id`` the way the middleware and auth do."""
    holder = RequestChatKey(key)
    holder.bind_owner(owner_id)
    with bind_request_chat_key(holder):
        yield holder
