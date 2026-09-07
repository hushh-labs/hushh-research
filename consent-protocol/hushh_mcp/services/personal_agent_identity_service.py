"""Sovereign identity for the per-user personal-information agent.

The user's VERIFIED phone number (E.164) is the primary key by which they own
and control their personal information everywhere. From that phone number this
module derives three stable values:

  * ``hushh_id`` -- the OPAQUE public handle used to address the user's agent
    (e.g. the A2A route ``/u/{hushh_id}``). Derived by HMAC so it is stable
    (same phone -> same handle) yet not reversible to the phone number; the raw
    E.164 is therefore never placed in a URL.
  * ``phone_e164_hash`` -- an HMAC hash of the phone used as the stored lookup
    key in ``personal_agent_registry`` so the raw phone is never persisted.
  * ``billing_space_id`` -- the OPAQUE cost-attribution id that becomes a cloud
    label. Derived from the HusshID under its own context. This is NOT the
    spaceID the owner names: that handle (``personal_agent_registry.space_id``)
    is user-chosen, not derived, and this module only VALIDATES it
    (:func:`is_valid_space_handle`); it never mints it.

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
# NOT the spaceID. The spaceID (`personal_agent_registry.space_id`) is the
# owner's OWN chosen handle for their space -- a product concept, user-facing and
# user-set, per the spaceID doctrine (docs/future/personal-agent/ARCHITECTURE.md,
# "one per node/instance") and the founder's instruction that space_id is "the
# nickname/username the user wants to create". This context derives the SEPARATE
# opaque identifier that makes cloud spend attributable, which is deliberately
# NOT the handle: a handle is user-readable and mutable, and a billing label must
# be neither. Naming it billing-space keeps the two from ever being confused.
_BILLING_SPACE_ID_CONTEXT = b"hushh.personal-agent.billing-space-id.v1"
_HUSHH_ID_PREFIX = "ha1_"
_BILLING_SPACE_ID_PREFIX = "bsp_"
# 20 digest bytes -> 32 base32 chars: ample collision resistance, compact URL.
_HUSHH_ID_DIGEST_BYTES = 20
# 10 digest bytes -> 16 base32 chars, 19 with the prefix. Comfortably inside the
# 63-character ceiling a GCP label value allows, with room for it to be read in
# a billing console without wrapping.
_BILLING_SPACE_ID_DIGEST_BYTES = 10

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


def mint_billing_space_id(hushh_id: str) -> str:
    """Derive the opaque cost-attribution id for one person's agent.

    NOT THE SPACEID. The spaceID (``personal_agent_registry.space_id``) is the
    owner's own handle for their space, which they choose and can read. This is
    the SEPARATE opaque value that carries cost attribution into the cloud, and
    the two must never be the same string: a handle is user-facing and mutable,
    while this becomes the ``hussh-billing-space`` label on a Cloud Run service,
    and a label is readable by anyone holding project billing access.
    ``gcp_backend._label_value``'s own docstring forbids an email, a phone
    number, or a raw user id from ever reaching that surface, so the identifier
    that makes spend attributable has to be one that discloses nothing on its
    own -- which a user's chosen handle is not.

    Derived from the HusshID rather than the phone, and under a DISTINCT HMAC
    context from :func:`mint_hushh_id` and :func:`hash_phone_e164`, so no one of
    the three can be cross-derived from another.

    PERSIST IT, DO NOT RE-DERIVE IT. The key is ``APP_SIGNING_KEY``; a rotation
    would silently change the derivation for every pod minted afterwards, and a
    billing join built on re-derivation would quietly stop matching the rows it
    is supposed to explain. ``personal_agent_registry.billing_space_id`` is the
    join key of record; this function runs once, at provision.
    """
    subject = str(hushh_id or "").strip()
    if not subject:
        raise ValueError("hushh_id is required to mint a billing space id")
    digest = _hmac_digest(_BILLING_SPACE_ID_CONTEXT, subject)
    token = (
        base64.b32encode(digest[:_BILLING_SPACE_ID_DIGEST_BYTES])
        .decode("ascii")
        .rstrip("=")
        .lower()
    )
    return f"{_BILLING_SPACE_ID_PREFIX}{token}"


def is_valid_space_handle(handle: str) -> tuple[bool, str]:
    """Validate a user-chosen spaceID handle. Returns (ok, reason).

    The handle is the owner's product-facing name for their space. It is NEVER a
    cloud label and NEVER derived, so it does not carry the label's charset
    constraints -- but it is stored, shown back, and used in URLs and logs, so it
    is bounded and kept to a legible character set rather than left free-form.
    """
    raw = str(handle or "").strip()
    if not raw:
        return False, "a space name cannot be empty"
    if len(raw) > 48:
        return False, "a space name must be 48 characters or fewer"
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9 _.'-]*$", raw):
        return False, (
            "a space name may use letters, numbers, spaces, and . _ - ' and must "
            "start with a letter or number"
        )
    return True, ""
