"""Sovereign identity for the per-user personal-information agent.

The user's VERIFIED phone number (E.164) is the primary key by which they own
and control their personal information everywhere. From that phone number this
module derives two stable values, and nothing else:

  * ``hushh_id`` -- the OPAQUE public handle used to address the user's agent
    (e.g. the A2A route ``/u/{hushh_id}``). Derived by HMAC so it is stable
    (same phone -> same handle) yet not reversible to the phone number; the raw
    E.164 is therefore never placed in a URL.
  * ``phone_e164_hash`` -- an HMAC hash of the phone used as the stored lookup
    key in ``personal_agent_registry`` so the raw phone is never persisted.

Both use HMAC-SHA256 keyed by ``APP_SIGNING_KEY`` (the same signing-key trust
domain as consent tokens), with DISTINCT context tags so the two digests can
never collide or be cross-derived. Pure functions; no I/O, no state mutation.

Recycled-phone edge case: because ``hushh_id`` is phone-derived, a number that
is later reassigned to a different person would map to the same handle. That is
disambiguated at provisioning time (Phase 1) via the deletion tombstone plus
the ``generation`` salt below before any address is reused; Phase 0 keeps the
derivation pure and defaults ``generation`` to 0.

Reached only when the ``PERSONAL_AGENT_ENABLED`` kill-switch is on.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re

from hushh_mcp.runtime_settings import get_core_security_settings

_HUSHH_ID_CONTEXT = b"hushh.personal-agent.hushh-id.v1"
_PHONE_HASH_CONTEXT = b"hushh.personal-agent.phone-hash.v1"
_HUSHH_ID_PREFIX = "ha1_"
# 20 digest bytes -> 32 base32 chars: ample collision resistance, compact URL.
_HUSHH_ID_DIGEST_BYTES = 20

# ASCII digits only: ``\d`` would also match Unicode digits (Arabic-Indic,
# fullwidth, ...), which hash to a different digest than the ASCII form of the
# same number. The normalizer is a trust boundary, so it must not admit that
# ambiguity -- ``[0-9]`` rejects non-ASCII digits fail-closed.
_E164_RE = re.compile(r"^\+[1-9][0-9]{6,14}$")
_STRIP_RE = re.compile(r"[\s\-().]")


def normalize_e164(phone: str) -> str:
    """Normalize a phone string to strict E.164, or raise ``ValueError``.

    Strips spaces/dashes/parens; requires a leading ``+`` and 7-15 digits.
    """
    raw = str(phone or "").strip()
    if not raw:
        raise ValueError("phone number is empty")
    compact = _STRIP_RE.sub("", raw)
    if not _E164_RE.match(compact):
        raise ValueError("phone number is not valid E.164")
    return compact


def _hmac_digest(context: bytes, message: str) -> bytes:
    key = get_core_security_settings().app_signing_key.encode("utf-8")
    return hmac.new(key, context + b"|" + message.encode("utf-8"), hashlib.sha256).digest()


def mint_hushh_id(phone_e164: str, generation: int = 0) -> str:
    """Derive the stable, opaque public HusshID from a verified E.164 phone.

    Deterministic (same phone + generation -> same id) and non-reversible. Safe
    to place in a public URL; the raw phone number never is. ``generation`` is
    reserved for recycled-phone rotation (see module docstring) and defaults 0.
    """
    if generation < 0:
        raise ValueError("generation must be non-negative")
    normalized = normalize_e164(phone_e164)
    digest = _hmac_digest(_HUSHH_ID_CONTEXT, f"{normalized}|g{generation}")
    token = base64.b32encode(digest[:_HUSHH_ID_DIGEST_BYTES]).decode("ascii").rstrip("=").lower()
    return f"{_HUSHH_ID_PREFIX}{token}"


def hash_phone_e164(phone_e164: str) -> str:
    """HMAC hash of the E.164 phone for storage as the registry lookup key.

    Uses a distinct HMAC context from :func:`mint_hushh_id` so the stored lookup
    hash can never be used to recover or cross-derive the public HusshID.
    """
    normalized = normalize_e164(phone_e164)
    return _hmac_digest(_PHONE_HASH_CONTEXT, normalized).hex()
