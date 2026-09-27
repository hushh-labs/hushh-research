"""The person's key for One chat history at rest.

Chat history (ADK session documents, command checkpoints, and the specialist
conversation titles and messages) is sealed with a key the person's browser
derives from their unlocked vault key:

    chat_key = HKDF-SHA256(ikm=vault_key, salt=b"", info=b"hussh-one-chat-v1", L=32)

The browser sends only the derived key, never the vault key, in the
``X-Hussh-Chat-Key`` header as ``hck1.<64 lowercase hex>``.
``api.middlewares.chat_key.ChatKeyMiddleware`` binds it to one HTTP exchange and
wipes it when that exchange and the background run it started have both ended.
Nothing here persists or logs the key, and nothing falls back to the process-wide
``VAULT_DATA_KEY``: a missing key refuses the read or write.

Key sourcing sits behind ``ChatKeyProvider``. A pod, which holds its owner's key
itself, replaces the per-request provider with ``set_chat_key_provider`` at process
start without touching any store.
"""

from __future__ import annotations

import base64
import os
import re
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.types import EncryptedPayload

CHAT_KEY_LABEL = "hussh-one-chat-v1"
CHAT_KEY_HEADER = "x-hussh-chat-key"
# Every ciphertext sealed with a person's chat key begins with this marker. A row
# without it was sealed with the platform key before the cutover. New code treats
# such a row as absent: it never opens it and never deletes it at runtime.
CHAT_CIPHERTEXT_PREFIX = "hussh-chat-v1:"
# Bind as a SQL parameter (``LIKE :chat_marker``); a literal ``%`` in raw SQL is a
# driver format character.
CHAT_CIPHERTEXT_LIKE = CHAT_CIPHERTEXT_PREFIX + "%"
# A request binding outlives its HTTP exchange only while the ADK run it started is
# still settling. The run itself is bounded at 200 s; this is the hard ceiling.
MAX_BINDING_SECONDS = 300.0

_WIRE = re.compile(r"hck1\.([0-9a-f]{64})")
_IV_BYTES = 12
_TAG_BYTES = 16


class ChatKeyUnavailableError(PermissionError):
    """No chat key is bound for this owner; chat history must not be read or written."""


class ChatKeyMismatchError(PermissionError):
    """A person-key record did not open with the bound key (wrong key or tampering)."""


class LegacyChatCiphertextError(LookupError):
    """The record was sealed with the platform key before the cutover: treat as absent."""


CHAT_KEY_ERRORS: tuple[type[Exception], ...] = (ChatKeyUnavailableError, ChatKeyMismatchError)

_KEY_REQUIRED = "Unlock your vault to open chat history."
_KEY_MISMATCH = "Chat history did not open with this vault."
_KEY_MALFORMED = "Chat key is malformed."
_KEY_OWNER_MISSING = "Chat key owner is missing."
_KEY_OTHER_OWNER = "Chat key belongs to another session."
# What a person sees when a request reaches the server without a usable chat key.
# The current app refuses locally while the vault is locked, so this is an app
# build or tab from before chat keys: an installed native build needs an update,
# a web tab a refresh.
CHAT_KEY_RECOVERY_MESSAGE = "Update or refresh the app, then unlock your vault and try again."
CHAT_KEY_REQUIRED_CODE = "CHAT_KEY_REQUIRED"

# Every message a chat-key error carries. Libraries that stringify an exception
# into a stream error (ag_ui_adk) are mapped back to the chat-key refusal by these.
CHAT_KEY_ERROR_MESSAGES = frozenset(
    {_KEY_REQUIRED, _KEY_MISMATCH, _KEY_MALFORMED, _KEY_OWNER_MISSING, _KEY_OTHER_OWNER}
)


class RequestChatKey:
    """One request's key, shared by every task that copied the request context.

    The holder is reference counted: the HTTP exchange holds one reference and a
    background ADK run may hold another. The key is dropped when the last reference
    is released or ``MAX_BINDING_SECONDS`` pass, whichever comes first, so a task
    that outlives the request can never keep using it.
    """

    __slots__ = ("_deadline", "_key", "_lock", "_owner", "_references")

    def __init__(self, key: bytes, *, max_seconds: float = MAX_BINDING_SECONDS) -> None:
        if len(key) != 32:
            raise ChatKeyUnavailableError(_KEY_MALFORMED)
        self._key: bytes | None = key
        self._owner: str | None = None
        self._references = 1
        self._deadline = time.monotonic() + max_seconds
        self._lock = threading.Lock()

    def key_for(self, owner_id: str) -> bytes | None:
        with self._lock:
            if self._key is not None and time.monotonic() >= self._deadline:
                self._key = None
            if self._key is None or not owner_id or self._owner != owner_id:
                return None
            return self._key

    def bind_owner(self, owner_id: str) -> None:
        """Bind the authenticated owner. A second, different owner is refused."""
        clean = str(owner_id or "").strip()
        with self._lock:
            if not clean:
                raise ChatKeyUnavailableError(_KEY_OWNER_MISSING)
            if self._owner is None:
                self._owner = clean
            elif self._owner != clean:
                self._key = None
                raise ChatKeyUnavailableError(_KEY_OTHER_OWNER)

    def retain(self) -> bool:
        with self._lock:
            if self._key is None:
                return False
            self._references += 1
            return True

    def release(self) -> None:
        with self._lock:
            self._references -= 1
            if self._references <= 0:
                self._key = None

    @property
    def bound(self) -> bool:
        with self._lock:
            return self._key is not None

    def refusal_state(self, owner_id: str | None) -> str:
        """Why this key can or cannot serve ``owner_id``. A category, never the key.

        ``owner_id=None`` skips the owner comparison (the caller does not know it).
        """
        with self._lock:
            if self._key is None or time.monotonic() >= self._deadline:
                return "released"
            if self._owner is None:
                return "unowned"
            if owner_id is not None and self._owner != owner_id:
                return "owner_mismatch"
            return "bound"

    def markers(self) -> tuple[str, ...]:
        """Printable forms of the key, only for leak guards."""
        with self._lock:
            key = self._key
        if key is None:
            return ()
        hex_key = key.hex()
        return (
            hex_key,
            hex_key.upper(),
            base64.b64encode(key).decode("ascii").rstrip("="),
            base64.urlsafe_b64encode(key).decode("ascii").rstrip("="),
        )

    def __repr__(self) -> str:
        return "<RequestChatKey>"


_request_key: ContextVar[RequestChatKey | None] = ContextVar("hussh_request_chat_key", default=None)


def parse_chat_key_header(value: str) -> bytes:
    match = _WIRE.fullmatch(str(value or "").strip())
    if match is None:
        raise ChatKeyUnavailableError(_KEY_MALFORMED)
    return bytes.fromhex(match.group(1))


def current_request_chat_key() -> RequestChatKey | None:
    return _request_key.get()


@contextmanager
def bind_request_chat_key(holder: RequestChatKey | None) -> Iterator[RequestChatKey | None]:
    """Bind ``holder`` to the current context; release this reference on exit."""
    token = _request_key.set(holder)
    try:
        yield holder
    finally:
        if holder is not None:
            holder.release()
        _request_key.reset(token)


def bind_request_chat_key_owner(owner_id: str) -> None:
    """Called once the vault owner is authenticated. No-op without a bound key."""
    holder = _request_key.get()
    if holder is not None:
        holder.bind_owner(owner_id)


@contextmanager
def retain_request_chat_key() -> Iterator[None]:
    """Keep the current request's key alive for a background run it started."""
    holder = _request_key.get()
    retained = holder.retain() if holder is not None else False
    try:
        yield
    finally:
        if retained and holder is not None:
            holder.release()


def request_has_chat_key(owner_id: str) -> bool:
    holder = _request_key.get()
    return holder is not None and holder.key_for(owner_id) is not None


def request_chat_key_state(owner_id: str | None = None) -> str:
    """``absent`` when this request carried no chat key, else the holder's state."""
    holder = _request_key.get()
    return "absent" if holder is None else holder.refusal_state(owner_id)


def current_chat_key_markers() -> tuple[str, ...]:
    holder = _request_key.get()
    return holder.markers() if holder is not None else ()


class ChatKeyProvider(Protocol):
    """Where the current owner's chat key comes from."""

    def current_key(self, owner_id: str) -> bytes:
        """Return the owner's 32-byte key or raise ``ChatKeyUnavailableError``."""
        ...


class RequestChatKeyProvider:
    """The key the owner's unlocked browser sent with this request, and only that."""

    def current_key(self, owner_id: str) -> bytes:
        holder = _request_key.get()
        key = holder.key_for(str(owner_id or "")) if holder is not None else None
        if key is None:
            raise ChatKeyUnavailableError(_KEY_REQUIRED)
        return key


_provider: ChatKeyProvider = RequestChatKeyProvider()


def get_chat_key_provider() -> ChatKeyProvider:
    return _provider


def set_chat_key_provider(provider: ChatKeyProvider) -> None:
    """Process-start hook for the pod provider. Never a per-request switch."""
    global _provider
    _provider = provider


def is_person_key_ciphertext(ciphertext: object) -> bool:
    return isinstance(ciphertext, str) and ciphertext.startswith(CHAT_CIPHERTEXT_PREFIX)


def chat_aad(table: str, column: str, row_key: str) -> str:
    """Bind a ciphertext to its row so it cannot be replayed into another one."""
    parts = (table, column, row_key)
    if not all(isinstance(part, str) and part for part in parts):
        raise ValueError("Chat record binding is incomplete.")
    return "|".join((CHAT_KEY_LABEL, *parts))


class ChatCipher:
    """AES-256-GCM under the owner's chat key: the only cipher for chat history."""

    def __init__(self, provider: ChatKeyProvider | None = None) -> None:
        self._provider = provider

    def _key(self, owner_id: str) -> bytes:
        return (self._provider or get_chat_key_provider()).current_key(owner_id)

    def seal(self, plaintext: str, *, owner_id: str, aad: str) -> EncryptedPayload:
        key = self._key(owner_id)
        iv = os.urandom(_IV_BYTES)
        sealed = AESGCM(key).encrypt(iv, str(plaintext).encode("utf-8"), aad.encode("utf-8"))
        body, tag = sealed[:-_TAG_BYTES], sealed[-_TAG_BYTES:]
        return EncryptedPayload(
            ciphertext=CHAT_CIPHERTEXT_PREFIX + base64.b64encode(body).decode("ascii"),
            iv=base64.b64encode(iv).decode("ascii"),
            tag=base64.b64encode(tag).decode("ascii"),
            encoding="base64",
            algorithm="aes-256-gcm",
        )

    def open(self, row: Mapping[str, Any], prefix: str, *, owner_id: str, aad: str) -> str:
        ciphertext = row.get(f"{prefix}_ciphertext")
        if ciphertext and not is_person_key_ciphertext(ciphertext):
            raise LegacyChatCiphertextError("Chat record predates person-key sealing.")
        iv = row.get(f"{prefix}_iv")
        tag = row.get(f"{prefix}_tag")
        if not ciphertext:
            return ""
        if not iv or not tag:
            # A marked record without its nonce or tag is damaged, never empty.
            raise ChatKeyMismatchError(_KEY_MISMATCH)
        key = self._key(owner_id)
        try:
            body = base64.b64decode(str(ciphertext)[len(CHAT_CIPHERTEXT_PREFIX) :], validate=True)
            nonce = base64.b64decode(str(iv), validate=True)
            mac = base64.b64decode(str(tag), validate=True)
            return AESGCM(key).decrypt(nonce, body + mac, aad.encode("utf-8")).decode("utf-8")
        except (InvalidTag, ValueError):
            raise ChatKeyMismatchError(_KEY_MISMATCH) from None


__all__ = [
    "CHAT_CIPHERTEXT_LIKE",
    "CHAT_CIPHERTEXT_PREFIX",
    "CHAT_KEY_ERRORS",
    "CHAT_KEY_ERROR_MESSAGES",
    "CHAT_KEY_RECOVERY_MESSAGE",
    "CHAT_KEY_REQUIRED_CODE",
    "CHAT_KEY_HEADER",
    "CHAT_KEY_LABEL",
    "ChatCipher",
    "ChatKeyMismatchError",
    "ChatKeyProvider",
    "ChatKeyUnavailableError",
    "LegacyChatCiphertextError",
    "RequestChatKey",
    "RequestChatKeyProvider",
    "bind_request_chat_key",
    "bind_request_chat_key_owner",
    "chat_aad",
    "current_chat_key_markers",
    "current_request_chat_key",
    "get_chat_key_provider",
    "is_person_key_ciphertext",
    "parse_chat_key_header",
    "request_chat_key_state",
    "request_has_chat_key",
    "retain_request_chat_key",
    "set_chat_key_provider",
]
