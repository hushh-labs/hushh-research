"""Referral display handle rules.

A handle is a PUBLIC leaderboard alias, chosen by the referrer themselves --
never the real/account name from `actor_identity_cache`. It reuses slug.py's
Unicode-folding and shape normalization (the same "two people can never end
up sharing one, any capitalization reaches the same record" requirement
applies here too) but with its own, shorter length bound: a slug is read
aloud from a URL, a handle is read on a leaderboard row, and the UI budget
for the second is tighter.
"""

from __future__ import annotations

from hushh_mcp.operons.referral.slug import RESERVED_SLUGS, normalize_slug

HANDLE_MIN_LENGTH = 3
HANDLE_MAX_LENGTH = 24


def normalize_handle(raw: str | None) -> str:
    """Reduce any input to canonical form, truncated to the handle bound."""
    return normalize_slug(raw)[:HANDLE_MAX_LENGTH].strip("-")


def is_valid_handle(value: str | None) -> bool:
    """True only for a handle already in canonical form and allowed."""
    if not value:
        return False
    if not (HANDLE_MIN_LENGTH <= len(value) <= HANDLE_MAX_LENGTH):
        return False
    if value != normalize_handle(value):
        return False
    return value not in RESERVED_SLUGS
