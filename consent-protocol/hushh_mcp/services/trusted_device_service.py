"""First-party trusted-device authorization and proof-of-possession.

The device registry is deliberately separate from developer OAuth. A developer
principal identifies an application; this service binds a signed-in person to
one local installation. It stores only public device keys, one-time hashes, and
metadata-only audit events.

Postgres is the shared state tier today. ``TrustedDeviceStore`` is the seam for
a later Redis/Memorystore nonce and replay cache without changing route
contracts.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from db.db_client import JsonParam, get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.developer_oauth_service import (
    OAuthValidationError,
    append_oauth_parameters,
    normalize_redirect_uri,
)

_AUTHORIZATION_TTL_MS = 5 * 60 * 1000
_CHALLENGE_TTL_MS = 2 * 60 * 1000
_PKCE_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
_DEVICE_ID_RE = re.compile(r"^tdv_[A-Za-z0-9_-]{20,80}$")
_AUTHORIZATION_ID_RE = re.compile(r"^tda_[A-Za-z0-9_-]{20,80}$")


class TrustedDeviceError(ValueError):
    """Stable, non-secret trusted-device error safe for an API response."""

    def __init__(self, code: str, message: str, *, status_code: int = 400):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True)
class DeviceAuthorization:
    authorization_id: str
    device_id: str
    redirect_uri: str
    redirect_url: str
    expires_at: int
    replaces_device_id: str | None = None


class TrustedDeviceStore(Protocol):
    def insert_authorization(self, row: dict[str, Any]) -> None: ...

    def attach_vault_handoff(
        self,
        *,
        authorization_id: str,
        user_id: str,
        handoff: dict[str, Any],
        now_ms: int,
    ) -> bool: ...

    def consume_authorization(
        self, *, code_hash: str, code_challenge: str, now_ms: int
    ) -> dict[str, Any] | None: ...

    def consume_and_activate_authorization(
        self, *, code_hash: str, code_challenge: str, now_ms: int
    ) -> dict[str, Any] | None: ...

    def upsert_device(self, row: dict[str, Any]) -> None: ...

    def list_devices(self, *, user_id: str) -> list[dict[str, Any]]: ...

    def get_active_device(self, *, user_id: str, device_id: str) -> dict[str, Any] | None: ...

    def revoke_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool: ...

    def insert_challenge(self, row: dict[str, Any]) -> None: ...

    def get_challenge(
        self, *, challenge_id: str, user_id: str, device_id: str, now_ms: int
    ) -> dict[str, Any] | None: ...

    def consume_challenge(
        self, *, challenge_id: str, user_id: str, device_id: str, nonce_hash: str, now_ms: int
    ) -> bool: ...

    def touch_device(self, *, user_id: str, device_id: str, now_ms: int) -> None: ...

    def record_sync(
        self, *, user_id: str, device_id: str, cursor: int | None, now_ms: int
    ) -> None: ...

    def record_heartbeat(
        self, *, user_id: str, device_id: str, snapshot: dict[str, Any], now_ms: int
    ) -> None: ...

    def get_device_status(self, *, user_id: str, device_id: str) -> dict[str, Any] | None: ...

    def seal_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool: ...

    def audit(
        self,
        *,
        user_id: str,
        device_id: str | None,
        event_type: str,
        created_at: int,
        metadata: dict[str, Any] | None = None,
    ) -> None: ...


class PostgresTrustedDeviceStore:
    """Synchronous Postgres adapter; routes run calls in a worker thread."""

    def __init__(self) -> None:
        self._db = get_db()

    def insert_authorization(self, row: dict[str, Any]) -> None:
        self._db.table("trusted_device_authorizations").insert(row).execute()

    def attach_vault_handoff(
        self,
        *,
        authorization_id: str,
        user_id: str,
        handoff: dict[str, Any],
        now_ms: int,
    ) -> bool:
        result = self._db.execute_raw(
            """UPDATE trusted_device_authorizations
               SET vault_handoff = :vault_handoff
               WHERE authorization_id = :authorization_id
                 AND user_id = :user_id
                 AND consumed_at IS NULL
                 AND expires_at > :now_ms
                 AND vault_handoff IS NULL
               RETURNING authorization_id""",
            {
                "authorization_id": authorization_id,
                "user_id": user_id,
                "vault_handoff": JsonParam(handoff),
                "now_ms": now_ms,
            },
        )
        return bool(result.data)

    def consume_authorization(
        self, *, code_hash: str, code_challenge: str, now_ms: int
    ) -> dict[str, Any] | None:
        result = self._db.execute_raw(
            """UPDATE trusted_device_authorizations
               SET consumed_at = :now_ms
               WHERE code_hash = :code_hash
                 AND consumed_at IS NULL
                 AND expires_at > :now_ms
                 AND code_challenge = :code_challenge
               RETURNING *""",
            {
                "code_hash": code_hash,
                "code_challenge": code_challenge,
                "now_ms": now_ms,
            },
        )
        return result.data[0] if result.data else None

    def consume_and_activate_authorization(
        self, *, code_hash: str, code_challenge: str, now_ms: int
    ) -> dict[str, Any] | None:
        """Consume PKCE and replace a legacy device in one database statement."""
        result = self._db.execute_raw(
            """WITH consumed AS (
                   UPDATE trusted_device_authorizations
                   SET consumed_at = :now_ms
                   WHERE code_hash = :code_hash
                     AND consumed_at IS NULL
                     AND expires_at > :now_ms
                     AND code_challenge = :code_challenge
                     AND (
                       replaces_device_id IS NULL OR EXISTS (
                         SELECT 1 FROM trusted_devices previous
                         WHERE previous.device_id = trusted_device_authorizations.replaces_device_id
                           AND previous.user_id = trusted_device_authorizations.user_id
                           AND previous.status = 'active'
                       )
                     )
                   RETURNING *
                 ), activated AS (
                   INSERT INTO trusted_devices
                     (device_id, user_id, device_public_key, device_name, platform,
                      status, created_at, last_used_at, revoked_at)
                   SELECT device_id, user_id, device_public_key, device_name, platform,
                          'active', :now_ms, :now_ms, NULL
                   FROM consumed
                   ON CONFLICT (device_id) DO UPDATE SET
                     device_public_key = EXCLUDED.device_public_key,
                     device_name = EXCLUDED.device_name,
                     platform = EXCLUDED.platform,
                     status = 'active',
                     last_used_at = EXCLUDED.last_used_at,
                     revoked_at = NULL
                   WHERE trusted_devices.user_id = EXCLUDED.user_id
                   RETURNING device_id, user_id, device_public_key, device_name, platform
                 ), replaced AS (
                   UPDATE trusted_devices previous
                   SET status = 'revoked', revoked_at = :now_ms
                   WHERE previous.device_id = (SELECT replaces_device_id FROM consumed)
                     AND previous.user_id = (SELECT user_id FROM consumed)
                     AND previous.status = 'active'
                   RETURNING previous.device_id
                 )
                 SELECT activated.*,
                        (SELECT device_id FROM replaced) AS replaced_device_id,
                        (SELECT authorization_id FROM consumed) AS authorization_id,
                        (SELECT expires_at FROM consumed) AS authorization_expires_at,
                        (SELECT vault_handoff FROM consumed) AS vault_handoff
                 FROM activated""",
            {"code_hash": code_hash, "code_challenge": code_challenge, "now_ms": now_ms},
        )
        return result.data[0] if result.data else None

    def upsert_device(self, row: dict[str, Any]) -> None:
        self._db.execute_raw(
            """INSERT INTO trusted_devices
               (device_id, user_id, device_public_key, device_name, platform,
                status, created_at, last_used_at, revoked_at)
               VALUES
               (:device_id, :user_id, :device_public_key, :device_name, :platform,
                'active', :created_at, :last_used_at, NULL)
               ON CONFLICT (device_id) DO UPDATE SET
                 device_public_key = EXCLUDED.device_public_key,
                 device_name = EXCLUDED.device_name,
                 platform = EXCLUDED.platform,
                 status = 'active',
                 last_used_at = EXCLUDED.last_used_at,
                 revoked_at = NULL
               WHERE trusted_devices.user_id = EXCLUDED.user_id""",
            row,
        )

    def list_devices(self, *, user_id: str) -> list[dict[str, Any]]:
        return (
            self._db.table("trusted_devices")
            .select(
                "device_id,device_name,platform,status,created_at,last_used_at,"
                "revoked_at,last_synced_at,last_sync_cursor,sealed_at,"
                "last_heartbeat_at,heartbeat"
            )
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .execute()
            .data
            or []
        )

    def get_active_device(self, *, user_id: str, device_id: str) -> dict[str, Any] | None:
        rows = (
            self._db.table("trusted_devices")
            .select("*")
            .eq("user_id", user_id)
            .eq("device_id", device_id)
            .eq("status", "active")
            .limit(1)
            .execute()
            .data
            or []
        )
        return rows[0] if rows else None

    def revoke_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool:
        result = self._db.execute_raw(
            """UPDATE trusted_devices
               SET status = 'revoked', revoked_at = :now_ms
               WHERE user_id = :user_id AND device_id = :device_id AND status = 'active'
               RETURNING device_id""",
            {"user_id": user_id, "device_id": device_id, "now_ms": now_ms},
        )
        return bool(result.data)

    def insert_challenge(self, row: dict[str, Any]) -> None:
        self._db.table("trusted_device_challenges").insert(row).execute()

    def get_challenge(
        self, *, challenge_id: str, user_id: str, device_id: str, now_ms: int
    ) -> dict[str, Any] | None:
        rows = (
            self._db.table("trusted_device_challenges")
            .select("challenge_id,nonce_hash,expires_at")
            .eq("challenge_id", challenge_id)
            .eq("user_id", user_id)
            .eq("device_id", device_id)
            .is_("consumed_at", None)
            .gt("expires_at", now_ms)
            .limit(1)
            .execute()
            .data
            or []
        )
        return rows[0] if rows else None

    def consume_challenge(
        self, *, challenge_id: str, user_id: str, device_id: str, nonce_hash: str, now_ms: int
    ) -> bool:
        result = self._db.execute_raw(
            """UPDATE trusted_device_challenges
               SET consumed_at = :now_ms
               WHERE challenge_id = :challenge_id
                 AND user_id = :user_id
                 AND device_id = :device_id
                 AND nonce_hash = :nonce_hash
                 AND consumed_at IS NULL
                 AND expires_at > :now_ms
               RETURNING challenge_id""",
            {
                "challenge_id": challenge_id,
                "user_id": user_id,
                "device_id": device_id,
                "nonce_hash": nonce_hash,
                "now_ms": now_ms,
            },
        )
        return bool(result.data)

    def touch_device(self, *, user_id: str, device_id: str, now_ms: int) -> None:
        (
            self._db.table("trusted_devices")
            .update({"last_used_at": now_ms})
            .eq("user_id", user_id)
            .eq("device_id", device_id)
            .eq("status", "active")
            .execute()
        )

    def record_sync(self, *, user_id: str, device_id: str, cursor: int | None, now_ms: int) -> None:
        updates: dict[str, Any] = {"last_synced_at": now_ms}
        if cursor is not None:
            updates["last_sync_cursor"] = cursor
        (
            self._db.table("trusted_devices")
            .update(updates)
            .eq("user_id", user_id)
            .eq("device_id", device_id)
            .eq("status", "active")
            .execute()
        )

    def record_heartbeat(
        self,
        *,
        user_id: str,
        device_id: str,
        snapshot: dict[str, Any],
        now_ms: int,
    ) -> None:
        (
            self._db.table("trusted_devices")
            .update({"last_heartbeat_at": now_ms, "heartbeat": snapshot})
            .eq("user_id", user_id)
            .eq("device_id", device_id)
            .eq("status", "active")
            .execute()
        )

    def get_device_status(self, *, user_id: str, device_id: str) -> dict[str, Any] | None:
        rows = (
            self._db.table("trusted_devices")
            .select("device_id,status,revoked_at,last_synced_at,sealed_at")
            .eq("user_id", user_id)
            .eq("device_id", device_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        return rows[0] if rows else None

    def seal_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool:
        result = self._db.execute_raw(
            """UPDATE trusted_devices
               SET sealed_at = :now_ms
               WHERE user_id = :user_id AND device_id = :device_id
                 AND status = 'revoked' AND sealed_at IS NULL
               RETURNING device_id""",
            {"user_id": user_id, "device_id": device_id, "now_ms": now_ms},
        )
        return bool(result.data)

    def audit(
        self,
        *,
        user_id: str,
        device_id: str | None,
        event_type: str,
        created_at: int,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._db.table("trusted_device_audit_events").insert(
            {
                "user_id": user_id,
                "device_id": device_id,
                "event_type": event_type,
                "created_at": created_at,
                "metadata": JsonParam(metadata or {}),
            }
        ).execute()


def trusted_devices_enabled() -> bool:
    return str(os.getenv("HUSSH_TRUSTED_DEVICE_ENABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
        "enabled",
    }


def _now_ms() -> int:
    return int(time.time() * 1000)


def _pepper() -> bytes:
    configured = str(os.getenv("TRUSTED_DEVICE_PEPPER") or "").strip()
    if configured:
        return configured.encode("utf-8")
    return get_core_security_settings().app_signing_key.encode("utf-8")


def _secret_hash(value: str) -> str:
    return hmac.new(_pepper(), value.encode("utf-8"), hashlib.sha256).hexdigest()


def _pkce_digest(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _validate_public_key(public_key_b64: str) -> None:
    try:
        encoded = base64.b64decode(public_key_b64, validate=True)
        key = serialization.load_der_public_key(encoded)
    except Exception as exc:
        raise TrustedDeviceError(
            "TRUSTED_DEVICE_INVALID_PUBLIC_KEY",
            "The device public key is invalid.",
        ) from exc
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise TrustedDeviceError(
            "TRUSTED_DEVICE_UNSUPPORTED_PUBLIC_KEY",
            "The device must use a P-256 signing key.",
        )


def _loopback_redirect_uri(value: str) -> str:
    try:
        normalized = normalize_redirect_uri(value)
    except OAuthValidationError as exc:
        raise TrustedDeviceError("TRUSTED_DEVICE_INVALID_REDIRECT", exc.message) from exc
    hostname = (urlsplit(normalized).hostname or "").lower()
    if hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise TrustedDeviceError(
            "TRUSTED_DEVICE_INVALID_REDIRECT",
            "Hermes device authorization requires a loopback redirect URI.",
        )
    return normalized


_HEARTBEAT_TEXT_FIELDS = (
    "machine_id",
    "current_model",
    "agent_version",
    # What the owner sees on connect: the machine their agent runs on. Names
    # only, never identifiers -- no serial number, no hostname, no MAC.
    "brand",
    "processor",
)
_HEARTBEAT_MAX_TEXT = 120

# Bounded because a device posts these. An unbounded float would let a bad or
# buggy client store 1e309 and render as garbage wherever it is shown; a value
# outside the plausible range is dropped rather than clamped, since clamping
# would invent a reading that was never taken.
_HEARTBEAT_NUMERIC_FIELDS: tuple[tuple[str, float, float], ...] = (
    ("ram_total_gb", 0.0, 16_384.0),
    ("ram_used_pct", 0.0, 100.0),
    # Only a machine with a battery sends these. A desktop omits them entirely
    # rather than sending 0, so an absent battery stays distinguishable from a
    # flat one. Never default these to a number when reading them back.
    ("battery_pct", 0.0, 100.0),
    ("battery_minutes_remaining", 0.0, 10_080.0),
)

_HEARTBEAT_BOOL_FIELDS = ("busy", "battery_charging", "on_ac")

# The heartbeat also carries two SUMMARIES of what the agent is doing: its
# scheduled jobs and its recent conversations. These widen the column from
# scalars to arrays, so they widen the allow-list -- but not its rule. Each row
# is REBUILT field by field from a fixed set of names, exactly as the scalars
# are, never filtered from what the device sent. That is the whole safety
# argument: a job's prompt, script, working directory or model credentials, any
# filesystem path, any URL, any token, and every message body have no name in
# this list, so no client change and no field added upstream later can carry
# one into the column. Do not "simplify" either builder into a copy with a
# blocklist; a blocklist only excludes what someone thought of.
_HEARTBEAT_MAX_ROWS = 10
_HEARTBEAT_ROW_NAME_MAX = 80
_HEARTBEAT_ROW_WHEN_MAX = 40
_HEARTBEAT_ROW_LAST_MAX = 16
_HEARTBEAT_ROW_TITLE_MAX = 80
_HEARTBEAT_MAX_MESSAGES = 100_000


def _heartbeat_row_text(value: Any, limit: int) -> str | None:
    """Coerce one row field the way the scalar text fields are coerced.

    Same discipline as _HEARTBEAT_TEXT_FIELDS: a bool is not text, a number
    renders as text, blank after stripping is nothing, and an over-long value
    is truncated rather than rejected. Truncating is deliberate -- an over-long
    name must cost the extra characters, never the row.
    """
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _heartbeat_row_epoch(value: Any) -> int | None:
    """Epoch SECONDS as reported. A bool is an int subclass and is not a time."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _safe_scheduled_row(row: Any) -> dict[str, Any] | None:
    """One scheduled job, or None when it cannot be built from permitted fields.

    name, when and paused are what the row IS, so a row missing any of them is
    dropped WHOLE rather than part-filled: a job shown without its schedule, or
    shown as running while it is paused, misleads the owner more than a job
    that is not shown at all. next_at and last are extras and may be absent.
    """
    if not isinstance(row, dict):
        return None
    name = _heartbeat_row_text(row.get("name"), _HEARTBEAT_ROW_NAME_MAX)
    when = _heartbeat_row_text(row.get("when"), _HEARTBEAT_ROW_WHEN_MAX)
    paused = row.get("paused")
    if name is None or when is None or not isinstance(paused, bool):
        return None
    safe: dict[str, Any] = {"name": name, "when": when, "paused": paused}
    next_at = _heartbeat_row_epoch(row.get("next_at"))
    if next_at is not None:
        safe["next_at"] = next_at
    last = _heartbeat_row_text(row.get("last"), _HEARTBEAT_ROW_LAST_MAX)
    if last is not None:
        safe["last"] = last
    return safe


def _safe_conversation_row(row: Any) -> dict[str, Any] | None:
    """One recent conversation: its title, its size, and when it last moved.

    All three are required. Message COUNT only -- no message, no body and no
    tool output has a name here, and none may ever be given one.
    """
    if not isinstance(row, dict):
        return None
    title = _heartbeat_row_text(row.get("title"), _HEARTBEAT_ROW_TITLE_MAX)
    at = _heartbeat_row_epoch(row.get("at"))
    messages = row.get("messages")
    if title is None or at is None:
        return None
    if isinstance(messages, bool) or not isinstance(messages, int):
        return None
    if not 0 <= messages <= _HEARTBEAT_MAX_MESSAGES:
        return None
    return {"title": title, "messages": messages, "at": at}


_HEARTBEAT_ROW_FIELDS: tuple[tuple[str, Callable[[Any], dict[str, Any] | None]], ...] = (
    ("scheduled", _safe_scheduled_row),
    ("conversations", _safe_conversation_row),
)


def _safe_heartbeat(snapshot: dict[str, Any] | None) -> dict[str, Any]:
    """Reduce a device-reported snapshot to a fixed allow-list.

    A device posts this, so the payload is untrusted input written straight to
    a JSONB column. Only these runtime fields are kept, each coerced and length
    capped: everything else -- unknown keys, oversized strings, anything
    resembling vault content, a filesystem path, or a credential -- is dropped
    rather than sanitized, so the column can only ever hold telemetry.

    Two keys ("scheduled", "conversations") hold ARRAYS of flat summary rows
    rather than a scalar. They are the only nesting the column accepts, and
    they carry the same guarantee one level down: each row is rebuilt from a
    per-row allow-list with the same coercion and capping, the array is capped
    at _HEARTBEAT_MAX_ROWS, a row that cannot supply its required fields is
    dropped whole, and a value that is not a list drops its key entirely. Every
    other nested object is still dropped on sight.
    """
    if not isinstance(snapshot, dict):
        return {}
    safe: dict[str, Any] = {}
    for field in _HEARTBEAT_TEXT_FIELDS:
        value = snapshot.get(field)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            text = str(value).strip()
            if text:
                safe[field] = text[:_HEARTBEAT_MAX_TEXT]
    for field, low, high in _HEARTBEAT_NUMERIC_FIELDS:
        value = snapshot.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            number = float(value)
            # NaN and the infinities fail every comparison, so they are excluded
            # by the range test rather than needing a separate guard.
            if low <= number <= high:
                safe[field] = round(number, 2)
    for field in _HEARTBEAT_BOOL_FIELDS:
        value = snapshot.get(field)
        if isinstance(value, bool):
            safe[field] = value
    for field in ("active_sessions", "next_cron_at"):
        value = snapshot.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            safe[field] = value
    for field, build_row in _HEARTBEAT_ROW_FIELDS:
        value = snapshot.get(field)
        if not isinstance(value, list):
            # An object, a string or a number is not a truncated list, so the
            # key is dropped entirely rather than coerced into one. An absent
            # key means the device does not report that summary; an empty list
            # means it reported none, and those are different answers.
            continue
        rows: list[dict[str, Any]] = []
        # Sliced BEFORE the rows are built, so the work a device can make the
        # server do is bounded by the cap and not by the length it chose to
        # send. The device orders soonest/newest first, so the head that
        # survives truncation is the useful half.
        for raw_row in value[:_HEARTBEAT_MAX_ROWS]:
            built = build_row(raw_row)
            if built is not None:
                rows.append(built)
        safe[field] = rows
    return safe


def _safe_device(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "device_id": str(row.get("device_id") or ""),
        "device_name": str(row.get("device_name") or ""),
        "platform": str(row.get("platform") or ""),
        "status": str(row.get("status") or "active"),
        "created_at": int(row.get("created_at") or 0),
        "last_used_at": int(row["last_used_at"]) if row.get("last_used_at") else None,
        "revoked_at": int(row["revoked_at"]) if row.get("revoked_at") else None,
        "last_synced_at": (
            int(row["last_synced_at"]) if row.get("last_synced_at") is not None else None
        ),
        "last_sync_cursor": (
            int(row["last_sync_cursor"]) if row.get("last_sync_cursor") is not None else None
        ),
        "sealed_at": int(row["sealed_at"]) if row.get("sealed_at") is not None else None,
        "last_heartbeat_at": (
            int(row["last_heartbeat_at"]) if row.get("last_heartbeat_at") is not None else None
        ),
        # Re-reduced on read: a row written before the allow-list existed, or by
        # any other writer, still cannot surface anything but telemetry.
        "heartbeat": _safe_heartbeat(row.get("heartbeat")) or None,
    }


class TrustedDeviceService:
    def __init__(self, store: TrustedDeviceStore | None = None) -> None:
        self._store = store or PostgresTrustedDeviceStore()

    def create_authorization(
        self,
        *,
        user_id: str,
        redirect_uri: str,
        code_challenge: str,
        device_public_key: str,
        device_name: str,
        platform: str,
        state: str,
        replaces_device_id: str | None = None,
    ) -> DeviceAuthorization:
        if not _PKCE_RE.fullmatch(code_challenge):
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_INVALID_PKCE",
                "A valid S256 PKCE challenge is required.",
            )
        _validate_public_key(device_public_key)
        normalized_redirect = _loopback_redirect_uri(redirect_uri)
        clean_name = device_name.strip()
        clean_platform = platform.strip().lower()
        if not clean_name or len(clean_name) > 100:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_INVALID_NAME", "A valid device name is required."
            )
        if clean_platform != "macos":
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_UNSUPPORTED_PLATFORM",
                "The trusted-device MVP currently supports macOS only.",
            )
        previous_device_id = str(replaces_device_id or "").strip() or None
        if previous_device_id and not _DEVICE_ID_RE.fullmatch(previous_device_id):
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_INVALID_REPLACEMENT",
                "The prior trusted device reference is invalid.",
            )

        now_ms = _now_ms()
        authorization_id = f"tda_{secrets.token_urlsafe(24)}"
        device_id = f"tdv_{secrets.token_urlsafe(24)}"
        code = f"tdc_{secrets.token_urlsafe(32)}"
        self._store.insert_authorization(
            {
                "authorization_id": authorization_id,
                "device_id": device_id,
                "user_id": user_id,
                "code_hash": _secret_hash(code),
                "redirect_uri": normalized_redirect,
                "code_challenge": code_challenge,
                "device_public_key": device_public_key,
                "device_name": clean_name,
                "platform": clean_platform,
                "oauth_state": state,
                "created_at": now_ms,
                "expires_at": now_ms + _AUTHORIZATION_TTL_MS,
                "replaces_device_id": previous_device_id,
            }
        )
        self._store.audit(
            user_id=user_id,
            device_id=device_id,
            event_type="authorization_approved",
            created_at=now_ms,
            metadata={"platform": clean_platform},
        )
        return DeviceAuthorization(
            authorization_id=authorization_id,
            device_id=device_id,
            redirect_uri=normalized_redirect,
            redirect_url=append_oauth_parameters(
                normalized_redirect, {"code": code, "state": state}
            ),
            expires_at=now_ms + _AUTHORIZATION_TTL_MS,
            replaces_device_id=previous_device_id,
        )

    def attach_vault_handoff(
        self,
        *,
        authorization_id: str,
        user_id: str,
        handoff: dict[str, Any],
    ) -> None:
        if not _AUTHORIZATION_ID_RE.fullmatch(authorization_id):
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_HANDOFF_UNAVAILABLE",
                "The trusted-device vault handoff is expired or already attached.",
                status_code=409,
            )
        now_ms = _now_ms()
        attached = self._store.attach_vault_handoff(
            authorization_id=authorization_id,
            user_id=user_id,
            handoff=handoff,
            now_ms=now_ms,
        )
        if not attached:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_HANDOFF_UNAVAILABLE",
                "The trusted-device vault handoff is expired or already attached.",
                status_code=409,
            )
        self._store.audit(
            user_id=user_id,
            device_id=None,
            event_type="vault_handoff_attached",
            created_at=now_ms,
            metadata={
                "authorization_id": authorization_id,
                "algorithm": str(handoff.get("vault_handoff_alg") or ""),
            },
        )

    def exchange_authorization(self, *, code: str, code_verifier: str) -> dict[str, Any]:
        if not code.startswith("tdc_") or not _PKCE_RE.fullmatch(code_verifier):
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_INVALID_GRANT", "The authorization grant is invalid."
            )
        now_ms = _now_ms()
        row = self._store.consume_and_activate_authorization(
            code_hash=_secret_hash(code),
            code_challenge=_pkce_digest(code_verifier),
            now_ms=now_ms,
        )
        if not row:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_INVALID_GRANT", "The authorization grant is invalid."
            )
        device = {
            "device_id": str(row["device_id"]),
            "user_id": str(row["user_id"]),
            "device_public_key": str(row["device_public_key"]),
            "device_name": str(row["device_name"]),
            "platform": str(row["platform"]),
            "replaced_device_id": str(row.get("replaced_device_id") or "") or None,
            "authorization_id": str(row.get("authorization_id") or ""),
            "authorization_expires_at": int(row.get("authorization_expires_at") or 0),
            "vault_handoff": row.get("vault_handoff"),
        }
        self._store.audit(
            user_id=device["user_id"],
            device_id=device["device_id"],
            event_type="authorization_exchanged",
            created_at=now_ms,
        )
        if device["replaced_device_id"]:
            self._store.audit(
                user_id=device["user_id"],
                device_id=device["device_id"],
                event_type="device_replaced",
                created_at=now_ms,
                metadata={"replaced_device_id": device["replaced_device_id"]},
            )
        return device

    def list_devices(self, *, user_id: str) -> list[dict[str, Any]]:
        return [_safe_device(row) for row in self._store.list_devices(user_id=user_id)]

    def is_active_device(self, *, user_id: str, device_id: str) -> bool:
        return self._store.get_active_device(user_id=user_id, device_id=device_id) is not None

    def audit_event(
        self,
        *,
        user_id: str,
        device_id: str,
        event_type: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._store.audit(
            user_id=user_id,
            device_id=device_id,
            event_type=event_type,
            created_at=_now_ms(),
            metadata=metadata,
        )

    def revoke_device(self, *, user_id: str, device_id: str) -> bool:
        if not _DEVICE_ID_RE.fullmatch(device_id):
            return False
        now_ms = _now_ms()
        revoked = self._store.revoke_device(user_id=user_id, device_id=device_id, now_ms=now_ms)
        if revoked:
            self._store.audit(
                user_id=user_id,
                device_id=device_id,
                event_type="device_revoked",
                created_at=now_ms,
            )
        return revoked

    def device_status(self, *, user_id: str, device_id: str) -> dict[str, Any] | None:
        """Own-device liveness read for the native runtime.

        Returns the caller's own device status and revocation/sync metadata, or
        None when no such row exists (mapped to a uniform 404 at the route so an
        unknown or foreign device_id cannot be enumerated). Never returns a
        capability or vault material; enforcement is unaffected.
        """
        if not _DEVICE_ID_RE.fullmatch(device_id):
            return None
        row = self._store.get_device_status(user_id=user_id, device_id=device_id)
        if not row:
            return None
        return {
            "device_id": device_id,
            "status": str(row.get("status") or "revoked"),
            "revoked_at": int(row["revoked_at"]) if row.get("revoked_at") else None,
            "last_synced_at": (int(row["last_synced_at"]) if row.get("last_synced_at") else None),
        }

    def record_sync(self, *, user_id: str, device_id: str, cursor: int | None = None) -> None:
        """Stamp last_synced_at (and the high-water cursor) for an active device.

        Best-effort telemetry: callers must swallow failures so a stamp problem
        never fails the device-sync read that triggered it. Only active devices
        are updated, so a revoked device can never be resurrected by a stamp.
        """
        if not _DEVICE_ID_RE.fullmatch(device_id):
            return
        self._store.record_sync(
            user_id=user_id, device_id=device_id, cursor=cursor, now_ms=_now_ms()
        )

    def record_heartbeat(
        self, *, user_id: str, device_id: str, snapshot: dict[str, Any] | None = None
    ) -> None:
        """Stamp liveness telemetry reported by a running device.

        Answers "is this agent reachable right now?", which last_synced_at
        cannot: that column only moves when the device pulls the sync channel,
        so a running-but-idle agent looks stale.

        The snapshot is reduced to a fixed allow-list of scalar runtime fields
        before it is stored, so a device cannot push vault content, filesystem
        paths, credentials, or unbounded payloads into the row. Only active
        devices are updated, so a revoked device can never appear live again.
        """
        if not _DEVICE_ID_RE.fullmatch(device_id):
            return
        self._store.record_heartbeat(
            user_id=user_id,
            device_id=device_id,
            snapshot=_safe_heartbeat(snapshot),
            now_ms=_now_ms(),
        )

    def seal_device(self, *, user_id: str, device_id: str) -> dict[str, Any] | None:
        """Record the native runtime's advisory seal confirmation after a remote
        revoke. One-way and idempotent: it can only stamp sealed_at on an
        already-revoked row and can never flip a device back to active. Returns
        the device status with sealed_at, or None when there is no such device.

        Enforcement never consults sealed_at; this closes the audit loop only.
        """
        if not _DEVICE_ID_RE.fullmatch(device_id):
            return None
        row = self._store.get_device_status(user_id=user_id, device_id=device_id)
        if not row:
            return None
        if str(row.get("status")) != "revoked":
            return {
                "device_id": device_id,
                "status": str(row.get("status") or "active"),
                "sealed_at": int(row["sealed_at"]) if row.get("sealed_at") else None,
            }
        now_ms = _now_ms()
        newly_sealed = self._store.seal_device(user_id=user_id, device_id=device_id, now_ms=now_ms)
        if newly_sealed:
            self._store.audit(
                user_id=user_id,
                device_id=device_id,
                event_type="device_sealed",
                created_at=now_ms,
                metadata={"advisory": True, "reason": "remote_revoke"},
            )
            sealed_at: int | None = now_ms
        else:
            existing = self._store.get_device_status(user_id=user_id, device_id=device_id)
            sealed_at = (
                int(existing["sealed_at"]) if existing and existing.get("sealed_at") else None
            )
        return {"device_id": device_id, "status": "revoked", "sealed_at": sealed_at}

    def create_challenge(self, *, user_id: str, device_id: str) -> dict[str, Any]:
        device = self._store.get_active_device(user_id=user_id, device_id=device_id)
        if not device:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_NOT_ACTIVE",
                "The trusted device is not active.",
                status_code=403,
            )
        now_ms = _now_ms()
        challenge_id = f"tdn_{secrets.token_urlsafe(24)}"
        nonce = secrets.token_urlsafe(32)
        self._store.insert_challenge(
            {
                "challenge_id": challenge_id,
                "device_id": device_id,
                "user_id": user_id,
                "nonce_hash": _secret_hash(nonce),
                "created_at": now_ms,
                "expires_at": now_ms + _CHALLENGE_TTL_MS,
            }
        )
        return {
            "challenge_id": challenge_id,
            "nonce": nonce,
            "expires_at": now_ms + _CHALLENGE_TTL_MS,
            "signing_payload": self.signing_payload(
                challenge_id=challenge_id,
                nonce=nonce,
                user_id=user_id,
                device_id=device_id,
            ),
        }

    @staticmethod
    def signing_payload(*, challenge_id: str, nonce: str, user_id: str, device_id: str) -> str:
        return json.dumps(
            {
                "challenge_id": challenge_id,
                "device_id": device_id,
                "nonce": nonce,
                "purpose": "vault-owner-capability",
                "user_id": user_id,
            },
            separators=(",", ":"),
            sort_keys=True,
        )

    def verify_challenge(
        self,
        *,
        user_id: str,
        device_id: str,
        challenge_id: str,
        nonce: str,
        signature_b64: str,
    ) -> None:
        device = self._store.get_active_device(user_id=user_id, device_id=device_id)
        if not device:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_NOT_ACTIVE",
                "The trusted device is not active.",
                status_code=403,
            )
        now_ms = _now_ms()
        challenge = self._store.get_challenge(
            challenge_id=challenge_id,
            user_id=user_id,
            device_id=device_id,
            now_ms=now_ms,
        )
        nonce_hash = _secret_hash(nonce)
        if not challenge or not hmac.compare_digest(
            str(challenge.get("nonce_hash") or ""), nonce_hash
        ):
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_CHALLENGE_INVALID",
                "The device challenge is expired, mismatched, or already used.",
                status_code=401,
            )

        try:
            key_bytes = base64.b64decode(str(device["device_public_key"]), validate=True)
            public_key = serialization.load_der_public_key(key_bytes)
            signature = base64.b64decode(signature_b64, validate=True)
            if not isinstance(public_key, ec.EllipticCurvePublicKey):
                raise TypeError("not an EC public key")
            public_key.verify(
                signature,
                self.signing_payload(
                    challenge_id=challenge_id,
                    nonce=nonce,
                    user_id=user_id,
                    device_id=device_id,
                ).encode("utf-8"),
                ec.ECDSA(hashes.SHA256()),
            )
        except (InvalidSignature, TypeError, ValueError) as exc:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_SIGNATURE_INVALID",
                "The device signature is invalid.",
                status_code=401,
            ) from exc

        # Consume only after proof verification. The conditional update is the
        # replay fence when two valid requests race.
        consumed = self._store.consume_challenge(
            challenge_id=challenge_id,
            user_id=user_id,
            device_id=device_id,
            nonce_hash=nonce_hash,
            now_ms=now_ms,
        )
        if not consumed:
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_CHALLENGE_INVALID",
                "The device challenge is expired, mismatched, or already used.",
                status_code=401,
            )

        self._store.touch_device(user_id=user_id, device_id=device_id, now_ms=now_ms)
        self._store.audit(
            user_id=user_id,
            device_id=device_id,
            event_type="device_challenge_verified",
            created_at=now_ms,
        )
