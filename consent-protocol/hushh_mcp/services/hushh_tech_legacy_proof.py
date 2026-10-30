"""Synthetic UAT legacy-session proof contract for the Hushh Tech client.

The proof is deliberately useful only for checked-in synthetic fixtures.  It is
not a production identity token and it never accepts email, phone, or provider
aliases as an account-mapping key.  The authenticated Hushh Tech developer app
is the caller authority; this object binds that server-side session proof to one
production-shaped synthetic legacy UUID and fixture hash.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from dataclasses import dataclass
from typing import Protocol

_PROOF_PREFIX = "synthetic-v1."
_SIGNING_CONTEXT = b"hushh-tech-uat-legacy-proof-signing-v1"
_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_BOUND_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,256}$")
_MAX_PROOF_BYTES = 2048
_MAX_SESSION_LIFETIME_MS = 5 * 60 * 1000
_CLOCK_SKEW_MS = 30 * 1000


class LegacySessionProofError(ValueError):
    """A synthetic legacy-session proof is malformed, stale, or out of scope."""

    def __init__(self, code: str, message: str, *, status_code: int = 403):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True)
class VerifiedLegacySessionProof:
    firebase_uid: str
    app_id: str
    audience: str
    legacy_project: str
    legacy_user_uuid: str
    source_hash: str
    session_id: str
    issued_at_ms: int
    expires_at_ms: int


class LegacySessionProofVerifier(Protocol):
    def verify(
        self,
        proof: str,
        *,
        signing_key: str,
        now_ms: int | None = None,
    ) -> VerifiedLegacySessionProof: ...


def _decode_base64url(encoded: str) -> bytes:
    padding = "=" * (-len(encoded) % 4)
    try:
        return base64.b64decode(
            (encoded + padding).encode("ascii"),
            altchars=b"-_",
            validate=True,
        )
    except (UnicodeError, ValueError) as exc:
        raise LegacySessionProofError(
            "LEGACY_PROOF_INVALID",
            "The legacy session proof is invalid.",
        ) from exc


def _decode_payload(encoded: str) -> dict[str, object]:
    raw = _decode_base64url(encoded)
    try:
        parsed = json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite")),
            object_pairs_hook=_unique_object,
        )
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise LegacySessionProofError(
            "LEGACY_PROOF_INVALID",
            "The legacy session proof is invalid.",
        ) from exc
    if not isinstance(parsed, dict):
        raise LegacySessionProofError(
            "LEGACY_PROOF_INVALID",
            "The legacy session proof is invalid.",
        )
    canonical = json.dumps(parsed, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if not hmac.compare_digest(raw, canonical):
        raise LegacySessionProofError(
            "LEGACY_PROOF_INVALID",
            "The legacy session proof is invalid.",
        )
    return parsed


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _derived_signing_key(signing_key: str) -> bytes:
    raw = str(signing_key or "").strip().encode("utf-8")
    if len(raw) < 32:
        raise LegacySessionProofError(
            "LEGACY_PROOF_INVALID",
            "The legacy session proof is invalid.",
        )
    return hmac.new(raw, _SIGNING_CONTEXT, hashlib.sha256).digest()


def _signature(encoded_payload: str, *, signing_key: str) -> bytes:
    return hmac.new(
        _derived_signing_key(signing_key),
        f"{_PROOF_PREFIX}{encoded_payload}".encode("ascii"),
        hashlib.sha256,
    ).digest()


class SyntheticFixtureLegacySessionProofVerifier:
    """Validate a bounded, signed fixture proof from the authenticated app.

    This verifier intentionally has no production mode.  The surrounding API
    requires the exact registered Hushh Tech UAT developer credential before
    this proof is evaluated, and the service independently matches
    ``source_hash`` against a checked-in shadow fixture in Cloud SQL.
    """

    _ALLOWED_KEYS = frozenset(
        {
            "legacy_project",
            "legacy_user_uuid",
            "firebase_uid",
            "app_id",
            "audience",
            "source_hash",
            "session_id",
            "issued_at_ms",
            "expires_at_ms",
        }
    )

    def __init__(self, *, allowed_legacy_project: str = "hushh-tech-uat-synthetic") -> None:
        self.allowed_legacy_project = allowed_legacy_project

    def verify(
        self,
        proof: str,
        *,
        signing_key: str,
        now_ms: int | None = None,
    ) -> VerifiedLegacySessionProof:
        raw = str(proof or "").strip()
        if not raw.startswith(_PROOF_PREFIX) or len(raw.encode("utf-8")) > _MAX_PROOF_BYTES:
            raise LegacySessionProofError(
                "LEGACY_PROOF_INVALID",
                "The legacy session proof is invalid.",
            )
        parts = raw.split(".")
        if len(parts) != 3 or parts[0] != "synthetic-v1" or not parts[1] or not parts[2]:
            raise LegacySessionProofError(
                "LEGACY_PROOF_INVALID",
                "The legacy session proof is invalid.",
            )
        encoded_payload, encoded_signature = parts[1], parts[2]
        supplied_signature = _decode_base64url(encoded_signature)
        expected_signature = _signature(encoded_payload, signing_key=signing_key)
        if len(supplied_signature) != len(expected_signature) or not hmac.compare_digest(
            supplied_signature,
            expected_signature,
        ):
            raise LegacySessionProofError(
                "LEGACY_PROOF_INVALID",
                "The legacy session proof is invalid.",
            )
        payload = _decode_payload(encoded_payload)
        if set(payload) != self._ALLOWED_KEYS:
            raise LegacySessionProofError(
                "LEGACY_PROOF_INVALID",
                "The legacy session proof is invalid.",
            )

        legacy_project = str(payload.get("legacy_project") or "").strip()
        legacy_user_uuid = str(payload.get("legacy_user_uuid") or "").strip().lower()
        firebase_uid = str(payload.get("firebase_uid") or "").strip()
        app_id = str(payload.get("app_id") or "").strip()
        audience = str(payload.get("audience") or "").strip()
        source_hash = str(payload.get("source_hash") or "").strip().lower()
        session_id = str(payload.get("session_id") or "").strip()
        try:
            canonical_uuid = str(uuid.UUID(legacy_user_uuid))
            raw_issued_at_ms = payload.get("issued_at_ms")
            raw_expires_at_ms = payload.get("expires_at_ms")
            if type(raw_issued_at_ms) is not int or type(raw_expires_at_ms) is not int:
                raise ValueError("invalid timestamp")
            issued_at_ms = raw_issued_at_ms
            expires_at_ms = raw_expires_at_ms
        except (TypeError, ValueError) as exc:
            raise LegacySessionProofError(
                "LEGACY_PROOF_INVALID",
                "The legacy session proof is invalid.",
            ) from exc

        current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        if (
            legacy_project != self.allowed_legacy_project
            or canonical_uuid != legacy_user_uuid
            or not _BOUND_IDENTIFIER_PATTERN.fullmatch(firebase_uid)
            or not _BOUND_IDENTIFIER_PATTERN.fullmatch(app_id)
            or not _BOUND_IDENTIFIER_PATTERN.fullmatch(audience)
            or not _HASH_PATTERN.fullmatch(source_hash)
            or not _SESSION_ID_PATTERN.fullmatch(session_id)
            or issued_at_ms > current_ms + _CLOCK_SKEW_MS
            or expires_at_ms <= current_ms
            or expires_at_ms <= issued_at_ms
            or expires_at_ms - issued_at_ms > _MAX_SESSION_LIFETIME_MS
        ):
            raise LegacySessionProofError(
                "LEGACY_PROOF_INVALID",
                "The legacy session proof is invalid or expired.",
            )

        return VerifiedLegacySessionProof(
            firebase_uid=firebase_uid,
            app_id=app_id,
            audience=audience,
            legacy_project=legacy_project,
            legacy_user_uuid=legacy_user_uuid,
            source_hash=source_hash,
            session_id=session_id,
            issued_at_ms=issued_at_ms,
            expires_at_ms=expires_at_ms,
        )


def encode_synthetic_fixture_proof(
    payload: dict[str, object],
    *,
    signing_key: str,
) -> str:
    """Canonical fixture helper used by tests and the Hushh Tech UAT gateway."""
    raw = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = (
        base64.urlsafe_b64encode(_signature(encoded, signing_key=signing_key))
        .decode("ascii")
        .rstrip("=")
    )
    return f"{_PROOF_PREFIX}{encoded}.{signature}"


__all__ = [
    "LegacySessionProofError",
    "LegacySessionProofVerifier",
    "SyntheticFixtureLegacySessionProofVerifier",
    "VerifiedLegacySessionProof",
    "encode_synthetic_fixture_proof",
]
