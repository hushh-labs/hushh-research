"""Owner-scoped Wallet Profile labels, not globally unique account handles."""

from __future__ import annotations

import re
import unicodedata

_FORMAT = re.compile(r"^[a-z0-9]+(?:\.[a-z0-9]+)*$")
_RESERVED = frozenset({"admin", "administrator", "support", "system", "hushh", "agentone"})
_BLOCKED = frozenset(
    {
        "sex",
        "sexy",
        "porn",
        "porno",
        "pornhub",
        "xxx",
        "fuck",
        "fucker",
        "shit",
        "bitch",
        "cunt",
        "nigger",
        "nigga",
    }
)
_MESSAGE = "Use 3–30 lowercase letters, numbers or single dots."


def validate_wallet_username(value: str) -> str:
    """Return a valid label or raise a safe, field-specific validation error."""
    if not isinstance(value, str) or not 3 <= len(value) <= 30 or not _FORMAT.fullmatch(value):
        raise ValueError(_MESSAGE)
    words = [re.sub(r"[0-9]", "", part) for part in value.split(".")]
    compact = "".join(words)
    if compact in _RESERVED or compact in _BLOCKED or any(word in _BLOCKED for word in words):
        raise ValueError("Choose another username.")
    return value


def generate_wallet_username(display_name: str | None, user_id: str = "") -> str:
    """Create a readable suggestion without leaking email or owner identifiers.

    A username is a label within the owner's profile. Public access still uses
    the existing opaque share token, so identical names need no global suffix.
    ``user_id`` is accepted for provisioning callers but is deliberately unused.
    """
    del user_id
    ascii_name = (
        unicodedata.normalize("NFKD", display_name or "").encode("ascii", "ignore").decode()
    )
    value = re.sub(r"[^a-z0-9]+", ".", ascii_name.lower()).strip(".")[:30].rstrip(".")
    try:
        return validate_wallet_username(value)
    except ValueError:
        return "member"
