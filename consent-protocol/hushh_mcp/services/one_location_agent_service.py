from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator
from uuid import UUID

from sqlalchemy import text

from api.utils.fcm_messages import build_push_message
from api.utils.firebase_admin import ensure_firebase_admin
from db.db_client import DatabaseExecutionError, get_db, get_db_connection
from hushh_mcp.consent.pii_sanitizer import mask_email
from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.operons.location.policy import (
    LOCATION_CAPABILITY_SCOPES,
    TIMED_LOCATION_SHARE_DURATION_MODE,
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
    format_duration_label,
    normalize_duration_hours,
    normalize_duration_mode,
    normalize_source_platform,
)
from hushh_mcp.types import AgentID, UserID
from mcp_modules.log_redaction import redact_log_field, redact_log_value

logger = logging.getLogger(__name__)

# Capability scope minted into the per-grant HCT consent token. Live-location
# viewing is the authority the recipient device exercises when reading
# ciphertext envelopes, so the grant's signed token carries this scope.
LOCATION_GRANT_CONSENT_SCOPE = "cap.location.live.view"

# One sentence for one rule. Every location authority path — grant creation,
# the atomic grant+envelope write, and SMS contact selection — admits the same
# two relationships: a direct connection, or shared membership of an active
# named Circle. Wording is shared so a rejected user is never told a different
# story depending on which endpoint refused them.
LOCATION_PEER_NOT_ELIGIBLE_MESSAGE = (
    "You can only share your live location with a connection or an active Circle member."
)
LOCATION_SMS_CONTACT_NOT_ELIGIBLE_MESSAGE = (
    "Only an active connection or Circle member can be added as an SMS contact."
)

_NOTIFICATION_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(1, int(os.getenv("ONE_LOCATION_NOTIFICATION_WORKERS", "2"))),
    thread_name_prefix="one-location-notify",
)

COORDINATE_METADATA_KEYS = {
    "lat",
    "latitude",
    "lng",
    "lon",
    "long",
    "longitude",
    "accuracy",
    "accuracy_m",
    "accuracym",
    "heading",
    "speed",
    "coordinates",
    "location",
    "address",
    "map",
    "map_url",
    "reverse_geocode",
}
LOCATION_TERMINAL_RETENTION_HOURS = 12
ATOMIC_LOCATION_SHARE_NAMESPACE = uuid.UUID("ef983dac-5044-49b0-9d35-c523b3437a54")


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


PUBLIC_INVITE_DEFAULT_OWNER_LABEL = "A trusted person"
PUBLIC_INVITE_MAX_SUBMISSIONS_PER_TOKEN = _bounded_int_env(
    "ONE_LOCATION_PUBLIC_INVITE_MAX_SUBMISSIONS_PER_TOKEN", 25, 1, 100
)
PUBLIC_INVITE_MAX_SUBMISSIONS_PER_PHONE = _bounded_int_env(
    "ONE_LOCATION_PUBLIC_INVITE_MAX_SUBMISSIONS_PER_PHONE", 1, 1, 5
)
PUBLIC_INVITE_PHONE_THROTTLE_MINUTES = _bounded_int_env(
    "ONE_LOCATION_PUBLIC_INVITE_PHONE_THROTTLE_MINUTES", 15, 1, 1440
)
PUBLIC_INVITE_FINGERPRINT_THROTTLE_MINUTES = _bounded_int_env(
    "ONE_LOCATION_PUBLIC_INVITE_FINGERPRINT_THROTTLE_MINUTES", 10, 1, 1440
)
PUBLIC_INVITE_MAX_SUBMISSIONS_PER_FINGERPRINT_WINDOW = _bounded_int_env(
    "ONE_LOCATION_PUBLIC_INVITE_MAX_SUBMISSIONS_PER_FINGERPRINT_WINDOW", 3, 1, 20
)
ONE_LOCATION_ACTIVITY_RANGES = {
    "7d": 7,
    "30d": 30,
    "90d": 90,
}
ONE_LOCATION_ACTIVITY_EVENT_TYPES = {
    "location_share_created",
    "location_share_viewed",
    "location_share_revoked",
    "location_share_expired",
    "location_access_request",
    "location_access_approved",
    "location_access_denied",
    "location_access_request_withdrawn",
    "location_referral_invite",
    "location_public_invite_created",
    "location_public_invite_revoked",
    "location_public_invite_submitted",
    "location_circle_invite_created",
    "location_circle_invite_claimed",
    "location_circle_invite_revoked",
    "location_one_network_joined",
}
ONE_LOCATION_SHARE_ACTIVITY_TYPES = {
    "location_share_created",
    "location_share_viewed",
    "location_share_revoked",
    "location_share_expired",
}
ONE_LOCATION_REQUEST_ACTIVITY_TYPES = {
    "location_access_request",
    "location_access_approved",
    "location_access_denied",
    "location_access_request_withdrawn",
    "location_referral_invite",
}
ONE_LOCATION_PUBLIC_ACTIVITY_TYPES = {
    "location_public_invite_created",
    "location_public_invite_revoked",
    "location_public_invite_submitted",
    "location_circle_invite_created",
    "location_circle_invite_claimed",
    "location_circle_invite_revoked",
    "location_one_network_joined",
}


class OneLocationAgentError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return str(value.astimezone(timezone.utc).isoformat())
    return str(value)


def _parse_datetime(value: datetime | str | None, *, field_name: str) -> datetime:
    if value is None:
        return _utcnow()
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise OneLocationAgentError(
                "LOCATION_TIMESTAMP_INVALID",
                f"{field_name} must be an ISO-8601 timestamp.",
                status_code=422,
            ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validated_envelope_fields(
    envelope: dict[str, Any],
    *,
    recipient_key_id: str,
    require_captured_at: bool = False,
) -> dict[str, Any]:
    """Validate a client-encrypted location envelope without decrypting it."""

    if _contains_plaintext_location_key(envelope.get("metadata")):
        raise OneLocationAgentError(
            "LOCATION_ENVELOPE_METADATA_INVALID",
            "Envelope metadata must not contain coordinates or map details.",
            status_code=422,
        )
    required_fields = [
        "ciphertext",
        "iv",
        "senderEphemeralPublicKeyJwk",
        *(["capturedAt"] if require_captured_at else []),
    ]
    for field in required_fields:
        if not envelope.get(field):
            raise OneLocationAgentError(
                "LOCATION_ENVELOPE_INVALID",
                f"Encrypted envelope is missing {field}.",
                status_code=422,
            )
    if str(envelope.get("recipientKeyId") or recipient_key_id) != recipient_key_id:
        raise OneLocationAgentError(
            "LOCATION_ENVELOPE_KEY_MISMATCH",
            "Envelope key does not match the approved recipient.",
            status_code=422,
        )
    publication_context = str(envelope.get("publicationContext") or "private_foreground").strip()
    if publication_context not in {
        "private_background",
        "private_foreground",
        "foreground_map_visible",
    }:
        raise OneLocationAgentError(
            "LOCATION_ENVELOPE_PUBLICATION_CONTEXT_INVALID",
            "Location publication context is invalid.",
            status_code=422,
        )
    return {
        "algorithm": str(envelope.get("algorithm") or "ECDH-P256-AES256-GCM"),
        "ciphertext": str(envelope.get("ciphertext") or ""),
        "iv": str(envelope.get("iv") or ""),
        "sender_key": json.dumps(
            envelope.get("senderEphemeralPublicKeyJwk"),
            sort_keys=True,
            separators=(",", ":"),
        ),
        "captured_at": _parse_datetime(
            envelope.get("capturedAt"),
            field_name="capturedAt",
        ),
        "source_platform": normalize_source_platform(envelope.get("sourcePlatform")),
        "publication_context": publication_context,
        "metadata_json": _json_param(envelope.get("metadata") or {}),
    }


def _private_share_operation_fingerprint(
    *,
    recipient_user_id: str,
    recipient_key_id: str,
    duration_hours: float | None,
    duration_mode: str,
    reason: str | None,
    share_kind: str,
    confirmed_at: datetime,
    envelope_fields: dict[str, Any],
) -> str:
    """Bind an idempotency key to the exact consented request and ciphertext."""

    canonical = json.dumps(
        {
            "recipient_user_id": recipient_user_id,
            "recipient_key_id": recipient_key_id,
            "duration_hours": duration_hours,
            "duration_mode": duration_mode,
            "reason": reason or "",
            "share_kind": share_kind,
            "confirmed_at": confirmed_at.isoformat(),
            "algorithm": envelope_fields["algorithm"],
            "ciphertext": envelope_fields["ciphertext"],
            "iv": envelope_fields["iv"],
            "sender_key": envelope_fields["sender_key"],
            "captured_at": envelope_fields["captured_at"].isoformat(),
            "source_platform": envelope_fields["source_platform"],
            "publication_context": envelope_fields["publication_context"],
            "metadata_json": envelope_fields["metadata_json"],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _private_share_freshness_error(
    *,
    captured_at: datetime,
    confirmed_at: datetime,
    now: datetime | None = None,
) -> OneLocationAgentError | None:
    current_time = now or _utcnow()
    if confirmed_at > current_time + timedelta(seconds=30):
        return OneLocationAgentError(
            "LOCATION_CONFIRMATION_TIMESTAMP_INVALID",
            "Location confirmation time is in the future.",
            status_code=422,
        )
    if captured_at > confirmed_at + timedelta(seconds=30):
        return OneLocationAgentError(
            "LOCATION_CONFIRMATION_TIMESTAMP_INVALID",
            "The encrypted location was captured after it was confirmed.",
            status_code=422,
        )
    if confirmed_at - captured_at > timedelta(seconds=60):
        return OneLocationAgentError(
            "LOCATION_REVIEWED_POINT_STALE",
            "Refresh and review your location before sharing it.",
            status_code=409,
        )
    if current_time - confirmed_at > timedelta(minutes=10):
        return OneLocationAgentError(
            "LOCATION_CONFIRMATION_EXPIRED",
            "This location confirmation expired. Refresh and review it again.",
            status_code=409,
        )
    return None


def _atomic_private_share_ids(
    *,
    owner_user_id: str,
    recipient_user_id: str,
    client_operation_id: str,
) -> tuple[str, str]:
    operation_key = f"{owner_user_id}\x1f{recipient_user_id}\x1f{client_operation_id}"
    return (
        str(
            uuid.uuid5(
                ATOMIC_LOCATION_SHARE_NAMESPACE,
                f"{operation_key}\x1fgrant",
            )
        ),
        str(
            uuid.uuid5(
                ATOMIC_LOCATION_SHARE_NAMESPACE,
                f"{operation_key}\x1fenvelope",
            )
        ),
    )


def _redact_location_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key).strip().lower()
            if normalized_key in COORDINATE_METADATA_KEYS:
                continue
            redacted[str(key)] = _redact_location_metadata(item)
        return redacted
    if isinstance(value, list):
        return [_redact_location_metadata(item) for item in value]
    return value


def _json_param(value: dict[str, Any] | list[Any] | None) -> str:
    return json.dumps(_redact_location_metadata(value or {}), separators=(",", ":"))


def _json_param_with_public_location(value: dict[str, Any] | None) -> str:
    return json.dumps(value or {}, separators=(",", ":"))


def _contains_plaintext_location_key(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).strip().lower() in COORDINATE_METADATA_KEYS:
                return True
            if _contains_plaintext_location_key(item):
                return True
    if isinstance(value, list):
        return any(_contains_plaintext_location_key(item) for item in value)
    return False


def _submit_notification_send(
    *,
    messaging: Any,
    message: Any,
    token: str,
    notification_type: str,
    user_id: str,
) -> None:
    def _deliver() -> None:
        try:
            messaging.send(message)
        except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
            try:
                get_db().execute_raw(
                    "DELETE FROM user_push_tokens WHERE token = :token",
                    {"token": token},
                )
            except Exception as exc:
                logger.warning(
                    "one.location.notification_token_cleanup_failed type=%s user=%s error=%s",
                    notification_type,
                    redact_log_field("user_id", user_id),
                    exc,
                )
        except Exception as exc:
            logger.warning(
                "one.location.notification_send_failed type=%s user=%s error=%s",
                notification_type,
                redact_log_field("user_id", user_id),
                exc,
            )

    try:
        _NOTIFICATION_EXECUTOR.submit(_deliver)
    except Exception as exc:
        logger.warning(
            "one.location.notification_submit_failed type=%s user=%s error=%s",
            notification_type,
            redact_log_field("user_id", user_id),
            exc,
        )


def _mask_phone(value: Any) -> str | None:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if not digits:
        return None
    if len(digits) <= 4:
        return f"***{digits}"
    return f"{'*' * max(3, len(digits) - 4)}{digits[-4:]}"


def _normalize_phone_digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _hash_public_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _public_invite_url(token: str) -> str:
    return f"/one/location/request/{token}"


def _circle_invite_url(token: str) -> str:
    return f"/one/location/invite/{token}"


#: Characters that separate one word of a name from the next, folded to spaces
#: before a directory search compares anything. Names are not stored tidily --
#: "Abdul-Rashid", "Abdul R.", "O'Brien" -- and a reader treats all of these as
#: two words, so the search has to as well.
#:
#: Both sides of the comparison MUST use this one list: the stored name is
#: folded by ``_DIRECTORY_SEPARATOR_SQL`` inside the statement, the typed query
#: by ``_DIRECTORY_SEPARATOR_FOLD`` in Python. When only one side was folded,
#: every name carrying punctuation became unsearchable.
_DIRECTORY_SEPARATORS = "-'._/,"
_DIRECTORY_SEPARATOR_FOLD = str.maketrans(_DIRECTORY_SEPARATORS, " " * len(_DIRECTORY_SEPARATORS))
#: The SQL half of the same fold, written out so a test can assert the
#: statement below still contains exactly this and nothing has drifted.
_DIRECTORY_SEPARATOR_SQL = (
    "TRANSLATE(LOWER(BTRIM(COALESCE(a.display_name, ''))), '{}', '{}')".format(
        _DIRECTORY_SEPARATORS.replace("'", "''"),
        " " * len(_DIRECTORY_SEPARATORS),
    )
)


def _identity_display_label(row: dict[str, Any] | None, fallback: str = "A trusted person") -> str:
    if not row:
        return fallback
    display_name = str(row.get("display_name") or "").strip()
    masked_phone = _mask_phone(row.get("phone_number"))
    return " - ".join(item for item in (display_name, masked_phone) if item) or fallback


def _identity_notification_label(
    row: dict[str, Any] | None,
    fallback: str = "A trusted person",
) -> str:
    """Return a lock-screen-safe identity label without phone-derived data."""
    if not row:
        return fallback
    return str(row.get("display_name") or "").strip() or fallback


def _notification_safe_data(data: dict[str, Any]) -> dict[str, Any]:
    """Exclude contact fields from notification transport metadata."""
    return {key: value for key, value in data.items() if "phone" not in str(key).strip().lower()}


def _fingerprint_public_key(public_key_jwk: dict[str, Any]) -> str:
    encoded = json.dumps(public_key_jwk, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


# Grant "reason" marker that identifies an SOS panic share. Kept as a constant so
# classification and message-filtering agree on the same string.
_SOS_SHARE_REASON = "sos_panic"

# Grant "reason" marker for a Drive-To share. The destination and ETA never live
# here (they are inside the encrypted envelope); this marker only tags the kind.
_DRIVE_TO_SHARE_REASON = "drive_to"

# Grant "reason" marker for a Check-In. User-authored Check-In text belongs
# inside the recipient-encrypted payload, never in grant/audit metadata.
_CHECK_IN_SHARE_REASON = "check_in"

# Internal grant "reason" markers used for plain shares, approved access requests,
# and the SOS panic flow. These are plumbing, never a human message, so they must
# NOT be surfaced verbatim to the recipient. Anything else (e.g. a Check-In note)
# is a real message. SOS still gets its own dedicated copy via the share kind.
_INTERNAL_SHARE_REASONS = {
    "owner_approved",
    "request_approved",
    _SOS_SHARE_REASON,
    _DRIVE_TO_SHARE_REASON,
    _CHECK_IN_SHARE_REASON,
}


# Which replacement lane a grant belongs to. Replacement of a live share is
# scoped to a LANE, and there are exactly TWO of them: the emergency lane
# (``share_kind == 'sos'``) and everything else. This is deliberately NOT one
# lane per share kind. `_classify_share_kind` below can return four kinds, the
# `/api/one/location/grants` route accepts `share_kind` as free text up to 40
# characters with no enum, and the web client already sends values this module
# never produces (e.g. `pick_me_up`). Per-exact-kind scoping would therefore let
# a single owner/recipient pair accumulate an unbounded number of live grants
# that no surface exposes a Stop for. Two lanes caps a pair at exactly two live
# grants: one normal share and one SOS.
#
# The invariant this enforces: an SOS grant must never supersede a normal share,
# and a normal share must never supersede an SOS grant. Within a lane, the newest
# grant still replaces the older one exactly as it always has -- `drive_to`,
# `check_in`, `pick_me_up` and plain `share` all sit in the non-emergency lane
# together and keep replacing each other.
#
# Bound as ``:is_sos_lane`` (a boolean) by every caller. The second arm reads the
# legacy `reason` marker for rows written before `share_kind` was persisted in
# metadata; it is belt-and-braces only and must never be relied on alone, because
# a user-typed SOS message REPLACES the `sos_panic` reason on the way in.
#
# Defined once, on purpose. Three hand-copied divergent versions of the
# replacement UPDATE are exactly what let an SMS alert silently revoke a normal
# share (#5506); a fourth write path must not be addable without this predicate.
_SHARE_LANE_MATCH_SQL = """
                AND (
                  COALESCE({alias}metadata->>'share_kind', '') = 'sos'
                  OR (
                    {alias}metadata->>'share_kind' IS NULL
                    AND {alias}metadata->>'reason' = 'sos_panic'
                  )
                ) = CAST(:is_sos_lane AS BOOLEAN)"""


def _share_lane_match_sql(alias: str = "") -> str:
    """The lane predicate, optionally qualified for an aliased UPDATE target."""
    return _SHARE_LANE_MATCH_SQL.format(alias=f"{alias}." if alias else "")


def _is_sos_lane(share_kind: str | None) -> bool:
    """True when a grant belongs to the emergency replacement lane.

    The lane split is `sos` vs everything-else -- NOT one lane per share kind.
    """
    return str(share_kind or "").strip() == "sos"


def _classify_share_kind(reason: str | None) -> str:
    """Classify a grant's share kind from its stored ``reason`` marker.

    Returns one of ``"sos"``, ``"check_in"``, or ``"share"`` so every surface
    (recipient notification, bell, and Consent Manager) can tell an emergency SOS
    from a friendly Check-In from a plain location share. Any caller-supplied note
    that is not an internal marker is treated as a Check-In.
    """
    text = " ".join(str(reason or "").split()).lower()
    if text == _SOS_SHARE_REASON:
        return "sos"
    if text == _DRIVE_TO_SHARE_REASON:
        return "drive_to"
    if text == _CHECK_IN_SHARE_REASON:
        return "check_in"
    if not text or text in {"owner_approved", "request_approved"}:
        return "share"
    return "check_in"


def _is_until_stopped_share(duration_mode: str | None) -> bool:
    return duration_mode == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE


def _resolve_share_duration(
    *,
    duration_hours: float | None,
    duration_mode: str | None,
    share_kind: str,
    now: datetime,
) -> tuple[float | None, datetime | None, str]:
    try:
        mode = normalize_duration_mode(duration_mode)
    except ValueError as exc:
        raise OneLocationAgentError(
            "LOCATION_DURATION_MODE_INVALID",
            str(exc),
            status_code=422,
        ) from exc
    if _is_until_stopped_share(mode):
        if share_kind in {"sos", "check_in"}:
            raise OneLocationAgentError(
                "LOCATION_DURATION_MODE_NOT_ALLOWED",
                "Until I stop is only available for trusted live shares.",
                status_code=422,
            )
        return None, None, mode
    try:
        duration = normalize_duration_hours(duration_hours)
    except ValueError as exc:
        raise OneLocationAgentError(
            "LOCATION_DURATION_INVALID",
            str(exc),
            status_code=422,
        ) from exc
    return duration, now + timedelta(hours=duration), TIMED_LOCATION_SHARE_DURATION_MODE


def _duration_metadata_value(duration_hours: float | None) -> float | None:
    return float(duration_hours) if duration_hours is not None else None


# What an approval falls back to when neither the owner nor the requester named
# a duration. Kept here rather than inline in the route default so approve_request
# can tell "the owner deliberately chose an hour" apart from "nobody said".
DEFAULT_APPROVAL_DURATION_HOURS = 1.0


def _normalized_requested_duration(
    *,
    duration_hours: Any,
    duration_mode: Any,
) -> tuple[float | None, str | None]:
    """Validate a requester's asked-for duration into (hours, mode).

    Returns ``(None, None)`` when the requester expressed no preference, which
    is the pre-existing behaviour every older client still has: the owner picks
    the number, exactly as before. An until-stopped ask carries no hours. A
    timed ask is bounded by the same policy that bounds a grant, so a request
    can never carry an amount an approval could not honour.
    """
    if duration_mode is None and duration_hours is None:
        return None, None
    try:
        mode = normalize_duration_mode(duration_mode)
    except ValueError as exc:
        raise OneLocationAgentError(
            "LOCATION_DURATION_MODE_INVALID", str(exc), status_code=422
        ) from exc
    if _is_until_stopped_share(mode):
        return None, mode
    if duration_hours is None:
        return None, None
    try:
        return normalize_duration_hours(duration_hours), mode
    except ValueError as exc:
        raise OneLocationAgentError("LOCATION_DURATION_INVALID", str(exc), status_code=422) from exc


def _remaining_label(expires_at: Any, *, now: datetime | None = None) -> str:
    """ "45 minutes"/"2 hours" of a live share still to run, or "" if none."""
    if expires_at is None:
        return ""
    try:
        parsed = _parse_datetime(expires_at, field_name="expires_at")
    except OneLocationAgentError:
        return ""
    remaining = (parsed - (now or _utcnow())).total_seconds()
    if remaining <= 0:
        return ""
    return format_duration_label(remaining / 3600.0)


def _access_ask_summary(
    *,
    requested_duration_hours: float | None,
    requested_duration_mode: str | None,
    is_extension: bool,
    remaining_label: str = "",
) -> str:
    """The one sentence that says WHAT was asked for, used everywhere.

    The owner's push notification, the feed line, and the Consent Center row all
    read from this, so the amount the owner is asked to approve is never worded
    one way in the popup and another way in the feed. The extension wording
    ("3 hours MORE") is deliberately different from the fresh-share wording
    ("for 3 hours") -- they are different questions, and an owner skimming a
    lock screen has to be able to tell them apart without opening anything.
    """
    amount = (
        "as long as they need"
        if requested_duration_mode == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
        else format_duration_label(requested_duration_hours)
    )
    if is_extension:
        if not amount:
            return "is asking for more time on your live location."
        tail = f" They have {remaining_label} left." if remaining_label else ""
        return f"is asking for {amount} more of your live location.{tail}"
    if not amount:
        return "is asking to view your location."
    return f"is asking to view your location for {amount}."


def _share_duration_change_direction(
    *,
    previous_expires_at: Any,
    new_expires_at: datetime | None,
    new_mode: str,
) -> str:
    """Which way the owner moved a running share's end time.

    One event type carries both directions so the ledger keeps a single row
    shape, which means the direction has to be recorded rather than implied by
    the name.

    A share that ran until stopped and now ends at a fixed time has no previous
    expiry to compare against, and it has been *shortened*: an open-ended share
    was just given an end.
    """
    if _is_until_stopped_share(new_mode):
        return "until_stopped"
    if new_expires_at is None:
        return "until_stopped"
    if previous_expires_at is None:
        return "shortened"
    previous = previous_expires_at
    if previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    return "extended" if new_expires_at > previous else "shortened"


def _grant_expires_at_is_past(row: dict[str, Any]) -> bool:
    expires_at_raw = row.get("expires_at")
    if expires_at_raw is None:
        return str(row.get("duration_mode") or "") != UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
    expires_at = _parse_datetime(expires_at_raw, field_name="expires_at")
    return expires_at <= _utcnow()


def _payload_expires_at_is_past(grant: dict[str, Any]) -> bool:
    expires_at_raw = grant.get("expiresAt")
    if not expires_at_raw:
        return str(grant.get("durationMode") or "") != UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
    expires_at = _parse_datetime(expires_at_raw, field_name="expiresAt")
    return expires_at <= _utcnow()


def _visible_share_message(reason: str | None) -> str | None:
    """Return a human-facing share message, or None for internal markers.

    A Check-In (or any future quick action) can pass a short note as the grant
    reason so the recipient's notification reads "<Owner>: <message>" instead of
    the generic "<Owner> shared location access with you." Internal defaults
    (including the ``sos_panic`` marker) are filtered out — SOS gets dedicated
    copy driven by the share kind instead of a raw message.
    """
    text = " ".join(str(reason or "").split())
    if not text or text.lower() in _INTERNAL_SHARE_REASONS:
        return None
    return text[:160]


def _loads_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _user_id(token_data: dict[str, Any]) -> str:
    return str(token_data.get("user_id") or "").strip()


def _one_location_url(**query: str | None) -> str:
    base = (
        (
            os.getenv("NEXT_PUBLIC_APP_URL")
            or os.getenv("APP_PUBLIC_URL")
            or os.getenv("FRONTEND_BASE_URL")
            or ""
        )
        .strip()
        .rstrip("/")
    )
    params = [f"{key}={value}" for key, value in query.items() if str(value or "").strip()]
    suffix = f"?{'&'.join(params)}" if params else ""
    path = f"/one/location{suffix}"
    return f"{base}{path}" if base else path


def _activity_since(range_key: str) -> datetime | None:
    days = ONE_LOCATION_ACTIVITY_RANGES.get(range_key)
    if not days:
        return None
    start = _utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return start - timedelta(days=days - 1)


def _activity_kind(event_type: str) -> str:
    if event_type in ONE_LOCATION_SHARE_ACTIVITY_TYPES:
        return "share"
    if event_type in ONE_LOCATION_REQUEST_ACTIVITY_TYPES:
        return "request"
    return "public"


def _activity_bucket_key(value: datetime, range_key: str) -> str:
    if range_key in {"90d", "all"}:
        return value.strftime("%Y-%m")
    return value.strftime("%Y-%m-%d")


def _activity_bucket_label(value: datetime, range_key: str) -> str:
    if range_key in {"90d", "all"}:
        return value.strftime("%b %Y")
    try:
        return value.strftime("%b %-d")
    except ValueError:
        return value.strftime("%b %#d")


def format_activity_time(value: datetime) -> str:
    try:
        return value.strftime("%b %-d, %H:%M UTC")
    except ValueError:
        return value.strftime("%b %#d, %H:%M UTC")


def _is_missing_encrypted_private_column(exc: Exception) -> bool:
    """True when a DB error is the specific `encrypted_private_key_jwk` drift.

    Matches the psycopg2 `UndefinedColumn` (SQLSTATE 42703) raised when the
    `one_location_recipient_keys` table exists but migration 083 (which adds the
    optional `encrypted_private_key_jwk` column) has not been applied to the
    running database. We match narrowly on both the column name and an
    undefined-column signature so this never swallows an unrelated failure.
    """
    detail = " ".join(
        part
        for part in (
            str(getattr(exc, "details", "") or ""),
            str(exc),
        )
        if part
    ).lower()
    return "encrypted_private_key_jwk" in detail and (
        "does not exist" in detail or "undefinedcolumn" in detail
    )


class OneLocationAgentService:
    """Persistence service for recipient-encrypted One Location Agent workflows."""

    # Per-process idempotency cache for the additive `encrypted_private_key_jwk`
    # self-heal below. The service is instantiated per request, so a class-level
    # flag keeps the backstop DDL from running on every call once it has
    # succeeded. This is a local DDL-idempotency cache, not shared runtime
    # state, so it needs no Postgres/Redis coordination.
    _recipient_encrypted_private_column_ensured: bool = False

    def _execute_one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        bound_connection = getattr(self, "_key_writer_connection", None)
        if bound_connection is not None:
            result = bound_connection.execute(text(sql), params or {})
            if not result.returns_rows:
                return None
            row = result.mappings().first()
            return dict(row) if row is not None else None
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        bound_connection = getattr(self, "_key_writer_connection", None)
        if bound_connection is not None:
            result = bound_connection.execute(text(sql), params or {})
            if not result.returns_rows:
                return []
            rows = result.mappings().all()
            return [dict(row) for row in rows]
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

    def _run_read_queries_parallel(
        self,
        tasks: list[tuple[str, str, dict[str, Any]]],
        *,
        max_workers: int = 8,
    ) -> dict[str, list[dict[str, Any]]]:
        """Run several independent, read-only SQL queries concurrently.

        The DB is Cloud SQL in us-central1, so every round trip here is a
        cross-continent hop -- roughly ~900ms dominated by RTT, not query
        cost. A read path that fires N independent, unrelated queries (no
        query here depends on another's result) pays N times that latency
        for no reason. This collapses it to about one round trip's worth of
        wall time instead.

        Never used for the bound single-connection writer path
        (`_key_writer_connection`): every task here calls `_execute_many`,
        which checks out its own pooled connection per call via
        `get_db().execute_raw`, so concurrent calls are safe -- there is no
        shared connection/cursor state across tasks.

        A failing task degrades to `[]` and is logged rather than raised --
        the same resilience a sequential per-section try/except gave before
        this existed. One bad section must never fail the rest of the page.
        Each worker runs inside a copy of the
        caller's context so `db.query_telemetry`'s ContextVar-based
        counters still attribute every round trip to the request that
        issued it, instead of silently under-counting once queries move
        off the request's own thread.
        """
        if not tasks:
            return {}
        results: dict[str, list[dict[str, Any]]] = {}
        with ThreadPoolExecutor(max_workers=min(max_workers, len(tasks))) as pool:
            future_to_key = {
                pool.submit(contextvars.copy_context().run, self._execute_many, sql, params): key
                for key, sql, params in tasks
            }
            for future in as_completed(future_to_key):
                key = future_to_key[future]
                try:
                    results[key] = future.result()
                except Exception as exc:  # noqa: BLE001 - degrade, never fail the page
                    logger.warning(
                        "one_location.parallel_query_failed section=%s error=%s",
                        key,
                        exc,
                    )
                    results[key] = []
        return results

    def _execute_atomic_private_share(
        self,
        *,
        recipient_key_lock_key: str,
        pair_lock_key: str,
        mutation_sql: str,
        params: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Run the private-share mutation after acquiring a fresh-snapshot lock.

        The lock is deliberately a separate statement inside the same
        transaction. Under Postgres READ COMMITTED, the following mutation gets
        a fresh snapshot after a concurrent holder commits, so an identical
        retry observes and returns the first operation instead of colliding on
        its deterministic IDs.
        """

        with get_db_connection() as connection:
            # Recipient-key rotation and grant creation acquire this same lock
            # first. The fixed ordering prevents deadlocks and guarantees that
            # the mutation below never commits against a key that was rotated
            # concurrently.
            connection.execute(
                text(
                    """
                    SELECT pg_advisory_xact_lock(
                      hashtextextended(:recipient_key_lock_key, 0)
                    )
                    """
                ),
                {"recipient_key_lock_key": recipient_key_lock_key},
            )
            connection.execute(
                text(
                    """
                    SELECT pg_advisory_xact_lock(
                      hashtextextended(:pair_lock_key, 0)
                    )
                    """
                ),
                {"pair_lock_key": pair_lock_key},
            )
            row = connection.execute(text(mutation_sql), params).mappings().first()
            return dict(row) if row is not None else None

    def _execute_recipient_key_registration(
        self,
        *,
        recipient_key_lock_key: str,
        mutation_sql: str,
        params: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Rotate/register a recipient key and finalize stale-key grants atomically."""

        with get_db_connection() as connection:
            connection.execute(
                text(
                    """
                    SELECT pg_advisory_xact_lock(
                      hashtextextended(:recipient_key_lock_key, 0)
                    )
                    """
                ),
                {"recipient_key_lock_key": recipient_key_lock_key},
            )
            row = connection.execute(text(mutation_sql), params).mappings().first()
            return dict(row) if row is not None else None

    @contextmanager
    def _key_bound_writer_guard(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
    ) -> Iterator[None]:
        """Run a legacy key-bound writer in one locked transaction."""

        key_lock = f"one-location-recipient-key:{recipient_user_id}"
        pair_lock = f"one-location-grant:{owner_user_id}:{recipient_user_id}"
        with get_db_connection() as connection:
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
                {"lock_key": key_lock},
            )
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
                {"lock_key": pair_lock},
            )
            previous_connection = getattr(self, "_key_writer_connection", None)
            self._key_writer_connection = connection
            try:
                yield
            finally:
                if previous_connection is None:
                    del self._key_writer_connection
                else:
                    self._key_writer_connection = previous_connection

    def _ensure_recipient_encrypted_private_column(self) -> None:
        """Idempotently add `one_location_recipient_keys.encrypted_private_key_jwk`.

        This mirrors migration 083 exactly (`ADD COLUMN IF NOT EXISTS ... JSONB`).
        The runtime startup schema guard only verifies table *existence*, never
        columns, so a database that has the table but never ran migration 083
        would 500 on recipient-key registration with `UndefinedColumn`. This
        additive, `IF NOT EXISTS` backstop self-heals that drift the same way
        `create_vault_keys` / `create_tickers` add columns idempotently in the
        migration runner — it never reads, rewrites, or drops data. The proper
        fix is still to run `python db/migrate.py --release`; this only keeps the
        feature from hard-failing when an environment is a migration behind.
        """
        try:
            get_db().execute_raw(
                "ALTER TABLE one_location_recipient_keys "
                "ADD COLUMN IF NOT EXISTS encrypted_private_key_jwk JSONB",
                {},
            )
            OneLocationAgentService._recipient_encrypted_private_column_ensured = True
        except DatabaseExecutionError as exc:
            logger.warning(
                "one_location.recipient_key_column_backfill_failed detail=%s",
                redact_log_value(str(getattr(exc, "details", exc))),
            )

    def _insert_event(
        self,
        *,
        owner_user_id: str,
        actor_user_id: str | None,
        event_type: str,
        recipient_user_id: str | None = None,
        grant_id: str | None = None,
        envelope_id: str | None = None,
        request_id: str | None = None,
        referral_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        try:
            self._execute_one(
                """
                INSERT INTO one_location_events (
                  owner_user_id, actor_user_id, recipient_user_id, grant_id, envelope_id,
                  request_id, referral_id, event_type, metadata, created_at
                )
                VALUES (
                  :owner_user_id, :actor_user_id, :recipient_user_id,
                  CAST(:grant_id AS UUID), CAST(:envelope_id AS UUID),
                  CAST(:request_id AS UUID), CAST(:referral_id AS UUID),
                  :event_type, CAST(:metadata_json AS JSONB), NOW()
                )
                """,
                {
                    "owner_user_id": owner_user_id,
                    "actor_user_id": actor_user_id,
                    "recipient_user_id": recipient_user_id,
                    "grant_id": grant_id,
                    "envelope_id": envelope_id,
                    "request_id": request_id,
                    "referral_id": referral_id,
                    "event_type": event_type,
                    "metadata_json": _json_param(metadata),
                },
            )
        except Exception as exc:
            logger.warning("one.location.event_insert_failed type=%s error=%s", event_type, exc)

    def _send_metadata_notification(
        self,
        *,
        user_id: str,
        notification_type: str,
        title: str,
        body: str,
        notification_tag: str,
        request_url: str,
        data: dict[str, str | None],
    ) -> bool:
        """Best-effort metadata-only FCM delivery for location workflow state.

        Returns True when at least one push message was handed to FCM, False when
        the recipient could not be reached at all -- no registered device token
        (notifications never enabled, or the token was reaped after an uninstall),
        Firebase not configured, or a payload the redaction guard rejected.

        The boolean exists because Save My Soul must never report a confident
        "SENT" for an alert that reached nobody. Actual FCM delivery stays
        asynchronous and best-effort; this only reports whether there was a
        device to deliver to, which is the failure the sender could otherwise
        never see.
        """
        safe_data = _notification_safe_data(data)
        if not user_id or _contains_plaintext_location_key(safe_data):
            return False
        try:
            rows = (
                get_db()
                .execute_raw(
                    "SELECT token, platform FROM user_push_tokens WHERE user_id = :user_id",
                    {"user_id": user_id},
                )
                .data
                or []
            )
            if not rows:
                return False
            configured, _ = ensure_firebase_admin()
            if not configured:
                return False
            from firebase_admin import messaging

            message_data = {
                "type": notification_type,
                "user_id": user_id,
                "request_url": request_url,
                "deep_link": "/one/location",
                "notification_tag": notification_tag,
                "notification_category": "ONE_LOCATION",
                **{key: str(value) for key, value in safe_data.items() if str(value or "").strip()},
            }
            if _contains_plaintext_location_key(message_data):
                logger.warning(
                    "one.location.notification_blocked_plaintext_keys type=%s user=%s",
                    notification_type,
                    redact_log_field("user_id", user_id),
                )
                return False
            submitted = False
            seen: set[str] = set()
            for row in rows:
                token = str(row.get("token") or "").strip()
                if not token or token in seen:
                    continue
                seen.add(token)
                platform = str(row.get("platform") or "").strip().lower()
                message = build_push_message(
                    messaging,
                    token=token,
                    platform=platform,
                    data=message_data,
                    title=title,
                    body=body,
                    request_url=request_url,
                    notification_tag=notification_tag,
                    show_alert=True,
                )
                _submit_notification_send(
                    messaging=messaging,
                    message=message,
                    token=token,
                    notification_type=notification_type,
                    user_id=user_id,
                )
                submitted = True
            return submitted
        except Exception as exc:
            logger.warning(
                "one.location.notification_skipped type=%s user=%s error=%s",
                notification_type,
                redact_log_field("user_id", user_id),
                exc,
            )
            return False

    def _send_push_notification(
        self,
        *,
        user_id: str,
        notification_type: str,
        title: str,
        body: str,
        notification_tag: str | None = None,
        request_url: str | None = None,
        data: dict[str, str | None] | None = None,
    ) -> None:
        """Compatibility wrapper for metadata-only location workflow pushes."""
        self._send_metadata_notification(
            user_id=user_id,
            notification_type=notification_type,
            title=title,
            body=body,
            notification_tag=notification_tag or f"one-location:{notification_type}",
            request_url=request_url or "/one/location",
            data=data or {},
        )

    def list_sos_email_recipients(
        self,
        *,
        owner_user_id: str,
        grant_ids: list[str],
    ) -> dict[str, Any]:
        """Who One may email for this Save my Soul alert.

        Resolution and authorization only — the message is rendered and sent by
        One through `hushh-mail-api`, the same service every other product mail
        uses. A second sender identity is a deliverability risk, and an
        emergency mail is the worst place to find that out.

        Returns the owner's display label plus one entry per reachable contact.
        Addresses are returned to One's server route, never to a browser: a
        sender does not necessarily know their contacts' email addresses and
        this must not be where they learn them.
        """
        from hushh_mcp.services.one_location_sos_email_service import (
            select_emailable_recipients,
        )

        cleaned_ids = [str(value).strip() for value in grant_ids if str(value or "").strip()]
        if not cleaned_ids:
            return {"ownerDisplayName": "", "openInOneUrl": "", "recipients": []}

        rows = self._execute_many(
            """
            SELECT
              g.id::TEXT             AS grant_id,
              g.owner_user_id        AS owner_user_id,
              g.recipient_user_id    AS recipient_user_id,
              g.status               AS status,
              g.expires_at           AS expires_at,
              EXTRACT(EPOCH FROM g.created_at) AS created_at_epoch,
              COALESCE(g.metadata ->> 'share_kind', '') AS share_kind,
              recipient.email        AS recipient_email,
              recipient.display_name AS recipient_display_name
            FROM one_location_share_grants g
            LEFT JOIN actor_identity_cache recipient
              ON recipient.user_id = g.recipient_user_id
            WHERE g.id = ANY(CAST(:grant_ids AS UUID[]))
              AND g.owner_user_id = :owner_user_id
            """,
            {"grant_ids": cleaned_ids, "owner_user_id": owner_user_id},
        )

        now_epoch = datetime.now(timezone.utc).timestamp()
        selected = select_emailable_recipients(
            rows, owner_user_id=owner_user_id, now_epoch_seconds=now_epoch
        )

        # Who this alert could NOT reach by mail, and why. Skipping them
        # silently is what made a broken email channel look like a working one:
        # the sender saw "Emailed 0" with nothing to act on. A phone-only
        # contact has no address anywhere, and the only fix is for them to add
        # one -- which the sender can only ask for if they are told.
        emailable_ids = {str(row.get("recipient_user_id") or "") for row in selected}
        without_email = [
            str(row.get("recipient_display_name") or "").strip() or "A contact"
            for row in rows
            if str(row.get("recipient_user_id") or "") not in emailable_ids
            and str(row.get("share_kind") or "") == "sos"
            and "@" not in str(row.get("recipient_email") or "")
        ]

        if not selected:
            return {
                "ownerDisplayName": "",
                "openInOneUrl": "",
                "recipients": [],
                "withoutEmail": without_email,
            }

        owner_label = _identity_notification_label(self._identity_row(owner_user_id))
        return {
            "ownerDisplayName": owner_label,
            # Same builder the push notification uses, so the email link and the
            # notification link cannot drift and the frontend origin has exactly
            # one reader (the runtime-config contract requires that).
            "openInOneUrl": _one_location_url(section="shared"),
            "recipients": [
                {
                    "grantId": str(row.get("grant_id") or ""),
                    "recipientUserId": str(row.get("recipient_user_id") or ""),
                    "email": str(row.get("recipient_email") or ""),
                    "displayName": str(row.get("recipient_display_name") or ""),
                    "expiresAt": _iso(row.get("expires_at")),
                }
                for row in selected
            ],
            "withoutEmail": without_email,
        }

    def _identity_row(self, user_id: str) -> dict[str, Any] | None:
        try:
            return self._execute_one(
                """
                SELECT user_id, display_name, phone_number, phone_verified
                FROM actor_identity_cache
                WHERE user_id = :user_id
                LIMIT 1
                """,
                {"user_id": user_id},
            )
        except Exception as exc:
            logger.debug(
                "one.location.identity_lookup_failed user=%s error=%s",
                redact_log_field("user_id", user_id),
                exc,
            )
            return None

    def _identity_row_by_phone_digits(self, phone_digits: str) -> dict[str, Any] | None:
        local_digits = phone_digits[-10:] if len(phone_digits) >= 10 else phone_digits
        try:
            return self._execute_one(
                """
                SELECT user_id, display_name, phone_number, phone_verified
                FROM actor_identity_cache
                WHERE phone_verified = TRUE
                  AND (
                    regexp_replace(COALESCE(phone_number, ''), '[^0-9]', '', 'g') = :phone_digits
                    OR RIGHT(
                      regexp_replace(COALESCE(phone_number, ''), '[^0-9]', '', 'g'),
                      :local_digits_length
                    ) = :local_digits
                  )
                ORDER BY last_synced_at DESC NULLS LAST, updated_at DESC NULLS LAST
                LIMIT 1
                """,
                {
                    "phone_digits": phone_digits,
                    "local_digits": local_digits,
                    "local_digits_length": len(local_digits),
                },
            )
        except Exception as exc:
            logger.debug("one.location.phone_identity_lookup_failed error=%s", exc)
            return None

    @staticmethod
    def _recipient_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        display_name = str(row.get("display_name") or "").strip()
        email = str(row.get("email") or "").strip()
        masked_phone = _mask_phone(row.get("phone_number"))
        user_id = str(row.get("user_id") or "")
        return {
            "userId": user_id,
            "displayName": display_name or masked_phone or "Verified user",
            "maskedEmail": mask_email(email) if email else None,
            "maskedPhone": masked_phone,
            "phoneVerified": bool(row.get("phone_verified")),
            "keyId": str(row.get("key_id") or "") or None,
            "publicKeyJwk": _loads_json(row.get("public_key_jwk")),
            "keyAlgorithm": str(row.get("algorithm") or "ECDH-P256-AES256-GCM"),
            "keyRegisteredAt": _iso(row.get("key_created_at") or row.get("created_at")),
            "canReceiveLocation": bool(row.get("key_id")),
        }

    @staticmethod
    def _recommendation_signal() -> dict[str, Any]:
        return {
            "score": 0,
            "reasons": {},
            "needs_action": False,
            "trusted": False,
            "professional": False,
            "relationship_type": None,
            "profile_headline": None,
            "verification_badge": None,
            "last_interaction_at": None,
        }

    @staticmethod
    def _signal_time_value(value: Any) -> float:
        if value is None:
            return 0.0
        if isinstance(value, datetime):
            parsed = value
        else:
            raw = str(value).strip()
            if not raw:
                return 0.0
            if raw.endswith("Z"):
                raw = f"{raw[:-1]}+00:00"
            try:
                parsed = datetime.fromisoformat(raw)
            except ValueError:
                return 0.0
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).timestamp()

    @classmethod
    def _remember_signal_time(cls, signal: dict[str, Any], *values: Any) -> None:
        current = signal.get("last_interaction_at")
        current_score = cls._signal_time_value(current)
        for value in values:
            value_score = cls._signal_time_value(value)
            if value_score > current_score:
                signal["last_interaction_at"] = value
                current_score = value_score

    @staticmethod
    def _safe_recommendation_text(value: Any, *, max_length: int = 96) -> str | None:
        text = " ".join(str(value or "").split())
        if not text:
            return None
        if len(text) <= max_length:
            return text
        return f"{text[: max_length - 1].rstrip()}..."

    @classmethod
    def _add_recommendation_reason(
        cls,
        signal: dict[str, Any],
        *,
        code: str,
        label: str,
        weight: int,
    ) -> None:
        reasons: dict[str, dict[str, Any]] = signal.setdefault("reasons", {})
        existing = reasons.get(code)
        normalized_weight = max(0, int(weight))
        if existing and int(existing.get("weight") or 0) >= normalized_weight:
            return
        if existing:
            signal["score"] -= int(existing.get("weight") or 0)
        reasons[code] = {
            "code": code,
            "label": cls._safe_recommendation_text(label, max_length=72) or label,
            "weight": normalized_weight,
        }
        signal["score"] += normalized_weight

    @classmethod
    def _safe_metadata_terms(cls, value: Any, *, max_terms: int = 4) -> list[str]:
        metadata = _loads_json(value)
        if not isinstance(metadata, dict):
            return []
        allowed_keys = {
            "category",
            "categories",
            "focus",
            "focus_area",
            "focus_areas",
            "industry",
            "industries",
            "interest",
            "interests",
            "investment_style",
            "investment_styles",
            "marketplace_categories",
            "sector",
            "sectors",
            "specialties",
            "specialty",
        }
        terms: list[str] = []

        def add_term(raw_value: Any) -> None:
            if isinstance(raw_value, str):
                candidates = raw_value.split(",") if "," in raw_value else [raw_value]
            elif isinstance(raw_value, (list, tuple, set)):
                candidates = list(raw_value)
            else:
                candidates = [raw_value]
            for candidate in candidates:
                term = cls._safe_recommendation_text(candidate, max_length=36)
                if term and term.lower() not in {existing.lower() for existing in terms}:
                    terms.append(term)

        for key, item in metadata.items():
            normalized_key = str(key or "").strip().lower()
            if normalized_key in COORDINATE_METADATA_KEYS or normalized_key not in allowed_keys:
                continue
            add_term(item)
            if len(terms) >= max_terms:
                break
        return terms[:max_terms]

    def _add_one_location_history_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        grant_rows: list[dict[str, Any]],
        request_rows: list[dict[str, Any]],
        referral_rows: list[dict[str, Any]],
    ) -> None:
        for row in grant_rows:
            other_user_id = (
                str(row.get("recipient_user_id") or "")
                if row.get("owner_user_id") == owner_user_id
                else str(row.get("owner_user_id") or "")
            )
            if other_user_id not in recipient_ids:
                continue
            signal = signals[other_user_id]
            status = str(row.get("status") or "").lower()
            if status == "active":
                self._add_recommendation_reason(
                    signal,
                    code="active_location_share",
                    label="Active location share",
                    weight=46,
                )
                signal["trusted"] = True
                signal["relationship_type"] = (
                    signal.get("relationship_type") or "Active One Location share"
                )
                signal["verification_badge"] = (
                    signal.get("verification_badge") or "Location trusted"
                )
            elif status in {"expired", "revoked"}:
                self._add_recommendation_reason(
                    signal,
                    code="prior_location_share",
                    label="Prior location sharing history",
                    weight=30,
                )
                signal["trusted"] = True
                signal["relationship_type"] = (
                    signal.get("relationship_type") or "Prior One Location share"
                )
            self._remember_signal_time(
                signal,
                row.get("updated_at"),
                row.get("created_at"),
                row.get("expires_at"),
                row.get("revoked_at"),
            )

        for row in request_rows:
            current_user_is_owner = row.get("owner_user_id") == owner_user_id
            other_user_id = (
                str(row.get("requester_user_id") or "")
                if current_user_is_owner
                else str(row.get("owner_user_id") or "")
            )
            if other_user_id not in recipient_ids:
                continue
            signal = signals[other_user_id]
            status = str(row.get("status") or "").lower()
            if status == "pending" and current_user_is_owner:
                self._add_recommendation_reason(
                    signal,
                    code="pending_location_request",
                    label="Asked to receive your location",
                    weight=44,
                )
                signal["needs_action"] = True
                signal["relationship_type"] = (
                    signal.get("relationship_type") or "Pending location request"
                )
            elif status == "pending":
                self._add_recommendation_reason(
                    signal,
                    code="outbound_location_request",
                    label="Waiting on their approval",
                    weight=22,
                )
            elif status == "approved":
                self._add_recommendation_reason(
                    signal,
                    code="approved_location_request",
                    label="Approved location request history",
                    weight=28,
                )
                signal["trusted"] = True
            self._remember_signal_time(signal, row.get("resolved_at"), row.get("requested_at"))

        for row in referral_rows:
            for candidate_field in ("owner_user_id", "referring_user_id", "referred_user_id"):
                candidate_id = str(row.get(candidate_field) or "")
                if candidate_id == owner_user_id or candidate_id not in recipient_ids:
                    continue
                signal = signals[candidate_id]
                self._add_recommendation_reason(
                    signal,
                    code="location_referral_signal",
                    label="Connected through a trusted referral",
                    weight=24,
                )
                signal["trusted"] = True
                signal["relationship_type"] = signal.get("relationship_type") or "Location referral"
                self._remember_signal_time(signal, row.get("resolved_at"), row.get("created_at"))

    def _add_prior_consent_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        for row in rows:
            if row.get("user_id") == owner_user_id:
                other_user_id = str(row.get("agent_id") or "")
            elif row.get("agent_id") == owner_user_id:
                other_user_id = str(row.get("user_id") or "")
            else:
                other_user_id = ""
            if other_user_id not in recipient_ids:
                continue
            action = str(row.get("action") or "").strip().lower()
            if action not in {"consent_granted", "approved", "granted"}:
                continue
            signal = signals[other_user_id]
            self._add_recommendation_reason(
                signal,
                code="prior_consent_relationship",
                label="Prior consent approval",
                weight=26,
            )
            signal["trusted"] = True
            signal["relationship_type"] = (
                signal.get("relationship_type") or "Prior consent relationship"
            )
            self._remember_signal_time(signal, row.get("issued_at"))

    def _add_one_network_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        for row in rows:
            other_user_id = str(row.get("trusted_user_id") or "")
            if other_user_id not in recipient_ids:
                continue
            signal = signals[other_user_id]
            self._add_recommendation_reason(
                signal,
                code="one_network_connection",
                label="Accepted Invite to One",
                weight=42,
            )
            signal["trusted"] = True
            signal["relationship_type"] = signal.get("relationship_type") or "One Network"
            signal["verification_badge"] = signal.get("verification_badge") or "One Network"
            self._remember_signal_time(signal, row.get("updated_at"), row.get("created_at"))

    def _add_mutual_kai_relationship_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        adjacency: dict[str, set[str]] = {}
        latest_by_pair: dict[tuple[str, str], Any] = {}
        for row in rows:
            investor_user_id = str(row.get("investor_user_id") or "")
            ria_user_id = str(row.get("ria_user_id") or "")
            if not investor_user_id or not ria_user_id:
                continue
            adjacency.setdefault(investor_user_id, set()).add(ria_user_id)
            adjacency.setdefault(ria_user_id, set()).add(investor_user_id)
            latest = row.get("updated_at") or row.get("created_at")
            latest_by_pair[(investor_user_id, ria_user_id)] = latest
            latest_by_pair[(ria_user_id, investor_user_id)] = latest

        owner_neighbors = adjacency.get(owner_user_id, set())
        if not owner_neighbors:
            return
        for recipient_id in recipient_ids:
            if recipient_id == owner_user_id:
                continue
            shared_neighbors = owner_neighbors.intersection(adjacency.get(recipient_id, set()))
            if not shared_neighbors:
                continue
            signal = signals[recipient_id]
            self._add_recommendation_reason(
                signal,
                code="mutual_kai_relationship",
                label="Mutual KAI relationship",
                weight=18,
            )
            signal["professional"] = True
            signal["relationship_type"] = signal.get("relationship_type") or "Mutual KAI connection"
            for neighbor_id in shared_neighbors:
                self._remember_signal_time(
                    signal,
                    latest_by_pair.get((owner_user_id, neighbor_id)),
                    latest_by_pair.get((recipient_id, neighbor_id)),
                )

    def _add_professional_network_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        for row in rows:
            if row.get("investor_user_id") == owner_user_id:
                other_user_id = str(row.get("ria_user_id") or "")
                relationship_label = "Advisor relationship"
            else:
                other_user_id = str(row.get("investor_user_id") or "")
                relationship_label = "Investor relationship"
            if other_user_id not in recipient_ids:
                continue
            signal = signals[other_user_id]
            status = str(row.get("status") or "").lower()
            share_status = str(row.get("relationship_share_status") or "").lower()
            if status == "approved" and share_status == "active":
                self._add_recommendation_reason(
                    signal,
                    code="approved_professional_relationship",
                    label="Approved advisor/investor relationship",
                    weight=38,
                )
                signal["trusted"] = True
            else:
                # Defensive fail-closed posture for partially migrated rows.
                continue
            signal["professional"] = True
            signal["relationship_type"] = signal.get("relationship_type") or relationship_label
            if str(row.get("ria_verification_status") or "").lower() in {"verified", "active"}:
                signal["verification_badge"] = signal.get("verification_badge") or "RIA verified"
            self._remember_signal_time(
                signal,
                row.get("relationship_share_granted_at"),
                row.get("consent_granted_at"),
                row.get("updated_at"),
                row.get("created_at"),
            )

    def _add_organization_membership_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        for row in rows:
            peer_user_id = str(row.get("peer_user_id") or "")
            if peer_user_id not in recipient_ids:
                continue
            signal = signals[peer_user_id]
            firm_label = self._safe_recommendation_text(row.get("firm_name"), max_length=48)
            reason_label = f"Same organization: {firm_label}" if firm_label else "Same organization"
            self._add_recommendation_reason(
                signal,
                code="organization_membership",
                label=reason_label,
                weight=20,
            )
            signal["professional"] = True
            signal["relationship_type"] = signal.get("relationship_type") or "Same organization"
            if not signal.get("profile_headline"):
                signal["profile_headline"] = self._safe_recommendation_text(
                    row.get("peer_role_title"),
                    max_length=80,
                )
            self._remember_signal_time(
                signal,
                row.get("peer_membership_updated_at"),
                row.get("owner_membership_updated_at"),
            )

    def _add_marketplace_profile_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        owner_terms: set[str] = set()
        for row in rows:
            if str(row.get("user_id") or "") == owner_user_id:
                owner_terms = {
                    term.lower()
                    for term in self._safe_metadata_terms(row.get("metadata"), max_terms=6)
                }
                break
        for row in rows:
            user_id = str(row.get("user_id") or "")
            if user_id not in recipient_ids:
                continue
            signal = signals[user_id]
            recipient_terms = self._safe_metadata_terms(row.get("metadata"), max_terms=6)
            shared_terms = [term for term in recipient_terms if term.lower() in owner_terms][:2]
            profile_type = str(row.get("profile_type") or "").strip().lower()
            profile_label = (
                "RIA marketplace profile"
                if profile_type == "ria"
                else "Investor marketplace profile"
            )
            self._add_recommendation_reason(
                signal,
                code="marketplace_public_profile",
                label=profile_label,
                weight=24,
            )
            signal["professional"] = True
            signal["relationship_type"] = signal.get("relationship_type") or "Marketplace profile"
            signal["profile_headline"] = signal.get(
                "profile_headline"
            ) or self._safe_recommendation_text(
                row.get("headline") or row.get("strategy_summary"),
                max_length=112,
            )
            signal["verification_badge"] = signal.get(
                "verification_badge"
            ) or self._safe_recommendation_text(
                row.get("verification_badge") or "Marketplace discoverable",
                max_length=48,
            )
            if shared_terms:
                self._add_recommendation_reason(
                    signal,
                    code="shared_marketplace_categories",
                    label=f"Shared marketplace focus: {', '.join(shared_terms)}",
                    weight=18,
                )
            self._remember_signal_time(signal, row.get("updated_at"), row.get("created_at"))

    def _add_persona_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
        rows: list[dict[str, Any]],
    ) -> None:
        for row in rows:
            user_id = str(row.get("user_id") or "")
            if user_id not in recipient_ids:
                continue
            persona = str(row.get("last_active_persona") or "").lower()
            if persona not in {"ria", "investor"}:
                continue
            signal = signals[user_id]
            self._add_recommendation_reason(
                signal,
                code=f"{persona}_persona",
                label="KAI advisor persona" if persona == "ria" else "KAI investor persona",
                weight=12,
            )
            signal["professional"] = True
            self._remember_signal_time(signal, row.get("updated_at"))

    def _apply_kai_circle_recommendations(
        self,
        *,
        owner_user_id: str,
        recipients: list[dict[str, Any]],
        preserve_order: bool = False,
    ) -> list[dict[str, Any]]:
        """Annotate recipients with Kai recommendation signals.

        ``preserve_order`` keeps the caller's incoming order instead of
        re-ranking by score. The Location screen wants the ranking -- "who
        should I share with" is exactly a recommendation question. A paged
        directory search does not: its order was decided by SQL, ahead of
        LIMIT, and re-sorting the slice here would reorder rows *within* a page
        while the page boundaries stayed alphabetical. That inconsistency was
        survivable only while the Connect client re-sorted the page itself;
        the moment that client sort was removed, the A-Z index the reader was
        promised became recommendation-score order wearing alphabetical page
        breaks.
        """
        if not recipients:
            return []
        recipient_ids = {str(recipient.get("userId") or "") for recipient in recipients}
        recipient_ids.discard("")
        signals = {recipient_id: self._recommendation_signal() for recipient_id in recipient_ids}

        for recipient in recipients:
            recipient_id = str(recipient.get("userId") or "")
            signal = signals.get(recipient_id)
            if not signal:
                continue
            if recipient.get("canReceiveLocation"):
                self._add_recommendation_reason(
                    signal,
                    code="location_key_ready",
                    label="Ready for location sharing",
                    weight=28,
                )
            else:
                self._add_recommendation_reason(
                    signal,
                    code="recipient_key_missing",
                    label="Needs to open One Location once",
                    weight=4,
                )

        # All 10 of these are independent, unrelated reads keyed only by
        # `owner_user_id` -- nothing here depends on another section's
        # result, so fetching them one cross-continent round trip at a time
        # was pure serialized RTT. This was the single largest contributor
        # to `list_state`'s (and, through it, the consent summary's) query
        # latency: roughly half of the ~23 queries a Location load measured
        # at came from this one enrichment step alone. Each function below
        # keeps its own unchanged row-processing logic; only WHERE the rows
        # come from changed.
        _signal_rows = self._run_read_queries_parallel(
            [
                (
                    "one_location_grants",
                    """
                    SELECT owner_user_id, recipient_user_id, status, created_at, updated_at,
                           expires_at, revoked_at
                    FROM one_location_share_grants
                    WHERE owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id
                    ORDER BY created_at DESC
                    LIMIT 100
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "one_location_requests",
                    """
                    SELECT owner_user_id, requester_user_id, referred_by_user_id, status,
                           requested_at, resolved_at
                    FROM one_location_access_requests
                    WHERE owner_user_id = :owner_user_id OR requester_user_id = :owner_user_id
                    ORDER BY requested_at DESC
                    LIMIT 100
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "one_location_referrals",
                    """
                    SELECT owner_user_id, referring_user_id, referred_user_id, status,
                           created_at, resolved_at
                    FROM one_location_referrals
                    WHERE owner_user_id = :owner_user_id
                       OR referring_user_id = :owner_user_id
                       OR referred_user_id = :owner_user_id
                    ORDER BY created_at DESC
                    LIMIT 100
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "consent_audit",
                    """
                    SELECT user_id, agent_id, action, issued_at
                    FROM consent_audit
                    WHERE user_id = :owner_user_id OR agent_id = :owner_user_id
                    ORDER BY issued_at DESC
                    LIMIT 100
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "trusted_connections",
                    """
                    SELECT owner_user_id, trusted_user_id, status, created_at, updated_at
                    FROM trusted_connections
                    WHERE status = 'active'
                      AND owner_user_id = :owner_user_id
                    ORDER BY created_at DESC
                    LIMIT 200
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "mutual_kai_relationships",
                    """
                    SELECT rel.investor_user_id, rel.created_at, rel.updated_at,
                           rp.user_id AS ria_user_id
                    FROM advisor_investor_relationships rel
                    JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
                    JOIN relationship_share_grants share
                      ON share.relationship_id = rel.id
                     AND share.grant_key = 'ria_active_picks_feed_v1'
                     AND share.status = 'active'
                     AND share.connection_scope_proposal_id IS NOT NULL
                    JOIN connection_scope_proposals proposal
                      ON proposal.id = share.connection_scope_proposal_id
                     AND proposal.status = 'active'
                     AND proposal.capability_key = 'ria_active_picks_feed_v1'
                    WHERE rel.status = 'approved'
                    ORDER BY COALESCE(rel.updated_at, rel.created_at) DESC
                    LIMIT 500
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "advisor_investor_relationships",
                    """
                    SELECT
                      rel.investor_user_id,
                      rel.status,
                      rel.granted_scope,
                      rel.consent_granted_at,
                      rel.created_at,
                      rel.updated_at,
                      rp.user_id AS ria_user_id,
                      rp.display_name AS ria_display_name,
                      rp.verification_status AS ria_verification_status,
                      share.status AS relationship_share_status,
                      share.granted_at AS relationship_share_granted_at
                    FROM advisor_investor_relationships rel
                    JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
                    JOIN relationship_share_grants share
                      ON share.relationship_id = rel.id
                     AND share.grant_key = 'ria_active_picks_feed_v1'
                     AND share.status = 'active'
                     AND share.connection_scope_proposal_id IS NOT NULL
                    JOIN connection_scope_proposals proposal
                      ON proposal.id = share.connection_scope_proposal_id
                     AND proposal.status = 'active'
                     AND proposal.capability_key = 'ria_active_picks_feed_v1'
                    WHERE rel.investor_user_id = :owner_user_id
                       OR rp.user_id = :owner_user_id
                    ORDER BY COALESCE(rel.consent_granted_at, rel.updated_at, rel.created_at) DESC
                    LIMIT 100
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "ria_firm_memberships",
                    """
                    SELECT
                      peer_rp.user_id AS peer_user_id,
                      firm.legal_name AS firm_name,
                      peer_membership.role_title AS peer_role_title,
                      owner_membership.updated_at AS owner_membership_updated_at,
                      peer_membership.updated_at AS peer_membership_updated_at
                    FROM ria_profiles owner_rp
                    JOIN ria_firm_memberships owner_membership
                      ON owner_membership.ria_profile_id = owner_rp.id
                     AND owner_membership.membership_status = 'active'
                    JOIN ria_firm_memberships peer_membership
                      ON peer_membership.firm_id = owner_membership.firm_id
                     AND peer_membership.membership_status = 'active'
                    JOIN ria_profiles peer_rp ON peer_rp.id = peer_membership.ria_profile_id
                    JOIN ria_firms firm ON firm.id = owner_membership.firm_id
                    WHERE owner_rp.user_id = :owner_user_id
                      AND peer_rp.user_id <> :owner_user_id
                    ORDER BY COALESCE(peer_membership.updated_at, owner_membership.updated_at) DESC
                    LIMIT 100
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "marketplace_public_profiles",
                    """
                    SELECT user_id, profile_type, headline, strategy_summary,
                           verification_badge, metadata, updated_at, created_at
                    FROM marketplace_public_profiles
                    WHERE is_discoverable = TRUE
                    ORDER BY updated_at DESC
                    LIMIT 200
                    """,
                    {"owner_user_id": owner_user_id},
                ),
                (
                    "runtime_persona_state",
                    """
                    SELECT user_id, last_active_persona, updated_at
                    FROM runtime_persona_state
                    WHERE user_id <> :owner_user_id
                    ORDER BY updated_at DESC
                    LIMIT 200
                    """,
                    {"owner_user_id": owner_user_id},
                ),
            ]
        )

        self._add_one_location_history_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            grant_rows=_signal_rows["one_location_grants"],
            request_rows=_signal_rows["one_location_requests"],
            referral_rows=_signal_rows["one_location_referrals"],
        )
        self._add_prior_consent_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["consent_audit"],
        )
        self._add_one_network_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["trusted_connections"],
        )
        self._add_mutual_kai_relationship_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["mutual_kai_relationships"],
        )
        self._add_professional_network_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["advisor_investor_relationships"],
        )
        self._add_organization_membership_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["ria_firm_memberships"],
        )
        self._add_marketplace_profile_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["marketplace_public_profiles"],
        )
        self._add_persona_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
            rows=_signal_rows["runtime_persona_state"],
        )

        enriched: list[dict[str, Any]] = []
        for recipient in recipients:
            recipient_id = str(recipient.get("userId") or "")
            signal = signals.get(recipient_id) or self._recommendation_signal()
            reasons = sorted(
                signal.get("reasons", {}).values(),
                key=lambda item: (-int(item.get("weight") or 0), str(item.get("code") or "")),
            )[:4]
            score = max(0, min(100, int(signal.get("score") or 0)))
            can_receive = bool(recipient.get("canReceiveLocation"))
            if not can_receive and signal.get("trusted"):
                category = "trusted_circle"
                tier = "setup_needed"
                trust_level = "high"
                category_label = "Trusted Circle"
                summary = (
                    "They are connected on One and need to open One Location once before sharing."
                )
            elif not can_receive and signal.get("professional"):
                category = "professional_network"
                tier = "setup_needed"
                trust_level = "medium"
                category_label = "Professional Network"
                summary = "A KAI network signal matched, but they need to open One Location once before sharing."
            elif not can_receive:
                category = "needs_setup"
                tier = "setup_needed"
                trust_level = "setup_needed"
                category_label = "Needs setup"
                summary = "They need to open One Location once before sharing."
            elif signal.get("needs_action"):
                category = "needs_action"
                tier = "needs_action"
                trust_level = "medium"
                category_label = "Needs action"
                summary = "They are waiting on your location-sharing decision."
            elif signal.get("trusted"):
                category = "trusted_circle"
                tier = "trusted_circle"
                trust_level = "high"
                category_label = "Trusted Circle"
                summary = "Existing trust or sharing history makes this a strong match."
            elif signal.get("professional"):
                category = "professional_network"
                tier = "kai_network"
                trust_level = "medium"
                category_label = "Professional Network"
                summary = "KAI marketplace, advisor, investor, or persona signals matched."
            else:
                category = "location_ready"
                tier = "available"
                trust_level = "new"
                category_label = "Location ready"
                summary = "Verified One member ready for location sharing."

            enriched.append(
                {
                    **recipient,
                    "recommendationScore": score,
                    "recommendationTier": tier,
                    "recommendationCategory": category,
                    "recommendationCategoryLabel": category_label,
                    "recommendationReasons": reasons,
                    "recommendationSummary": summary,
                    "trustLevel": trust_level,
                    "relationshipType": signal.get("relationship_type"),
                    "profileHeadline": signal.get("profile_headline"),
                    "verificationBadge": signal.get("verification_badge")
                    or ("Location ready" if can_receive else None),
                    "lastInteractionAt": _iso(signal.get("last_interaction_at")),
                }
            )

        if not preserve_order:
            enriched.sort(
                key=lambda item: (
                    -int(item.get("recommendationScore") or 0),
                    0 if item.get("canReceiveLocation") else 1,
                    str(item.get("displayName") or "").lower(),
                    str(item.get("userId") or ""),
                )
            )
        for index, recipient in enumerate(enriched, start=1):
            recipient["recommendationRank"] = index
        return enriched

    @staticmethod
    def _grant_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        # Surface the grant's share kind + optional human message so the
        # recipient's in-app notification, bell, and Consent Manager can tell an
        # SOS from a Check-In from a plain share. The kind/message come from the
        # stored grant metadata "reason" marker (never coordinates). When the row
        # was selected without metadata (some callers), default to a plain share.
        metadata = _loads_json(row.get("metadata"))
        reason = metadata.get("reason") if isinstance(metadata, dict) else None
        stored_kind = metadata.get("share_kind") if isinstance(metadata, dict) else None
        duration_mode = str(
            row.get("duration_mode")
            or (metadata.get("duration_mode") if isinstance(metadata, dict) else "")
            or TIMED_LOCATION_SHARE_DURATION_MODE
        )
        share_kind = stored_kind or _classify_share_kind(reason)
        share_message = _visible_share_message(reason)
        return {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "recipientUserId": str(row.get("recipient_user_id") or ""),
            "ownerDisplayName": str(row.get("owner_display_name") or "") or None,
            "ownerMaskedPhone": _mask_phone(row.get("owner_phone_number")),
            "recipientDisplayName": str(row.get("recipient_display_name") or "") or None,
            "recipientMaskedPhone": _mask_phone(row.get("recipient_phone_number")),
            "recipientKeyId": str(row.get("recipient_key_id") or ""),
            "status": str(row.get("status") or ""),
            "consentScope": str(row.get("consent_scope") or "cap.location.live.view"),
            "capabilityScopes": _loads_json(row.get("capability_scopes")) or [],
            "durationMode": duration_mode,
            "durationHours": (
                float(row.get("duration_hours")) if row.get("duration_hours") is not None else None
            ),
            "expiresAt": _iso(row.get("expires_at")),
            # Furthest-out expiry the owner has explicitly authorized. Lets a
            # duration edit tell "still within what was approved" (no consent
            # needed) apart from "asking for more" (needs request_access).
            "ceilingExpiresAt": _iso(row.get("ceiling_expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
            "latestEnvelopeId": str(row.get("latest_envelope_id") or "") or None,
            "sourceCircleId": str(row.get("source_circle_id") or "") or None,
            "shareKind": share_kind,
            "shareMessage": share_message,
        }

    @staticmethod
    def _envelope_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": str(row.get("id") or ""),
            "grantId": str(row.get("grant_id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "recipientUserId": str(row.get("recipient_user_id") or ""),
            "recipientKeyId": str(row.get("recipient_key_id") or ""),
            "algorithm": str(row.get("algorithm") or "ECDH-P256-AES256-GCM"),
            "ciphertext": str(row.get("ciphertext") or ""),
            "iv": str(row.get("iv") or ""),
            "senderEphemeralPublicKeyJwk": _loads_json(row.get("sender_ephemeral_public_key_jwk")),
            "capturedAt": _iso(row.get("captured_at")),
            "sourcePlatform": str(row.get("source_platform") or "unknown"),
            "publicationContext": str(row.get("publication_context") or "private_foreground"),
            "createdAt": _iso(row.get("created_at")),
            "metadata": _loads_json(row.get("metadata")) or {},
        }

    @staticmethod
    def _request_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        # How much time was asked for, and whether the ask is about time on a
        # share that is already running. Every surface that has to say what the
        # request IS -- the owner's approvals list and Approve control, the
        # requester's own people row, the notification copy -- reads these
        # rather than parsing the free-text message, which is why "Requesting
        # more time." used to be the only trace of an extension anywhere.
        extends_grant_id = str(row.get("extends_grant_id") or "") or None
        requested_duration_hours = (
            float(row["requested_duration_hours"])
            if row.get("requested_duration_hours") is not None
            else None
        )
        return {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "requesterUserId": str(row.get("requester_user_id") or ""),
            "requesterDisplayName": str(row.get("requester_display_name") or "") or None,
            "requesterMaskedPhone": _mask_phone(row.get("requester_phone_number")),
            "referredByUserId": str(row.get("referred_by_user_id") or "") or None,
            "status": str(row.get("status") or "pending"),
            "message": str(row.get("message") or "") or None,
            "requestedAt": _iso(row.get("requested_at")),
            "resolvedAt": _iso(row.get("resolved_at")),
            "approvedGrantId": str(row.get("approved_grant_id") or "") or None,
            "requestedDurationHours": requested_duration_hours,
            "requestedDurationMode": str(row.get("requested_duration_mode") or "") or None,
            "extendsGrantId": extends_grant_id,
            "isExtension": bool(extends_grant_id),
            # The live share's own expiry, joined in by the request reads so a
            # surface can say "3 more hours on top of the 45 minutes left"
            # without a second round trip per row.
            "extendsGrantExpiresAt": _iso(row.get("extends_grant_expires_at")),
            "requestRevision": int(row.get("request_revision") or 1),
        }

    @staticmethod
    def _referral_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": str(row.get("id") or ""),
            "grantId": str(row.get("grant_id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "referringUserId": str(row.get("referring_user_id") or ""),
            "referredUserId": str(row.get("referred_user_id") or ""),
            "requestId": str(row.get("request_id") or "") or None,
            "status": str(row.get("status") or "pending_owner_approval"),
            "createdAt": _iso(row.get("created_at")),
            "resolvedAt": _iso(row.get("resolved_at")),
        }

    @staticmethod
    def _public_invite_payload(
        row: dict[str, Any] | None, *, public: bool = False
    ) -> dict[str, Any] | None:
        if not row:
            return None
        metadata = _loads_json(row.get("metadata")) or {}
        safe_label = ""
        if isinstance(metadata, dict):
            safe_label = str(metadata.get("owner_safe_label") or "").strip()
        if public:
            payload = {
                "status": str(row.get("status") or "active"),
                "durationHours": float(row.get("duration_hours") or 0),
                "expiresAt": _iso(row.get("expires_at")),
                "ownerLabel": safe_label or PUBLIC_INVITE_DEFAULT_OWNER_LABEL,
            }
            if isinstance(metadata, dict) and isinstance(metadata.get("publicLocation"), dict):
                payload["locationAvailable"] = True
            return payload
        payload = {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "status": str(row.get("status") or "active"),
            "durationHours": float(row.get("duration_hours") or 0),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
        }
        if safe_label:
            payload["ownerLabel"] = safe_label
        return payload

    @staticmethod
    def _circle_invite_payload(
        row: dict[str, Any] | None, *, public: bool = False
    ) -> dict[str, Any] | None:
        if not row:
            return None
        metadata = _loads_json(row.get("metadata")) or {}
        safe_label = ""
        if isinstance(metadata, dict):
            safe_label = str(metadata.get("owner_safe_label") or "").strip()
        message = str(row.get("message") or "").strip() or None
        if public:
            payload = {
                "status": str(row.get("status") or "active"),
                "durationHours": float(row.get("duration_hours") or 0),
                "expiresAt": _iso(row.get("expires_at")),
                "ownerLabel": safe_label or PUBLIC_INVITE_DEFAULT_OWNER_LABEL,
            }
            if message:
                payload["message"] = message
            return payload
        payload = {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "status": str(row.get("status") or "active"),
            "durationHours": float(row.get("duration_hours") or 0),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
            "claimedAt": _iso(row.get("claimed_at")),
            "claimedByUserId": str(row.get("claimed_by_user_id") or "") or None,
            "requestId": str(row.get("request_id") or "") or None,
            "message": message,
        }
        if safe_label:
            payload["ownerLabel"] = safe_label
        return payload

    @staticmethod
    def _trusted_connection_as_network_payload(
        row: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Map a trusted_connections edge (owner -> trusted) into the legacy
        networkConnections payload shape the frontend SOS/check-in selectors read.
        userAId is always the owner, userBId the trusted person."""
        if not row:
            return None
        return {
            "id": str(row.get("id") or ""),
            "userAId": str(row.get("owner_user_id") or ""),
            "userBId": str(row.get("trusted_user_id") or ""),
            "inviterUserId": str(row.get("owner_user_id") or ""),
            "inviteeUserId": str(row.get("trusted_user_id") or ""),
            "inviteId": None,
            "status": str(row.get("status") or "active"),
            "connectedAt": _iso(row.get("created_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
        }

    @staticmethod
    def _public_location_snapshot_payload(value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_LOCATION_INVALID",
                "Public location links need a valid captured location.",
                status_code=422,
            )
        latitude_raw = value.get("latitude")
        longitude_raw = value.get("longitude")
        if latitude_raw is None or longitude_raw is None:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_LOCATION_INVALID",
                "Public location links need valid latitude and longitude.",
                status_code=422,
            )
        try:
            latitude = float(latitude_raw)
            longitude = float(longitude_raw)
        except (TypeError, ValueError) as exc:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_LOCATION_INVALID",
                "Public location links need valid latitude and longitude.",
                status_code=422,
            ) from exc
        if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_LOCATION_INVALID",
                "Public location coordinates are outside the valid range.",
                status_code=422,
            )
        accuracy_raw = value.get("accuracyM", value.get("accuracy_m"))
        accuracy_m: float | None = None
        if accuracy_raw is not None:
            try:
                parsed_accuracy = float(accuracy_raw)
                if parsed_accuracy > 0:
                    accuracy_m = round(parsed_accuracy, 2)
            except (TypeError, ValueError):
                accuracy_m = None
        captured_at = _parse_datetime(
            value.get("capturedAt") or value.get("captured_at"),
            field_name="capturedAt",
        )
        return {
            "latitude": round(latitude, 7),
            "longitude": round(longitude, 7),
            "accuracyM": accuracy_m,
            "capturedAt": _iso(captured_at),
            "sourcePlatform": normalize_source_platform(
                value.get("sourcePlatform") or value.get("source_platform")
            ),
        }

    @staticmethod
    def _public_submission_payload(
        row: dict[str, Any] | None, *, public: bool = False
    ) -> dict[str, Any] | None:
        if not row:
            return None
        if public:
            return {
                "status": str(row.get("status") or "pending_identity"),
                "submittedAt": _iso(row.get("submitted_at")),
            }
        return {
            "id": str(row.get("id") or ""),
            "inviteId": str(row.get("invite_id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "visitorDisplayName": str(row.get("visitor_display_name") or ""),
            "visitorMaskedPhone": _mask_phone(row.get("visitor_phone_last4")),
            "matchedUserId": str(row.get("matched_user_id") or "") or None,
            "requestId": str(row.get("request_id") or "") or None,
            "requestStatus": str(row.get("request_status") or "") or None,
            "status": str(row.get("status") or "pending_identity"),
            "message": str(row.get("message") or "") or None,
            "submittedAt": _iso(row.get("submitted_at")),
            "resolvedAt": _iso(row.get("resolved_at")),
        }

    @staticmethod
    def _activity_display_label(
        value: Any,
        *,
        fallback: str = "KAI member",
    ) -> str:
        label = str(value or "").strip()
        return label or fallback

    @classmethod
    def _activity_event_payload(
        cls,
        row: dict[str, Any],
        *,
        user_id: str,
        range_key: str,
    ) -> dict[str, Any] | None:
        event_type = str(row.get("event_type") or "")
        if event_type not in ONE_LOCATION_ACTIVITY_EVENT_TYPES:
            return None
        occurred_at = _parse_datetime(row.get("created_at"), field_name="created_at")
        owner_user_id = str(row.get("owner_user_id") or "")
        owner_label = cls._activity_display_label(
            row.get("owner_display_name"),
            fallback="A trusted person",
        )
        actor_label = cls._activity_display_label(
            row.get("actor_display_name"),
            fallback="KAI member",
        )
        recipient_label = cls._activity_display_label(
            row.get("recipient_display_name"),
            fallback="KAI member",
        )
        visitor_label = cls._activity_display_label(
            row.get("visitor_display_name"),
            fallback="Public request",
        )
        event_id = str(row.get("id") or f"{event_type}:{_iso(occurred_at)}")
        kind = _activity_kind(event_type)
        detail = {
            "share": "Private sharing",
            "request": "Approval workflow",
            "public": "Request link",
        }[kind]

        title = "One Location activity"
        if event_type == "location_share_created":
            title = (
                f"Shared with {recipient_label}"
                if owner_user_id == user_id
                else f"{owner_label} shared with you"
            )
        elif event_type == "location_share_viewed":
            title = (
                f"Viewed by {actor_label}"
                if owner_user_id == user_id
                else f"You viewed {owner_label}'s update"
            )
        elif event_type == "location_share_revoked":
            title = (
                f"Sharing stopped with {recipient_label}"
                if owner_user_id == user_id
                else f"{owner_label} stopped sharing"
            )
        elif event_type == "location_share_expired":
            title = (
                f"Share expired for {recipient_label}"
                if owner_user_id == user_id
                else f"{owner_label}'s share expired"
            )
        elif event_type == "location_access_request":
            title = (
                f"Request from {actor_label}"
                if owner_user_id == user_id
                else f"Request sent to {owner_label}"
            )
        elif event_type == "location_access_approved":
            title = (
                f"Approved request for {recipient_label}"
                if owner_user_id == user_id
                else f"{owner_label} approved your request"
            )
        elif event_type == "location_access_denied":
            title = (
                f"Denied request from {recipient_label or actor_label}"
                if owner_user_id == user_id
                else f"{owner_label} denied your request"
            )
        elif event_type == "location_access_request_withdrawn":
            title = (
                f"{actor_label} took back their request"
                if owner_user_id == user_id
                else f"You took back your request to {owner_label}"
            )
        elif event_type == "location_referral_invite":
            title = f"Referral added for {recipient_label}"
        elif event_type == "location_public_invite_created":
            title = "Request link created"
        elif event_type == "location_public_invite_revoked":
            title = "Request link closed"
        elif event_type == "location_public_invite_submitted":
            title = f"Response from {visitor_label}"
        elif event_type == "location_circle_invite_created":
            title = "Invite to One created"
        elif event_type == "location_circle_invite_claimed":
            title = (
                f"{actor_label} accepted your Invite to One"
                if owner_user_id == user_id
                else f"You joined {owner_label} on One"
            )
        elif event_type == "location_circle_invite_revoked":
            title = "Invite to One closed"
        elif event_type == "location_one_network_joined":
            title = (
                f"{actor_label} joined your One Network"
                if owner_user_id == user_id
                else f"You joined {owner_label}'s One Network"
            )

        return {
            "id": event_id,
            "kind": kind,
            "eventType": event_type,
            "occurredAt": _iso(occurred_at),
            "bucketKey": _activity_bucket_key(occurred_at, range_key),
            "bucketLabel": _activity_bucket_label(occurred_at, range_key),
            "title": title,
            "detail": f"{detail} - {format_activity_time(occurred_at)}",
        }

    def list_activity(
        self,
        *,
        user_id: str,
        range_key: str = "30d",
        limit: int = 40,
    ) -> dict[str, Any]:
        if not user_id:
            raise OneLocationAgentError(
                "LOCATION_AUTH_REQUIRED", "A user is required.", status_code=401
            )
        normalized_range = range_key if range_key in {"7d", "30d", "90d", "all"} else "30d"
        since_at = _activity_since(normalized_range)
        bounded_limit = max(1, min(int(limit or 40), 100))
        rows = self._execute_many(
            """
            SELECT
              e.id,
              e.owner_user_id,
              e.actor_user_id,
              e.recipient_user_id,
              e.event_type,
              e.metadata,
              e.created_at,
              owner.display_name AS owner_display_name,
              actor.display_name AS actor_display_name,
              recipient.display_name AS recipient_display_name,
              submission.visitor_display_name AS visitor_display_name
            FROM one_location_events e
            LEFT JOIN actor_identity_cache owner ON owner.user_id = e.owner_user_id
            LEFT JOIN actor_identity_cache actor ON actor.user_id = e.actor_user_id
            LEFT JOIN actor_identity_cache recipient ON recipient.user_id = e.recipient_user_id
            LEFT JOIN one_location_public_invite_submissions submission
              ON submission.id::text = e.metadata->>'submission_id'
            WHERE e.event_type = ANY(:event_types)
              AND (:since_at IS NULL OR e.created_at >= :since_at)
              AND (
                e.owner_user_id = :user_id
                OR e.actor_user_id = :user_id
                OR e.recipient_user_id = :user_id
              )
            ORDER BY e.created_at DESC
            LIMIT :limit
            """,
            {
                "user_id": user_id,
                "since_at": since_at,
                "limit": bounded_limit,
                "event_types": sorted(ONE_LOCATION_ACTIVITY_EVENT_TYPES),
            },
        )
        active_row = (
            self._execute_one(
                """
            SELECT COUNT(*)::int AS active_share_count
            FROM one_location_share_grants
            WHERE owner_user_id = :user_id
              AND status = 'active'
            """,
                {"user_id": user_id},
            )
            or {}
        )

        events = [
            payload
            for row in rows
            if (
                payload := self._activity_event_payload(
                    row,
                    user_id=user_id,
                    range_key=normalized_range,
                )
            )
        ]
        bucket_map: dict[str, dict[str, Any]] = {}
        for event in events:
            key = str(event["bucketKey"])
            bucket = bucket_map.setdefault(
                key,
                {
                    "key": key,
                    "label": event["bucketLabel"],
                    "shares": 0,
                    "requests": 0,
                    "views": 0,
                    "publicActivity": 0,
                    "total": 0,
                },
            )
            event_type = str(event.get("eventType") or "")
            if event["kind"] == "share":
                bucket["shares"] += 1
            if event["kind"] == "request":
                bucket["requests"] += 1
            if event_type == "location_share_viewed":
                bucket["views"] += 1
            if event["kind"] == "public":
                bucket["publicActivity"] += 1
            bucket["total"] += 1

        shared_with = {
            str(row.get("recipient_user_id") or "")
            for row in rows
            if str(row.get("event_type") or "") == "location_share_created"
            and str(row.get("owner_user_id") or "") == user_id
            and str(row.get("recipient_user_id") or "")
        }
        summary = {
            "sharedWithCount": len(shared_with),
            "activeShareCount": int(active_row.get("active_share_count") or 0),
            "requestsReceivedCount": sum(
                1
                for row in rows
                if str(row.get("event_type") or "") == "location_access_request"
                and str(row.get("owner_user_id") or "") == user_id
            ),
            "requestsSentCount": sum(
                1
                for row in rows
                if str(row.get("event_type") or "") == "location_access_request"
                and str(row.get("actor_user_id") or "") == user_id
                and str(row.get("owner_user_id") or "") != user_id
            ),
            "viewsCount": sum(
                1 for row in rows if str(row.get("event_type") or "") == "location_share_viewed"
            ),
            "publicLinkCount": sum(
                1
                for row in rows
                if str(row.get("event_type") or "") == "location_public_invite_created"
                and str(row.get("owner_user_id") or "") == user_id
            ),
            "publicResponseCount": sum(
                1
                for row in rows
                if str(row.get("event_type") or "") == "location_public_invite_submitted"
                and str(row.get("owner_user_id") or "") == user_id
            ),
            "totalEvents": len(events),
        }

        return {
            "range": normalized_range,
            "summary": summary,
            "buckets": [bucket_map[key] for key in sorted(bucket_map.keys())][-8:],
            "events": events[:bounded_limit],
        }

    def _expire_stale_grants(self, user_id: str | None) -> None:
        retention_cutoff = _utcnow() - timedelta(hours=LOCATION_TERMINAL_RETENTION_HOURS)
        expired = self._execute_many(
            """
            WITH stale AS (
              SELECT id
              FROM one_location_share_grants
              WHERE status = 'active'
                AND expires_at <= NOW()
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR recipient_user_id = :user_id
                )
              ORDER BY expires_at
              LIMIT 500
              FOR UPDATE SKIP LOCKED
            )
            UPDATE one_location_share_grants AS target_grant
            SET status = 'expired', updated_at = NOW()
            FROM stale
            WHERE target_grant.id = stale.id
            RETURNING
              target_grant.id,
              target_grant.owner_user_id,
              target_grant.recipient_user_id,
              target_grant.expires_at
            """,
            {"user_id": user_id},
        )
        for row in expired:
            grant_id = str(row.get("id") or "") or None
            owner_user_id = str(row.get("owner_user_id") or "")
            recipient_user_id = str(row.get("recipient_user_id") or "")
            expires_at = _parse_datetime(row.get("expires_at"), field_name="expires_at")
            if expires_at <= retention_cutoff:
                continue
            owner_label = _identity_notification_label(self._identity_row(owner_user_id))
            recipient_label = _identity_notification_label(self._identity_row(recipient_user_id))
            self._insert_event(
                owner_user_id=owner_user_id,
                actor_user_id=None,
                recipient_user_id=recipient_user_id or None,
                grant_id=grant_id,
                event_type="location_share_expired",
                metadata={"reason": "expires_at", "counterpart_label": recipient_label},
            )
            if grant_id and recipient_user_id:
                self._send_metadata_notification(
                    user_id=recipient_user_id,
                    notification_type="location_share_expired",
                    title="Location access expired",
                    body="A location share reached its expiry time.",
                    notification_tag=f"one-location-expired:{grant_id}",
                    request_url=_one_location_url(grantId=grant_id, section="shared"),
                    data={
                        "grant_id": grant_id,
                        "owner_user_id": owner_user_id,
                        "owner_display_label": owner_label,
                    },
                )

    def _purge_terminal_work(
        self,
        *,
        user_id: str | None = None,
        older_than_hours: float = LOCATION_TERMINAL_RETENTION_HOURS,
    ) -> dict[str, Any]:
        hours = max(1.0, min(float(older_than_hours or LOCATION_TERMINAL_RETENTION_HOURS), 168.0))
        row = (
            self._execute_one(
                """
            WITH stale_grants AS (
              SELECT id
              FROM one_location_share_grants
              WHERE ((
                  status = 'expired'
                  AND expires_at <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'revoked'
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                ))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR recipient_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_requests AS (
              SELECT id
              FROM one_location_access_requests
              WHERE ((
                  status IN ('approved', 'denied', 'cancelled')
                  AND COALESCE(resolved_at, requested_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR approved_grant_id IN (SELECT id FROM stale_grants))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR requester_user_id = :user_id
                  OR referred_by_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_referrals AS (
              SELECT id
              FROM one_location_referrals
              WHERE ((
                  status IN ('approved', 'denied', 'cancelled')
                  AND COALESCE(resolved_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR grant_id IN (SELECT id FROM stale_grants)
                OR request_id IN (SELECT id FROM stale_requests))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR referring_user_id = :user_id
                  OR referred_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_public_invites AS (
              SELECT id
              FROM one_location_public_invites
              WHERE ((
                  status = 'expired'
                  AND expires_at <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'revoked'
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                ))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_public_submissions AS (
              SELECT id
              FROM one_location_public_invite_submissions
              WHERE ((
                  status IN ('approved', 'denied', 'cancelled')
                  AND COALESCE(resolved_at, submitted_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR invite_id IN (SELECT id FROM stale_public_invites)
                OR request_id IN (SELECT id FROM stale_requests))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR matched_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_circle_invites AS (
              SELECT id
              FROM one_location_circle_invites
              WHERE (
                (
                  status IN ('claimed', 'expired')
                  AND COALESCE(claimed_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'revoked'
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
              )
              AND (
                :user_id IS NULL
                OR owner_user_id = :user_id
                OR claimed_by_user_id = :user_id
              )
              LIMIT 500
            ),
            stale_named_circle_codes AS (
              SELECT id
              FROM one_location_circle_invite_codes
              WHERE (
                (
                  status IN ('expired', 'revoked')
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'active'
                  AND expires_at <= NOW() - (:hours * INTERVAL '1 hour')
                )
              )
              AND (
                :user_id IS NULL
                OR created_by_user_id = :user_id
              )
              LIMIT 500
            ),
            expired_named_circle_member_invite_candidates AS (
              SELECT invite.id
              FROM one_location_circle_member_invites invite
              WHERE invite.status = 'pending'
                AND invite.expires_at <= NOW()
                AND (
                  :user_id IS NULL
                  OR invite.inviter_user_id = :user_id
                  OR invite.invitee_user_id = :user_id
                )
              ORDER BY invite.expires_at, invite.id
              LIMIT 500
              FOR UPDATE SKIP LOCKED
            ),
            expired_named_circle_member_invites AS (
              UPDATE one_location_circle_member_invites invite
              SET status = 'expired',
                  updated_at = NOW()
              FROM expired_named_circle_member_invite_candidates candidate
              WHERE invite.id = candidate.id
              RETURNING invite.id
            ),
            stale_named_circle_member_invites AS (
              SELECT invite.id
              FROM one_location_circle_member_invites invite
              WHERE invite.status IN (
                  'accepted',
                  'declined',
                  'cancelled',
                  'expired'
                )
                AND COALESCE(
                  invite.responded_at,
                  invite.cancelled_at,
                  invite.updated_at,
                  invite.expires_at,
                  invite.created_at
                ) <= NOW() - (:hours * INTERVAL '1 hour')
                AND (
                  :user_id IS NULL
                  OR invite.inviter_user_id = :user_id
                  OR invite.invitee_user_id = :user_id
                )
                AND (SELECT COUNT(*) FROM expired_named_circle_member_invites) >= 0
              LIMIT 500
            ),
            deleted_events AS (
              DELETE FROM one_location_events e
              WHERE e.grant_id IN (SELECT id FROM stale_grants)
                 OR e.request_id IN (SELECT id FROM stale_requests)
                 OR e.referral_id IN (SELECT id FROM stale_referrals)
                 OR (
                   e.event_type IN (
                     'location_public_invite_created',
                     'location_public_invite_revoked',
                     'location_public_invite_submitted'
                   )
                   AND (
                     e.metadata->>'invite_id' IN (
                       SELECT id::text FROM stale_public_invites
                     )
                     OR e.metadata->>'submission_id' IN (
                       SELECT id::text FROM stale_public_submissions
                     )
                   )
                 )
                 OR (
                   e.event_type IN (
                     'location_circle_invite_created',
                     'location_circle_invite_claimed',
                     'location_circle_invite_revoked',
                     'location_one_network_joined'
                   )
                   AND e.metadata->>'invite_id' IN (
                     SELECT id::text FROM stale_circle_invites
                   )
                 )
              RETURNING id
            ),
            deleted_public_submissions AS (
              DELETE FROM one_location_public_invite_submissions s
              WHERE s.id IN (SELECT id FROM stale_public_submissions)
                AND (SELECT COUNT(*) FROM deleted_events) >= 0
              RETURNING id
            ),
            deleted_envelopes AS (
              DELETE FROM one_location_envelopes e
              WHERE e.grant_id IN (SELECT id FROM stale_grants)
                AND (SELECT COUNT(*) FROM deleted_public_submissions) >= 0
              RETURNING id
            ),
            deleted_referrals AS (
              DELETE FROM one_location_referrals r
              WHERE (
                  r.id IN (SELECT id FROM stale_referrals)
                  OR r.grant_id IN (SELECT id FROM stale_grants)
                  OR r.request_id IN (SELECT id FROM stale_requests)
                )
                AND (SELECT COUNT(*) FROM deleted_envelopes) >= 0
              RETURNING id
            ),
            deleted_requests AS (
              DELETE FROM one_location_access_requests req
              WHERE req.id IN (SELECT id FROM stale_requests)
                AND (SELECT COUNT(*) FROM deleted_referrals) >= 0
              RETURNING id
            ),
            deleted_grants AS (
              DELETE FROM one_location_share_grants g
              WHERE g.id IN (SELECT id FROM stale_grants)
                AND (SELECT COUNT(*) FROM deleted_requests) >= 0
              RETURNING id
            ),
            deleted_public_invites AS (
              DELETE FROM one_location_public_invites i
              WHERE i.id IN (SELECT id FROM stale_public_invites)
                AND (SELECT COUNT(*) FROM deleted_grants) >= 0
              RETURNING id
            ),
            deleted_circle_invites AS (
              DELETE FROM one_location_circle_invites i
              WHERE i.id IN (SELECT id FROM stale_circle_invites)
                AND (SELECT COUNT(*) FROM deleted_public_invites) >= 0
              RETURNING id
            ),
            deleted_named_circle_codes AS (
              DELETE FROM one_location_circle_invite_codes code
              WHERE code.id IN (SELECT id FROM stale_named_circle_codes)
                AND (SELECT COUNT(*) FROM deleted_circle_invites) >= 0
              RETURNING id
            ),
            deleted_named_circle_member_invites AS (
              DELETE FROM one_location_circle_member_invites invite
              WHERE invite.id IN (
                  SELECT id FROM stale_named_circle_member_invites
                )
                AND (SELECT COUNT(*) FROM deleted_named_circle_codes) >= 0
              RETURNING id
            )
            SELECT
              (SELECT COUNT(*) FROM deleted_grants) AS deleted_grants,
              (SELECT COUNT(*) FROM deleted_envelopes) AS deleted_envelopes,
              (SELECT COUNT(*) FROM deleted_requests) AS deleted_requests,
              (SELECT COUNT(*) FROM deleted_referrals) AS deleted_referrals,
              (SELECT COUNT(*) FROM deleted_public_invites) AS deleted_public_invites,
              (SELECT COUNT(*) FROM deleted_circle_invites) AS deleted_circle_invites,
              (SELECT COUNT(*) FROM deleted_named_circle_codes) AS deleted_named_circle_codes,
              (SELECT COUNT(*) FROM deleted_named_circle_member_invites)
                AS deleted_named_circle_member_invites,
              (SELECT COUNT(*) FROM deleted_public_submissions) AS deleted_public_submissions,
              (SELECT COUNT(*) FROM deleted_events) AS deleted_events
            """,
                {"user_id": user_id, "hours": hours},
            )
            or {}
        )
        return {
            "deleted_grants": int(row.get("deleted_grants") or 0),
            "deleted_envelopes": int(row.get("deleted_envelopes") or 0),
            "deleted_requests": int(row.get("deleted_requests") or 0),
            "deleted_referrals": int(row.get("deleted_referrals") or 0),
            "deleted_public_invites": int(row.get("deleted_public_invites") or 0),
            "deleted_circle_invites": int(row.get("deleted_circle_invites") or 0),
            "deleted_named_circle_codes": int(row.get("deleted_named_circle_codes") or 0),
            "deleted_named_circle_member_invites": int(
                row.get("deleted_named_circle_member_invites") or 0
            ),
            "deleted_public_submissions": int(row.get("deleted_public_submissions") or 0),
            "deleted_events": int(row.get("deleted_events") or 0),
            "retention_hours": hours,
        }

    def purge_terminal_work(
        self, *, older_than_hours: float = LOCATION_TERMINAL_RETENTION_HOURS
    ) -> dict[str, Any]:
        self._expire_stale_grants(None)
        return self._purge_terminal_work(user_id=None, older_than_hours=older_than_hours)

    def register_recipient_key(
        self,
        *,
        user_id: str,
        public_key_jwk: dict[str, Any],
        key_id: str | None = None,
        algorithm: str = "ECDH-P256-AES256-GCM",
        encrypted_private_key_jwk: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not user_id:
            raise OneLocationAgentError(
                "LOCATION_AUTH_REQUIRED", "A user is required.", status_code=401
            )
        if not isinstance(public_key_jwk, dict) or not public_key_jwk.get("kty"):
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_KEY_INVALID",
                "Recipient public key material is required.",
                status_code=422,
            )
        normalized_key_id = (key_id or _fingerprint_public_key(public_key_jwk)).strip()
        if len(normalized_key_id) < 8:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_KEY_INVALID",
                "Recipient key id is too short.",
                status_code=422,
            )
        fingerprint = _fingerprint_public_key(public_key_jwk)
        # Opaque client-encrypted (vault-key) private key blob, stored verbatim so
        # every device the user signs into can recover the SAME keypair. COALESCE on
        # update so a device that only re-registers the public key doesn't wipe an
        # existing blob.
        encrypted_private_key_json = (
            json.dumps(encrypted_private_key_jwk, sort_keys=True, separators=(",", ":"))
            if isinstance(encrypted_private_key_jwk, dict)
            else None
        )
        mutation_sql = """
            WITH key_id_compatibility AS MATERIALIZED (
              SELECT (
                NOT EXISTS (
                  SELECT 1
                  FROM one_location_recipient_keys
                  WHERE user_id = :user_id
                    AND key_id = :key_id
                )
                OR EXISTS (
                  SELECT 1
                  FROM one_location_recipient_keys
                  WHERE user_id = :user_id
                    AND key_id = :key_id
                    AND public_key_fingerprint = :fingerprint
                )
              ) AS compatible
            ),
            rotated_keys AS (
              UPDATE one_location_recipient_keys
              SET status = 'rotated', updated_at = NOW()
              WHERE user_id = :user_id
                AND key_id <> :key_id
                AND status = 'active'
                AND (SELECT compatible FROM key_id_compatibility)
              RETURNING key_id
            ),
            revoked_grants AS (
              UPDATE one_location_share_grants
              SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
              WHERE recipient_user_id = :user_id
                AND recipient_key_id <> :key_id
                AND status = 'active'
                AND (SELECT compatible FROM key_id_compatibility)
              RETURNING id, owner_user_id, recipient_user_id
            ),
            upserted_key AS (
              INSERT INTO one_location_recipient_keys (
                user_id, key_id, public_key_jwk, public_key_fingerprint, algorithm,
                status, created_at, updated_at, metadata, encrypted_private_key_jwk
              )
              SELECT
                :user_id, :key_id, CAST(:public_key_jwk AS JSONB), :fingerprint,
                :algorithm, 'active', NOW(), NOW(), '{}'::jsonb,
                CAST(:encrypted_private_key_jwk AS JSONB)
              FROM key_id_compatibility
              WHERE compatible
              ON CONFLICT (user_id, key_id) DO UPDATE SET
                public_key_jwk = EXCLUDED.public_key_jwk,
                public_key_fingerprint = EXCLUDED.public_key_fingerprint,
                algorithm = EXCLUDED.algorithm,
                status = 'active',
                revoked_at = NULL,
                updated_at = NOW(),
                encrypted_private_key_jwk = COALESCE(
                  EXCLUDED.encrypted_private_key_jwk,
                  one_location_recipient_keys.encrypted_private_key_jwk
                )
              RETURNING
                user_id, key_id, public_key_jwk, algorithm,
                created_at AS key_created_at, TRUE AS phone_verified
            ),
            revoked_grant_events AS (
              INSERT INTO one_location_events (
                owner_user_id, actor_user_id, recipient_user_id, grant_id,
                event_type, metadata, created_at
              )
              SELECT
                g.owner_user_id, :user_id, g.recipient_user_id, g.id,
                'location_share_revoked',
                jsonb_build_object(
                  'reason', 'recipient_key_rotated',
                  'counterpart_label', COALESCE(
                    NULLIF(
                      (SELECT display_name FROM actor_identity_cache WHERE user_id = :user_id),
                      ''
                    ),
                    'A trusted person'
                  )
                ),
                NOW()
              FROM revoked_grants g
              RETURNING id
            ),
            registered_key_event AS (
              INSERT INTO one_location_events (
                owner_user_id, actor_user_id, recipient_user_id,
                event_type, metadata, created_at
              )
              SELECT
                k.user_id, k.user_id, k.user_id,
                'location_recipient_key_registered',
                jsonb_build_object(
                  'key_id', k.key_id,
                  'algorithm', k.algorithm,
                  'rotated_key_count', (SELECT COUNT(*) FROM rotated_keys),
                  'revoked_grant_count', (SELECT COUNT(*) FROM revoked_grants)
                ),
                NOW()
              FROM upserted_key k
              RETURNING id
            )
            SELECT k.*
            FROM upserted_key k
            CROSS JOIN (SELECT COUNT(*) FROM revoked_grant_events) revoked_event_barrier
            CROSS JOIN (SELECT COUNT(*) FROM registered_key_event) registered_event_barrier
            """
        insert_params = {
            "user_id": user_id,
            "key_id": normalized_key_id,
            "public_key_jwk": json.dumps(public_key_jwk, sort_keys=True, separators=(",", ":")),
            "fingerprint": fingerprint,
            "algorithm": algorithm,
            "encrypted_private_key_jwk": encrypted_private_key_json,
        }
        try:
            row = self._execute_recipient_key_registration(
                recipient_key_lock_key=f"one-location-recipient-key:{user_id}",
                mutation_sql=mutation_sql,
                params=insert_params,
            )
        except Exception as exc:
            # Self-heal the specific `encrypted_private_key_jwk` migration drift
            # (migration 083 not yet applied) once, then retry. Any other DB
            # error propagates unchanged. The retry is bounded: it only fires
            # when the column was actually missing and we have not already
            # ensured it this process.
            if (
                _is_missing_encrypted_private_column(exc)
                and not OneLocationAgentService._recipient_encrypted_private_column_ensured
            ):
                logger.warning(
                    "one_location.recipient_key_column_missing_self_heal user=%s",
                    redact_log_field("user_id", user_id),
                )
                self._ensure_recipient_encrypted_private_column()
                row = self._execute_recipient_key_registration(
                    recipient_key_lock_key=f"one-location-recipient-key:{user_id}",
                    mutation_sql=mutation_sql,
                    params=insert_params,
                )
            else:
                raise
        if not row:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_KEY_ID_CONFLICT",
                "This secure key id is already bound to different key material.",
                status_code=409,
            )
        return self._recipient_payload(row) or {}

    def list_verified_recipients(
        self, *, owner_user_id: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        # A recipient is eligible through either the canonical two-way
        # connections graph or shared active named-Circle membership. Neither
        # relationship grants location access: the explicit encrypted grant
        # below remains the sole authority.
        #
        # This predicate must stay identical to the one the authority paths
        # enforce (`_resolve_location_peer_eligibility`,
        # `_lock_circle_share_eligibility`, and the atomic private-share SQL).
        # Offering someone the mutation will refuse produces a dead end the
        # user has no way to resolve, so the direct-connection branch requires
        # a non-`named_circle` origin here too: a pair whose only provenance is
        # a Circle qualifies through the Circle branch, and stops qualifying
        # the moment that Circle membership ends.
        rows = self._execute_many(
            """
            SELECT
              a.user_id, a.display_name, a.email, a.phone_number, a.phone_verified,
              k.key_id, k.public_key_jwk, k.algorithm, k.created_at AS key_created_at
            FROM actor_identity_cache a
            LEFT JOIN LATERAL (
              SELECT key_id, public_key_jwk, algorithm, created_at
              FROM one_location_recipient_keys
              WHERE user_id = a.user_id
                AND status = 'active'
              ORDER BY created_at DESC
              LIMIT 1
            ) k ON TRUE
            WHERE a.user_id <> :owner_user_id
              AND (
                EXISTS (
                  SELECT 1
                  FROM connections c
                  JOIN connection_origins origin
                    ON origin.connection_id = c.id
                   AND origin.status = 'active'
                   AND origin.origin_kind <> 'named_circle'
                  WHERE c.status = 'active'
                    AND (
                      (c.user_a_id = :owner_user_id AND c.user_b_id = a.user_id)
                      OR
                      (c.user_b_id = :owner_user_id AND c.user_a_id = a.user_id)
                    )
                )
                OR EXISTS (
                  SELECT 1
                  FROM one_location_circle_memberships mine
                  JOIN one_location_circle_memberships theirs
                    ON theirs.circle_id = mine.circle_id
                   AND theirs.user_id = a.user_id
                   AND theirs.status = 'active'
                  JOIN one_location_circles circle
                    ON circle.id = mine.circle_id
                   AND circle.status = 'active'
                  WHERE mine.user_id = :owner_user_id
                    AND mine.status = 'active'
                )
              )
            ORDER BY COALESCE(a.display_name, a.phone_number, a.user_id), a.user_id
            LIMIT :limit
            """,
            {"owner_user_id": owner_user_id, "limit": max(1, min(int(limit), 100))},
        )

        recipients = [payload for row in rows if (payload := self._recipient_payload(row))]
        return self._apply_kai_circle_recommendations(
            owner_user_id=owner_user_id,
            recipients=recipients,
        )

    def list_directory_candidates(
        self, *, owner_user_id: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        # Broad discovery directory for the Connections "find people" flow
        # (/connect search + name resolution). Distinct from
        # list_verified_recipients, which is intentionally scoped to the
        # connections graph for LOCATION sharing.
        #
        # A user is discoverable when ANY of the following holds:
        #   1. The owner has an active trusted_connections edge (owner -> person).
        #   2. They are phone-verified (the broad verified-actor directory).
        #   3. They are connected to the owner through the marketplace via an
        #      approved advisor<->investor relationship, AND are currently
        #      marketplace-discoverable.
        #
        # Privacy gate: a user who turned marketplace visibility OFF
        # (marketplace_public_profiles.is_discoverable = FALSE) disappears from
        # the directory too, UNLESS the owner has an explicit trusted edge.
        return self.search_directory_candidates(
            owner_user_id=owner_user_id,
            page=1,
            limit=limit,
        )["items"]

    def search_directory_candidates(
        self,
        *,
        owner_user_id: str,
        query: str = "",
        page: int = 1,
        limit: int = 20,
        candidate_user_id: str | None = None,
        audience: str = "all",
    ) -> dict[str, Any]:
        """Search the eligible Connect directory before pagination.

        ``audience`` splits the same eligible directory in two: ``"ria"`` keeps
        only people holding a capability-bearing RIA profile, ``"people"`` keeps
        only those who do not, and ``"all"`` (the default, and what every
        pre-existing caller gets) keeps both. It is applied HERE, in the same
        statement, for the same reason the matching is -- see below.

        This preserves the existing discovery policy while preventing callers
        from being limited by an in-memory first page.  The result remains a
        safe profile projection; it is not an all-account directory.

        Matching, ranking and ordering all happen HERE, in one statement, ahead
        of ``LIMIT``.  That placement is the contract, not an implementation
        detail: this used to match any substring (``LIKE '%n%'``) and leave the
        caller to narrow the result, so Connect asked for 8 rows for "n", got
        the 8 alphabetically-first names that merely CONTAIN an n -- Anand,
        Ankit, Arun -- and then discarded all 8 client-side because none of
        them START with n.  Nilesh and Nirmal existed and were real, and were
        several pages further into a result set nobody could reach.  A filter
        applied after ``LIMIT`` can only ever subtract from a page that was
        already chosen wrongly, so no caller-side rule could have fixed it.

        The order is: name-prefix matches first, then word-prefix matches, and
        A-Z (case-insensitively) within each tier.  Paging is therefore paging
        through one stable, fully-ranked list, and ``hasMore`` describes the
        same rows the reader is looking at.
        """
        page = max(1, int(page or 1))
        # Keep the legacy Ready People caller's 100-item ceiling intact. The
        # Connect API applies its narrower public page limit before it gets
        # here, so it cannot use this to request an unbounded directory.
        limit = max(1, min(int(limit or 20), 100))
        offset = (page - 1) * limit
        # Fold the typed query exactly the way the stored name is folded.
        #
        # Only one side of the comparison used to be folded. The statement
        # below rewrites a stored name's separators to spaces, so "O'Brien" is
        # matched as "o brien" -- but the query kept its punctuation, and
        # "o'brien%" cannot match "o brien". Typing a name the way it is
        # actually spelled returned nothing, and every apostrophe, hyphen and
        # initial did it: O'Brien, D'Souza, Jean-Luc, Smith-Jones, "K.R.".
        # Deleting the punctuation instead ("obrien") failed too, so the search
        # box looked broken for these names with no way to type around it.
        #
        # Fold first, then escape. "_" is on both lists -- a separator here and
        # a LIKE wildcard below -- and folding settles which one it is: the
        # stored side has already turned it into a space, so matching it as a
        # literal could only ever return nothing. Once folded it is a space, so
        # it reaches LIKE as a space and cannot act as a wildcard either.
        needle = (query or "").strip().lower().translate(_DIRECTORY_SEPARATOR_FOLD).strip()
        target = (candidate_user_id or "").strip() or None
        # An unrecognised audience widens to "all" rather than narrowing: a typo
        # in a caller must not silently hide people who are really there.
        requested_audience = (audience or "all").strip().lower()
        if requested_audience not in ("all", "people", "ria"):
            requested_audience = "all"
        # LIKE metacharacters in a typed name are literal characters, not
        # wildcards. Unescaped, a single "%" typed into Connect matches every
        # row in the directory, so the escape is what keeps the pattern
        # describing the name the person actually typed.
        #
        # "!" is the escape character rather than the conventional backslash on
        # purpose: a backslash would have to survive both Python's string
        # escaping and Postgres' standard_conforming_strings, and getting
        # either wrong degrades silently into a pattern that still runs.
        escaped_needle = needle.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        # Two patterns, because a directory search is answered in two tiers.
        #   name_prefix -- the name STARTS with what was typed. Typing "n" is
        #     an index request: every N person, A-Z. This is the tier the
        #     Connect screen exists to serve.
        #   word_prefix -- some later word starts with it, so "rashid" still
        #     finds "Abdul Rashid". An earlier version matched surnames with no
        #     ranking at all, which is why "r" felt random; here the tier is
        #     strictly below name_prefix, so a first-name hit always outranks a
        #     surname hit and the list never reads as shuffled.
        #
        # Both patterns are applied to a name that has been trimmed, lowered,
        # and had its separators folded to spaces (see the TRANSLATE in the
        # statement). Names are not stored tidily: " Nilesh" with a leading
        # space would fail a `n%` test and get demoted to the surname tier,
        # and "Abdul-Rashid" or "Abdul R." would put their second word behind
        # a character that `% r%` cannot see. Fold once, match once, and the
        # tier a person lands in is about their name rather than about the
        # punctuation someone typed into a profile field.
        name_prefix_pattern = f"{escaped_needle}%"
        word_prefix_pattern = f"% {escaped_needle}%"
        rows = self._execute_many(
            """
            SELECT
              a.user_id, a.display_name, a.email, a.phone_number, a.phone_verified,
              k.key_id, k.public_key_jwk, k.algorithm, k.created_at AS key_created_at
            FROM actor_identity_cache a
            LEFT JOIN LATERAL (
              SELECT key_id, public_key_jwk, algorithm, created_at
              FROM one_location_recipient_keys
              WHERE user_id = a.user_id
                AND status = 'active'
              ORDER BY created_at DESC
              LIMIT 1
            ) k ON TRUE
            WHERE a.user_id <> :owner_user_id
              AND (:candidate_user_id IS NULL OR a.user_id = :candidate_user_id)
              AND (
                EXISTS (
                  SELECT 1
                  FROM trusted_connections tc
                  WHERE tc.status = 'active'
                    AND tc.owner_user_id = :owner_user_id
                    AND tc.trusted_user_id = a.user_id
                )
                OR (
                  (
                    a.phone_verified = TRUE
                    OR EXISTS (
                      SELECT 1
                      FROM advisor_investor_relationships air
                      JOIN ria_profiles rp ON rp.id = air.ria_profile_id
                      JOIN relationship_share_grants share
                        ON share.relationship_id = air.id
                       AND share.grant_key = 'ria_active_picks_feed_v1'
                       AND share.status = 'active'
                       AND share.connection_scope_proposal_id IS NOT NULL
                      JOIN connection_scope_proposals proposal
                        ON proposal.id = share.connection_scope_proposal_id
                       AND proposal.status = 'active'
                       AND proposal.capability_key = 'ria_active_picks_feed_v1'
                      WHERE air.status = 'approved'
                        AND (
                          (air.investor_user_id = :owner_user_id AND rp.user_id = a.user_id)
                          OR (rp.user_id = :owner_user_id AND air.investor_user_id = a.user_id)
                        )
                    )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM marketplace_public_profiles mp
                    WHERE mp.user_id = a.user_id
                      AND mp.is_discoverable = FALSE
                  )
                )
              )
              AND (
                :query = ''
                OR TRANSLATE(LOWER(BTRIM(COALESCE(a.display_name, ''))), '-''._/,', '      ')
                     LIKE :name_prefix ESCAPE '!'
                OR TRANSLATE(LOWER(BTRIM(COALESCE(a.display_name, ''))), '-''._/,', '      ')
                     LIKE :word_prefix ESCAPE '!'
              )
              AND (
                :audience = 'all'
                OR (
                  :audience = 'ria'
                ) = EXISTS (
                  SELECT 1
                  FROM ria_profiles rp_audience
                  WHERE rp_audience.user_id = a.user_id
                    AND rp_audience.verification_status
                          IN ('active', 'verified', 'finra_verified')
                )
              )
            ORDER BY
              CASE
                WHEN :query = '' THEN 0
                WHEN TRANSLATE(LOWER(BTRIM(COALESCE(a.display_name, ''))), '-''._/,', '      ')
                       LIKE :name_prefix ESCAPE '!' THEN 0
                ELSE 1
              END,
              LOWER(COALESCE(NULLIF(BTRIM(a.display_name), ''), a.phone_number, a.user_id)),
              a.user_id
            LIMIT :fetch_limit OFFSET :offset
            """,
            {
                "owner_user_id": owner_user_id,
                "candidate_user_id": target,
                "query": needle,
                "name_prefix": name_prefix_pattern,
                "word_prefix": word_prefix_pattern,
                "audience": requested_audience,
                "fetch_limit": limit + 1,
                "offset": offset,
            },
        )
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        recipients = [payload for row in page_rows if (payload := self._recipient_payload(row))]
        items = self._apply_kai_circle_recommendations(
            owner_user_id=owner_user_id,
            recipients=recipients,
            # The SQL above already decided rank and A-Z, across the whole
            # matched set rather than this slice of it. Re-sorting here would
            # only ever shuffle one page against boundaries drawn by a
            # different ordering.
            preserve_order=True,
        )
        return {"items": items, "page": page, "hasMore": has_more}

    def is_directory_candidate(self, *, owner_user_id: str, candidate_user_id: str) -> bool:
        result = self.search_directory_candidates(
            owner_user_id=owner_user_id,
            candidate_user_id=candidate_user_id,
            page=1,
            limit=1,
        )
        return bool(result["items"])

    def _recipient_key_row(
        self,
        *,
        recipient_user_id: str,
        recipient_key_id: str | None = None,
        require_phone_verified: bool = True,
        unavailable_message: str | None = None,
    ) -> dict[str, Any]:
        row = self._execute_one(
            """
            SELECT
              a.user_id, a.display_name, a.phone_number, a.phone_verified,
              k.key_id, k.public_key_jwk, k.algorithm, k.created_at AS key_created_at
            FROM actor_identity_cache a
            JOIN one_location_recipient_keys k ON k.user_id = a.user_id
            WHERE a.user_id = :recipient_user_id
              AND (:require_phone_verified IS FALSE OR a.phone_verified = TRUE)
              AND k.status = 'active'
              AND (:recipient_key_id IS NULL OR k.key_id = :recipient_key_id)
            ORDER BY k.created_at DESC
            LIMIT 1
            """,
            {
                "recipient_user_id": recipient_user_id,
                "recipient_key_id": recipient_key_id,
                "require_phone_verified": require_phone_verified,
            },
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_UNAVAILABLE",
                unavailable_message
                or (
                    "They are in your One Network but their secure location key "
                    "isn't ready yet. Ask them to open One Location and unlock "
                    "their vault once, then try again."
                ),
                status_code=409,
            )
        return row

    def _mint_grant_capability_token(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        duration_hours: float,
    ) -> dict[str, str]:
        """Mint a signed HCT capability token for a device-to-device grant.

        The token is the cryptographic capability that authorizes the recipient
        device to read live-location ciphertext for this grant. Scope is
        cap.location.live.view; the agent identity binds the token to the
        recipient device principal. Expiry mirrors the grant duration so the
        capability and the row expire together.
        """
        expires_in_ms = max(1, int(round(duration_hours * 60 * 60 * 1000)))
        token = issue_token(
            user_id=UserID(owner_user_id),
            agent_id=AgentID(f"device:{recipient_user_id}"),
            scope=ConsentScope.CAP_LOCATION_LIVE_VIEW,
            expires_in_ms=expires_in_ms,
        )
        return {"token": token.token, "token_id": token.token}

    def _assert_grant_capability_token(self, grant_row: dict[str, Any]) -> None:
        """Cryptographically validate a grant's capability token before use.

        Older grants created before per-grant HCT minting carry no token in
        metadata; those fall back to the DB status/expiry checks already
        performed by the caller. When a token is present it must validate:
        signature, expiry, and cap.location.live.view scope. This makes the
        grant's authority a verifiable capability rather than a descriptive
        string column.
        """
        metadata = grant_row.get("metadata")
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except (TypeError, ValueError):
                metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}
        capability = metadata.get("capability_token")
        if not capability:
            return
        valid, reason, _token = validate_token(
            capability,
            expected_scope=LOCATION_GRANT_CONSENT_SCOPE,
        )
        if not valid:
            raise OneLocationAgentError(
                "LOCATION_GRANT_CAPABILITY_INVALID",
                "Location share capability is no longer valid.",
                status_code=403,
            )

    # `_is_active_connection` used to live here and answered a narrower
    # question than every caller needed: it recognized only a direct
    # (non-`named_circle`) connection origin. Once named Circles shipped, the
    # recipient picker legitimately offered Circle-only peers that this gate
    # then refused, so a share the product intends failed with "you can only
    # share with your connections". Location eligibility now has exactly one
    # definition — `_resolve_location_peer_eligibility` — and callers use it.
    def _resolve_location_peer_eligibility(
        self,
        *,
        owner_user_id: str,
        other_user_id: str,
        source_circle_id: str | None = None,
    ) -> tuple[bool, str | None]:
        cleaned_source_circle_id: str | None = None
        if source_circle_id is not None:
            try:
                cleaned_source_circle_id = str(UUID(str(source_circle_id)))
            except (TypeError, ValueError, AttributeError) as exc:
                raise OneLocationAgentError(
                    "LOCATION_CIRCLE_NOT_FOUND",
                    "Circle not found.",
                    status_code=404,
                ) from exc
        row = self._execute_one(
            """
            SELECT
              EXISTS (
                SELECT 1
                FROM connections connection
                JOIN connection_origins origin
                  ON origin.connection_id = connection.id
                 AND origin.status = 'active'
                 AND origin.origin_kind <> 'named_circle'
                WHERE connection.status = 'active'
                  AND :source_circle_id IS NULL
                  AND (
                    (
                      connection.user_a_id = :owner_user_id
                      AND connection.user_b_id = :other_user_id
                    )
                    OR
                    (
                      connection.user_b_id = :owner_user_id
                      AND connection.user_a_id = :other_user_id
                    )
                  )
              ) AS active_connection,
              (
                SELECT mine.circle_id::text
                FROM one_location_circle_memberships mine
                JOIN one_location_circle_memberships theirs
                  ON theirs.circle_id = mine.circle_id
                 AND theirs.user_id = :other_user_id
                 AND theirs.status = 'active'
                JOIN one_location_circles circle
                  ON circle.id = mine.circle_id
                 AND circle.status = 'active'
                WHERE mine.user_id = :owner_user_id
                  AND mine.status = 'active'
                  AND (
                    :source_circle_id IS NULL
                    OR mine.circle_id = CAST(:source_circle_id AS UUID)
                  )
                ORDER BY mine.joined_at, mine.circle_id
                LIMIT 1
              ) AS eligible_circle_id
            LIMIT 1
            """,
            {
                "owner_user_id": owner_user_id,
                "other_user_id": other_user_id,
                "source_circle_id": cleaned_source_circle_id,
            },
        )
        if not row:
            return False, None
        active_connection = bool(row.get("active_connection"))
        eligible_circle_id = str(row.get("eligible_circle_id") or "").strip() or None
        if cleaned_source_circle_id is not None:
            return eligible_circle_id == cleaned_source_circle_id, eligible_circle_id
        if active_connection:
            return True, None
        return eligible_circle_id is not None, eligible_circle_id

    def _is_location_peer_eligible(
        self,
        *,
        owner_user_id: str,
        other_user_id: str,
        source_circle_id: str | None = None,
    ) -> bool:
        eligible, _source_circle_id = self._resolve_location_peer_eligibility(
            owner_user_id=owner_user_id,
            other_user_id=other_user_id,
            source_circle_id=source_circle_id,
        )
        return eligible

    def _is_sms_contact(self, *, owner_user_id: str, contact_user_id: str) -> bool:
        """Fail closed when the selected-contact table is unavailable.

        Postgres is the authoritative membership store. A future Redis layer may
        cache this lookup, but it must preserve the same owner-scoped contract
        and fall back to Postgres without broadening the recipient set.
        """
        try:
            row = self._execute_one(
                """
                SELECT 1
                FROM one_location_sms_contacts
                WHERE owner_user_id = :owner_user_id
                  AND contact_user_id = :contact_user_id
                LIMIT 1
                """,
                {
                    "owner_user_id": owner_user_id,
                    "contact_user_id": contact_user_id,
                },
            )
        except Exception as exc:  # noqa: BLE001 - safety path must fail closed
            logger.warning(
                "one_location.sms_contact_lookup_failed owner=%s contact=%s error=%s",
                redact_log_field("owner_user_id", owner_user_id),
                redact_log_field("contact_user_id", contact_user_id),
                exc,
            )
            return False
        return row is not None

    def list_sms_contact_ids(self, *, owner_user_id: str) -> list[str]:
        rows = self._execute_many(
            """
            SELECT sms.contact_user_id
            FROM one_location_sms_contacts sms
            WHERE sms.owner_user_id = :owner_user_id
              AND EXISTS (
                SELECT 1 WHERE EXISTS (
                  SELECT 1
                  FROM connections c
                  JOIN connection_origins origin
                    ON origin.connection_id = c.id
                   AND origin.status = 'active'
                   AND origin.origin_kind <> 'named_circle'
                  WHERE c.status = 'active'
                    AND (
                      (c.user_a_id = :owner_user_id AND c.user_b_id = sms.contact_user_id)
                      OR
                      (c.user_b_id = :owner_user_id AND c.user_a_id = sms.contact_user_id)
                    )
                )
                OR EXISTS (
                  SELECT 1
                  FROM one_location_circle_memberships mine
                  JOIN one_location_circle_memberships theirs
                    ON theirs.circle_id = mine.circle_id
                   AND theirs.user_id = sms.contact_user_id
                   AND theirs.status = 'active'
                  JOIN one_location_circles circle
                    ON circle.id = mine.circle_id
                   AND circle.status = 'active'
                  WHERE mine.user_id = :owner_user_id
                    AND mine.status = 'active'
                )
              )
            ORDER BY sms.created_at, sms.contact_user_id
            """,
            {"owner_user_id": owner_user_id},
        )
        return [
            str(row.get("contact_user_id") or "")
            for row in rows
            if str(row.get("contact_user_id") or "").strip()
        ]

    def _add_sms_contact_with_locked_eligibility(
        self,
        *,
        owner_user_id: str,
        contact_user_id: str,
    ) -> None:
        """Atomically validate Circle eligibility and persist SMS selection."""
        try:
            with get_db().engine.begin() as conn:
                try:
                    self._lock_circle_share_eligibility(
                        conn,
                        owner_user_id=owner_user_id,
                        recipient_user_id=contact_user_id,
                        requested_circle_id=None,
                    )
                except OneLocationAgentError as exc:
                    if exc.code != "LOCATION_RECIPIENT_NOT_CONNECTED":
                        raise
                    raise OneLocationAgentError(
                        "LOCATION_SMS_CONTACT_NOT_CONNECTED",
                        LOCATION_SMS_CONTACT_NOT_ELIGIBLE_MESSAGE,
                        status_code=403,
                    ) from exc
                conn.execute(
                    text(
                        """
                        INSERT INTO one_location_sms_contacts (
                          owner_user_id, contact_user_id, created_at, updated_at
                        )
                        VALUES (:owner_user_id, :contact_user_id, NOW(), NOW())
                        ON CONFLICT (owner_user_id, contact_user_id) DO UPDATE
                        SET updated_at = one_location_sms_contacts.updated_at
                        """
                    ),
                    {
                        "owner_user_id": owner_user_id,
                        "contact_user_id": contact_user_id,
                    },
                )
        except OneLocationAgentError:
            raise
        except Exception as exc:
            logger.exception("one_location.sms_contact_transaction_failed")
            raise OneLocationAgentError(
                "LOCATION_SMS_CONTACT_UPDATE_FAILED",
                "Could not update SMS contacts.",
                status_code=500,
            ) from exc

    def add_sms_contact(self, *, owner_user_id: str, contact_user_id: str) -> list[str]:
        if owner_user_id == contact_user_id:
            raise OneLocationAgentError(
                "LOCATION_SMS_CONTACT_SELF",
                "Choose a different connection as an SMS contact.",
                status_code=422,
            )
        # Reject contacts that cannot actually decrypt a live-location envelope.
        self._recipient_key_row(
            recipient_user_id=contact_user_id,
            require_phone_verified=True,
            unavailable_message=(
                "This connection must finish Location setup before they can be "
                "added as an SMS contact."
            ),
        )
        self._add_sms_contact_with_locked_eligibility(
            owner_user_id=owner_user_id,
            contact_user_id=contact_user_id,
        )
        return self.list_sms_contact_ids(owner_user_id=owner_user_id)

    def remove_sms_contact(self, *, owner_user_id: str, contact_user_id: str) -> list[str]:
        self._execute_one(
            """
            DELETE FROM one_location_sms_contacts
            WHERE owner_user_id = :owner_user_id
              AND contact_user_id = :contact_user_id
            RETURNING contact_user_id
            """,
            {
                "owner_user_id": owner_user_id,
                "contact_user_id": contact_user_id,
            },
        )
        return self.list_sms_contact_ids(owner_user_id=owner_user_id)

    def _send_location_share_created_notification(
        self,
        *,
        grant: dict[str, Any],
        owner_user_id: str,
        recipient_user_id: str,
        duration: float | None,
        reason: str | None,
        resolved_kind: str,
    ) -> bool:
        """Notify the recipient. Returns False when they had no reachable device.

        Save My Soul surfaces this per recipient, so a sender is never shown a
        confident "SENT" for an alert that had nowhere to land.
        """
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_notification_label(owner_identity)
        share_message = _visible_share_message(reason)
        if resolved_kind == "sos":
            # Titled for what this actually is. It read "SMS · Save my soul",
            # but no SMS is sent anywhere in this flow -- this push IS the
            # alert. Naming a channel that does not exist tells a recipient
            # their phone will buzz by text when it will not.
            notification_title = "Save my Soul"
            notification_body = (
                f"{owner_label}: {share_message}"
                if share_message
                else (f"{owner_label} sent a Save My Soul alert and shared live location with you.")
            )
        elif resolved_kind == "drive_to":
            notification_title = "Drive shared"
            notification_body = f"{owner_label} started sharing their drive and live ETA with you."
        elif resolved_kind == "pick_me_up":
            notification_title = "Pickup requested"
            notification_body = (
                f"{owner_label}: {share_message}"
                if share_message
                else f"{owner_label} is requesting a pickup."
            )
        elif resolved_kind == "pickup_enroute":
            notification_title = "Drive shared"
            notification_body = f"{owner_label} started sharing their drive and live ETA with you."
        elif resolved_kind == "check_in":
            notification_title = "Check-in shared"
            notification_body = (
                f"{owner_label}: {share_message}"
                if share_message
                else f"{owner_label} checked in and shared their location with you."
            )
        else:
            notification_title = "Location shared"
            notification_body = f"{owner_label} shared location access with you."
        return self._send_metadata_notification(
            user_id=recipient_user_id,
            notification_type="location_share_created",
            title=notification_title,
            body=notification_body,
            notification_tag=f"one-location-share:{grant['id']}",
            request_url=_one_location_url(
                grantId=grant["id"],
                locationNotification="opened",
                section="shared",
            ),
            data={
                "grant_id": grant["id"],
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "duration_hours": str(duration) if duration is not None else "",
                "duration_mode": str(
                    grant.get("durationMode") or TIMED_LOCATION_SHARE_DURATION_MODE
                ),
                "expires_at": grant.get("expiresAt"),
                "share_kind": resolved_kind,
                **(
                    {
                        "notification_profile": "one_location_sms_emergency",
                        "notification_category": "ONE_LOCATION_SMS_EMERGENCY",
                    }
                    if resolved_kind == "sos"
                    else {}
                ),
                **({"share_message": share_message} if share_message else {}),
            },
        )

    def _lock_circle_share_eligibility(
        self,
        conn: Any,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        requested_circle_id: str | None,
    ) -> str | None:
        """Lock and revalidate a relationship before an authority mutation.

        Circle and membership locks deliberately follow the same order as
        membership removal: Circle first, memberships second. A share that
        wins the lock commits before removal, so removal revokes it; a removal
        that wins first makes the revalidation fail closed.
        """
        cleaned_circle_id: str | None = None
        if requested_circle_id is not None:
            try:
                cleaned_circle_id = str(UUID(str(requested_circle_id)))
            except (TypeError, ValueError, AttributeError) as exc:
                raise OneLocationAgentError(
                    "LOCATION_CIRCLE_NOT_FOUND",
                    "Circle not found.",
                    status_code=404,
                ) from exc

        if cleaned_circle_id is None:
            connection_row = (
                conn.execute(
                    text(
                        """
                        SELECT 1
                        FROM connections connection
                        JOIN connection_origins origin
                          ON origin.connection_id = connection.id
                         AND origin.status = 'active'
                         AND origin.origin_kind <> 'named_circle'
                        WHERE connection.status = 'active'
                          AND (
                            (
                              connection.user_a_id = :owner_user_id
                              AND connection.user_b_id = :recipient_user_id
                            )
                            OR
                            (
                              connection.user_b_id = :owner_user_id
                              AND connection.user_a_id = :recipient_user_id
                            )
                          )
                        LIMIT 1
                        FOR SHARE OF connection, origin
                        """
                    ),
                    {
                        "owner_user_id": owner_user_id,
                        "recipient_user_id": recipient_user_id,
                    },
                )
                .mappings()
                .first()
            )
            if connection_row:
                return None

            candidate_row = (
                conn.execute(
                    text(
                        """
                        SELECT mine.circle_id::text AS circle_id
                        FROM one_location_circle_memberships mine
                        JOIN one_location_circle_memberships theirs
                          ON theirs.circle_id = mine.circle_id
                         AND theirs.user_id = :recipient_user_id
                         AND theirs.status = 'active'
                        JOIN one_location_circles circle
                          ON circle.id = mine.circle_id
                         AND circle.status = 'active'
                        WHERE mine.user_id = :owner_user_id
                          AND mine.status = 'active'
                        ORDER BY mine.joined_at, mine.circle_id
                        LIMIT 1
                        """
                    ),
                    {
                        "owner_user_id": owner_user_id,
                        "recipient_user_id": recipient_user_id,
                    },
                )
                .mappings()
                .first()
            )
            cleaned_circle_id = (
                str(candidate_row.get("circle_id") or "").strip() if candidate_row else None
            )

        if not cleaned_circle_id:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_NOT_CONNECTED",
                LOCATION_PEER_NOT_ELIGIBLE_MESSAGE,
                status_code=403,
            )

        circle_row = (
            conn.execute(
                text(
                    """
                    SELECT id
                    FROM one_location_circles
                    WHERE id = CAST(:circle_id AS UUID)
                      AND status = 'active'
                    FOR SHARE
                    """
                ),
                {"circle_id": cleaned_circle_id},
            )
            .mappings()
            .first()
        )
        if not circle_row:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_NOT_CONNECTED",
                LOCATION_PEER_NOT_ELIGIBLE_MESSAGE,
                status_code=403,
            )

        membership_rows = (
            conn.execute(
                text(
                    """
                    SELECT user_id
                    FROM one_location_circle_memberships
                    WHERE circle_id = CAST(:circle_id AS UUID)
                      AND user_id IN (:owner_user_id, :recipient_user_id)
                      AND status = 'active'
                    ORDER BY user_id
                    FOR SHARE
                    """
                ),
                {
                    "circle_id": cleaned_circle_id,
                    "owner_user_id": owner_user_id,
                    "recipient_user_id": recipient_user_id,
                },
            )
            .mappings()
            .all()
        )
        locked_users = {str(row.get("user_id") or "").strip() for row in membership_rows}
        if locked_users != {owner_user_id, recipient_user_id}:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_NOT_CONNECTED",
                LOCATION_PEER_NOT_ELIGIBLE_MESSAGE,
                status_code=403,
            )
        return cleaned_circle_id

    def _create_enforced_grant_row(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        requested_circle_id: str | None,
        grant_params: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Atomically authorize and replace a relationship-backed grant."""
        try:
            with get_db().engine.begin() as conn:
                source_circle_id = self._lock_circle_share_eligibility(
                    conn,
                    owner_user_id=owner_user_id,
                    recipient_user_id=recipient_user_id,
                    requested_circle_id=requested_circle_id,
                )
                params = {
                    **grant_params,
                    "duration_mode": grant_params.get(
                        "duration_mode", TIMED_LOCATION_SHARE_DURATION_MODE
                    ),
                    "source_circle_id": source_circle_id,
                }
                # Replacement is scoped to ONE LANE, and there are exactly two
                # of them: the emergency lane (`share_kind == 'sos'`) and
                # everything else. An SOS grant must never supersede a normal
                # share, and a normal share must never supersede an SOS grant --
                # a person who shared their location for four hours and then
                # raised an SMS alert with the same person had the four-hour
                # share silently revoked at SEND time (#5506). This is two lanes,
                # NOT one lane per share kind: `drive_to`, `check_in`,
                # `pick_me_up` and plain `share` all sit in the non-emergency
                # lane together and go on replacing each other exactly as before.
                conn.execute(
                    text(
                        """
                        UPDATE one_location_share_grants
                        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                        WHERE owner_user_id = :owner_user_id
                          AND recipient_user_id = :recipient_user_id
                          AND status = 'active'"""  # nosec B608 - the lane predicate
                        # below is a module-level constant of static SQL text and the
                        # lane itself is BOUND as `:is_sos_lane`; nothing
                        # caller-supplied reaches this statement.
                        + _share_lane_match_sql()
                        + """
                        """
                    ),
                    params,
                )
                row = (
                    conn.execute(
                        text(
                            """
                            INSERT INTO one_location_share_grants (
                              owner_user_id, recipient_user_id, recipient_key_id, status,
                              consent_scope, capability_scopes, duration_hours, expires_at,
                              ceiling_expires_at, duration_mode, source_circle_id,
                              created_at, updated_at, metadata
                            )
                            VALUES (
                              :owner_user_id, :recipient_user_id, :recipient_key_id, 'active',
                              'cap.location.live.view', CAST(:capability_scopes AS JSONB),
                              :duration_hours, :expires_at, :ceiling_expires_at, :duration_mode,
                              CAST(:source_circle_id AS UUID), NOW(), NOW(),
                              CAST(:metadata_json AS JSONB)
                            )
                            RETURNING *,
                              :recipient_display_name AS recipient_display_name,
                              :recipient_phone_number AS recipient_phone_number
                            """
                        ),
                        params,
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    return None
                conn.execute(
                    text(
                        """
                        INSERT INTO one_location_events (
                          owner_user_id, actor_user_id, recipient_user_id,
                          grant_id, event_type, metadata, created_at
                        )
                        VALUES (
                          :owner_user_id, :owner_user_id, :recipient_user_id,
                          CAST(:grant_id AS UUID), 'location_share_created',
                          CAST(:event_metadata_json AS JSONB), NOW()
                        )
                        """
                    ),
                    {
                        **params,
                        "grant_id": str(row.get("id") or ""),
                        "event_metadata_json": _json_param(
                            {
                                "duration_hours": params["duration_hours"],
                                "duration_mode": params["duration_mode"],
                                "counterpart_label": str(
                                    params.get("recipient_display_name") or ""
                                ).strip()
                                or "A trusted person",
                            }
                        ),
                    },
                )
                return dict(row)
        except OneLocationAgentError:
            raise
        except Exception as exc:
            logger.exception("one_location.create_grant_transaction_failed")
            raise OneLocationAgentError(
                "LOCATION_GRANT_CREATE_FAILED",
                "Could not create the location share.",
                status_code=500,
            ) from exc

    def create_grant(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        recipient_key_id: str | None,
        duration_hours: float | None,
        duration_mode: str = TIMED_LOCATION_SHARE_DURATION_MODE,
        reason: str | None = None,
        share_kind: str | None = None,
        source_circle_id: str | None = None,
        require_recipient_phone_verified: bool = True,
        enforce_connection: bool = False,
        source: str | None = None,
        _key_writer_guarded: bool = False,
    ) -> dict[str, Any]:
        if owner_user_id == recipient_user_id:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_SELF",
                "Choose a different verified recipient.",
                status_code=422,
            )
        if not _key_writer_guarded:
            with self._key_bound_writer_guard(
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
            ):
                grant = self.create_grant(
                    owner_user_id=owner_user_id,
                    recipient_user_id=recipient_user_id,
                    recipient_key_id=recipient_key_id,
                    duration_hours=duration_hours,
                    duration_mode=duration_mode,
                    reason=reason,
                    share_kind=share_kind,
                    source_circle_id=source_circle_id,
                    require_recipient_phone_verified=require_recipient_phone_verified,
                    enforce_connection=enforce_connection,
                    source=source,
                    _key_writer_guarded=True,
                )
            resolved_kind = share_kind or _classify_share_kind(reason)

            if reason != "request_approved" and resolved_kind != "sos":
                self._send_location_share_created_notification(
                    grant=grant,
                    owner_user_id=owner_user_id,
                    recipient_user_id=recipient_user_id,
                    duration=_duration_metadata_value(grant.get("durationHours")),
                    reason=reason,
                    resolved_kind=resolved_kind,
                )
            return grant
        # The pre-check must use exactly the relationship the authoritative
        # mutation below (`_create_enforced_grant_row`) will re-validate under
        # lock: a direct connection OR shared active Circle membership. A
        # narrower gate here rejects Circle-only peers that the recipient
        # picker legitimately offers, which is a rejection the user cannot act
        # on.
        if enforce_connection and not self._is_location_peer_eligible(
            owner_user_id=owner_user_id,
            other_user_id=recipient_user_id,
            source_circle_id=source_circle_id,
        ):
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_NOT_CONNECTED",
                LOCATION_PEER_NOT_ELIGIBLE_MESSAGE,
                status_code=403,
            )
        resolved_kind = share_kind or _classify_share_kind(reason)
        duration, expires_at, resolved_duration_mode = _resolve_share_duration(
            duration_hours=duration_hours,
            duration_mode=duration_mode,
            share_kind=resolved_kind,
            now=_utcnow(),
        )
        if resolved_kind == "sos" and not self._is_sms_contact(
            owner_user_id=owner_user_id, contact_user_id=recipient_user_id
        ):
            raise OneLocationAgentError(
                "LOCATION_SMS_CONTACT_REQUIRED",
                "This person is not in your SMS contacts.",
                status_code=403,
            )
        recipient = self._recipient_key_row(
            recipient_user_id=recipient_user_id,
            recipient_key_id=recipient_key_id,
            require_phone_verified=require_recipient_phone_verified,
        )
        key_id = str(recipient.get("key_id") or "")
        capability = (
            self._mint_grant_capability_token(
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
                duration_hours=duration,
            )
            if duration is not None
            else None
        )
        metadata = {
            "reason": reason or "owner_approved",
            "share_kind": resolved_kind,
            "duration_mode": resolved_duration_mode,
            "capability_scope": LOCATION_GRANT_CONSENT_SCOPE,
        }
        if capability is not None:
            metadata["capability_token"] = capability["token"]
        # Which of the two replacement lanes this grant lands in. Bound into
        # BOTH write paths below -- the enforced transaction reads it out of
        # `grant_params`, the non-enforced branch binds it on its own revoke.
        is_sos_lane = _is_sos_lane(resolved_kind)
        grant_params = {
            "owner_user_id": owner_user_id,
            "recipient_user_id": recipient_user_id,
            "recipient_key_id": key_id,
            "is_sos_lane": is_sos_lane,
            "capability_scopes": _json_param(LOCATION_CAPABILITY_SCOPES),
            "duration_hours": duration,
            "expires_at": expires_at,
            # The owner is authorizing this expiry right now -- at creation
            # time the ceiling and the live expiry are the same moment. A
            # later self-serve shrink/regrow (shorten_grant) will move
            # expires_at without ever touching this.
            "ceiling_expires_at": expires_at,
            "duration_mode": resolved_duration_mode,
            "source_circle_id": source_circle_id,
            "metadata_json": _json_param(metadata),
            "recipient_display_name": recipient.get("display_name"),
            "recipient_phone_number": recipient.get("phone_number"),
        }
        if enforce_connection:
            row = self._create_enforced_grant_row(
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
                requested_circle_id=source_circle_id,
                grant_params=grant_params,
            )
        else:
            # Same two-lane replacement rule as the enforced path above: an
            # SOS grant never supersedes a normal share and vice versa, and the
            # split is `sos` vs everything-else rather than one lane per share
            # kind. This is the branch `approve_request` reaches (it calls
            # `create_grant` without `enforce_connection`), so approving a
            # plain access request must not tear down a live SOS share either.
            self._execute_many(
                """
                UPDATE one_location_share_grants
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE owner_user_id = :owner_user_id
                  AND recipient_user_id = :recipient_user_id
                  AND status = 'active'"""  # nosec B608 - the lane predicate below
                # is a module-level constant of static SQL text and the lane itself is
                # BOUND as `:is_sos_lane`; nothing caller-supplied reaches this
                # statement.
                + _share_lane_match_sql()
                + """
                RETURNING id
                """,
                {
                    "owner_user_id": owner_user_id,
                    "recipient_user_id": recipient_user_id,
                    "is_sos_lane": is_sos_lane,
                },
            )
            row = self._execute_one(
                """
                INSERT INTO one_location_share_grants (
                  owner_user_id, recipient_user_id, recipient_key_id, status,
                  consent_scope, capability_scopes, duration_hours, expires_at,
                  ceiling_expires_at, duration_mode, source_circle_id,
                  created_at, updated_at, metadata
                )
                VALUES (
                  :owner_user_id, :recipient_user_id, :recipient_key_id, 'active',
                  'cap.location.live.view', CAST(:capability_scopes AS JSONB),
                  :duration_hours, :expires_at, :ceiling_expires_at, :duration_mode,
                  CAST(:source_circle_id AS UUID), NOW(), NOW(),
                  CAST(:metadata_json AS JSONB)
                )
                RETURNING *,
                  :recipient_display_name AS recipient_display_name,
                  :recipient_phone_number AS recipient_phone_number
                """,
                grant_params,
            )
        grant = self._grant_payload(row)
        if not grant:
            raise OneLocationAgentError(
                "LOCATION_GRANT_CREATE_FAILED",
                "Could not create the location share.",
                status_code=500,
            )
        if not enforce_connection:
            recipient_label = str(recipient.get("display_name") or "").strip() or "A trusted person"
            self._insert_event(
                owner_user_id=owner_user_id,
                actor_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
                grant_id=grant["id"],
                event_type="location_share_created",
                metadata={
                    "duration_hours": _duration_metadata_value(duration),
                    "duration_mode": resolved_duration_mode,
                    "counterpart_label": recipient_label,
                    # Why this grant exists. The audit ledger keeps the row
                    # either way; the Feed fan-out trigger reads this to drop
                    # the duplicate. Approving a request already writes
                    # `location_access_approved` right after this call, and one
                    # tap that produces two Feed rows reads as two things
                    # happening. Same rule the notification below applies.
                    "reason": reason or "",
                },
            )
        # Request approval has its own richer notification immediately after
        # this call. Sending share-created as well produces two alerts for one
        # user action. SMS waits until its first encrypted envelope is durably
        # stored so a recipient is never told a location is available too early.
        if not _key_writer_guarded and reason != "request_approved" and resolved_kind != "sos":
            self._send_location_share_created_notification(
                grant=grant,
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
                duration=_duration_metadata_value(duration),
                reason=reason,
                resolved_kind=resolved_kind,
            )
        return grant

    def create_grant_with_initial_envelope(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        recipient_key_id: str | None,
        duration_hours: float | None,
        client_operation_id: str,
        confirmed_at: datetime | str,
        envelope: dict[str, Any],
        duration_mode: str = TIMED_LOCATION_SHARE_DURATION_MODE,
        reason: str | None = None,
        share_kind: str | None = None,
        source_circle_id: str | None = None,
        require_recipient_phone_verified: bool = True,
        enforce_connection: bool = False,
    ) -> dict[str, Any]:
        """Atomically replace a grant and persist its first ciphertext envelope.

        Deterministic IDs and an exact request fingerprint make retries safe
        after ambiguous network responses. A transaction-scoped advisory lock
        serializes replacements for the owner/recipient pair; the mutation then
        runs with a fresh Postgres snapshot. The notification is emitted only
        after the transaction has durably committed.
        """

        operation_id = str(client_operation_id or "").strip()
        if not operation_id or len(operation_id) > 160:
            raise OneLocationAgentError(
                "LOCATION_OPERATION_ID_INVALID",
                "A valid private-share operation id is required.",
                status_code=422,
            )
        if owner_user_id == recipient_user_id:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_SELF",
                "Choose a different verified recipient.",
                status_code=422,
            )
        key_id = str(recipient_key_id or "").strip()
        if not key_id:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_KEY_REQUIRED",
                "The approved recipient key is required.",
                status_code=422,
            )
        resolved_kind = share_kind or _classify_share_kind(reason)
        duration, expires_at, resolved_duration_mode = _resolve_share_duration(
            duration_hours=duration_hours,
            duration_mode=duration_mode,
            share_kind=resolved_kind,
            now=_utcnow(),
        )
        # Record which relationship authorized this share. When the caller names
        # a Circle it must be that Circle; otherwise a Circle-only peer still
        # gets its source Circle stamped, so revoking the Circle later revokes
        # the grant's provenance rather than leaving an unattributed share.
        grant_source_circle_id: str | None = None
        if enforce_connection:
            eligible, relationship_circle_id = self._resolve_location_peer_eligibility(
                owner_user_id=owner_user_id,
                other_user_id=recipient_user_id,
                source_circle_id=source_circle_id,
            )
            if not eligible:
                raise OneLocationAgentError(
                    "LOCATION_RECIPIENT_NOT_CONNECTED",
                    LOCATION_PEER_NOT_ELIGIBLE_MESSAGE,
                    status_code=403,
                )
            # On success this is the canonical UUID text of the Circle that
            # authorized the share (equal to the requested one when given), or
            # None when a direct connection authorized it.
            grant_source_circle_id = relationship_circle_id
        # Check-In notes are recipient information, not audit metadata. The web
        # client encrypts the note with the point; this fixed marker is the only
        # Check-In reason persisted or sent through notification metadata.
        stored_reason = _CHECK_IN_SHARE_REASON if resolved_kind == "check_in" else reason
        envelope_fields = _validated_envelope_fields(
            envelope,
            recipient_key_id=key_id,
            require_captured_at=True,
        )
        confirmed_at_value = _parse_datetime(
            confirmed_at,
            field_name="confirmedAt",
        )
        captured_at = envelope_fields["captured_at"]
        now = _utcnow()
        freshness_error = _private_share_freshness_error(
            captured_at=captured_at,
            confirmed_at=confirmed_at_value,
            now=now,
        )

        operation_fingerprint = _private_share_operation_fingerprint(
            recipient_user_id=recipient_user_id,
            recipient_key_id=key_id,
            duration_hours=duration,
            duration_mode=resolved_duration_mode,
            reason=stored_reason,
            share_kind=resolved_kind,
            confirmed_at=confirmed_at_value,
            envelope_fields=envelope_fields,
        )
        grant_id, envelope_id = _atomic_private_share_ids(
            owner_user_id=owner_user_id,
            recipient_user_id=recipient_user_id,
            client_operation_id=operation_id,
        )
        capability = (
            self._mint_grant_capability_token(
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
                duration_hours=duration,
            )
            if duration is not None
            else None
        )
        metadata = {
            "reason": stored_reason or "owner_approved",
            "share_kind": resolved_kind,
            "duration_mode": resolved_duration_mode,
            "capability_scope": LOCATION_GRANT_CONSENT_SCOPE,
            "client_operation_id": operation_id,
            "client_operation_fingerprint": operation_fingerprint,
            "confirmed_at": confirmed_at_value.isoformat(),
        }
        if capability is not None:
            metadata["capability_token"] = capability["token"]
        metadata_json = _json_param(metadata)
        row = self._execute_atomic_private_share(
            recipient_key_lock_key=f"one-location-recipient-key:{recipient_user_id}",
            pair_lock_key=f"one-location-grant:{owner_user_id}:{recipient_user_id}",
            mutation_sql="""
            WITH replayed_grant AS MATERIALIZED (
              SELECT g.*
              FROM one_location_share_grants g
              WHERE g.id = CAST(:grant_id AS UUID)
                AND g.owner_user_id = :owner_user_id
                AND g.recipient_user_id = :recipient_user_id
              LIMIT 1
            ),
            replayed_envelope AS MATERIALIZED (
              SELECT e.*
              FROM one_location_envelopes e
              JOIN replayed_grant g
                ON g.latest_envelope_id = e.id
               AND e.id = CAST(:envelope_id AS UUID)
              LIMIT 1
            ),
            eligible_recipient AS MATERIALIZED (
              SELECT
                a.user_id, a.display_name, a.phone_number, a.phone_verified,
                k.key_id
              FROM actor_identity_cache a
              JOIN one_location_recipient_keys k ON k.user_id = a.user_id
              WHERE a.user_id = :recipient_user_id
                AND k.key_id = :recipient_key_id
                AND k.status = 'active'
                AND (
                  CAST(:require_phone_verified AS BOOLEAN) IS FALSE
                  OR a.phone_verified = TRUE
                )
                AND CAST(:freshness_valid AS BOOLEAN) IS TRUE
                AND CAST(:confirmed_at AS TIMESTAMPTZ)
                  <= NOW() + INTERVAL '30 seconds'
                AND CAST(:captured_at AS TIMESTAMPTZ)
                  <= CAST(:confirmed_at AS TIMESTAMPTZ) + INTERVAL '30 seconds'
                AND CAST(:confirmed_at AS TIMESTAMPTZ)
                    - CAST(:captured_at AS TIMESTAMPTZ)
                  <= INTERVAL '60 seconds'
                AND NOW() - CAST(:confirmed_at AS TIMESTAMPTZ)
                  <= INTERVAL '10 minutes'
                -- Same relationship rule as `_resolve_location_peer_eligibility`
                -- and `_lock_circle_share_eligibility`: a direct (non-Circle)
                -- connection origin, or shared membership of an active named
                -- Circle. Re-evaluated inside this transaction so a membership
                -- removed after the pre-check still fails closed. An explicitly
                -- requested Circle narrows this to that Circle alone.
                AND (
                  CAST(:enforce_connection AS BOOLEAN) IS FALSE
                  OR (
                    CAST(:source_circle_id AS UUID) IS NULL
                    AND EXISTS (
                      SELECT 1
                      FROM connections c
                      JOIN connection_origins origin
                        ON origin.connection_id = c.id
                       AND origin.status = 'active'
                       AND origin.origin_kind <> 'named_circle'
                      WHERE c.status = 'active'
                        AND (
                          (
                            c.user_a_id = :owner_user_id
                            AND c.user_b_id = :recipient_user_id
                          )
                          OR (
                            c.user_a_id = :recipient_user_id
                            AND c.user_b_id = :owner_user_id
                          )
                        )
                    )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM one_location_circle_memberships mine
                    JOIN one_location_circle_memberships theirs
                      ON theirs.circle_id = mine.circle_id
                     AND theirs.user_id = :recipient_user_id
                     AND theirs.status = 'active'
                    JOIN one_location_circles circle
                      ON circle.id = mine.circle_id
                     AND circle.status = 'active'
                    WHERE mine.user_id = :owner_user_id
                      AND mine.status = 'active'
                      AND (
                        CAST(:source_circle_id AS UUID) IS NULL
                        OR mine.circle_id = CAST(:source_circle_id AS UUID)
                      )
                  )
                )
                AND (
                  CAST(:require_sms_contact AS BOOLEAN) IS FALSE
                  OR EXISTS (
                    SELECT 1
                    FROM one_location_sms_contacts sc
                    WHERE sc.owner_user_id = :owner_user_id
                      AND sc.contact_user_id = :recipient_user_id
                  )
                )
              LIMIT 1
            ),
            revoked_grants AS (
              -- Two-lane replacement, same invariant as the two non-atomic
              -- create paths: replacement is scoped to the emergency lane, so
              -- an SOS grant never supersedes a normal share and a normal share
              -- never supersedes an SOS grant. Two lanes (`sos` vs
              -- everything-else), NOT one lane per share kind.
              UPDATE one_location_share_grants g
              SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
              WHERE g.owner_user_id = :owner_user_id
                AND g.recipient_user_id = :recipient_user_id
                AND g.status = 'active'"""  # nosec B608 - the lane predicate below
            # is a module-level constant of static SQL text with a fixed alias
            # substituted, and the lane itself is BOUND as `:is_sos_lane`; nothing
            # caller-supplied reaches this statement.
            + _share_lane_match_sql("g")
            + """
                AND EXISTS (SELECT 1 FROM eligible_recipient)
                AND NOT EXISTS (SELECT 1 FROM replayed_grant)
              RETURNING g.id
            ),
            created_grant AS (
              INSERT INTO one_location_share_grants (
                id, owner_user_id, recipient_user_id, recipient_key_id,
                status, consent_scope, capability_scopes, duration_hours,
                expires_at, ceiling_expires_at, duration_mode, source_circle_id,
                created_at, updated_at, metadata
              )
              SELECT
                CAST(:grant_id AS UUID),
                :owner_user_id, :recipient_user_id, :recipient_key_id, 'active',
                'cap.location.live.view', CAST(:capability_scopes AS JSONB),
                :duration_hours, :expires_at, :expires_at, :duration_mode,
                CAST(:source_circle_id AS UUID), NOW(), NOW(),
                CAST(:metadata_json AS JSONB)
              FROM eligible_recipient
              CROSS JOIN (SELECT COUNT(*) FROM revoked_grants) revoke_barrier
              WHERE NOT EXISTS (SELECT 1 FROM replayed_grant)
              RETURNING *
            ),
            created_envelope AS (
              INSERT INTO one_location_envelopes (
                id, grant_id, owner_user_id, recipient_user_id,
                recipient_key_id, algorithm, ciphertext, iv,
                sender_ephemeral_public_key_jwk, captured_at, source_platform,
                publication_context, created_at, metadata
              )
              SELECT
                CAST(:envelope_id AS UUID),
                g.id, g.owner_user_id, g.recipient_user_id, g.recipient_key_id,
                :algorithm, :ciphertext, :iv, CAST(:sender_key AS JSONB),
                :captured_at, :source_platform, :publication_context, NOW(),
                CAST(:envelope_metadata_json AS JSONB)
              FROM created_grant g
              RETURNING *
            ),
            completed_grant AS (
              UPDATE one_location_share_grants g
              SET latest_envelope_id = e.id, updated_at = NOW()
              FROM created_envelope e
              WHERE g.id = e.grant_id
              RETURNING g.*
            ),
            created_grant_event AS (
              INSERT INTO one_location_events (
                owner_user_id, actor_user_id, recipient_user_id, grant_id,
                event_type, metadata, created_at
              )
              SELECT
                g.owner_user_id, g.owner_user_id, g.recipient_user_id, g.id,
                'location_share_created',
                jsonb_build_object(
                  'duration_hours', g.duration_hours,
                  'duration_mode', g.duration_mode,
                  'counterpart_label', COALESCE(NULLIF(e.display_name, ''), 'A trusted person')
                ),
                NOW()
              FROM completed_grant g
              CROSS JOIN eligible_recipient e
              RETURNING id
            ),
            created_envelope_event AS (
              INSERT INTO one_location_events (
                owner_user_id, actor_user_id, recipient_user_id, grant_id,
                envelope_id, event_type, metadata, created_at
              )
              SELECT
                e.owner_user_id, e.owner_user_id, e.recipient_user_id,
                e.grant_id, e.id, 'location_envelope_updated',
                jsonb_build_object(
                  'source_platform', e.source_platform,
                  'recipient_key_id', e.recipient_key_id
                ),
                NOW()
              FROM created_envelope e
              RETURNING id
            ),
            selected_grant AS (
              SELECT g.*, TRUE AS idempotent_replay
              FROM replayed_grant g
              WHERE EXISTS (SELECT 1 FROM replayed_envelope)
              UNION ALL
              SELECT g.*, FALSE AS idempotent_replay
              FROM completed_grant g
            ),
            selected_envelope AS (
              SELECT * FROM replayed_envelope
              UNION ALL
              SELECT * FROM created_envelope
            )
            SELECT
              (
                to_jsonb(g.*) - 'idempotent_replay'
                || jsonb_build_object(
                  'recipient_display_name', a.display_name,
                  'recipient_phone_number', a.phone_number
                )
              ) AS grant_row,
              to_jsonb(e.*) AS envelope_row,
              g.idempotent_replay,
              EXISTS (
                SELECT 1
                FROM one_location_recipient_keys active_key
                WHERE active_key.user_id = g.recipient_user_id
                  AND active_key.key_id = g.recipient_key_id
                  AND active_key.status = 'active'
              ) AS recipient_key_active
            FROM selected_grant g
            JOIN selected_envelope e ON e.grant_id = g.id
            LEFT JOIN actor_identity_cache a ON a.user_id = g.recipient_user_id
            LIMIT 1
            """,
            params={
                "grant_id": grant_id,
                "envelope_id": envelope_id,
                "owner_user_id": owner_user_id,
                "recipient_user_id": recipient_user_id,
                "recipient_key_id": key_id,
                "capability_scopes": _json_param(LOCATION_CAPABILITY_SCOPES),
                "duration_hours": duration,
                "duration_mode": resolved_duration_mode,
                "expires_at": expires_at,
                "metadata_json": metadata_json,
                "freshness_valid": freshness_error is None,
                "confirmed_at": confirmed_at_value,
                "require_phone_verified": require_recipient_phone_verified,
                "enforce_connection": enforce_connection,
                "source_circle_id": grant_source_circle_id,
                "require_sms_contact": resolved_kind == "sos",
                # The `revoked_grants` CTE above is lane-scoped. This dict is
                # built independently of `create_grant`'s, so a missing bind
                # here fails OPEN to the old kind-blind replacement.
                "is_sos_lane": _is_sos_lane(resolved_kind),
                "envelope_metadata_json": envelope_fields["metadata_json"],
                **{key: value for key, value in envelope_fields.items() if key != "metadata_json"},
            },
        )
        if not row:
            freshness_error = _private_share_freshness_error(
                captured_at=captured_at,
                confirmed_at=confirmed_at_value,
            )
            if freshness_error is not None:
                raise freshness_error
            if enforce_connection and not self._is_location_peer_eligible(
                owner_user_id=owner_user_id,
                other_user_id=recipient_user_id,
                source_circle_id=source_circle_id,
            ):
                raise OneLocationAgentError(
                    "LOCATION_RECIPIENT_NOT_CONNECTED",
                    LOCATION_PEER_NOT_ELIGIBLE_MESSAGE,
                    status_code=403,
                )
            if resolved_kind == "sos" and not self._is_sms_contact(
                owner_user_id=owner_user_id,
                contact_user_id=recipient_user_id,
            ):
                raise OneLocationAgentError(
                    "LOCATION_SMS_CONTACT_REQUIRED",
                    "This person is not in your SMS contacts.",
                    status_code=403,
                )
            self._recipient_key_row(
                recipient_user_id=recipient_user_id,
                recipient_key_id=key_id,
                require_phone_verified=require_recipient_phone_verified,
            )
            raise OneLocationAgentError(
                "LOCATION_ATOMIC_SHARE_FAILED",
                "Could not save the private location share.",
                status_code=500,
            )

        raw_grant = _loads_json(row.get("grant_row"))
        raw_envelope = _loads_json(row.get("envelope_row"))
        if not isinstance(raw_grant, dict) or not isinstance(raw_envelope, dict):
            raise OneLocationAgentError(
                "LOCATION_ATOMIC_SHARE_FAILED",
                "Could not read the saved private location share.",
                status_code=500,
            )
        stored_metadata = _loads_json(raw_grant.get("metadata"))
        stored_fingerprint = (
            str(stored_metadata.get("client_operation_fingerprint") or "")
            if isinstance(stored_metadata, dict)
            else ""
        )
        if stored_fingerprint != operation_fingerprint:
            raise OneLocationAgentError(
                "LOCATION_OPERATION_CONFLICT",
                "This private-share operation id was already used for different details.",
                status_code=409,
            )

        grant = self._grant_payload(raw_grant)
        envelope_payload = self._envelope_payload(raw_envelope)
        if not grant or not envelope_payload:
            raise OneLocationAgentError(
                "LOCATION_ATOMIC_SHARE_FAILED",
                "Could not read the saved private location share.",
                status_code=500,
            )
        if grant["status"] != "active":
            raise OneLocationAgentError(
                "LOCATION_OPERATION_FINALIZED",
                "This private location share is no longer active.",
                status_code=409,
            )
        if not bool(row.get("recipient_key_active")):
            raise OneLocationAgentError(
                "LOCATION_OPERATION_FINALIZED",
                "The recipient's secure location key changed. Review and share again.",
                status_code=409,
            )
        if _payload_expires_at_is_past(grant):
            # Expiry is lazily materialized elsewhere. Never report a stale
            # deterministic replay as active; normalize it before failing.
            self._expire_stale_grants(recipient_user_id)
            raise OneLocationAgentError(
                "LOCATION_OPERATION_FINALIZED",
                "This private location share has expired.",
                status_code=409,
            )

        idempotent_replay = bool(row.get("idempotent_replay"))
        if not idempotent_replay:
            self._send_location_share_created_notification(
                grant=grant,
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
                duration=duration,
                reason=stored_reason,
                resolved_kind=resolved_kind,
            )
        return {
            "grant": grant,
            "envelope": envelope_payload,
            "idempotentReplay": idempotent_replay,
        }

    def store_encrypted_envelope(
        self,
        *,
        owner_user_id: str,
        grant_id: str,
        envelope: dict[str, Any],
        _key_writer_guarded: bool = False,
    ) -> dict[str, Any]:
        # Reject malformed/plaintext metadata before performing any grant read.
        if _contains_plaintext_location_key(envelope.get("metadata")):
            raise OneLocationAgentError(
                "LOCATION_ENVELOPE_METADATA_INVALID",
                "Envelope metadata must not contain coordinates or map details.",
                status_code=422,
            )
        for field in ("ciphertext", "iv", "senderEphemeralPublicKeyJwk"):
            if not envelope.get(field):
                raise OneLocationAgentError(
                    "LOCATION_ENVELOPE_INVALID",
                    f"Encrypted envelope is missing {field}.",
                    status_code=422,
                )
        if not _key_writer_guarded:
            lock_target = self._execute_one(
                """
                SELECT recipient_user_id
                FROM one_location_share_grants
                WHERE id = CAST(:grant_id AS UUID)
                  AND owner_user_id = :owner_user_id
                LIMIT 1
                """,
                {"owner_user_id": owner_user_id, "grant_id": grant_id},
            )
            if not lock_target:
                raise OneLocationAgentError(
                    "LOCATION_GRANT_NOT_FOUND",
                    "Location share was not found.",
                    status_code=404,
                )
            recipient_user_id = str(lock_target.get("recipient_user_id") or "")
            with self._key_bound_writer_guard(
                owner_user_id=owner_user_id,
                recipient_user_id=recipient_user_id,
            ):
                envelope_payload = self.store_encrypted_envelope(
                    owner_user_id=owner_user_id,
                    grant_id=grant_id,
                    envelope=envelope,
                    _key_writer_guarded=True,
                )
            post_commit_notification = envelope_payload.pop(
                "_post_commit_notification",
                None,
            )
            if isinstance(post_commit_notification, dict):
                # Save My Soul notifies here rather than at grant creation, so
                # this is the only place that knows whether the alert reached a
                # device. Report it back instead of discarding it -- a sender
                # whose contact has notifications off would otherwise still see
                # a confident "SENT".
                envelope_payload["recipientAlerted"] = (
                    self._send_location_share_created_notification(
                        **post_commit_notification,
                    )
                )
            return envelope_payload
        grant_row = self._execute_one(
            """
            SELECT *
            FROM one_location_share_grants
            WHERE id = CAST(:grant_id AS UUID)
              AND owner_user_id = :owner_user_id
            LIMIT 1
            """,
            {"owner_user_id": owner_user_id, "grant_id": grant_id},
        )
        if not grant_row:
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_FOUND", "Location share was not found.", status_code=404
            )
        if str(grant_row.get("status") or "") != "active":
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_ACTIVE", "Location share is not active.", status_code=409
            )
        is_first_envelope = not bool(grant_row.get("latest_envelope_id"))
        if _grant_expires_at_is_past(grant_row):
            self._expire_stale_grants(owner_user_id)
            raise OneLocationAgentError(
                "LOCATION_GRANT_EXPIRED", "Location share has expired.", status_code=410
            )
        # Cryptographically verify the grant's HCT capability token (signature,
        # expiry, cap.location.live.view scope) before accepting ciphertext.
        # Grants minted before per-grant tokens fall back to the DB checks above.
        self._assert_grant_capability_token(grant_row)
        recipient_key_id = str(grant_row.get("recipient_key_id") or "")
        envelope_fields = _validated_envelope_fields(
            envelope,
            recipient_key_id=recipient_key_id,
        )
        row = self._execute_one(
            """
            INSERT INTO one_location_envelopes (
              grant_id, owner_user_id, recipient_user_id, recipient_key_id,
              algorithm, ciphertext, iv, sender_ephemeral_public_key_jwk,
              captured_at, source_platform, publication_context, created_at, metadata
            )
            VALUES (
              CAST(:grant_id AS UUID), :owner_user_id, :recipient_user_id, :recipient_key_id,
              :algorithm, :ciphertext, :iv, CAST(:sender_key AS JSONB),
              :captured_at, :source_platform, :publication_context, NOW(), CAST(:metadata_json AS JSONB)
            )
            RETURNING *
            """,
            {
                "grant_id": grant_id,
                "owner_user_id": owner_user_id,
                "recipient_user_id": str(grant_row.get("recipient_user_id") or ""),
                "recipient_key_id": recipient_key_id,
                **envelope_fields,
            },
        )
        envelope_payload = self._envelope_payload(row)
        if not envelope_payload:
            raise OneLocationAgentError(
                "LOCATION_ENVELOPE_STORE_FAILED",
                "Could not store the encrypted envelope.",
                status_code=500,
            )
        self._execute_one(
            """
            UPDATE one_location_share_grants
            SET latest_envelope_id = CAST(:envelope_id AS UUID), updated_at = NOW()
            WHERE id = CAST(:grant_id AS UUID)
            """,
            {"grant_id": grant_id, "envelope_id": envelope_payload["id"]},
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=envelope_payload["recipientUserId"],
            grant_id=grant_id,
            envelope_id=envelope_payload["id"],
            event_type="location_envelope_updated",
            metadata={
                "source_platform": envelope_payload["sourcePlatform"],
                "recipient_key_id": recipient_key_id,
            },
        )
        grant_metadata = _loads_json(grant_row.get("metadata"))
        if not isinstance(grant_metadata, dict):
            grant_metadata = {}
        stored_kind = str(grant_metadata.get("share_kind") or "")
        if stored_kind == "sos" and is_first_envelope:
            notification_args = {
                "grant": self._grant_payload(
                    {
                        **grant_row,
                        "latest_envelope_id": envelope_payload["id"],
                    }
                )
                or {"id": grant_id, "expiresAt": _iso(grant_row.get("expires_at"))},
                "owner_user_id": owner_user_id,
                "recipient_user_id": str(grant_row.get("recipient_user_id") or ""),
                "duration": float(grant_row.get("duration_hours") or 8),
                "reason": str(grant_metadata.get("reason") or "") or None,
                "resolved_kind": "sos",
            }
            if _key_writer_guarded:
                # Deferred: the caller sends it after the write commits and
                # records the outcome there.
                envelope_payload["_post_commit_notification"] = notification_args
            else:
                # Direct route path (POST .../envelopes), which is the one
                # runSosPanic drives. Record reachability so the sender can be
                # told which contacts the alert actually reached.
                envelope_payload["recipientAlerted"] = (
                    self._send_location_share_created_notification(**notification_args)
                )
        return envelope_payload

    def view_latest_envelope(
        self, *, recipient_user_id: str, grant_id: str, allow_empty: bool = False
    ) -> dict[str, Any]:
        self._expire_stale_grants(recipient_user_id)
        grant_row = self._execute_one(
            """
            SELECT
              g.*,
              owner.display_name AS owner_display_name,
              owner.phone_number AS owner_phone_number,
              EXISTS (
                SELECT 1
                FROM one_location_recipient_keys active_key
                WHERE active_key.user_id = g.recipient_user_id
                  AND active_key.key_id = g.recipient_key_id
                  AND active_key.status = 'active'
              ) AS recipient_key_active
            FROM one_location_share_grants g
            LEFT JOIN actor_identity_cache owner ON owner.user_id = g.owner_user_id
            WHERE g.id = CAST(:grant_id AS UUID)
              AND g.recipient_user_id = :recipient_user_id
            LIMIT 1
            """,
            {"recipient_user_id": recipient_user_id, "grant_id": grant_id},
        )
        if not grant_row:
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_FOUND", "No approved location share was found.", status_code=404
            )
        if str(grant_row.get("status") or "") != "active":
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_ACTIVE", "Location share is not active.", status_code=410
            )
        if not bool(grant_row.get("recipient_key_active")):
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_ACTIVE",
                "The secure recipient key changed. Ask the owner to share again.",
                status_code=410,
            )
        row = self._execute_one(
            """
            SELECT *
            FROM one_location_envelopes
            WHERE grant_id = CAST(:grant_id AS UUID)
              AND recipient_user_id = :recipient_user_id
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"recipient_user_id": recipient_user_id, "grant_id": grant_id},
        )
        if not row:
            # "The share is live, the owner just hasn't published a point yet"
            # is a normal state on the happy path — the recipient opens One the
            # moment they are granted access, before the owner's first GPS fix
            # lands. Callers that opt in get that as a success with a null
            # envelope so it never surfaces as a failed request; callers that
            # do not keep the original 404 contract they already branch on.
            if allow_empty:
                return {
                    "grant": self._grant_payload(grant_row),
                    "envelope": None,
                    "status": "awaiting_first_publish",
                }
            raise OneLocationAgentError(
                "LOCATION_ENVELOPE_MISSING",
                "The owner has not published an encrypted location envelope yet.",
                status_code=404,
            )
        self._insert_event(
            owner_user_id=str(grant_row.get("owner_user_id") or ""),
            actor_user_id=recipient_user_id,
            recipient_user_id=recipient_user_id,
            grant_id=grant_id,
            envelope_id=str(row.get("id") or "") or None,
            event_type="location_share_viewed",
            metadata={"status": "ciphertext_returned"},
        )
        return {
            "grant": self._grant_payload(grant_row),
            "envelope": self._envelope_payload(row),
            "status": "published",
        }

    def get_map_preferences(self, *, user_id: str) -> dict[str, Any]:
        """Return the caller's metadata-only Map visibility preference.

        Coordinates remain exclusively in the recipient-encrypted envelopes. A
        missing row is deliberately Ghost Mode so opening Map never makes a
        person discoverable.
        """
        row = self._execute_one(
            """
            SELECT presence_mode, renderer_consent_version, updated_at
            FROM one_location_map_preferences
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        return {
            "presenceMode": str((row or {}).get("presence_mode") or "ghost"),
            "rendererConsentVersion": str((row or {}).get("renderer_consent_version") or "")
            or None,
            "updatedAt": _iso((row or {}).get("updated_at")),
        }

    def update_map_preferences(
        self,
        *,
        user_id: str,
        presence_mode: str | None,
        renderer_consent_version: str | None,
    ) -> dict[str, Any]:
        if presence_mode is not None and presence_mode not in {"ghost", "foreground_private"}:
            raise OneLocationAgentError(
                "LOCATION_MAP_PRESENCE_INVALID",
                "Map presence mode is invalid.",
                status_code=422,
            )
        if renderer_consent_version is not None and len(renderer_consent_version) > 80:
            raise OneLocationAgentError(
                "LOCATION_MAP_CONSENT_INVALID",
                "Map renderer consent is invalid.",
                status_code=422,
            )
        row = self._execute_one(
            """
            INSERT INTO one_location_map_preferences (
              user_id, presence_mode, renderer_consent_version, created_at, updated_at
            ) VALUES (
              :user_id, COALESCE(:presence_mode, 'ghost'), :renderer_consent_version, NOW(), NOW()
            )
            ON CONFLICT (user_id) DO UPDATE SET
              presence_mode = COALESCE(:presence_mode, one_location_map_preferences.presence_mode),
              renderer_consent_version = COALESCE(:renderer_consent_version, one_location_map_preferences.renderer_consent_version),
              updated_at = NOW()
            RETURNING presence_mode, renderer_consent_version, updated_at
            """,
            {
                "user_id": user_id,
                "presence_mode": presence_mode,
                "renderer_consent_version": renderer_consent_version,
            },
        )
        return {
            "presenceMode": str((row or {}).get("presence_mode") or "ghost"),
            "rendererConsentVersion": str((row or {}).get("renderer_consent_version") or "")
            or None,
            "updatedAt": _iso((row or {}).get("updated_at")),
        }

    def list_map_state(self, *, user_id: str) -> dict[str, Any]:
        """Read active, freshly published private Map envelopes for the viewer.

        This query never expires grants, writes audit events, or returns raw
        coordinates. The browser/native renderer decrypts returned ciphertext
        only in its foreground memory.
        """
        # Retention, not freshness. The 90-second cut used to remove people from
        # the response entirely, so a sharer who locked their phone vanished
        # from the map with nothing said -- indistinguishable from having
        # stopped sharing. They are returned now with `capturedAt`, and the
        # renderer ages them: past the freshness window the pin goes grey and
        # carries a disconnected badge, which is a fact about their signal
        # rather than a claim about their intent.
        retention_seconds = _bounded_int_env(
            "ONE_LOCATION_MAP_RETENTION_SECONDS", 3600, 300, 86_400
        )
        # Still published to the client, and still means the same thing: how
        # recent a position has to be to count as live. It just no longer
        # decides who exists.
        freshness_seconds = _bounded_int_env("ONE_LOCATION_MAP_FRESHNESS_SECONDS", 90, 30, 300)
        rows = self._execute_many(
            """
            SELECT
              g.*, owner.display_name AS owner_display_name, owner.phone_number AS owner_phone_number,
              envelope.id AS map_envelope_id,
              envelope.grant_id AS map_envelope_grant_id,
              envelope.owner_user_id AS map_envelope_owner_user_id,
              envelope.recipient_user_id AS map_envelope_recipient_user_id,
              envelope.recipient_key_id AS map_envelope_recipient_key_id,
              envelope.algorithm AS map_envelope_algorithm,
              envelope.ciphertext AS map_envelope_ciphertext,
              envelope.iv AS map_envelope_iv,
              envelope.sender_ephemeral_public_key_jwk AS map_envelope_sender_key,
              envelope.captured_at AS map_envelope_captured_at,
              envelope.source_platform AS map_envelope_source_platform,
              envelope.publication_context AS map_envelope_publication_context,
              envelope.created_at AS map_envelope_created_at,
              envelope.metadata AS map_envelope_metadata
            FROM one_location_share_grants g
            -- Opt-in, and it stays opt-in.
            --
            -- `presence_mode` defaults to 'ghost', so appearing on somebody
            -- else's map is something the sharer has to choose. Widening this
            -- to "anyone who has not explicitly opted out" was considered and
            -- rejected: it would have made every existing sharer visible
            -- without asking them, which is not a default anyone gets to
            -- change on their behalf. The answer was to make the choice
            -- findable instead -- it now lives in Location settings rather
            -- than only behind a Ghost toggle on the map screen.
            JOIN one_location_map_preferences preference
              ON preference.user_id = g.owner_user_id
             AND preference.presence_mode = 'foreground_private'
            LEFT JOIN actor_identity_cache owner ON owner.user_id = g.owner_user_id
            JOIN LATERAL (
              SELECT *
              FROM one_location_envelopes candidate
              WHERE candidate.grant_id = g.id
                AND candidate.recipient_user_id = :user_id
                AND candidate.publication_context = 'foreground_map_visible'
                AND candidate.captured_at >= NOW() - make_interval(secs => :retention_seconds)
              ORDER BY candidate.captured_at DESC, candidate.created_at DESC
              LIMIT 1
            ) envelope ON TRUE
            WHERE g.recipient_user_id = :user_id
              AND g.status = 'active'
              AND (g.expires_at IS NULL OR g.expires_at > NOW())
            ORDER BY envelope.captured_at DESC
            LIMIT 100
            """,
            {"user_id": user_id, "retention_seconds": retention_seconds},
        )
        markers: list[dict[str, Any]] = []
        for row in rows:
            grant = self._grant_payload(row)
            envelope = {
                "id": str(row.get("map_envelope_id") or ""),
                "grantId": str(row.get("map_envelope_grant_id") or ""),
                "ownerUserId": str(row.get("map_envelope_owner_user_id") or ""),
                "recipientUserId": str(row.get("map_envelope_recipient_user_id") or ""),
                "recipientKeyId": str(row.get("map_envelope_recipient_key_id") or ""),
                "algorithm": str(row.get("map_envelope_algorithm") or "ECDH-P256-AES256-GCM"),
                "ciphertext": str(row.get("map_envelope_ciphertext") or ""),
                "iv": str(row.get("map_envelope_iv") or ""),
                "senderEphemeralPublicKeyJwk": _loads_json(row.get("map_envelope_sender_key")),
                "capturedAt": _iso(row.get("map_envelope_captured_at")),
                "sourcePlatform": str(row.get("map_envelope_source_platform") or "unknown"),
                "publicationContext": str(row.get("map_envelope_publication_context") or ""),
                "createdAt": _iso(row.get("map_envelope_created_at")),
                "metadata": _loads_json(row.get("map_envelope_metadata")) or {},
            }
            if grant and envelope:
                markers.append({"grant": grant, "envelope": envelope})
        return {
            "preferences": self.get_map_preferences(user_id=user_id),
            "freshnessSeconds": freshness_seconds,
            "markers": markers,
        }

    def _expire_public_invite(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row or str(row.get("status") or "") != "active":
            return row
        expires_at = _parse_datetime(row.get("expires_at"), field_name="expires_at")
        if expires_at > _utcnow():
            return row
        updated = self._execute_one(
            """
            UPDATE one_location_public_invites
            SET status = 'expired', updated_at = NOW()
            WHERE id = CAST(:invite_id AS UUID)
              AND status = 'active'
            RETURNING *
            """,
            {"invite_id": str(row.get("id") or "")},
        )
        return updated or {**row, "status": "expired"}

    @staticmethod
    def _project_expired(row: dict[str, Any] | None) -> dict[str, Any] | None:
        """Project wall-clock expiry for read models without mutating storage."""
        if not row or str(row.get("status") or "") != "active":
            return row
        return {**row, "status": "expired"} if _grant_expires_at_is_past(row) else row

    def _expire_circle_invite(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row or str(row.get("status") or "") != "active":
            return row
        expires_at = _parse_datetime(row.get("expires_at"), field_name="expires_at")
        if expires_at > _utcnow():
            return row
        updated = self._execute_one(
            """
            UPDATE one_location_circle_invites
            SET status = 'expired', updated_at = NOW()
            WHERE id = CAST(:invite_id AS UUID)
              AND status = 'active'
            RETURNING *
            """,
            {"invite_id": str(row.get("id") or "")},
        )
        return updated or {**row, "status": "expired"}

    def create_public_invite(
        self,
        *,
        owner_user_id: str,
        duration_hours: float,
        location_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not owner_user_id:
            raise OneLocationAgentError(
                "LOCATION_AUTH_REQUIRED", "A user is required.", status_code=401
            )
        try:
            duration = normalize_duration_hours(duration_hours)
        except ValueError as exc:
            raise OneLocationAgentError(
                "LOCATION_DURATION_INVALID",
                str(exc),
                status_code=422,
            ) from exc
        raw_token = secrets.token_urlsafe(32)
        token_hash = _hash_public_value(raw_token)
        expires_at = _utcnow() + timedelta(hours=duration)
        public_location = self._public_location_snapshot_payload(location_snapshot)
        metadata: dict[str, Any] = {}
        if public_location:
            metadata["publicLocation"] = public_location
        row = self._execute_one(
            """
            INSERT INTO one_location_public_invites (
              owner_user_id, public_code_hash, status, duration_hours,
              expires_at, created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :public_code_hash, 'active', :duration_hours,
              :expires_at, NOW(), NOW(), CAST(:metadata_json AS JSONB)
            )
            RETURNING *
            """,
            {
                "owner_user_id": owner_user_id,
                "public_code_hash": token_hash,
                "duration_hours": duration,
                "expires_at": expires_at,
                "metadata_json": _json_param_with_public_location(metadata),
            },
        )
        invite = self._public_invite_payload(row)
        if not invite:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_CREATE_FAILED",
                "Could not create the public request link.",
                status_code=500,
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            event_type="location_public_invite_created",
            metadata={
                "invite_id": invite["id"],
                "duration_hours": duration,
                "location_snapshot": "attached" if public_location else "none",
            },
        )
        return {
            "invite": invite,
            "publicToken": raw_token,
            "publicUrl": _public_invite_url(raw_token),
        }

    def _public_invite_row_for_token(self, *, public_token: str) -> dict[str, Any]:
        normalized_token = str(public_token or "").strip()
        if len(normalized_token) < 16:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_INVALID",
                "This request link is invalid.",
                status_code=404,
            )
        row = self._execute_one(
            """
            SELECT i.*
            FROM one_location_public_invites i
            WHERE i.public_code_hash = :public_code_hash
            LIMIT 1
            """,
            {"public_code_hash": _hash_public_value(normalized_token)},
        )
        row = self._expire_public_invite(row)
        if not row or str(row.get("status") or "") != "active":
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_NOT_ACTIVE",
                "This request link is no longer active.",
                status_code=410 if row else 404,
            )
        return row

    def resolve_public_invite(self, *, public_token: str) -> dict[str, Any]:
        row = self._public_invite_row_for_token(public_token=public_token)
        invite = self._public_invite_payload(row, public=True)
        result = {"invite": invite}
        metadata = _loads_json(row.get("metadata")) or {}
        public_location = metadata.get("publicLocation") if isinstance(metadata, dict) else None
        if isinstance(public_location, dict):
            result["publicLocation"] = self._public_location_snapshot_payload(public_location)
        return result

    def _check_public_submission_limits(
        self,
        *,
        invite_id: str,
        visitor_phone_hash: str,
        submitter_fingerprint_hash: str | None,
    ) -> None:
        row = (
            self._execute_one(
                """
            SELECT
              COUNT(*)::int AS total_submissions,
              COUNT(*) FILTER (
                WHERE visitor_phone_hash = :visitor_phone_hash
              )::int AS phone_submissions,
              COUNT(*) FILTER (
                WHERE visitor_phone_hash = :visitor_phone_hash
                  AND submitted_at >= NOW() - (:phone_window_minutes * INTERVAL '1 minute')
              )::int AS recent_phone_submissions,
              COUNT(*) FILTER (
                WHERE :submitter_fingerprint_hash IS NOT NULL
                  AND metadata->>'submitter_fingerprint_hash' = :submitter_fingerprint_hash
                  AND submitted_at >= NOW() - (:fingerprint_window_minutes * INTERVAL '1 minute')
              )::int AS recent_fingerprint_submissions
            FROM one_location_public_invite_submissions
            WHERE invite_id = CAST(:invite_id AS UUID)
            """,
                {
                    "invite_id": invite_id,
                    "visitor_phone_hash": visitor_phone_hash,
                    "submitter_fingerprint_hash": submitter_fingerprint_hash,
                    "phone_window_minutes": PUBLIC_INVITE_PHONE_THROTTLE_MINUTES,
                    "fingerprint_window_minutes": PUBLIC_INVITE_FINGERPRINT_THROTTLE_MINUTES,
                },
            )
            or {}
        )
        total_submissions = int(row.get("total_submissions") or 0)
        phone_submissions = int(row.get("phone_submissions") or 0)
        recent_phone_submissions = int(row.get("recent_phone_submissions") or 0)
        recent_fingerprint_submissions = int(row.get("recent_fingerprint_submissions") or 0)
        if total_submissions >= PUBLIC_INVITE_MAX_SUBMISSIONS_PER_TOKEN:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_SUBMISSION_LIMIT",
                "This request link has reached its submission limit.",
                status_code=429,
            )
        if (
            phone_submissions >= PUBLIC_INVITE_MAX_SUBMISSIONS_PER_PHONE
            or recent_phone_submissions >= PUBLIC_INVITE_MAX_SUBMISSIONS_PER_PHONE
        ):
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_ALREADY_SUBMITTED",
                "This phone number has already sent a request for this link.",
                status_code=429,
            )
        if (
            submitter_fingerprint_hash
            and recent_fingerprint_submissions
            >= PUBLIC_INVITE_MAX_SUBMISSIONS_PER_FINGERPRINT_WINDOW
        ):
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_THROTTLED",
                "Too many requests were sent recently. Try again later.",
                status_code=429,
            )

    def submit_public_invite_request(
        self,
        *,
        public_token: str,
        visitor_display_name: str,
        phone_number: str,
        message: str | None = None,
        submitter_fingerprint_hash: str | None = None,
    ) -> dict[str, Any]:
        invite_row = self._public_invite_row_for_token(public_token=public_token)
        invite = self._public_invite_payload(invite_row) or {}
        invite_metadata = _loads_json(invite_row.get("metadata")) or {}
        public_location = (
            invite_metadata.get("publicLocation") if isinstance(invite_metadata, dict) else None
        )
        has_public_location = isinstance(public_location, dict)
        display_name = str(visitor_display_name or "").strip()
        if len(display_name) < 2:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_VISITOR_NAME_REQUIRED",
                "Enter your name before requesting location access.",
                status_code=422,
            )
        phone_digits = _normalize_phone_digits(phone_number)
        if len(phone_digits) < 8 or len(phone_digits) > 15:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_VISITOR_PHONE_INVALID",
                "Enter a valid phone number before requesting location access.",
                status_code=422,
            )
        visitor_phone_hash = _hash_public_value(phone_digits)
        self._check_public_submission_limits(
            invite_id=str(invite_row.get("id") or ""),
            visitor_phone_hash=visitor_phone_hash,
            submitter_fingerprint_hash=submitter_fingerprint_hash,
        )
        message_value = (message or "").strip()[:500] or None
        owner_user_id = invite["ownerUserId"]
        matched_identity = self._identity_row_by_phone_digits(phone_digits)
        matched_user_id = str(matched_identity.get("user_id") or "") if matched_identity else None
        status_value = "approved" if has_public_location else "pending_identity"
        request: dict[str, Any] | None = None
        if matched_user_id == owner_user_id:
            matched_user_id = None
        if matched_user_id and not has_public_location:
            try:
                request = self.request_access(
                    requester_user_id=matched_user_id,
                    owner_user_id=owner_user_id,
                    message=message_value or f"Public request from {display_name}",
                    notify_owner=False,
                    require_requester_key_material=True,
                )
                status_value = "matched_request_pending"
            except OneLocationAgentError as exc:
                if exc.code != "LOCATION_RECIPIENT_UNAVAILABLE":
                    raise
                status_value = "identity_pending_key"
        row = self._execute_one(
            """
            INSERT INTO one_location_public_invite_submissions (
              invite_id, owner_user_id, visitor_display_name, visitor_phone_hash,
              visitor_phone_last4, matched_user_id, request_id, status, message,
              submitted_at, metadata
            )
            VALUES (
              CAST(:invite_id AS UUID), :owner_user_id, :visitor_display_name,
              :visitor_phone_hash, :visitor_phone_last4, :matched_user_id,
              CAST(:request_id AS UUID), :status, :message, NOW(),
              CAST(:metadata_json AS JSONB)
            )
            RETURNING *
            """,
            {
                "invite_id": invite["id"],
                "owner_user_id": owner_user_id,
                "visitor_display_name": display_name[:120],
                "visitor_phone_hash": visitor_phone_hash,
                "visitor_phone_last4": phone_digits[-4:],
                "matched_user_id": matched_user_id,
                "request_id": request["id"] if request else None,
                "status": status_value,
                "message": message_value,
                "metadata_json": _json_param(
                    {
                        "intake_only": not has_public_location,
                        "public_location_view": has_public_location,
                        "submitter_fingerprint_hash": submitter_fingerprint_hash,
                    }
                ),
            },
        )
        submission = self._public_submission_payload(row)
        if not submission:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_SUBMISSION_FAILED",
                "Could not send the public location request.",
                status_code=500,
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=matched_user_id,
            recipient_user_id=matched_user_id,
            request_id=request["id"] if request else None,
            event_type="location_public_invite_submitted",
            metadata={
                "invite_id": invite["id"],
                "submission_id": submission["id"],
                "matched": bool(matched_user_id),
                "request_created": bool(request),
                "intake_only": not has_public_location,
                "public_location_view": has_public_location,
            },
        )
        self._send_metadata_notification(
            user_id=owner_user_id,
            notification_type="location_public_invite_submitted",
            title="Public location viewed" if has_public_location else "Public location request",
            body=(
                f"{display_name[:80]} opened your public location link."
                if has_public_location
                else f"{display_name[:80]} requested location access from your link."
            ),
            notification_tag=f"one-location-public-request:{submission['id']}",
            request_url=_one_location_url(
                requestId=request["id"] if request else None,
                submissionId=submission["id"],
                section="public_responses",
            ),
            data={
                "submission_id": submission["id"],
                "invite_id": invite["id"],
                "request_id": request["id"] if request else None,
                "visitor_display_label": display_name[:80],
                "matched_user_id": matched_user_id,
                "status": status_value,
            },
        )
        result = {"submission": self._public_submission_payload(row, public=True)}
        if has_public_location:
            result["publicLocation"] = public_location
        return result

    def revoke_public_invite(self, *, owner_user_id: str, invite_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE one_location_public_invites
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:invite_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "invite_id": invite_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_NOT_FOUND",
                "Active public request link was not found.",
                status_code=404,
            )
        invite = self._public_invite_payload(row) or {}
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            event_type="location_public_invite_revoked",
            metadata={"invite_id": invite_id},
        )
        return invite

    def create_circle_invite(
        self,
        *,
        owner_user_id: str,
        duration_hours: float,
        message: str | None = None,
    ) -> dict[str, Any]:
        if not owner_user_id:
            raise OneLocationAgentError(
                "LOCATION_AUTH_REQUIRED", "A user is required.", status_code=401
            )
        try:
            duration = normalize_duration_hours(duration_hours)
        except ValueError as exc:
            raise OneLocationAgentError(
                "LOCATION_DURATION_INVALID",
                str(exc),
                status_code=422,
            ) from exc
        raw_token = secrets.token_urlsafe(32)
        token_hash = _hash_public_value(raw_token)
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_display_label(owner_identity)
        message_value = (message or "").strip()[:500] or None
        row = self._execute_one(
            """
            INSERT INTO one_location_circle_invites (
              owner_user_id, invite_code_hash, status, duration_hours,
              expires_at, message, created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :invite_code_hash, 'active', :duration_hours,
              :expires_at, :message, NOW(), NOW(), CAST(:metadata_json AS JSONB)
            )
            RETURNING *
            """,
            {
                "owner_user_id": owner_user_id,
                "invite_code_hash": token_hash,
                "duration_hours": duration,
                "expires_at": _utcnow() + timedelta(hours=duration),
                "message": message_value,
                "metadata_json": _json_param({"owner_safe_label": owner_label}),
            },
        )
        invite = self._circle_invite_payload(row)
        if not invite:
            raise OneLocationAgentError(
                "LOCATION_CIRCLE_INVITE_CREATE_FAILED",
                "Could not create the Invite to One link.",
                status_code=500,
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            event_type="location_circle_invite_created",
            metadata={"invite_id": invite["id"], "duration_hours": duration},
        )
        return {
            "invite": invite,
            "inviteToken": raw_token,
            "inviteUrl": _circle_invite_url(raw_token),
        }

    def _circle_invite_row_for_token(self, *, invite_token: str) -> dict[str, Any]:
        normalized_token = str(invite_token or "").strip()
        if len(normalized_token) < 16:
            raise OneLocationAgentError(
                "LOCATION_CIRCLE_INVITE_INVALID",
                "This Invite to One link is invalid.",
                status_code=404,
            )
        row = self._execute_one(
            """
            SELECT i.*
            FROM one_location_circle_invites i
            WHERE i.invite_code_hash = :invite_code_hash
            LIMIT 1
            """,
            {"invite_code_hash": _hash_public_value(normalized_token)},
        )
        row = self._expire_circle_invite(row)
        if not row or str(row.get("status") or "") != "active":
            raise OneLocationAgentError(
                "LOCATION_CIRCLE_INVITE_NOT_ACTIVE",
                "This Invite to One link is no longer active.",
                status_code=410 if row else 404,
            )
        return row

    def resolve_circle_invite(self, *, invite_token: str) -> dict[str, Any]:
        row = self._circle_invite_row_for_token(invite_token=invite_token)
        return {"invite": self._circle_invite_payload(row, public=True)}

    def claim_circle_invite(
        self,
        *,
        invite_token: str,
        claimant_user_id: str,
        message: str | None = None,
    ) -> dict[str, Any]:
        if not claimant_user_id:
            raise OneLocationAgentError(
                "LOCATION_AUTH_REQUIRED",
                "Sign in before accepting this Invite to One link.",
                status_code=401,
            )
        invite_row = self._circle_invite_row_for_token(invite_token=invite_token)
        owner_user_id = str(invite_row.get("owner_user_id") or "")
        if owner_user_id == claimant_user_id:
            raise OneLocationAgentError(
                "LOCATION_CIRCLE_INVITE_SELF",
                "Open One Location instead of accepting your own Invite to One link.",
                status_code=422,
            )
        invite_id = str(invite_row.get("id") or "")
        claimant_identity = self._identity_row(claimant_user_id)
        if not claimant_identity or not bool(claimant_identity.get("phone_verified")):
            raise OneLocationAgentError(
                "LOCATION_PHONE_VERIFICATION_REQUIRED",
                "Verify your phone number before joining One Network.",
                status_code=409,
            )
        owner_identity = self._identity_row(owner_user_id)
        # Claim the invite atomically BEFORE writing the trusted edge so that a
        # second claimant on an already-claimed invite is rejected without any
        # spurious trusted_connections row being inserted.
        row = self._execute_one(
            """
            UPDATE one_location_circle_invites
            SET status = 'claimed',
                claimed_by_user_id = :claimant_user_id,
                claimed_at = NOW(),
                updated_at = NOW()
            WHERE id = CAST(:invite_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {
                "invite_id": invite_id,
                "owner_user_id": owner_user_id,
                "claimant_user_id": claimant_user_id,
            },
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_CIRCLE_INVITE_NOT_ACTIVE",
                "This Invite to One link is no longer active.",
                status_code=410,
            )
        invite = self._circle_invite_payload(row) or {}
        connection_row = self._execute_one(
            """
            INSERT INTO trusted_connections (
              owner_user_id, trusted_user_id, status, source, resolved_via,
              created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :trusted_user_id, 'active', 'circle_invite', 'user_id',
              NOW(), NOW(), CAST(:metadata_json AS JSONB)
            )
            ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
              status = 'active',
              updated_at = NOW(),
              revoked_at = NULL,
              source = 'circle_invite'
            RETURNING id, owner_user_id, trusted_user_id, status, created_at, updated_at, revoked_at
            """,
            {
                "owner_user_id": claimant_user_id,
                "trusted_user_id": owner_user_id,
                "metadata_json": _json_param({"source": "invite_to_one", "invite_id": invite_id}),
            },
        )
        if not connection_row:
            raise OneLocationAgentError(
                "LOCATION_NETWORK_CONNECTION_FAILED",
                "Could not connect this One Network invite.",
                status_code=500,
            )
        # Build the response payload with correct inviter/invitee semantics:
        # inviterUserId = invite owner (who created the invite),
        # inviteeUserId = claimant (who accepted it).
        connection: dict[str, Any] = {
            "id": str(connection_row.get("id") or ""),
            "userAId": owner_user_id,
            "userBId": claimant_user_id,
            "inviterUserId": owner_user_id,
            "inviteeUserId": claimant_user_id,
            "inviteId": invite_id,
            "status": str(connection_row.get("status") or "active"),
            "connectedAt": _iso(connection_row.get("created_at")),
            "createdAt": _iso(connection_row.get("created_at")),
            "updatedAt": _iso(connection_row.get("updated_at")),
            "revokedAt": _iso(connection_row.get("revoked_at")),
        }
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=claimant_user_id,
            recipient_user_id=claimant_user_id,
            event_type="location_circle_invite_claimed",
            metadata={"invite_id": invite_id, "connection_id": connection["id"]},
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=claimant_user_id,
            recipient_user_id=claimant_user_id,
            event_type="location_one_network_joined",
            metadata={"invite_id": invite_id, "connection_id": connection["id"]},
        )
        claimant_label = _identity_notification_label(claimant_identity, fallback="Someone")
        owner_label = _identity_notification_label(owner_identity)
        self._send_metadata_notification(
            user_id=owner_user_id,
            notification_type="location_one_network_joined",
            title="Invite to One accepted",
            body=f"{claimant_label} joined your One Network.",
            notification_tag=f"one-location-network:{connection['id']}",
            request_url=_one_location_url(section="people"),
            data={
                "connection_id": connection["id"],
                "invite_id": invite_id,
                "invitee_user_id": claimant_user_id,
                "invitee_display_label": claimant_label,
            },
        )
        self._send_metadata_notification(
            user_id=claimant_user_id,
            notification_type="location_one_network_joined",
            title="You're connected on One",
            body=f"You and {owner_label} can now use One Location together.",
            notification_tag=f"one-location-network:{connection['id']}",
            request_url=_one_location_url(section="people"),
            data={
                "connection_id": connection["id"],
                "invite_id": invite_id,
                "inviter_user_id": owner_user_id,
                "inviter_display_label": owner_label,
            },
        )
        return {"invite": invite, "connection": connection}

    def revoke_circle_invite(self, *, owner_user_id: str, invite_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE one_location_circle_invites
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:invite_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "invite_id": invite_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_CIRCLE_INVITE_NOT_FOUND",
                "Active Invite to One link was not found.",
                status_code=404,
            )
        invite = self._circle_invite_payload(row) or {}
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            event_type="location_circle_invite_revoked",
            metadata={"invite_id": invite_id},
        )
        return invite

    def list_state(self, *, user_id: str) -> dict[str, Any]:
        # Resilience: one failing auxiliary section (e.g. schema drift on a
        # rarely-used table) must NOT 500 the whole endpoint. A 500 here cascades
        # into the consent-center contributor (which then returns empty buckets)
        # AND breaks the One Location page on every load. Each section below is
        # fetched by `_run_read_queries_parallel`, which gives every task the
        # same per-section degrade-to-`[]`-and-log resilience a sequential
        # `_safe_many` call gave it before, while running the 10 independent
        # reads concurrently instead of one cross-continent round trip at a
        # time -- this loop used to be most of why this endpoint was slow.
        read_only_state = str(
            os.getenv("ONE_LOCATION_READ_ONLY_STATE_ENABLED") or ""
        ).strip().lower() in {"1", "true", "yes", "on"}
        if not read_only_state:
            try:
                self._expire_stale_grants(user_id)
            except Exception as exc:  # noqa: BLE001 - compatibility housekeeping
                logger.warning(
                    "one_location.list_state.expire_stale_failed user=%s error=%s",
                    user_id,
                    exc,
                )
        try:
            recipients = self.list_verified_recipients(owner_user_id=user_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "one_location.list_state.recipients_failed user=%s error=%s",
                user_id,
                exc,
            )
            recipients = []
        circle_service = None
        try:
            from hushh_mcp.services.one_location_circle_service import (
                OneLocationCircleService,
            )

            circle_service = OneLocationCircleService()
            named_circles = circle_service.list_circles(user_id=user_id)
        except Exception as exc:  # noqa: BLE001 - additive schema rollout
            logger.warning(
                "one_location.list_state.named_circles_failed user=%s error=%s",
                redact_log_field("user_id", user_id),
                exc,
            )
            named_circles = []
        try:
            circle_member_invites = (
                circle_service or OneLocationCircleService()
            ).list_member_invites(
                user_id=user_id,
                direction="incoming",
                expire_stale=not read_only_state,
            )
        except Exception as exc:  # noqa: BLE001 - additive schema rollout
            logger.warning(
                "one_location.list_state.circle_member_invites_failed user=%s error=%s",
                redact_log_field("user_id", user_id),
                exc,
            )
            circle_member_invites = []
        # The caller's OWN active recipient key, including the opaque
        # vault-key-encrypted private blob. Scoped to this user_id and returned only
        # here (never in the `recipients` list shown to other users), so a device the
        # user signs into can recover the shared keypair after vault unlock.
        _sections = self._run_read_queries_parallel(
            [
                (
                    "owner_grants",
                    """
                    SELECT
                      g.*,
                      r.display_name AS recipient_display_name,
                      r.phone_number AS recipient_phone_number
                    FROM one_location_share_grants g
                    LEFT JOIN actor_identity_cache r ON r.user_id = g.recipient_user_id
                    WHERE g.owner_user_id = :user_id
                    ORDER BY g.created_at DESC
                    LIMIT 50
                    """,
                    {"user_id": user_id},
                ),
                (
                    "received_grants",
                    """
                    SELECT
                      g.*,
                      o.display_name AS owner_display_name,
                      o.phone_number AS owner_phone_number
                    FROM one_location_share_grants g
                    LEFT JOIN actor_identity_cache o ON o.user_id = g.owner_user_id
                    WHERE g.recipient_user_id = :user_id
                    ORDER BY g.created_at DESC
                    LIMIT 50
                    """,
                    {"user_id": user_id},
                ),
                (
                    "requests",
                    """
                    SELECT
                      req.*,
                      requester.display_name AS requester_display_name,
                      requester.phone_number AS requester_phone_number,
                      extended.expires_at AS extends_grant_expires_at
                    FROM one_location_access_requests req
                    LEFT JOIN actor_identity_cache requester ON requester.user_id = req.requester_user_id
                    -- The live share an extra-time ask is about. Joined here so both
                    -- sides can render "3 more hours on top of the 45 minutes left"
                    -- from the state they already load, with no per-row round trip.
                    LEFT JOIN one_location_share_grants extended ON extended.id = req.extends_grant_id
                    WHERE req.owner_user_id = :user_id OR req.requester_user_id = :user_id
                    ORDER BY req.requested_at DESC
                    LIMIT 50
                    """,
                    {"user_id": user_id},
                ),
                (
                    "referrals",
                    """
                    SELECT *
                    FROM one_location_referrals
                    WHERE owner_user_id = :user_id
                       OR referring_user_id = :user_id
                       OR referred_user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT 50
                    """,
                    {"user_id": user_id},
                ),
                (
                    "public_invites",
                    """
                    SELECT *
                    FROM one_location_public_invites
                    WHERE owner_user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT 20
                    """,
                    {"user_id": user_id},
                ),
                (
                    "circle_invites",
                    """
                    SELECT *
                    FROM one_location_circle_invites
                    WHERE owner_user_id = :user_id
                       OR claimed_by_user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT 20
                    """,
                    {"user_id": user_id},
                ),
                (
                    "network_connections",
                    """
                    SELECT id, owner_user_id, trusted_user_id, status, created_at, updated_at, revoked_at
                    FROM trusted_connections
                    WHERE status = 'active'
                      AND owner_user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT 50
                    """,
                    {"user_id": user_id},
                ),
                (
                    "sms_contacts",
                    """
                    SELECT sms.contact_user_id
                    FROM one_location_sms_contacts sms
                    WHERE sms.owner_user_id = :user_id
                      AND EXISTS (
                        SELECT 1 WHERE EXISTS (
                          SELECT 1
                          FROM connections c
                          WHERE c.status = 'active'
                            AND (
                              (c.user_a_id = :user_id AND c.user_b_id = sms.contact_user_id)
                              OR
                              (c.user_b_id = :user_id AND c.user_a_id = sms.contact_user_id)
                            )
                        )
                        OR EXISTS (
                          SELECT 1
                          FROM one_location_circle_memberships mine
                          JOIN one_location_circle_memberships theirs
                            ON theirs.circle_id = mine.circle_id
                           AND theirs.user_id = sms.contact_user_id
                           AND theirs.status = 'active'
                          JOIN one_location_circles circle
                            ON circle.id = mine.circle_id
                           AND circle.status = 'active'
                          WHERE mine.user_id = :user_id
                            AND mine.status = 'active'
                        )
                      )
                    ORDER BY sms.created_at, sms.contact_user_id
                    """,
                    {"user_id": user_id},
                ),
                (
                    "public_submissions",
                    """
                    SELECT
                      submission.*,
                      req.status AS request_status
                    FROM one_location_public_invite_submissions submission
                    LEFT JOIN one_location_access_requests req ON req.id = submission.request_id
                    WHERE submission.owner_user_id = :user_id
                       OR submission.matched_user_id = :user_id
                    ORDER BY submission.submitted_at DESC
                    LIMIT 50
                    """,
                    {"user_id": user_id},
                ),
                (
                    "my_recipient_key",
                    """
                    SELECT key_id, public_key_jwk, algorithm, encrypted_private_key_jwk,
                           created_at AS key_created_at
                    FROM one_location_recipient_keys
                    WHERE user_id = :user_id
                      AND status = 'active'
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    {"user_id": user_id},
                ),
            ]
        )
        owner_grants = _sections["owner_grants"]
        received_grants = _sections["received_grants"]
        requests = _sections["requests"]
        referrals = _sections["referrals"]
        public_invites = _sections["public_invites"]
        circle_invites = _sections["circle_invites"]
        network_connections = _sections["network_connections"]
        sms_contacts = _sections["sms_contacts"]
        public_submissions = _sections["public_submissions"]
        my_recipient_key_rows = _sections["my_recipient_key"]
        my_recipient_key = None
        if my_recipient_key_rows:
            _mrk = my_recipient_key_rows[0]
            my_recipient_key = {
                "keyId": str(_mrk.get("key_id") or "") or None,
                "publicKeyJwk": _loads_json(_mrk.get("public_key_jwk")),
                "keyAlgorithm": str(_mrk.get("algorithm") or "ECDH-P256-AES256-GCM"),
                "encryptedPrivateKeyJwk": _loads_json(_mrk.get("encrypted_private_key_jwk")),
                "keyRegisteredAt": _iso(_mrk.get("key_created_at")),
            }

        return {
            "recipients": recipients,
            "circles": named_circles,
            "myRecipientKey": my_recipient_key,
            "ownerGrants": [
                payload
                for row in owner_grants
                if (
                    payload := self._grant_payload(
                        self._project_expired(row) if read_only_state else row
                    )
                )
            ],
            "receivedGrants": [
                payload
                for row in received_grants
                if (
                    payload := self._grant_payload(
                        self._project_expired(row) if read_only_state else row
                    )
                )
            ],
            "requests": [payload for row in requests if (payload := self._request_payload(row))],
            "referrals": [payload for row in referrals if (payload := self._referral_payload(row))],
            "publicInvites": [
                payload
                for row in public_invites
                if (
                    payload := self._public_invite_payload(
                        self._project_expired(row)
                        if read_only_state
                        else self._expire_public_invite(row)
                    )
                )
            ],
            "circleInvites": [
                payload
                for row in circle_invites
                if (
                    payload := self._circle_invite_payload(
                        self._project_expired(row)
                        if read_only_state
                        else self._expire_circle_invite(row)
                    )
                )
            ],
            "circleMemberInvites": circle_member_invites,
            "networkConnections": [
                payload
                for row in network_connections
                if (payload := self._trusted_connection_as_network_payload(row))
            ],
            "smsContactUserIds": [
                str(row.get("contact_user_id") or "")
                for row in sms_contacts
                if str(row.get("contact_user_id") or "").strip()
            ],
            "publicInviteSubmissions": [
                payload
                for row in public_submissions
                if (payload := self._public_submission_payload(row))
            ],
            "capabilityScopes": LOCATION_CAPABILITY_SCOPES,
        }

    def revoke_grant(self, *, owner_user_id: str, grant_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE one_location_share_grants
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:grant_id AS UUID)
              AND (owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id)
              AND status = 'active'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "grant_id": grant_id},
        )
        if not row:
            existing_row = self._execute_one(
                """
                SELECT *
                FROM one_location_share_grants
                WHERE id = CAST(:grant_id AS UUID)
                  AND (owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id)
                LIMIT 1
                """,
                {"owner_user_id": owner_user_id, "grant_id": grant_id},
            )
            if existing_row:
                return self._grant_payload(existing_row) or {}
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_FOUND", "Location share was not found.", status_code=404
            )
        actor_is_owner = str(row.get("owner_user_id") or "") == owner_user_id
        recipient_user_id = str(row.get("recipient_user_id") or "") or None
        owner_identity = self._identity_row(str(row.get("owner_user_id") or owner_user_id))
        owner_label = _identity_notification_label(owner_identity)
        recipient_identity = self._identity_row(recipient_user_id or "")
        recipient_label = _identity_notification_label(recipient_identity)
        self._insert_event(
            owner_user_id=str(row.get("owner_user_id") or owner_user_id),
            actor_user_id=owner_user_id,
            recipient_user_id=recipient_user_id,
            grant_id=grant_id,
            event_type="location_share_revoked",
            metadata={
                "reason": "owner_revoke" if actor_is_owner else "recipient_revoke",
                "counterpart_label": recipient_label,
            },
        )
        notification_user_id = (
            recipient_user_id if actor_is_owner else str(row.get("owner_user_id") or "")
        )
        self._send_metadata_notification(
            user_id=notification_user_id,
            notification_type="location_share_revoked",
            title="Location access revoked",
            body=(
                f"{owner_label} removed your location access."
                if actor_is_owner
                else f"{recipient_label} stopped receiving your location share."
            ),
            notification_tag=f"one-location-revoked:{grant_id}",
            request_url=_one_location_url(
                grantId=grant_id, section="shared" if actor_is_owner else "people"
            ),
            data={
                "grant_id": grant_id,
                "owner_user_id": str(row.get("owner_user_id") or owner_user_id),
                "owner_display_label": owner_label,
                "recipient_user_id": recipient_user_id,
                "recipient_display_label": recipient_label,
            },
        )
        return self._grant_payload(row) or {}

    def shorten_grant(
        self, *, caller_user_id: str, grant_id: str, duration_hours: float
    ) -> dict[str, Any]:
        """Move a grant's expiry anywhere the owner already authorized. Either side may do this.

        The owner already agreed to be seen up to `ceiling_expires_at` --
        moving the live expiry to anything at or under that ceiling, in
        either direction, needs no fresh consent from the other party: a
        decrease is a partial early revoke, and a later increase back toward
        the ceiling is just returning to what was already agreed, not asking
        for anything new. Only a candidate PAST the ceiling grows how long
        the recipient can see the owner, which is the owner's consent to
        give again, not something either side can hand themselves through
        this endpoint -- that goes through request_access instead, and the
        owner approves it like any other request (which also mints a fresh
        ceiling for the grant it produces).

        A grant with no known ceiling (an until_stopped share, or a row from
        before the ceiling existed) falls back to the live `expires_at` as
        its own bound, which reproduces this endpoint's original shorten-only
        behavior exactly.
        """
        row = self._execute_one(
            """
            SELECT id, owner_user_id, recipient_user_id, expires_at,
                   ceiling_expires_at, status
            FROM one_location_share_grants
            WHERE id = CAST(:grant_id AS UUID)
              AND (owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id)
            LIMIT 1
            """,
            {"grant_id": grant_id, "owner_user_id": caller_user_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_FOUND", "Location share was not found.", status_code=404
            )
        if str(row.get("status") or "") != "active":
            return self._grant_payload(row) or {}

        try:
            duration = normalize_duration_hours(duration_hours)
        except ValueError as exc:
            raise OneLocationAgentError(
                "LOCATION_DURATION_INVALID",
                str(exc),
                status_code=422,
            ) from exc
        candidate_expires_at = datetime.now(timezone.utc) + timedelta(hours=duration)
        current_expires_at = row.get("expires_at")
        ceiling_expires_at = row.get("ceiling_expires_at")
        # No ceiling on record -- fall back to the live expiry, which is
        # exactly the original shorten-only bound this endpoint had before
        # ceilings existed.
        bound = ceiling_expires_at if ceiling_expires_at is not None else current_expires_at
        if bound is not None:
            if bound.tzinfo is None:
                bound = bound.replace(tzinfo=timezone.utc)
            if candidate_expires_at > bound:
                raise OneLocationAgentError(
                    "LOCATION_GRANT_SHORTEN_ONLY",
                    "This can only move within what was already approved.",
                    status_code=422,
                )

        updated = self._execute_one(
            """
            UPDATE one_location_share_grants
            SET duration_mode = 'timed',
                duration_hours = :duration_hours,
                expires_at = :new_expires_at,
                updated_at = NOW()
            WHERE id = CAST(:grant_id AS UUID)
              AND (owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id)
              AND status = 'active'
              -- Re-checked atomically against whatever the row's bound is
              -- RIGHT NOW, not the possibly-stale value read above -- closes
              -- the window where a concurrent set_grant_duration lowers the
              -- ceiling between this function's read and this write.
              AND :new_expires_at <= COALESCE(ceiling_expires_at, expires_at)
            RETURNING *
            """,
            {
                "grant_id": grant_id,
                "owner_user_id": caller_user_id,
                "duration_hours": duration,
                "new_expires_at": candidate_expires_at,
            },
        )
        if not updated:
            # Revoked, or raced past a since-lowered ceiling, between the
            # read above and this write -- report the grant as it now
            # stands rather than raising on a race.
            existing_row = self._execute_one(
                """
                SELECT * FROM one_location_share_grants
                WHERE id = CAST(:grant_id AS UUID)
                LIMIT 1
                """,
                {"grant_id": grant_id},
            )
            return self._grant_payload(existing_row) or {}

        actor_is_owner = str(row.get("owner_user_id") or "") == caller_user_id
        recipient_user_id = str(row.get("recipient_user_id") or "") or None
        owner_identity = self._identity_row(str(row.get("owner_user_id") or caller_user_id))
        owner_label = _identity_notification_label(owner_identity)
        recipient_identity = self._identity_row(recipient_user_id or "")
        recipient_label = _identity_notification_label(recipient_identity)
        # Which way this particular call moved the expiry -- shrinking to 15
        # min and then regrowing to 30 (still under the ceiling) is a real
        # increase, and must not be reported to either party as a shorten.
        direction = _share_duration_change_direction(
            previous_expires_at=current_expires_at,
            new_expires_at=candidate_expires_at,
            new_mode="timed",
        )
        grew = direction == "extended"
        self._insert_event(
            owner_user_id=str(row.get("owner_user_id") or caller_user_id),
            actor_user_id=caller_user_id,
            recipient_user_id=recipient_user_id,
            grant_id=grant_id,
            event_type="location_share_shortened",
            metadata={
                "reason": "owner_shorten" if actor_is_owner else "recipient_shorten",
                "direction": direction,
                "counterpart_label": recipient_label,
            },
        )
        notification_user_id = (
            recipient_user_id if actor_is_owner else str(row.get("owner_user_id") or "")
        )
        if grew:
            notification_title = "Location access time changed"
            notification_body = (
                f"{owner_label} adjusted the shared time, within what was already approved."
                if actor_is_owner
                else f"{recipient_label} adjusted their viewing time, within what you already approved."
            )
        else:
            notification_title = "Location access shortened"
            notification_body = (
                f"{owner_label} shortened your location access."
                if actor_is_owner
                else f"{recipient_label} gave back some of their remaining time early."
            )
        self._send_metadata_notification(
            user_id=notification_user_id,
            notification_type="location_share_shortened",
            title=notification_title,
            body=notification_body,
            notification_tag=f"one-location-shortened:{grant_id}",
            request_url=_one_location_url(
                grantId=grant_id, section="shared" if actor_is_owner else "people"
            ),
            data={
                "grant_id": grant_id,
                "owner_user_id": str(row.get("owner_user_id") or caller_user_id),
                "owner_display_label": owner_label,
                "recipient_user_id": recipient_user_id,
                "recipient_display_label": recipient_label,
                "direction": direction,
            },
        )
        return self._grant_payload(updated) or {}

    def _active_grant_between(
        self, *, owner_user_id: str, recipient_user_id: str, is_sos_lane: bool | None
    ) -> dict[str, Any] | None:
        """The live share from owner to recipient IN ONE LANE, if there is one.

        A pair can now hold two live grants at once -- one normal share and one
        SOS -- so "the live share between these two people" is no longer a
        single well-defined row and this read must say which one it means.
        ``is_sos_lane`` is required for exactly that reason: left implicit, the
        ``ORDER BY created_at DESC`` below silently resolves to whichever grant
        was created most recently, which during an emergency is the SOS grant.

        Pass ``False`` for the normal-share lane, ``True`` for the emergency
        lane, or ``None`` to deliberately mean "either lane, newest wins" --
        which is the pre-#5506 behaviour and is almost never what a caller
        wants.
        """
        lane_predicate = "" if is_sos_lane is None else _share_lane_match_sql()
        return self._execute_one(
            """
            SELECT id, expires_at, duration_mode, duration_hours
            FROM one_location_share_grants
            WHERE owner_user_id = :owner_user_id
              AND recipient_user_id = :recipient_user_id
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())"""  # nosec B608 -
            # `lane_predicate` is either empty or a module-level constant of static
            # SQL text, and the lane itself is BOUND as `:is_sos_lane`; nothing
            # caller-supplied reaches this statement.
            + lane_predicate
            + """
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {
                "owner_user_id": owner_user_id,
                "recipient_user_id": recipient_user_id,
                "is_sos_lane": bool(is_sos_lane),
            },
        )

    def set_grant_duration(
        self,
        *,
        owner_user_id: str,
        grant_id: str,
        duration_hours: float | None,
        duration_mode: str = TIMED_LOCATION_SHARE_DURATION_MODE,
    ) -> dict[str, Any]:
        """Set a new end time on a share that is already running. Owner only.

        `shorten_grant` refuses to move an expiry later, and that refusal is
        right for the person being shared *with*: more of somebody else's
        location is not a thing you hand yourself. It was wrong for the person
        doing the sharing. Picking 30 minutes and then wanting 45 is the owner
        revising their own consent about their own location, and there is no
        second party whose approval is missing -- so the app offered Stop and
        nothing else, and "make it a bit longer" meant ending the share and
        starting a new one.

        The invariant is unchanged and now stated where it belongs: only the
        owner may lengthen, and only ever their own share. The row is mutated
        in place rather than revoked-and-recreated, because the grant id is
        what the recipient's subscription, the stored envelope, and the SOS
        teardown set are all keyed on -- replacing it to add fifteen minutes
        blanks the recipient's map and sends them a share-ended alert for a
        share that never ended.
        """
        row = self._execute_one(
            """
            SELECT id, owner_user_id, recipient_user_id, expires_at, status, metadata
            FROM one_location_share_grants
            WHERE id = CAST(:grant_id AS UUID)
              AND owner_user_id = :owner_user_id
            LIMIT 1
            """,
            {"grant_id": grant_id, "owner_user_id": owner_user_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_FOUND", "Location share was not found.", status_code=404
            )
        if str(row.get("status") or "") != "active":
            return self._grant_payload(row) or {}

        metadata = row.get("metadata")
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except (TypeError, ValueError):
                metadata = {}
        share_kind = str((metadata or {}).get("share_kind") or "") or "trusted"
        # Reuses the create path's rules verbatim: the same 15-minute floor and
        # 24-hour ceiling, and the same refusal to put an SOS or a check-in
        # share on "until I stop". A share must not become, by editing, a shape
        # it could never have been created in.
        duration, expires_at, resolved_mode = _resolve_share_duration(
            duration_hours=duration_hours,
            duration_mode=duration_mode,
            share_kind=share_kind,
            now=_utcnow(),
        )
        # Read before the write, not after. Which way the owner moved the end
        # time is a comparison against the expiry that is about to be replaced,
        # and holding the row is not the same as holding its value.
        previous_expires_at = row.get("expires_at")

        updated = self._execute_one(
            """
            UPDATE one_location_share_grants
            SET duration_mode = :duration_mode,
                duration_hours = :duration_hours,
                expires_at = :new_expires_at,
                -- The owner is re-authorizing this share right now, in
                -- whichever direction they moved it -- their explicit choice
                -- is the new ceiling a later self-serve shrink/regrow (via
                -- shorten_grant) can move freely within, same as at creation.
                ceiling_expires_at = :new_expires_at,
                updated_at = NOW()
            WHERE id = CAST(:grant_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {
                "grant_id": grant_id,
                "owner_user_id": owner_user_id,
                "duration_mode": resolved_mode,
                "duration_hours": duration,
                "new_expires_at": expires_at,
            },
        )
        if not updated:
            # Stopped between the read above and this write -- report the grant
            # as it now stands rather than raising on a race.
            existing_row = self._execute_one(
                """
                SELECT * FROM one_location_share_grants
                WHERE id = CAST(:grant_id AS UUID)
                LIMIT 1
                """,
                {"grant_id": grant_id},
            )
            return self._grant_payload(existing_row) or {}

        direction = _share_duration_change_direction(
            previous_expires_at=previous_expires_at,
            new_expires_at=expires_at,
            new_mode=resolved_mode,
        )
        recipient_user_id = str(row.get("recipient_user_id") or "") or None
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_notification_label(owner_identity)
        recipient_identity = self._identity_row(recipient_user_id or "")
        recipient_label = _identity_notification_label(recipient_identity)
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=recipient_user_id,
            grant_id=grant_id,
            event_type="location_share_duration_changed",
            metadata={
                "direction": direction,
                "duration_hours": _duration_metadata_value(duration),
                "duration_mode": resolved_mode,
                "counterpart_label": recipient_label,
            },
        )
        self._send_metadata_notification(
            user_id=recipient_user_id or "",
            notification_type="location_share_duration_changed",
            title="Sharing time changed",
            body=(
                f"{owner_label} is sharing until they stop."
                if direction == "until_stopped"
                else f"{owner_label} gave you more time."
                if direction == "extended"
                else f"{owner_label} shortened your location access."
            ),
            notification_tag=f"one-location-duration:{grant_id}",
            request_url=_one_location_url(grantId=grant_id, section="people"),
            data={
                "grant_id": grant_id,
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "recipient_user_id": recipient_user_id,
                "recipient_display_label": recipient_label,
            },
        )
        return self._grant_payload(updated) or {}

    def request_access(
        self,
        *,
        requester_user_id: str,
        owner_user_id: str,
        message: str | None = None,
        referred_by_user_id: str | None = None,
        notify_owner: bool = True,
        require_requester_key_material: bool = False,
        requested_duration_hours: float | None = None,
        requested_duration_mode: str | None = None,
        extends_grant_id: str | None = None,
    ) -> dict[str, Any]:
        """Ask an owner for location access -- optionally for a named duration.

        A request now carries the amount of time the requester actually wants,
        and, when they are already being shared with, the grant that time would
        be added to. Neither widens access by itself: this still writes nothing
        but a pending row, and only ``approve_request`` mints a grant. What they
        buy is that the owner is asked a question with a number in it, and the
        requester finds out which number they were given.

        When the requester is already inside a live share, the ask is an
        EXTENSION whether or not the caller says so -- detected from the grant,
        not from the client -- so an older client that only sends a duration
        still produces "asking for 3 hours more" rather than a second, confusing
        "asking to view your location" for a person who is already visible.
        """
        if requester_user_id == owner_user_id:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_SELF", "Request a different person's location.", status_code=422
            )
        if require_requester_key_material:
            self._recipient_key_row(
                recipient_user_id=requester_user_id,
                require_phone_verified=False,
            )
        message_value = (message or "").strip()[:500] or None
        duration_hours_value, duration_mode_value = _normalized_requested_duration(
            duration_hours=requested_duration_hours,
            duration_mode=requested_duration_mode,
        )

        # Resolve which live share (if any) this ask is about. A client-supplied
        # id is a hint that must be verified -- it is only honoured when the
        # grant really is this owner's live share with this requester, so a
        # crafted id cannot attach an ask to somebody else's grant. When it does
        # not check out we fall back to the real active grant rather than
        # failing: the person is asking for time either way.
        # Scoped to the NORMAL-SHARE lane on purpose. An access request is an
        # ask for ordinary visibility, and the only grant it can sensibly be an
        # extension of is the ordinary one. Unscoped, this read returns the
        # newest live grant -- so while the owner has an SOS share running with
        # this same person, a client correctly naming the share it wants
        # extended was silently redirected onto the SOS grant by the mismatch
        # fallback below, and `remaining_label` then quoted the SOS grant's
        # hours back at them. Nobody may extend an emergency share by asking.
        active_grant = self._active_grant_between(
            owner_user_id=owner_user_id,
            recipient_user_id=requester_user_id,
            is_sos_lane=False,
        )
        active_grant_id = str(active_grant.get("id") or "") if active_grant else ""
        requested_grant_id = str(extends_grant_id or "").strip()
        extends_grant_value = active_grant_id or None
        if requested_grant_id and requested_grant_id != active_grant_id:
            logger.info(
                "one.location.extend_request_grant_mismatch owner=%s",
                redact_log_field("user_id", owner_user_id),
            )
        remaining_label = _remaining_label(active_grant.get("expires_at")) if active_grant else ""
        is_extension = bool(extends_grant_value)

        row = self._execute_one(
            """
            SELECT *
            FROM one_location_access_requests
            WHERE owner_user_id = :owner_user_id
              AND requester_user_id = :requester_user_id
              AND status = 'pending'
              AND referred_by_user_id IS NOT DISTINCT FROM :referred_by_user_id
            ORDER BY requested_at DESC
            LIMIT 1
            """,
            {
                "owner_user_id": owner_user_id,
                "requester_user_id": requester_user_id,
                "referred_by_user_id": referred_by_user_id,
            },
        )
        if not row:
            row = self._execute_one(
                """
                INSERT INTO one_location_access_requests (
                  owner_user_id, requester_user_id, referred_by_user_id, status,
                  message, requested_at, metadata,
                  requested_duration_hours, requested_duration_mode, extends_grant_id,
                  request_revision
                )
                VALUES (
                  :owner_user_id, :requester_user_id, :referred_by_user_id, 'pending',
                  :message, NOW(), '{}'::jsonb,
                  :requested_duration_hours, :requested_duration_mode,
                  CAST(:extends_grant_id AS UUID), 1
                )
                RETURNING *
                """,
                {
                    "owner_user_id": owner_user_id,
                    "requester_user_id": requester_user_id,
                    "referred_by_user_id": referred_by_user_id,
                    "message": message_value,
                    "requested_duration_hours": duration_hours_value,
                    "requested_duration_mode": duration_mode_value,
                    "extends_grant_id": extends_grant_value,
                },
            )
        else:
            # A pending ask already exists. Asking again for a DIFFERENT amount
            # is a new question, not a duplicate: the row is updated in place
            # (one pending ask per pair stays the invariant) and its revision is
            # bumped so the owner's client treats the re-ask as a fresh event
            # instead of de-duplicating it against the number it already showed.
            existing_hours = (
                float(row["requested_duration_hours"])
                if row.get("requested_duration_hours") is not None
                else None
            )
            existing_mode = str(row.get("requested_duration_mode") or "") or None
            existing_grant = str(row.get("extends_grant_id") or "") or None
            existing_message = str(row.get("message") or "") or None
            ask_changed = (
                existing_hours != duration_hours_value
                or existing_mode != duration_mode_value
                or existing_grant != extends_grant_value
            )
            message_changed = bool(message_value) and existing_message != message_value
            if ask_changed or message_changed:
                refreshed = self._execute_one(
                    """
                    UPDATE one_location_access_requests
                    SET message = COALESCE(:message, message),
                        requested_duration_hours = :requested_duration_hours,
                        requested_duration_mode = :requested_duration_mode,
                        extends_grant_id = CAST(:extends_grant_id AS UUID),
                        request_revision = request_revision + CASE WHEN :ask_changed THEN 1 ELSE 0 END,
                        requested_at = NOW()
                    WHERE id = CAST(:request_id AS UUID)
                      AND status = 'pending'
                    RETURNING *
                    """,
                    {
                        "request_id": str(row.get("id") or ""),
                        "message": message_value,
                        "requested_duration_hours": duration_hours_value,
                        "requested_duration_mode": duration_mode_value,
                        "extends_grant_id": extends_grant_value,
                        "ask_changed": ask_changed,
                    },
                )
                row = refreshed or row
        request = self._request_payload(row)
        if not request:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_CREATE_FAILED",
                "Could not create the access request.",
                status_code=500,
            )
        # The joined column is absent on INSERT/UPDATE RETURNING, so fill the
        # live share's expiry from the grant we already read. Surfaces render
        # "3 more hours on top of the 45 minutes left" straight off the created
        # request, without waiting for the next state refresh.
        if is_extension and active_grant is not None:
            request["extendsGrantExpiresAt"] = _iso(active_grant.get("expires_at"))
        requester_identity = self._identity_row(requester_user_id)
        requester_label = _identity_notification_label(requester_identity, fallback="Someone")
        owner_label_for_feed = _identity_notification_label(self._identity_row(owner_user_id))
        ask_summary = _access_ask_summary(
            requested_duration_hours=request["requestedDurationHours"],
            requested_duration_mode=request["requestedDurationMode"],
            is_extension=is_extension,
            remaining_label=remaining_label,
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=requester_user_id,
            recipient_user_id=requester_user_id,
            request_id=request["id"],
            event_type="location_access_request",
            metadata={
                "referred": bool(referred_by_user_id),
                "counterpart_label": requester_label,
                # The feed fan-out writes this row to BOTH parties and swaps
                # counterpart_label for the requester's copy, so neither side
                # reads its own name back as the other person.
                "owner_label": owner_label_for_feed,
                # The feed reads these to say "Asked for 3 hours more" instead
                # of a subjectless "Requested your location".
                "requested_duration_hours": request["requestedDurationHours"],
                "requested_duration_mode": request["requestedDurationMode"],
                "is_extension": is_extension,
                "extends_grant_id": extends_grant_value,
                "request_revision": request["requestRevision"],
            },
        )
        if notify_owner:
            self._send_metadata_notification(
                user_id=owner_user_id,
                notification_type="location_access_request",
                title=(
                    "More location time requested" if is_extension else "Location access request"
                ),
                body=f"{requester_label} {ask_summary}",
                notification_tag=f"one-location-request:{request['id']}",
                request_url=_one_location_url(requestId=request["id"], section="approvals"),
                data={
                    "request_id": request["id"],
                    "requester_user_id": requester_user_id,
                    "requester_display_label": requester_label,
                    "referred_by_user_id": referred_by_user_id,
                    "requested_duration_hours": request["requestedDurationHours"],
                    "requested_duration_mode": request["requestedDurationMode"],
                    "is_extension": "true" if is_extension else None,
                    "extends_grant_id": extends_grant_value,
                    "extends_grant_expires_at": request.get("extendsGrantExpiresAt"),
                    # Distinguishes a re-ask from the ask the client already
                    # showed, so a raised number is never swallowed by the
                    # client's per-request notification de-dup.
                    "notification_revision": str(request["requestRevision"]),
                },
            )
        return request

    def approve_request(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        duration_hours: float | None,
        duration_mode: str | None = None,
    ) -> dict[str, Any]:
        """Grant the access that was asked for, defaulting to the amount asked.

        ``duration_hours``/``duration_mode`` left as ``None`` means "give them
        what they asked for" -- the owner approved a request that named a
        number, and re-deriving a different number from a control they never
        touched is how an approval used to silently hand out an hour to someone
        who had asked for four. An explicitly supplied duration still wins: the
        owner is always free to grant less (or more) than was asked, and the
        approve control sends one whenever they adjust it.
        """
        request_row = self._execute_one(
            """
            SELECT *
            FROM one_location_access_requests
            WHERE id = CAST(:request_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'pending'
            LIMIT 1
            """,
            {"owner_user_id": owner_user_id, "request_id": request_id},
        )
        if not request_row:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_NOT_FOUND",
                "Pending location access request was not found.",
                status_code=404,
            )
        requester_user_id = str(request_row.get("requester_user_id") or "")
        requested_hours, requested_mode = _normalized_requested_duration(
            duration_hours=request_row.get("requested_duration_hours"),
            duration_mode=request_row.get("requested_duration_mode"),
        )
        was_extension = bool(str(request_row.get("extends_grant_id") or "").strip())
        if duration_hours is None and duration_mode is None:
            resolved_mode = requested_mode or TIMED_LOCATION_SHARE_DURATION_MODE
            resolved_hours = (
                None
                if _is_until_stopped_share(resolved_mode)
                else (
                    requested_hours
                    if requested_hours is not None
                    else DEFAULT_APPROVAL_DURATION_HOURS
                )
            )
        else:
            resolved_mode = duration_mode or TIMED_LOCATION_SHARE_DURATION_MODE
            resolved_hours = None if _is_until_stopped_share(resolved_mode) else duration_hours
        grant = self.create_grant(
            owner_user_id=owner_user_id,
            recipient_user_id=requester_user_id,
            recipient_key_id=None,
            duration_hours=resolved_hours,
            duration_mode=resolved_mode,
            reason="request_approved",
            require_recipient_phone_verified=False,
        )
        resolved = self._execute_one(
            """
            UPDATE one_location_access_requests
            SET status = 'approved',
                resolved_at = NOW(),
                approved_grant_id = CAST(:grant_id AS UUID)
            WHERE id = CAST(:request_id AS UUID)
            RETURNING *
            """,
            {"request_id": request_id, "grant_id": grant["id"]},
        )
        requester_label = _identity_notification_label(self._identity_row(requester_user_id))
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_notification_label(owner_identity)
        granted_hours = _duration_metadata_value(grant.get("durationHours"))
        granted_mode = grant.get("durationMode") or TIMED_LOCATION_SHARE_DURATION_MODE
        granted_label = (
            "for as long as you need"
            if _is_until_stopped_share(str(granted_mode))
            else format_duration_label(granted_hours)
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=requester_user_id,
            grant_id=grant["id"],
            request_id=request_id,
            event_type="location_access_approved",
            metadata={
                "duration_hours": granted_hours,
                "duration_mode": granted_mode,
                "counterpart_label": requester_label,
                # Swapped in for the requester's copy of this feed row, so they
                # read the owner's name rather than their own.
                "owner_label": owner_label,
                # Kept so the feed can say "You gave them 3 more hours" rather
                # than reporting an extension as a brand-new share.
                "is_extension": was_extension,
                "requested_duration_hours": requested_hours,
                "requested_duration_mode": requested_mode,
            },
        )
        if granted_label and was_extension:
            approved_body = f"{owner_label} gave you {granted_label} more of their live location."
        elif granted_label:
            approved_body = f"{owner_label} shared their live location with you {granted_label}."
        else:
            approved_body = f"{owner_label} approved your location request."
        self._send_metadata_notification(
            user_id=requester_user_id,
            notification_type="location_access_approved",
            title=("More location time approved" if was_extension else "Location request approved"),
            body=approved_body,
            notification_tag=f"one-location-approved:{request_id}",
            request_url=_one_location_url(
                requestId=request_id,
                grantId=grant["id"],
                locationNotification="opened",
                section="shared",
            ),
            data={
                "request_id": request_id,
                "grant_id": grant["id"],
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "duration_hours": granted_hours,
                "duration_mode": granted_mode,
                "expires_at": grant.get("expiresAt"),
                "is_extension": "true" if was_extension else None,
            },
        )
        return {"request": self._request_payload(resolved), "grant": grant}

    def deny_request(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE one_location_access_requests
            SET status = 'denied', resolved_at = NOW()
            WHERE id = CAST(:request_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'pending'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "request_id": request_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_NOT_FOUND",
                "Pending location access request was not found.",
                status_code=404,
            )
        requester_user_id = str(row.get("requester_user_id") or "") or None
        requester_label = _identity_notification_label(self._identity_row(requester_user_id or ""))
        # Which ask was refused. Someone who asked for an hour, then for four,
        # and is refused, is otherwise told only "denied" -- with no way to know
        # whether they still hold the time they already had.
        denied_hours, denied_mode = _normalized_requested_duration(
            duration_hours=row.get("requested_duration_hours"),
            duration_mode=row.get("requested_duration_mode"),
        )
        was_extension = bool(str(row.get("extends_grant_id") or "").strip())
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_notification_label(owner_identity)
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=requester_user_id,
            request_id=request_id,
            event_type="location_access_denied",
            metadata={
                "counterpart_label": requester_label,
                "owner_label": owner_label,
                "requested_duration_hours": denied_hours,
                "requested_duration_mode": denied_mode,
                "is_extension": was_extension,
            },
        )
        self._send_metadata_notification(
            user_id=str(row.get("requester_user_id") or ""),
            notification_type="location_access_denied",
            title=("Extra time declined" if was_extension else "Location request denied"),
            body=(
                f"{owner_label} declined the extra time. Any access you already have is unchanged."
                if was_extension
                else f"{owner_label} denied your location request."
            ),
            notification_tag=f"one-location-denied:{request_id}",
            request_url=_one_location_url(requestId=request_id, section="my_requests"),
            data={
                "request_id": request_id,
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "requested_duration_hours": denied_hours,
                "requested_duration_mode": denied_mode,
                "is_extension": "true" if was_extension else None,
            },
        )
        return self._request_payload(row) or {}

    def withdraw_request(self, *, requester_user_id: str, request_id: str) -> dict[str, Any]:
        """The asker takes back their own pending request.

        Approve and deny are the owner's verbs and both are keyed on
        ``owner_user_id``. This one is keyed on ``requester_user_id`` instead,
        which is the whole safety property: it can only ever end a request the
        caller themselves sent, and it can never touch a request sent TO them.
        Ending an ask you received is still ``deny_request``.

        Only ``pending`` moves. An approved request has already produced a
        grant, and taking the ask back would not take the access back -- that
        is ``revoke_grant``, a different act on a different object. A request
        already denied or already withdrawn has nothing left to end, so a
        second call is a 404 rather than a silent success.
        """
        row = self._execute_one(
            """
            UPDATE one_location_access_requests
            SET status = 'cancelled', resolved_at = NOW()
            WHERE id = CAST(:request_id AS UUID)
              AND requester_user_id = :requester_user_id
              AND status = 'pending'
            RETURNING *
            """,
            {"requester_user_id": requester_user_id, "request_id": request_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_NOT_FOUND",
                "Pending location access request was not found.",
                status_code=404,
            )
        owner_user_id = str(row.get("owner_user_id") or "")
        requester_label = _identity_notification_label(
            self._identity_row(requester_user_id), fallback="Someone"
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=requester_user_id,
            recipient_user_id=requester_user_id,
            request_id=request_id,
            event_type="location_access_request_withdrawn",
            metadata={"counterpart_label": requester_label},
        )
        # Same notification tag as the original ask, so on the owner's device
        # this REPLACES "X is asking to view your location" instead of stacking
        # a second card under it. Leaving the first one in the tray is how
        # somebody taps through to approve a request that no longer exists.
        self._send_metadata_notification(
            user_id=owner_user_id,
            notification_type="location_access_request_withdrawn",
            title="Location request taken back",
            body=f"{requester_label} took back their location request.",
            notification_tag=f"one-location-request:{request_id}",
            request_url=_one_location_url(requestId=request_id, section="approvals"),
            data={
                "request_id": request_id,
                "requester_user_id": requester_user_id,
                "requester_display_label": requester_label,
            },
        )
        return self._request_payload(row) or {}

    def refer_recipient(
        self,
        *,
        referring_user_id: str,
        grant_id: str,
        referred_user_id: str,
        message: str | None = None,
    ) -> dict[str, Any]:
        grant = self._execute_one(
            """
            SELECT *
            FROM one_location_share_grants
            WHERE id = CAST(:grant_id AS UUID)
              AND recipient_user_id = :referring_user_id
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
            """,
            {"grant_id": grant_id, "referring_user_id": referring_user_id},
        )
        if not grant:
            raise OneLocationAgentError(
                "LOCATION_REFERRAL_NOT_ALLOWED",
                "Only an active approved recipient can refer another verified user.",
                status_code=403,
            )
        owner_user_id = str(grant.get("owner_user_id") or "")
        request = self.request_access(
            requester_user_id=referred_user_id,
            owner_user_id=owner_user_id,
            message=message,
            referred_by_user_id=referring_user_id,
        )
        referral = self._execute_one(
            """
            INSERT INTO one_location_referrals (
              grant_id, owner_user_id, referring_user_id, referred_user_id,
              request_id, status, created_at, metadata
            )
            VALUES (
              CAST(:grant_id AS UUID), :owner_user_id, :referring_user_id,
              :referred_user_id, CAST(:request_id AS UUID),
              'pending_owner_approval', NOW(), '{}'::jsonb
            )
            RETURNING *
            """,
            {
                "grant_id": grant_id,
                "owner_user_id": owner_user_id,
                "referring_user_id": referring_user_id,
                "referred_user_id": referred_user_id,
                "request_id": request["id"],
            },
        )
        referral_payload = self._referral_payload(referral)
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=referring_user_id,
            recipient_user_id=referred_user_id,
            grant_id=grant_id,
            request_id=request["id"],
            referral_id=referral_payload["id"] if referral_payload else None,
            event_type="location_referral_invite",
            metadata={"creates_access": False},
        )
        owner_label = _identity_notification_label(self._identity_row(owner_user_id))
        referring_identity = self._identity_row(referring_user_id)
        referring_label = _identity_notification_label(referring_identity)
        if referral_payload:
            self._send_metadata_notification(
                user_id=referred_user_id,
                notification_type="location_referral_invite",
                title="Location referral pending",
                body=f"{referring_label} referred you into a location request.",
                notification_tag=f"one-location-referral:{referral_payload['id']}",
                request_url=_one_location_url(
                    requestId=request["id"],
                    referralId=referral_payload["id"],
                    section="my_requests",
                ),
                data={
                    "request_id": request["id"],
                    "referral_id": referral_payload["id"],
                    "grant_id": grant_id,
                    "owner_user_id": owner_user_id,
                    "owner_display_label": owner_label,
                    "referring_user_id": referring_user_id,
                    "referring_display_label": referring_label,
                },
            )
        return {"referral": referral_payload, "request": request}


def location_error_detail(exc: OneLocationAgentError) -> dict[str, str]:
    return {"code": exc.code, "message": exc.message}


_DB_UNAVAILABLE_HTTP_STATUS = 503
_DB_UNAVAILABLE_MESSAGE = "Location storage is temporarily unavailable. Try again shortly."
_DB_FAILED_MESSAGE = "Location request failed."


def database_error_detail(exc: DatabaseExecutionError) -> dict[str, str]:
    """Client-safe detail for a database failure.

    `exc.details` is `str(<the DBAPI error>)`, and SQLAlchemy appends the failing
    statement plus every bound value to that string (no engine here sets
    `hide_parameters`). Location binds phone numbers, display labels, invite
    tokens and coordinates, so the raw detail stays server-side: the caller gets
    the stable code and the static hint, which is all it can act on anyway.
    """
    code = getattr(exc, "code", "DATABASE_EXECUTION_ERROR")
    status_code = getattr(exc, "status_code", 500)
    logger.error(
        "one_location.database_error code=%s table=%s operation=%s",
        code,
        getattr(exc, "table_name", "unknown"),
        getattr(exc, "operation", "unknown"),
    )
    return {
        "code": code,
        "message": (
            _DB_UNAVAILABLE_MESSAGE
            if status_code == _DB_UNAVAILABLE_HTTP_STATUS
            else _DB_FAILED_MESSAGE
        ),
        "hint": getattr(exc, "hint", "") or "",
    }


__all__ = [
    "COORDINATE_METADATA_KEYS",
    "OneLocationAgentError",
    "OneLocationAgentService",
    "_contains_plaintext_location_key",
    "_json_param",
    "_mask_phone",
    "_redact_location_metadata",
    "_user_id",
    "database_error_detail",
    "location_error_detail",
]
