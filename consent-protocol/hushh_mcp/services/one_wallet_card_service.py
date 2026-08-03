"""Wallet Profile card lifecycle — the owner-controlled plane behind a Hussh One pass.

This service owns exactly one table, ``one_wallet_cards``, with one row per
owner. It is the only place in the product that turns owner-selected
information into something an anonymous stranger can read, so the invariants
below are structural rather than advisory.

**A dedicated plane, deliberately.** Nothing here reads or writes
``pkm_default_available_projections``. That table is scanned by the Information
Marketplace catalogue with no source filter, so publishing a card through it
would silently list the owner for sale; it also mints a fresh handle on every
edit, which would invalidate an already-printed QR code. See the plan's D1.

**The share token.** Minted as ``secrets.token_urlsafe(32)`` and stored only as
its SHA-256 hex digest, mirroring the shipped One Location public-invite
pattern (``one_location_agent_service._hash_public_value``). The plaintext is
returned to the owner exactly once — at create and at rotate — and is never
stored, never logged, and never echoed in an error body. Rotating overwrites
the digest, so the previous token stops resolving the instant the statement
commits. Lookup hashes the presented token and confirms the row with
``hmac.compare_digest``.

**Status semantics are a privacy boundary, not cosmetics.** A ``paused`` card
and an unknown token produce the *identical* result object, so a visitor
holding a stale link cannot detect that a card exists and was paused.
``revoked`` and ``expired`` report honest terminal states because the visitor
already knew the card existed. Any status the schema does not define collapses
to "not found" — the read fails closed.

**One projection builder.** ``build_public_projection`` is the single function
behind both the public resolve route and the owner preview route, so
preview-as-visitor is byte-identical to what a stranger receives. It emits no
``user_id``, no ``pass_serial``, no ``share_token_hash``, no status and no
timestamp finer than a date.

**Scan counters are aggregate and best-effort.** ``record_scan`` bumps
``scan_count``/``last_scanned_at`` and swallows every failure at debug level:
no per-scan row, no address, no user agent, no referrer, no coordinates, and a
counter problem can never fail a visitor's read.

Every statement is parameterised — bandit forbids f-string SQL — and no
``card_payload`` value is ever logged.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Final, TypedDict, cast
from urllib.parse import urlparse

from db.db_client import get_db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------

STATUS_ACTIVE: Final = "active"
STATUS_PAUSED: Final = "paused"
STATUS_REVOKED: Final = "revoked"

# Public read states. ``not_found`` covers both an unknown token and a paused
# card; the route maps it to a generic 404 and the two are indistinguishable.
PUBLIC_NOT_FOUND: Final = "not_found"
PUBLIC_REVOKED: Final = "revoked"
PUBLIC_EXPIRED: Final = "expired"

# Error codes surfaced to the route layer.
CODE_OWNER_REQUIRED: Final = "WALLET_CARD_OWNER_REQUIRED"
CODE_PAYLOAD_INVALID: Final = "WALLET_CARD_PAYLOAD_INVALID"
CODE_FIELD_UNKNOWN: Final = "WALLET_CARD_FIELD_UNKNOWN"
CODE_NOT_FOUND: Final = "WALLET_CARD_NOT_FOUND"
CODE_TURNED_OFF: Final = "WALLET_CARD_TURNED_OFF"
CODE_WRITE_FAILED: Final = "WALLET_CARD_WRITE_FAILED"

# 32 bytes of entropy, url-safe — 43 characters. Same shape and same helper the
# One Location public invite uses.
_SHARE_SECRET_BYTES: Final = 32
_MIN_SHARE_LENGTH: Final = 16
_MAX_SHARE_LENGTH: Final = 128
_SHARE_ALPHABET: Final = re.compile(r"^[A-Za-z0-9_-]+$")

_MAX_USER_ID_LENGTH: Final = 160

# Public card page (contract §1). Relative when no public origin is configured.
_PUBLIC_CARD_PATH: Final = "/c/"
_PUBLIC_ORIGIN_ENV: Final = ("NEXT_PUBLIC_APP_URL", "APP_PUBLIC_URL", "FRONTEND_BASE_URL")


# ---------------------------------------------------------------------------
# card_payload allowlist (contract §3) — closed set, server-validated
# ---------------------------------------------------------------------------

# Declaration order is the serialisation order of the visitor projection.
_ORDERED_ALLOWLIST: Final[tuple[str, ...]] = (
    "full_name",
    "headline",
    "organisation",
    "location_label",
    "summary",
    "skills",
    "email",
    "phone",
    "website",
    "linkedin",
    "github",
    "portfolio",
    "preferred_contact",
)
_ALLOWED_KEYS: Final = frozenset(_ORDERED_ALLOWLIST)

_TEXT_FIELD_LIMITS: Final[dict[str, int]] = {
    "full_name": 80,
    "headline": 120,
    "organisation": 80,
    "location_label": 80,
    "summary": 400,
    "email": 254,
    "phone": 32,
    "website": 300,
    "linkedin": 300,
    "github": 300,
    "portfolio": 300,
    "preferred_contact": 16,
}

_FIELD_LABELS: Final[dict[str, str]] = {
    "full_name": "Name",
    "headline": "Headline",
    "organisation": "Organisation",
    "location_label": "Location",
    "summary": "Summary",
    "skills": "Skills",
    "email": "Email",
    "phone": "Phone",
    "website": "Website",
    "linkedin": "LinkedIn",
    "github": "GitHub",
    "portfolio": "Portfolio",
    "preferred_contact": "Preferred contact",
    # Not an allowlisted payload key — a column, validated like any link.
    "avatar_url": "Photo",
}

_URL_FIELDS: Final = frozenset({"website", "linkedin", "github", "portfolio"})
_PREFERRED_CONTACT_CHOICES: Final = ("email", "phone", "linkedin", "website")

_MAX_SKILLS: Final = 12
_MAX_SKILL_LENGTH: Final = 40
_MAX_AVATAR_URL_LENGTH: Final = 300

# Same shapes the route model enforces, restated here because the service is
# also reachable from background work and from tests without the route.
_EMAIL_PATTERN: Final = re.compile(r"^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$")
_PHONE_PATTERN: Final = re.compile(r"^\+?[0-9][0-9\s().-]{5,31}$")

# Everything after ``https://``: RFC 3986 characters only. Excludes whitespace,
# quotes, backslash and angle brackets, so markup can never survive into a
# stored link. ``@`` is allowed because it is legal in a path
# (``https://medium.com/@user``); the userinfo spoof is rejected separately by
# inspecting the netloc.
_URL_SAFE_PATTERN: Final = re.compile(r"^[A-Za-z0-9\-._~%:/?#\[\]@!$&()*+,;=]+$")

# Rejected key names are echoed back so the client can fix the request. They
# are client-authored text, so they are reduced to a safe charset first and
# only the first few are named.
_KEY_NAME_SAFE: Final = re.compile(r"[^A-Za-z0-9_.-]")
_MAX_REPORTED_KEYS: Final = 5
_MAX_REPORTED_KEY_LENGTH: Final = 40


# ---------------------------------------------------------------------------
# SQL — parameterised only (bandit forbids f-string SQL)
# ---------------------------------------------------------------------------

_SELECT_CARD_BY_OWNER: Final = """
    SELECT *
    FROM one_wallet_cards
    WHERE user_id = :user_id
    LIMIT 1
"""

_SELECT_CARD_BY_SHARE_HASH: Final = """
    SELECT *
    FROM one_wallet_cards
    WHERE share_token_hash = :share_token_hash
    LIMIT 1
"""

# ``DO NOTHING`` makes creation idempotent under a concurrent first write: the
# loser gets no row back and falls through to the update path.
_INSERT_CARD: Final = """
    INSERT INTO one_wallet_cards (
      user_id, share_token_hash, status, card_payload,
      display_name, headline, avatar_url, expires_at, created_at, updated_at
    )
    VALUES (
      :user_id, :share_token_hash, 'active', CAST(:card_payload_json AS JSONB),
      :display_name, :headline, CAST(:avatar_url AS TEXT),
      CAST(:expires_at AS TIMESTAMPTZ), NOW(), NOW()
    )
    ON CONFLICT (user_id) DO NOTHING
    RETURNING *
"""

# The share token is deliberately absent: editing a card must never invalidate
# an already-printed QR code. ``status <> 'revoked'`` fails the write closed if
# the owner revoked concurrently.
_UPDATE_CARD: Final = """
    UPDATE one_wallet_cards
    SET card_payload = CAST(:card_payload_json AS JSONB),
        display_name = :display_name,
        headline = :headline,
        avatar_url = CASE WHEN :apply_avatar
          THEN CAST(:avatar_url AS TEXT) ELSE avatar_url END,
        expires_at = CASE WHEN :apply_expiry
          THEN CAST(:expires_at AS TIMESTAMPTZ) ELSE expires_at END,
        updated_at = NOW()
    WHERE user_id = :user_id
      AND status <> 'revoked'
    RETURNING *
"""

# Setting the card up again after a revoke. The token is re-minted so links
# shared before the revoke stay dead, and revoked_at is cleared to satisfy the
# table's revocation CHECK.
_REACTIVATE_CARD: Final = """
    UPDATE one_wallet_cards
    SET card_payload = CAST(:card_payload_json AS JSONB),
        display_name = :display_name,
        headline = :headline,
        share_token_hash = :share_token_hash,
        share_token_version = share_token_version + 1,
        status = CASE WHEN status = 'revoked' THEN 'active' ELSE status END,
        revoked_at = NULL,
        avatar_url = CASE WHEN :apply_avatar
          THEN CAST(:avatar_url AS TEXT) ELSE avatar_url END,
        expires_at = CASE WHEN :apply_expiry
          THEN CAST(:expires_at AS TIMESTAMPTZ) ELSE expires_at END,
        updated_at = NOW()
    WHERE user_id = :user_id
      AND status = 'revoked'
    RETURNING *
"""

_ROTATE_SHARE_HASH: Final = """
    UPDATE one_wallet_cards
    SET share_token_hash = :share_token_hash,
        share_token_version = share_token_version + 1,
        updated_at = NOW()
    WHERE user_id = :user_id
      AND status <> 'revoked'
    RETURNING *
"""

_SET_CARD_STATUS: Final = """
    UPDATE one_wallet_cards
    SET status = :status,
        updated_at = NOW()
    WHERE user_id = :user_id
      AND status <> 'revoked'
    RETURNING *
"""

# Idempotent: COALESCE keeps the first revocation moment on a repeat call.
_REVOKE_CARD: Final = """
    UPDATE one_wallet_cards
    SET status = 'revoked',
        revoked_at = COALESCE(revoked_at, NOW()),
        updated_at = NOW()
    WHERE user_id = :user_id
    RETURNING *
"""

# Aggregate counters only. ``updated_at`` is deliberately untouched so a scan
# never shifts the coarse date a visitor can see.
_BUMP_SCAN_COUNTERS: Final = """
    UPDATE one_wallet_cards
    SET scan_count = scan_count + 1,
        last_scanned_at = NOW()
    WHERE share_token_hash = :share_token_hash
      AND status = 'active'
"""


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class OneWalletCardError(RuntimeError):
    """A Wallet Profile failure the route can translate directly.

    ``message`` is user-facing copy. It never carries a ``card_payload`` value,
    a share token, or any internal identifier.
    """

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def wallet_card_error_detail(error: OneWalletCardError) -> dict[str, str]:
    """HTTPException detail body for a Wallet Profile failure."""

    return {"code": error.code, "message": error.message}


class _Unset:
    """Sentinel for "leave the stored value exactly as it is"."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid only
        return "<unset>"


UNSET: Final = _Unset()


# ---------------------------------------------------------------------------
# Typed shapes
# ---------------------------------------------------------------------------


class PublicCardProjection(TypedDict, total=False):
    """What an anonymous visitor receives. Every key is optional because every
    allowlisted field is optional; absent values are omitted, never blank."""

    fullName: str
    headline: str
    organisation: str
    locationLabel: str
    summary: str
    skills: list[str]
    email: str
    phone: str
    website: str
    linkedin: str
    github: str
    portfolio: str
    preferredContact: str
    avatarUrl: str
    updatedOn: str


class PublicCardResult(TypedDict):
    """Envelope the public plane reports rather than raises, so the route can
    map ``not_found`` to a generic 404 and the terminal states to 410."""

    status: str
    card: PublicCardProjection | None


class OwnerCardView(TypedDict, total=False):
    """Owner-authenticated view. Carries no ``user_id`` and no token digest."""

    passSerial: str
    status: str
    shareTokenVersion: int
    cardPayload: dict[str, Any]
    displayName: str | None
    headline: str | None
    avatarUrl: str | None
    expiresAt: str | None
    createdAt: str | None
    updatedAt: str | None
    revokedAt: str | None
    lastScannedAt: str | None
    scanCount: int


class WalletCardMutation(TypedDict, total=False):
    """Owner mutation result. ``shareToken``/``shareUrl`` appear only when a
    token was minted — at create and at rotate — and never on a plain edit."""

    card: OwnerCardView
    shareToken: str
    shareUrl: str


class PassMaterial(TypedDict, total=False):
    """Everything the pass factory needs. No owner identifier, no digest."""

    passSerial: str
    publicCardUrl: str
    cardPayload: dict[str, Any]
    displayName: str | None
    headline: str | None
    expiresAt: str | None


class PassMaterialResult(TypedDict):
    status: str
    material: PassMaterial | None


@dataclass(frozen=True)
class WalletCardRecord:
    """One ``one_wallet_cards`` row, typed.

    Personal fields and the token digest are ``repr=False`` so they cannot leak
    through a traceback frame dump or an accidental log interpolation.
    """

    user_id: str = field(repr=False, default="")
    pass_serial: str = ""
    share_token_hash: str = field(repr=False, default="")
    share_token_version: int = 1
    status: str = STATUS_ACTIVE
    card_payload: dict[str, Any] = field(repr=False, default_factory=dict)
    display_name: str = field(repr=False, default="")
    headline: str = field(repr=False, default="")
    avatar_url: str = field(repr=False, default="")
    expires_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    revoked_at: datetime | None = None
    last_scanned_at: datetime | None = None
    scan_count: int = 0

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> WalletCardRecord:
        """Build a record from a raw database row, coercing every field.

        Never raises: a read must not fail because a column arrived in an
        unexpected representation.
        """

        return cls(
            user_id=_text(row.get("user_id")),
            pass_serial=_text(row.get("pass_serial")),
            share_token_hash=_text(row.get("share_token_hash")),
            share_token_version=_int(row.get("share_token_version"), default=1),
            status=_text(row.get("status")).lower(),
            card_payload=_json_object(row.get("card_payload")),
            display_name=_text(row.get("display_name")),
            headline=_text(row.get("headline")),
            avatar_url=_text(row.get("avatar_url")),
            expires_at=_as_datetime(row.get("expires_at")),
            created_at=_as_datetime(row.get("created_at")),
            updated_at=_as_datetime(row.get("updated_at")),
            revoked_at=_as_datetime(row.get("revoked_at")),
            last_scanned_at=_as_datetime(row.get("last_scanned_at")),
            scan_count=_int(row.get("scan_count"), default=0),
        )


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _int(value: Any, *, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _json_object(value: Any) -> dict[str, Any]:
    """Stored JSONB as a dict. Any other shape reads as empty."""

    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return dict(decoded) if isinstance(decoded, dict) else {}
    return {}


def _as_datetime(value: Any) -> datetime | None:
    """Coerce a column to an aware UTC datetime, or ``None``."""

    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        if not raw:
            return None
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _coarse_date(value: datetime | None) -> str:
    """Date only. The visitor never sees a timestamp finer than this."""

    return "" if value is None else value.strftime("%Y-%m-%d")


def _normalise_text(value: str) -> str:
    """Trim, collapse whitespace runs, drop control characters.

    Collapsing newlines is deliberate: pass fields and the visitor page are
    single-line surfaces, and a stored newline is the cheapest way to fake
    structure on either of them.
    """

    printable = "".join(char for char in value if char.isprintable() or char.isspace())
    return " ".join(printable.split())


def _hash_share_secret(value: str) -> str:
    """SHA-256 hex of the plaintext token — the only form ever persisted."""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalised_share_secret(value: Any) -> str:
    """Trimmed token, or ``""`` when the shape cannot be one of ours.

    A wrong-shape token is rejected here, before any query runs, so junk never
    reaches the database and a probe learns nothing from response timing.
    """

    candidate = _text(value)
    if len(candidate) < _MIN_SHARE_LENGTH or len(candidate) > _MAX_SHARE_LENGTH:
        return ""
    return candidate if _SHARE_ALPHABET.match(candidate) else ""


def _public_origin() -> str:
    """Configured public web origin, or ``""`` for a relative URL."""

    raw = ""
    for name in _PUBLIC_ORIGIN_ENV:
        raw = _text(os.getenv(name))
        if raw:
            break
    raw = raw.rstrip("/")
    if not raw:
        return ""
    return raw if "://" in raw else f"https://{raw}"


def public_card_url(share_token: str) -> str:
    """Visitor URL for a share token — the QR payload and the owner's link."""

    origin = _public_origin()
    path = f"{_PUBLIC_CARD_PATH}{share_token}"
    return f"{origin}{path}" if origin else path


def _safe_key_names(keys: list[str]) -> str:
    """Client-authored key names, reduced to a charset safe to echo back."""

    names = [
        _KEY_NAME_SAFE.sub("", str(key))[:_MAX_REPORTED_KEY_LENGTH]
        for key in keys[:_MAX_REPORTED_KEYS]
    ]
    return ", ".join(name for name in names if name)


def _invalid(field_key: str, message: str) -> OneWalletCardError:
    label = _FIELD_LABELS.get(field_key, "This field")
    return OneWalletCardError(CODE_PAYLOAD_INVALID, f"{label}: {message}", status_code=422)


# ---------------------------------------------------------------------------
# Field validation (contract §3)
# ---------------------------------------------------------------------------


def _validated_https_url(field_key: str, value: str) -> str:
    """Accept a plain ``https://host/...`` URL and nothing else.

    Rejects every other scheme — notably ``javascript:`` and ``data:`` — the
    scheme-relative ``//host`` form, the ``https://trusted@evil`` userinfo
    spoof, and any character that could carry markup. Stored as plain text and
    escaped at render time.

    Only the scheme is normalised (to lower case), so a link the owner pasted
    is served back exactly as they wrote it.
    """

    try:
        parsed = urlparse(value)
    except ValueError as exc:
        raise _invalid(field_key, "enter a valid link.") from exc
    if parsed.scheme != "https":
        raise _invalid(field_key, "links must start with https://")
    if not parsed.hostname:
        raise _invalid(field_key, "links must include a website address.")
    if "@" in parsed.netloc:
        raise _invalid(field_key, "links must not contain sign-in details.")

    _, _, remainder = value.partition("://")
    if not _URL_SAFE_PATTERN.match(remainder):
        raise _invalid(field_key, "links must not contain spaces or symbols.")
    return f"https://{remainder}"


def _validated_skills(value: Any) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise _invalid("skills", "add skills as a list of short labels.")
    if len(value) > _MAX_SKILLS:
        raise _invalid("skills", f"add up to {_MAX_SKILLS}.")

    cleaned: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise _invalid("skills", "each skill must be text.")
        text = _normalise_text(item)
        if not text:
            continue
        if len(text) > _MAX_SKILL_LENGTH:
            raise _invalid("skills", f"each must be {_MAX_SKILL_LENGTH} characters or fewer.")
        cleaned.append(text)
    return cleaned or None


def _validated_field(field_key: str, value: Any) -> Any | None:
    """Stored form of one allowlisted field, or ``None`` to omit it.

    Over-long values are refused, never truncated: silently shortening what
    someone chose to publish is its own kind of misrepresentation.
    """

    if field_key == "skills":
        return _validated_skills(value)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid(field_key, "must be text.")

    text = _normalise_text(value)
    if not text:
        return None

    limit = _TEXT_FIELD_LIMITS[field_key]
    if len(text) > limit:
        raise _invalid(field_key, f"must be {limit} characters or fewer.")

    if field_key in _URL_FIELDS:
        return _validated_https_url(field_key, text)
    if field_key == "email" and not _EMAIL_PATTERN.match(text):
        raise _invalid(field_key, "enter a valid email address.")
    if field_key == "phone" and not _PHONE_PATTERN.match(text):
        raise _invalid(field_key, "enter a valid phone number.")
    if field_key == "preferred_contact":
        choice = text.lower()
        if choice not in _PREFERRED_CONTACT_CHOICES:
            raise _invalid(field_key, "choose email, phone, LinkedIn or website.")
        return choice
    return text


def _resolve_preferred_contact(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop a preferred contact whose field is not being shared.

    Pointing the visitor at a channel that is not on the card would print a
    promise the card cannot keep.
    """

    choice = payload.get("preferred_contact")
    if choice and not payload.get(str(choice)):
        payload.pop("preferred_contact", None)
    return payload


def validate_card_payload(card_payload: Any) -> dict[str, Any]:
    """Validate a client-supplied ``card_payload`` against the closed allowlist.

    An unknown key is **rejected**, never silently dropped: the owner asked for
    something to be published, and quietly discarding part of that request
    would leave them believing it was shared. Empty values are dropped rather
    than stored blank.

    Raises:
        OneWalletCardError: 422 for an unknown key or an invalid value. The
            message names the field but never repeats the value.
    """

    if not isinstance(card_payload, Mapping):
        raise OneWalletCardError(
            CODE_PAYLOAD_INVALID,
            "Wallet Profile details must be sent as an object.",
            status_code=422,
        )

    unknown = [str(key) for key in card_payload if key not in _ALLOWED_KEYS]
    if unknown:
        named = _safe_key_names(unknown)
        detail = f": {named}" if named else ""
        raise OneWalletCardError(
            CODE_FIELD_UNKNOWN,
            f"These fields cannot be shared on a Wallet Profile{detail}.",
            status_code=422,
        )

    validated: dict[str, Any] = {}
    for field_key in _ORDERED_ALLOWLIST:
        if field_key not in card_payload:
            continue
        value = _validated_field(field_key, card_payload[field_key])
        if value is not None:
            validated[field_key] = value
    return _resolve_preferred_contact(validated)


def allowlisted_card_payload(stored: Any) -> dict[str, Any]:
    """Read-side sanitiser for an already-stored payload.

    Applies the same per-field rules as :func:`validate_card_payload` but drops
    what fails instead of raising, so a row written before a rule tightened can
    still be read — while a value that would now be refused (an off-allowlist
    key, a ``javascript:`` link) can never reach a visitor.
    """

    if not isinstance(stored, Mapping):
        return {}

    clean: dict[str, Any] = {}
    for field_key in _ORDERED_ALLOWLIST:
        if field_key not in stored:
            continue
        try:
            value = _validated_field(field_key, stored[field_key])
        except OneWalletCardError:
            continue
        if value is not None:
            clean[field_key] = value
    return _resolve_preferred_contact(clean)


# ---------------------------------------------------------------------------
# The visitor projection
# ---------------------------------------------------------------------------

# Stored key -> public key. Declaration order is the emitted order.
_PROJECTION_KEYS: Final[tuple[tuple[str, str], ...]] = (
    ("full_name", "fullName"),
    ("headline", "headline"),
    ("organisation", "organisation"),
    ("location_label", "locationLabel"),
    ("summary", "summary"),
    ("skills", "skills"),
    ("email", "email"),
    ("phone", "phone"),
    ("website", "website"),
    ("linkedin", "linkedin"),
    ("github", "github"),
    ("portfolio", "portfolio"),
    ("preferred_contact", "preferredContact"),
)


def _shareable_avatar_url(record: WalletCardRecord) -> str:
    """The headshot, when it is safe to hand to an anonymous visitor.

    Two guards, both fail-closed. The URL must survive the same link
    validation an owner-supplied link does, so a ``javascript:`` value that
    somehow reached the column can never be rendered. And it is withheld
    entirely if it contains the owner's ``user_id`` — object-storage paths
    routinely embed the uid, and the visitor plane must not leak one.
    """

    if not record.avatar_url:
        return ""
    try:
        url = _validated_https_url("avatar_url", _normalise_text(record.avatar_url))
    except OneWalletCardError:
        return ""
    return "" if record.user_id and record.user_id in url else url


def build_public_projection(card: WalletCardRecord | Mapping[str, Any]) -> PublicCardProjection:
    """Build the visitor projection for one card.

    **This is the single builder used by both the public resolve route and the
    owner preview route.** Preview-as-visitor is byte-identical to what a
    stranger receives because it is literally the same function over the same
    row — there is no second code path, and no route may assemble a projection
    of its own.

    The result carries only allowlisted ``card_payload`` fields, the headshot
    when it is safe to share, and a coarse ``updatedOn`` date. It never emits
    ``user_id``, ``pass_serial``, ``share_token_hash``, the card status, a scan
    counter, or any other internal identifier or timestamp. Absent fields are
    omitted rather than sent as blanks.
    """

    record = card if isinstance(card, WalletCardRecord) else WalletCardRecord.from_row(card)
    payload = allowlisted_card_payload(record.card_payload)

    projection: dict[str, Any] = {}
    for stored_key, public_key in _PROJECTION_KEYS:
        value = payload.get(stored_key)
        if not value:
            continue
        projection[public_key] = list(value) if isinstance(value, list) else value

    avatar_url = _shareable_avatar_url(record)
    if avatar_url:
        projection["avatarUrl"] = avatar_url

    updated_on = _coarse_date(record.updated_at or record.created_at)
    if updated_on:
        projection["updatedOn"] = updated_on
    return cast(PublicCardProjection, projection)


def _not_found_result() -> PublicCardResult:
    """The result an unknown token produces — and a paused card with it.

    A paused card must be indistinguishable from one that never existed, so
    both states return this identical object.
    """

    return {"status": PUBLIC_NOT_FOUND, "card": None}


def _terminal_result(state: str) -> PublicCardResult:
    return {"status": state, "card": None}


def _is_expired(record: WalletCardRecord) -> bool:
    return record.expires_at is not None and record.expires_at <= _utcnow()


def _public_result(row: Mapping[str, Any] | None) -> PublicCardResult:
    """Apply the binding §6 status rules to a resolved row.

    Order matters: ``paused`` is checked before anything else so a paused card
    cannot be distinguished by its expiry, and an unrecognised status falls
    through to "not found" so the read fails closed.
    """

    if row is None:
        return _not_found_result()

    record = WalletCardRecord.from_row(row)
    if record.status == STATUS_PAUSED:
        return _not_found_result()
    if record.status == STATUS_REVOKED:
        return _terminal_result(PUBLIC_REVOKED)
    if record.status != STATUS_ACTIVE:
        return _not_found_result()
    if _is_expired(record):
        return _terminal_result(PUBLIC_EXPIRED)
    return {"status": STATUS_ACTIVE, "card": build_public_projection(record)}


def _owner_card_view(row: Mapping[str, Any]) -> OwnerCardView:
    """Owner-authenticated view of a row. Omits ``user_id`` and the digest."""

    record = WalletCardRecord.from_row(row)
    return {
        "passSerial": record.pass_serial,
        "status": record.status,
        "shareTokenVersion": record.share_token_version,
        "cardPayload": allowlisted_card_payload(record.card_payload),
        "displayName": record.display_name or None,
        "headline": record.headline or None,
        "avatarUrl": record.avatar_url or None,
        "expiresAt": _iso(record.expires_at),
        "createdAt": _iso(record.created_at),
        "updatedAt": _iso(record.updated_at),
        "revokedAt": _iso(record.revoked_at),
        "lastScannedAt": _iso(record.last_scanned_at),
        "scanCount": record.scan_count,
    }


def _pass_material(record: WalletCardRecord, share_token: str) -> PassMaterial:
    """Pass-face material for an active card.

    The public card URL is the QR payload, so it must be the same URL the
    owner shares. No owner identifier and no token digest travel with it.
    """

    payload = allowlisted_card_payload(record.card_payload)
    return {
        "passSerial": record.pass_serial,
        "publicCardUrl": public_card_url(share_token),
        "cardPayload": payload,
        "displayName": str(payload.get("full_name") or record.display_name) or None,
        "headline": str(payload.get("headline") or record.headline) or None,
        "expiresAt": _iso(record.expires_at),
    }


# ---------------------------------------------------------------------------
# Owner input coercion
# ---------------------------------------------------------------------------


def _require_user_id(value: Any) -> str:
    owner_id = _text(value)
    if not owner_id or len(owner_id) > _MAX_USER_ID_LENGTH:
        raise OneWalletCardError(
            CODE_OWNER_REQUIRED,
            "Sign in to manage your Wallet Profile.",
            status_code=401,
        )
    return owner_id


def _expiry_parameters(value: str | datetime | None | _Unset) -> tuple[bool, datetime | None]:
    """``(apply, value)`` for the expiry column.

    ``UNSET`` keeps whatever is stored; an explicit ``None`` or empty string
    clears the expiry, which is how the contract spells "no expiry".
    """

    if isinstance(value, _Unset):
        return (False, None)
    if value is None:
        return (True, None)
    if isinstance(value, datetime):
        return (True, _as_datetime(value))

    text = _text(value)
    if not text:
        return (True, None)
    parsed = _as_datetime(text)
    if parsed is None:
        raise OneWalletCardError(
            CODE_PAYLOAD_INVALID,
            "Enter the expiry as a date and time.",
            status_code=422,
        )
    return (True, parsed)


def _avatar_parameters(value: str | None | _Unset) -> tuple[bool, str | None]:
    """``(apply, value)`` for the avatar column, validated like any link."""

    if isinstance(value, _Unset):
        return (False, None)
    if value is None:
        return (True, None)

    text = _normalise_text(_text(value))
    if not text:
        return (True, None)
    if len(text) > _MAX_AVATAR_URL_LENGTH:
        raise _invalid("avatar_url", f"must be {_MAX_AVATAR_URL_LENGTH} characters or fewer.")
    return (True, _validated_https_url("avatar_url", text))


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class OneWalletCardService:
    """Lifecycle of the single ``one_wallet_cards`` row an owner may have."""

    # --- persistence seam -------------------------------------------------

    def _execute_one(
        self,
        sql: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params or {})
        rows = getattr(result, "data", None) or []
        return dict(rows[0]) if rows else None

    def _execute(self, sql: str, params: dict[str, Any] | None = None) -> None:
        get_db().execute_raw(sql, params or {})

    def _row_for_owner(self, owner_id: str) -> dict[str, Any] | None:
        return self._execute_one(_SELECT_CARD_BY_OWNER, {"user_id": owner_id})

    def _row_for_share_token(self, share_token: Any) -> dict[str, Any] | None:
        """Resolve a presented token to its row, or ``None``.

        The plaintext is hashed and only the digest is queried; the row is then
        confirmed with a constant-time comparison so the lookup cannot be
        narrowed by timing a partial match.
        """

        presented = _normalised_share_secret(share_token)
        if not presented:
            return None

        expected = _hash_share_secret(presented)
        row = self._execute_one(_SELECT_CARD_BY_SHARE_HASH, {"share_token_hash": expected})
        if row is None:
            return None
        if not hmac.compare_digest(_text(row.get("share_token_hash")), expected):
            return None
        return row

    def _missing_or_turned_off(self, owner_id: str) -> OneWalletCardError:
        """Explain why an owner mutation matched no row."""

        if self._row_for_owner(owner_id) is None:
            return OneWalletCardError(
                CODE_NOT_FOUND,
                "Set up your Wallet Profile first.",
                status_code=404,
            )
        return OneWalletCardError(
            CODE_TURNED_OFF,
            "This Wallet Profile was turned off. Set it up again to share it.",
            status_code=409,
        )

    @staticmethod
    def _mutation(row: Mapping[str, Any], *, share_token: str | None = None) -> WalletCardMutation:
        result: dict[str, Any] = {"card": _owner_card_view(row)}
        if share_token:
            result["shareToken"] = share_token
            result["shareUrl"] = public_card_url(share_token)
        return cast(WalletCardMutation, result)

    # --- owner reads ------------------------------------------------------

    def get_card(self, *, user_id: str) -> OwnerCardView | None:
        """The owner's card, or ``None`` when they have not set one up.

        Scoped to the caller by primary key, so one owner can never read
        another's row. The plaintext share token is not returned here — it
        exists only in the create and rotate responses.
        """

        owner_id = _require_user_id(user_id)
        row = self._row_for_owner(owner_id)
        return None if row is None else _owner_card_view(row)

    def preview_public_card(self, *, user_id: str) -> PublicCardResult:
        """Preview-as-visitor for the owner.

        Runs the owner's row through the same status rules and the same
        :func:`build_public_projection` the public route uses, so what the
        owner sees here is exactly what a stranger receives.
        """

        owner_id = _require_user_id(user_id)
        return _public_result(self._row_for_owner(owner_id))

    # --- owner mutations --------------------------------------------------

    def upsert_card(
        self,
        *,
        user_id: str,
        card_payload: Any,
        expires_at: str | datetime | None | _Unset = UNSET,
        avatar_url: str | None | _Unset = UNSET,
    ) -> WalletCardMutation:
        """Create or replace the shared fields. Idempotent.

        The token is minted on first creation and returned exactly once; a
        later edit leaves it untouched so an already-printed QR keeps working.
        Setting the card up again after a revoke re-mints the token instead of
        resurrecting the old one, so links shared before the revoke stay dead.

        ``card_payload`` replaces the stored payload wholesale — the owner's
        edit screen submits the complete set of fields it is sharing, and
        merging would make removing a field impossible.
        """

        owner_id = _require_user_id(user_id)
        payload = validate_card_payload(card_payload)
        apply_expiry, expiry = _expiry_parameters(expires_at)
        apply_avatar, avatar = _avatar_parameters(avatar_url)

        share_token = secrets.token_urlsafe(_SHARE_SECRET_BYTES)
        columns: dict[str, Any] = {
            "user_id": owner_id,
            "card_payload_json": json.dumps(payload, sort_keys=True, separators=(",", ":")),
            "display_name": payload.get("full_name"),
            "headline": payload.get("headline"),
            "avatar_url": avatar,
            "expires_at": expiry,
        }

        created = self._execute_one(
            _INSERT_CARD,
            {**columns, "share_token_hash": _hash_share_secret(share_token)},
        )
        if created is not None:
            logger.info("wallet_card.created user_id=%s", owner_id)
            return self._mutation(created, share_token=share_token)

        existing = self._row_for_owner(owner_id)
        if existing is None:
            # The insert conflicted, so a row existed a moment ago. Fail closed
            # rather than retry into an unbounded loop.
            raise OneWalletCardError(
                CODE_WRITE_FAILED,
                "We couldn't save your Wallet Profile. Please try again.",
                status_code=409,
            )

        mutable = {**columns, "apply_avatar": apply_avatar, "apply_expiry": apply_expiry}
        if _text(existing.get("status")).lower() == STATUS_REVOKED:
            reactivated = self._execute_one(
                _REACTIVATE_CARD,
                {**mutable, "share_token_hash": _hash_share_secret(share_token)},
            )
            if reactivated is None:
                raise self._missing_or_turned_off(owner_id)
            logger.info("wallet_card.reactivated user_id=%s", owner_id)
            return self._mutation(reactivated, share_token=share_token)

        updated = self._execute_one(_UPDATE_CARD, mutable)
        if updated is None:
            raise self._missing_or_turned_off(owner_id)
        logger.info("wallet_card.updated user_id=%s", owner_id)
        return self._mutation(updated)

    def rotate_share_token(self, *, user_id: str) -> WalletCardMutation:
        """Mint a new share token and invalidate the previous one immediately.

        Only the current digest is retained, so the moment this statement
        commits every previously shared link stops resolving. The plaintext is
        returned here once and is not recoverable afterwards. ``pass_serial``
        is untouched, so re-adding the pass overwrites the installed one rather
        than stacking a duplicate.
        """

        owner_id = _require_user_id(user_id)
        share_token = secrets.token_urlsafe(_SHARE_SECRET_BYTES)
        row = self._execute_one(
            _ROTATE_SHARE_HASH,
            {"user_id": owner_id, "share_token_hash": _hash_share_secret(share_token)},
        )
        if row is None:
            raise self._missing_or_turned_off(owner_id)

        logger.info(
            "wallet_card.share_rotated user_id=%s version=%s",
            owner_id,
            row.get("share_token_version"),
        )
        return self._mutation(row, share_token=share_token)

    def pause_card(self, *, user_id: str) -> WalletCardMutation:
        """Stop serving the card. A visitor sees exactly "not found"."""

        return self._set_status(user_id=user_id, status=STATUS_PAUSED)

    def resume_card(self, *, user_id: str) -> WalletCardMutation:
        """Serve the card again on the same token, so printed QRs still work."""

        return self._set_status(user_id=user_id, status=STATUS_ACTIVE)

    def _set_status(self, *, user_id: str, status: str) -> WalletCardMutation:
        owner_id = _require_user_id(user_id)
        row = self._execute_one(_SET_CARD_STATUS, {"user_id": owner_id, "status": status})
        if row is None:
            # A revoked card is excluded by the statement: revocation is
            # terminal and pause/resume must not undo it.
            raise self._missing_or_turned_off(owner_id)
        logger.info("wallet_card.status_set user_id=%s status=%s", owner_id, status)
        return self._mutation(row)

    def revoke_card(self, *, user_id: str) -> WalletCardMutation:
        """Turn the card off for good. Idempotent.

        A repeat revoke keeps the original ``revoked_at`` so the honest "no
        longer shared" state the visitor sees never drifts.
        """

        owner_id = _require_user_id(user_id)
        row = self._execute_one(_REVOKE_CARD, {"user_id": owner_id})
        if row is None:
            raise OneWalletCardError(
                CODE_NOT_FOUND,
                "There is no Wallet Profile to turn off.",
                status_code=404,
            )
        logger.info("wallet_card.revoked user_id=%s", owner_id)
        return self._mutation(row)

    # --- public plane -----------------------------------------------------

    def resolve_public_card(self, *, share_token: str) -> PublicCardResult:
        """Resolve a scanned token into the visitor projection.

        Reports the state rather than raising, because the route has to map
        ``not_found`` to a generic 404 and ``revoked``/``expired`` to an honest
        410 — raising would collapse every terminal state into one answer.

        Unknown tokens and paused cards return the identical result object.
        This does not touch the scan counters; the route bumps them out of band
        with :meth:`record_scan`.
        """

        return _public_result(self._row_for_share_token(share_token))

    def resolve_pass_material(self, *, share_token: str) -> PassMaterialResult:
        """Material for the signed `.pkpass`, under the same status rules.

        Returns no material for any state other than ``active``, so a paused,
        revoked or expired card can never be downloaded as a pass.
        """

        presented = _normalised_share_secret(share_token)
        row = self._row_for_share_token(presented)
        result = _public_result(row)
        if row is None or result["status"] != STATUS_ACTIVE:
            return {"status": result["status"], "material": None}

        record = WalletCardRecord.from_row(row)
        return {"status": STATUS_ACTIVE, "material": _pass_material(record, presented)}

    def record_scan(self, *, share_token: str) -> None:
        """Bump the coarse scan counters. Best effort, never fatal.

        Aggregate only: ``scan_count`` and ``last_scanned_at``, nothing else.
        No per-scan row, address, user agent, referrer or location is recorded.
        Every failure is swallowed at debug level with no token and no payload
        value in the log line, because a counter must never fail a read.
        """

        try:
            presented = _normalised_share_secret(share_token)
            if not presented:
                return
            self._execute(
                _BUMP_SCAN_COUNTERS,
                {"share_token_hash": _hash_share_secret(presented)},
            )
        except Exception as exc:  # counters are advisory only
            logger.debug("wallet_card.scan_counter_failed error=%s", exc.__class__.__name__)
