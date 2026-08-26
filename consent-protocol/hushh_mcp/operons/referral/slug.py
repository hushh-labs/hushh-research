"""Referral slug rules.

A slug is a PUBLIC attribution code. It is not a credential, it is not a
secret, and holding one proves nothing about who is holding it. What it must be
is unambiguous: two people can never end up sharing one, and a link typed in
any capitalisation must reach the same person.

Normalisation is therefore the load-bearing function in this module. It is the
only form uniqueness is defined on, and the database constrains the column to
this exact shape so a service bug cannot store something lookups would miss.
"""

from __future__ import annotations

import re
import secrets
import unicodedata

# Lowercase letters, digits, single interior hyphens. Nothing else survives
# normalisation, so nothing else can be stored.
_ALLOWED = re.compile(r"[^a-z0-9]+")
_SLUG_SHAPE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

SLUG_MIN_LENGTH = 3
SLUG_MAX_LENGTH = 64

# The random half. No vowels and no look-alike characters: a slug gets read
# aloud and typed from a screenshot, and `l`/`1`/`I` and `0`/`O` are where that
# goes wrong. Dropping vowels also means the generator cannot accidentally
# spell a word in the suffix.
_SUFFIX_ALPHABET = "23456789bcdfghjkmnpqrstvwxz"
_SUFFIX_LENGTH = 4

# Reserved outright: these either collide with a real route, or let a slug
# impersonate the product itself. Someone opening /r/support has every reason
# to think they are talking to Hushh.
RESERVED_SLUGS = frozenset(
    {
        "hushh",
        "hussh",
        "one",
        "kai",
        "nav",
        "admin",
        "root",
        "support",
        "help",
        "team",
        "official",
        "security",
        "billing",
        "account",
        "login",
        "signin",
        "signup",
        "verify",
        "settings",
        "profile",
        "referral",
        "referrals",
        "invite",
        "invites",
        "api",
        "www",
        "app",
        "new",
        "null",
        "undefined",
        "test",
        "r",
    }
)


def normalize_slug(raw: str | None) -> str:
    """Reduce any input to the single canonical form, or return ''.

    Unicode is folded to its ASCII skeleton first, so `Ánkit` and `Ankit`
    cannot become two different slugs that look identical in a message.
    """
    if not raw:
        return ""
    text = unicodedata.normalize("NFKD", str(raw))
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = _ALLOWED.sub("-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)
    return text[:SLUG_MAX_LENGTH].strip("-")


def is_valid_slug(value: str | None) -> bool:
    """True only for a slug that is already in canonical form and allowed."""
    if not value:
        return False
    if not (SLUG_MIN_LENGTH <= len(value) <= SLUG_MAX_LENGTH):
        return False
    if not _SLUG_SHAPE.match(value):
        return False
    return value not in RESERVED_SLUGS


def slug_stem(display_name: str | None) -> str:
    """The human half of a slug, taken from whatever name we have.

    Falls back to a neutral stem rather than leaking an email local-part or a
    phone number into a public URL.
    """
    stem = normalize_slug(display_name)
    # One word keeps the link short enough to read out loud.
    stem = stem.split("-")[0] if stem else ""
    if len(stem) < SLUG_MIN_LENGTH or stem in RESERVED_SLUGS:
        return "friend"
    return stem[:24]


def generate_slug(display_name: str | None, *, rng: secrets.SystemRandom | None = None) -> str:
    """Propose one slug. Uniqueness is the database's job, not this function's.

    The caller retries on collision; with 27^4 suffixes per stem a retry is
    rare, and pretending to guarantee uniqueness here would only hide the race.
    """
    chooser = rng or secrets.SystemRandom()
    suffix = "".join(chooser.choice(_SUFFIX_ALPHABET) for _ in range(_SUFFIX_LENGTH))
    candidate = f"{slug_stem(display_name)}-{suffix}"
    return candidate if is_valid_slug(candidate) else f"friend-{suffix}"
