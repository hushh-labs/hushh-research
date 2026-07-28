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


class TrustedDeviceStore(Protocol):
    def insert_authorization(self, row: dict[str, Any]) -> None: ...

    def consume_authorization(
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
            .select("device_id,device_name,platform,status,created_at,last_used_at,revoked_at")
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


def _safe_device(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "device_id": str(row.get("device_id") or ""),
        "device_name": str(row.get("device_name") or ""),
        "platform": str(row.get("platform") or ""),
        "status": str(row.get("status") or "active"),
        "created_at": int(row.get("created_at") or 0),
        "last_used_at": int(row["last_used_at"]) if row.get("last_used_at") else None,
        "revoked_at": int(row["revoked_at"]) if row.get("revoked_at") else None,
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
                "created_at": now_ms,
                "expires_at": now_ms + _AUTHORIZATION_TTL_MS,
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
        )

    def exchange_authorization(self, *, code: str, code_verifier: str) -> dict[str, Any]:
        if not code.startswith("tdc_") or not _PKCE_RE.fullmatch(code_verifier):
            raise TrustedDeviceError(
                "TRUSTED_DEVICE_INVALID_GRANT", "The authorization grant is invalid."
            )
        now_ms = _now_ms()
        row = self._store.consume_authorization(
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
            "created_at": now_ms,
            "last_used_at": now_ms,
        }
        self._store.upsert_device(device)
        self._store.audit(
            user_id=device["user_id"],
            device_id=device["device_id"],
            event_type="authorization_exchanged",
            created_at=now_ms,
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
