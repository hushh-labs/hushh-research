from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

from api.utils.fcm_messages import build_push_message
from api.utils.firebase_admin import ensure_firebase_admin
from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.operons.location.policy import (
    LOCATION_CAPABILITY_SCOPES,
    normalize_duration_hours,
    normalize_source_platform,
)

logger = logging.getLogger(__name__)
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
        return value.astimezone(timezone.utc).isoformat()
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
                    user_id,
                    exc,
                )
        except Exception as exc:
            logger.warning(
                "one.location.notification_send_failed type=%s user=%s error=%s",
                notification_type,
                user_id,
                exc,
            )

    try:
        _NOTIFICATION_EXECUTOR.submit(_deliver)
    except Exception as exc:
        logger.warning(
            "one.location.notification_submit_failed type=%s user=%s error=%s",
            notification_type,
            user_id,
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
    path = f"/location/request/{token}"
    return f"{base}{path}" if base else path


def _identity_display_label(row: dict[str, Any] | None, fallback: str = "A trusted person") -> str:
    if not row:
        return fallback
    display_name = str(row.get("display_name") or "").strip()
    masked_phone = _mask_phone(row.get("phone_number"))
    return " - ".join(item for item in (display_name, masked_phone) if item) or fallback


def _fingerprint_public_key(public_key_jwk: dict[str, Any]) -> str:
    encoded = json.dumps(public_key_jwk, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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


class OneLocationAgentService:
    """Persistence service for recipient-encrypted One Location Agent workflows."""

    def _execute_one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

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
    ) -> None:
        """Best-effort metadata-only FCM delivery for location workflow state."""
        if not user_id or _contains_plaintext_location_key(data):
            return
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
                return
            configured, _ = ensure_firebase_admin()
            if not configured:
                return
            from firebase_admin import messaging

            message_data = {
                "type": notification_type,
                "user_id": user_id,
                "request_url": request_url,
                "deep_link": "/one/location",
                "notification_tag": notification_tag,
                "notification_category": "ONE_LOCATION",
                **{key: str(value) for key, value in data.items() if str(value or "").strip()},
            }
            if _contains_plaintext_location_key(message_data):
                logger.warning(
                    "one.location.notification_blocked_plaintext_keys type=%s user=%s",
                    notification_type,
                    user_id,
                )
                return
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
        except Exception as exc:
            logger.warning(
                "one.location.notification_skipped type=%s user=%s error=%s",
                notification_type,
                user_id,
                exc,
            )

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
            logger.debug("one.location.identity_lookup_failed user=%s error=%s", user_id, exc)
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
        masked_phone = _mask_phone(row.get("phone_number"))
        user_id = str(row.get("user_id") or "")
        return {
            "userId": user_id,
            "displayName": display_name or masked_phone or "Verified user",
            "maskedPhone": masked_phone,
            "phoneVerified": bool(row.get("phone_verified")),
            "keyId": str(row.get("key_id") or "") or None,
            "publicKeyJwk": _loads_json(row.get("public_key_jwk")),
            "keyAlgorithm": str(row.get("algorithm") or "ECDH-P256-AES256-GCM"),
            "keyRegisteredAt": _iso(row.get("key_created_at") or row.get("created_at")),
            "canReceiveLocation": bool(row.get("key_id")),
        }

    @staticmethod
    def _grant_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
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
            "durationHours": float(row.get("duration_hours") or 0),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
            "latestEnvelopeId": str(row.get("latest_envelope_id") or "") or None,
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
            "createdAt": _iso(row.get("created_at")),
            "metadata": _loads_json(row.get("metadata")) or {},
        }

    @staticmethod
    def _request_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
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
    def _public_invite_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        owner_label = str(row.get("owner_display_name") or "").strip()
        owner_masked_phone = _mask_phone(row.get("owner_phone_number"))
        return {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "ownerDisplayName": owner_label or None,
            "ownerMaskedPhone": owner_masked_phone,
            "status": str(row.get("status") or "active"),
            "durationHours": float(row.get("duration_hours") or 0),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
        }

    @staticmethod
    def _public_submission_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
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

    def _expire_stale_grants(self, user_id: str) -> None:
        expired = self._execute_many(
            """
            UPDATE one_location_share_grants
            SET status = 'expired', updated_at = NOW()
            WHERE status = 'active'
              AND expires_at <= NOW()
              AND (owner_user_id = :user_id OR recipient_user_id = :user_id)
            RETURNING id, owner_user_id, recipient_user_id
            """,
            {"user_id": user_id},
        )
        for row in expired:
            grant_id = str(row.get("id") or "") or None
            owner_user_id = str(row.get("owner_user_id") or "")
            recipient_user_id = str(row.get("recipient_user_id") or "")
            owner_label = _identity_display_label(self._identity_row(owner_user_id))
            self._insert_event(
                owner_user_id=owner_user_id,
                actor_user_id=None,
                recipient_user_id=recipient_user_id or None,
                grant_id=grant_id,
                event_type="location_share_expired",
                metadata={"reason": "expires_at"},
            )
            if grant_id and recipient_user_id:
                self._send_metadata_notification(
                    user_id=recipient_user_id,
                    notification_type="location_share_expired",
                    title="Location access expired",
                    body="A location share reached its expiry time.",
                    notification_tag=f"one-location-expired:{grant_id}",
                    request_url=_one_location_url(grantId=grant_id),
                    data={
                        "grant_id": grant_id,
                        "owner_user_id": owner_user_id,
                        "owner_display_label": owner_label,
                    },
                )

    def register_recipient_key(
        self,
        *,
        user_id: str,
        public_key_jwk: dict[str, Any],
        key_id: str | None = None,
        algorithm: str = "ECDH-P256-AES256-GCM",
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
        self._execute_one(
            """
            UPDATE one_location_recipient_keys
            SET status = 'rotated', updated_at = NOW()
            WHERE user_id = :user_id
              AND key_id <> :key_id
              AND status = 'active'
            """,
            {"user_id": user_id, "key_id": normalized_key_id},
        )
        row = self._execute_one(
            """
            INSERT INTO one_location_recipient_keys (
              user_id, key_id, public_key_jwk, public_key_fingerprint, algorithm,
              status, created_at, updated_at, metadata
            )
            VALUES (
              :user_id, :key_id, CAST(:public_key_jwk AS JSONB), :fingerprint,
              :algorithm, 'active', NOW(), NOW(), '{}'::jsonb
            )
            ON CONFLICT (user_id, key_id) DO UPDATE SET
              public_key_jwk = EXCLUDED.public_key_jwk,
              public_key_fingerprint = EXCLUDED.public_key_fingerprint,
              algorithm = EXCLUDED.algorithm,
              status = 'active',
              revoked_at = NULL,
              updated_at = NOW()
            RETURNING user_id, key_id, public_key_jwk, algorithm, created_at AS key_created_at, TRUE AS phone_verified
            """,
            {
                "user_id": user_id,
                "key_id": normalized_key_id,
                "public_key_jwk": json.dumps(public_key_jwk, sort_keys=True, separators=(",", ":")),
                "fingerprint": fingerprint,
                "algorithm": algorithm,
            },
        )
        self._insert_event(
            owner_user_id=user_id,
            actor_user_id=user_id,
            recipient_user_id=user_id,
            event_type="location_recipient_key_registered",
            metadata={"key_id": normalized_key_id, "algorithm": algorithm},
        )
        return self._recipient_payload(row) or {}

    def list_verified_recipients(
        self, *, owner_user_id: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        rows = self._execute_many(
            """
            SELECT
              a.user_id, a.display_name, a.phone_number, a.phone_verified,
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
            WHERE a.phone_verified = TRUE
              AND a.user_id <> :owner_user_id
            ORDER BY COALESCE(a.display_name, a.phone_number, a.user_id), a.user_id
            LIMIT :limit
            """,
            {"owner_user_id": owner_user_id, "limit": max(1, min(int(limit), 100))},
        )
        return [payload for row in rows if (payload := self._recipient_payload(row))]

    def _recipient_key_row(
        self, *, recipient_user_id: str, recipient_key_id: str | None = None
    ) -> dict[str, Any]:
        row = self._execute_one(
            """
            SELECT
              a.user_id, a.display_name, a.phone_number, a.phone_verified,
              k.key_id, k.public_key_jwk, k.algorithm, k.created_at AS key_created_at
            FROM actor_identity_cache a
            JOIN one_location_recipient_keys k ON k.user_id = a.user_id
            WHERE a.user_id = :recipient_user_id
              AND a.phone_verified = TRUE
              AND k.status = 'active'
              AND (:recipient_key_id IS NULL OR k.key_id = :recipient_key_id)
            ORDER BY k.created_at DESC
            LIMIT 1
            """,
            {"recipient_user_id": recipient_user_id, "recipient_key_id": recipient_key_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_UNAVAILABLE",
                "Choose a verified recipient who has location key material ready.",
                status_code=409,
            )
        return row

    def create_grant(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        recipient_key_id: str | None,
        duration_hours: float,
        reason: str | None = None,
    ) -> dict[str, Any]:
        if owner_user_id == recipient_user_id:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_SELF",
                "Choose a different verified recipient.",
                status_code=422,
            )
        try:
            duration = normalize_duration_hours(duration_hours)
        except ValueError as exc:
            raise OneLocationAgentError(
                "LOCATION_DURATION_INVALID",
                str(exc),
                status_code=422,
            ) from exc
        recipient = self._recipient_key_row(
            recipient_user_id=recipient_user_id, recipient_key_id=recipient_key_id
        )
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_display_label(owner_identity)
        key_id = str(recipient.get("key_id") or "")
        expires_at = _utcnow() + timedelta(hours=duration)
        self._execute_many(
            """
            UPDATE one_location_share_grants
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND recipient_user_id = :recipient_user_id
              AND status = 'active'
            RETURNING id
            """,
            {"owner_user_id": owner_user_id, "recipient_user_id": recipient_user_id},
        )
        row = self._execute_one(
            """
            INSERT INTO one_location_share_grants (
              owner_user_id, recipient_user_id, recipient_key_id, status,
              consent_scope, capability_scopes, duration_hours, expires_at,
              created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :recipient_user_id, :recipient_key_id, 'active',
              'cap.location.live.view', CAST(:capability_scopes AS JSONB),
              :duration_hours, :expires_at, NOW(), NOW(), CAST(:metadata_json AS JSONB)
            )
            RETURNING *,
              :recipient_display_name AS recipient_display_name,
              :recipient_phone_number AS recipient_phone_number
            """,
            {
                "owner_user_id": owner_user_id,
                "recipient_user_id": recipient_user_id,
                "recipient_key_id": key_id,
                "capability_scopes": _json_param(LOCATION_CAPABILITY_SCOPES),
                "duration_hours": duration,
                "expires_at": expires_at,
                "metadata_json": _json_param({"reason": reason or "owner_approved"}),
                "recipient_display_name": recipient.get("display_name"),
                "recipient_phone_number": recipient.get("phone_number"),
            },
        )
        grant = self._grant_payload(row)
        if not grant:
            raise OneLocationAgentError(
                "LOCATION_GRANT_CREATE_FAILED",
                "Could not create the location share.",
                status_code=500,
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=recipient_user_id,
            grant_id=grant["id"],
            event_type="location_share_created",
            metadata={"duration_hours": duration},
        )
        self._send_metadata_notification(
            user_id=recipient_user_id,
            notification_type="location_share_created",
            title="Location shared",
            body=f"{owner_label} shared location access with you.",
            notification_tag=f"one-location-share:{grant['id']}",
            request_url=_one_location_url(grantId=grant["id"], locationNotification="opened"),
            data={
                "grant_id": grant["id"],
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "owner_masked_phone": _mask_phone(owner_identity.get("phone_number"))
                if owner_identity
                else None,
                "duration_hours": str(duration),
                "expires_at": grant.get("expiresAt"),
            },
        )
        return grant

    def store_encrypted_envelope(
        self,
        *,
        owner_user_id: str,
        grant_id: str,
        envelope: dict[str, Any],
    ) -> dict[str, Any]:
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
        expires_at = _parse_datetime(grant_row.get("expires_at"), field_name="expires_at")
        if expires_at <= _utcnow():
            self._expire_stale_grants(owner_user_id)
            raise OneLocationAgentError(
                "LOCATION_GRANT_EXPIRED", "Location share has expired.", status_code=410
            )
        recipient_key_id = str(grant_row.get("recipient_key_id") or "")
        if str(envelope.get("recipientKeyId") or recipient_key_id) != recipient_key_id:
            raise OneLocationAgentError(
                "LOCATION_ENVELOPE_KEY_MISMATCH",
                "Envelope key does not match the approved recipient.",
                status_code=422,
            )
        captured_at = _parse_datetime(envelope.get("capturedAt"), field_name="capturedAt")
        row = self._execute_one(
            """
            INSERT INTO one_location_envelopes (
              grant_id, owner_user_id, recipient_user_id, recipient_key_id,
              algorithm, ciphertext, iv, sender_ephemeral_public_key_jwk,
              captured_at, source_platform, created_at, metadata
            )
            VALUES (
              CAST(:grant_id AS UUID), :owner_user_id, :recipient_user_id, :recipient_key_id,
              :algorithm, :ciphertext, :iv, CAST(:sender_key AS JSONB),
              :captured_at, :source_platform, NOW(), CAST(:metadata_json AS JSONB)
            )
            RETURNING *
            """,
            {
                "grant_id": grant_id,
                "owner_user_id": owner_user_id,
                "recipient_user_id": str(grant_row.get("recipient_user_id") or ""),
                "recipient_key_id": recipient_key_id,
                "algorithm": str(envelope.get("algorithm") or "ECDH-P256-AES256-GCM"),
                "ciphertext": str(envelope.get("ciphertext") or ""),
                "iv": str(envelope.get("iv") or ""),
                "sender_key": json.dumps(
                    envelope.get("senderEphemeralPublicKeyJwk"),
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "captured_at": captured_at,
                "source_platform": normalize_source_platform(envelope.get("sourcePlatform")),
                "metadata_json": _json_param(envelope.get("metadata") or {}),
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
        return envelope_payload

    def view_latest_envelope(self, *, recipient_user_id: str, grant_id: str) -> dict[str, Any]:
        self._expire_stale_grants(recipient_user_id)
        grant_row = self._execute_one(
            """
            SELECT
              g.*,
              owner.display_name AS owner_display_name,
              owner.phone_number AS owner_phone_number
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

    def create_public_invite(
        self,
        *,
        owner_user_id: str,
        duration_hours: float,
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
        row = self._execute_one(
            """
            INSERT INTO one_location_public_invites (
              owner_user_id, public_code_hash, status, duration_hours,
              expires_at, created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :public_code_hash, 'active', :duration_hours,
              :expires_at, NOW(), NOW(), '{}'::jsonb
            )
            RETURNING *
            """,
            {
                "owner_user_id": owner_user_id,
                "public_code_hash": token_hash,
                "duration_hours": duration,
                "expires_at": expires_at,
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
            metadata={"invite_id": invite["id"], "duration_hours": duration},
        )
        return {
            "invite": invite,
            "publicToken": raw_token,
            "publicUrl": _public_invite_url(raw_token),
        }

    def resolve_public_invite(self, *, public_token: str) -> dict[str, Any]:
        normalized_token = str(public_token or "").strip()
        if len(normalized_token) < 16:
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_INVALID",
                "This request link is invalid.",
                status_code=404,
            )
        row = self._execute_one(
            """
            SELECT
              i.*,
              owner.display_name AS owner_display_name,
              owner.phone_number AS owner_phone_number
            FROM one_location_public_invites i
            LEFT JOIN actor_identity_cache owner ON owner.user_id = i.owner_user_id
            WHERE i.public_code_hash = :public_code_hash
            LIMIT 1
            """,
            {"public_code_hash": _hash_public_value(normalized_token)},
        )
        row = self._expire_public_invite(row)
        invite = self._public_invite_payload(row)
        if not invite or invite["status"] != "active":
            raise OneLocationAgentError(
                "LOCATION_PUBLIC_INVITE_NOT_ACTIVE",
                "This request link is no longer active.",
                status_code=410 if invite else 404,
            )
        return {"invite": invite}

    def submit_public_invite_request(
        self,
        *,
        public_token: str,
        visitor_display_name: str,
        phone_number: str,
        message: str | None = None,
    ) -> dict[str, Any]:
        invite = self.resolve_public_invite(public_token=public_token)["invite"]
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
        message_value = (message or "").strip()[:500] or None
        owner_user_id = invite["ownerUserId"]
        matched_identity = self._identity_row_by_phone_digits(phone_digits)
        matched_user_id = str(matched_identity.get("user_id") or "") if matched_identity else None
        status_value = "pending_identity"
        request: dict[str, Any] | None = None
        if matched_user_id == owner_user_id:
            matched_user_id = None
        if matched_user_id:
            try:
                request = self.request_access(
                    requester_user_id=matched_user_id,
                    owner_user_id=owner_user_id,
                    message=message_value or f"Public request from {display_name}",
                    notify_owner=False,
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
              CAST(:request_id AS UUID), :status, :message, NOW(), '{}'::jsonb
            )
            RETURNING *
            """,
            {
                "invite_id": invite["id"],
                "owner_user_id": owner_user_id,
                "visitor_display_name": display_name[:120],
                "visitor_phone_hash": _hash_public_value(phone_digits),
                "visitor_phone_last4": phone_digits[-4:],
                "matched_user_id": matched_user_id,
                "request_id": request["id"] if request else None,
                "status": status_value,
                "message": message_value,
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
            },
        )
        self._send_metadata_notification(
            user_id=owner_user_id,
            notification_type="location_public_invite_submitted",
            title="Public location request",
            body=f"{display_name[:80]} requested location access from your link.",
            notification_tag=f"one-location-public-request:{submission['id']}",
            request_url=_one_location_url(requestId=request["id"] if request else None),
            data={
                "submission_id": submission["id"],
                "invite_id": invite["id"],
                "request_id": request["id"] if request else None,
                "visitor_display_label": display_name[:80],
                "visitor_masked_phone": _mask_phone(phone_digits),
                "matched_user_id": matched_user_id,
                "status": status_value,
            },
        )
        return {"submission": submission, "request": request}

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

    def list_state(self, *, user_id: str) -> dict[str, Any]:
        self._expire_stale_grants(user_id)
        recipients = self.list_verified_recipients(owner_user_id=user_id)
        owner_grants = self._execute_many(
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
        )
        received_grants = self._execute_many(
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
        )
        requests = self._execute_many(
            """
            SELECT
              req.*,
              requester.display_name AS requester_display_name,
              requester.phone_number AS requester_phone_number
            FROM one_location_access_requests req
            LEFT JOIN actor_identity_cache requester ON requester.user_id = req.requester_user_id
            WHERE req.owner_user_id = :user_id OR req.requester_user_id = :user_id
            ORDER BY req.requested_at DESC
            LIMIT 50
            """,
            {"user_id": user_id},
        )
        referrals = self._execute_many(
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
        )
        public_invites = self._execute_many(
            """
            SELECT *
            FROM one_location_public_invites
            WHERE owner_user_id = :user_id
            ORDER BY created_at DESC
            LIMIT 20
            """,
            {"user_id": user_id},
        )
        public_submissions = self._execute_many(
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
        )
        return {
            "recipients": recipients,
            "ownerGrants": [
                payload for row in owner_grants if (payload := self._grant_payload(row))
            ],
            "receivedGrants": [
                payload for row in received_grants if (payload := self._grant_payload(row))
            ],
            "requests": [payload for row in requests if (payload := self._request_payload(row))],
            "referrals": [payload for row in referrals if (payload := self._referral_payload(row))],
            "publicInvites": [
                payload
                for row in public_invites
                if (payload := self._public_invite_payload(self._expire_public_invite(row)))
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
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "grant_id": grant_id},
        )
        if not row:
            raise OneLocationAgentError(
                "LOCATION_GRANT_NOT_FOUND", "Active location share was not found.", status_code=404
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=str(row.get("recipient_user_id") or "") or None,
            grant_id=grant_id,
            event_type="location_share_revoked",
            metadata={"reason": "owner_revoke"},
        )
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_display_label(owner_identity)
        self._send_metadata_notification(
            user_id=str(row.get("recipient_user_id") or ""),
            notification_type="location_share_revoked",
            title="Location access revoked",
            body=f"{owner_label} removed your location access.",
            notification_tag=f"one-location-revoked:{grant_id}",
            request_url=_one_location_url(grantId=grant_id),
            data={
                "grant_id": grant_id,
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "owner_masked_phone": _mask_phone(owner_identity.get("phone_number"))
                if owner_identity
                else None,
            },
        )
        return self._grant_payload(row) or {}

    def request_access(
        self,
        *,
        requester_user_id: str,
        owner_user_id: str,
        message: str | None = None,
        referred_by_user_id: str | None = None,
        notify_owner: bool = True,
    ) -> dict[str, Any]:
        if requester_user_id == owner_user_id:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_SELF", "Request a different person's location.", status_code=422
            )
        self._recipient_key_row(recipient_user_id=requester_user_id)
        message_value = (message or "").strip()[:500] or None
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
                  message, requested_at, metadata
                )
                VALUES (
                  :owner_user_id, :requester_user_id, :referred_by_user_id, 'pending',
                  :message, NOW(), '{}'::jsonb
                )
                RETURNING *
                """,
                {
                    "owner_user_id": owner_user_id,
                    "requester_user_id": requester_user_id,
                    "referred_by_user_id": referred_by_user_id,
                    "message": message_value,
                },
            )
        elif message_value and str(row.get("message") or "") != message_value:
            refreshed = self._execute_one(
                """
                UPDATE one_location_access_requests
                SET message = :message,
                    requested_at = NOW()
                WHERE id = CAST(:request_id AS UUID)
                  AND status = 'pending'
                RETURNING *
                """,
                {"request_id": str(row.get("id") or ""), "message": message_value},
            )
            row = refreshed or row
        request = self._request_payload(row)
        if not request:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_CREATE_FAILED",
                "Could not create the access request.",
                status_code=500,
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=requester_user_id,
            recipient_user_id=requester_user_id,
            request_id=request["id"],
            event_type="location_access_request",
            metadata={"referred": bool(referred_by_user_id)},
        )
        requester_identity = self._identity_row(requester_user_id)
        requester_label = _identity_display_label(requester_identity, fallback="Someone")
        if notify_owner:
            self._send_metadata_notification(
                user_id=owner_user_id,
                notification_type="location_access_request",
                title="Location access request",
                body=f"{requester_label} is asking to view your location.",
                notification_tag=f"one-location-request:{request['id']}",
                request_url=_one_location_url(requestId=request["id"]),
                data={
                    "request_id": request["id"],
                    "requester_user_id": requester_user_id,
                    "requester_display_label": requester_label,
                    "requester_masked_phone": _mask_phone(requester_identity.get("phone_number"))
                    if requester_identity
                    else None,
                    "referred_by_user_id": referred_by_user_id,
                },
            )
        return request

    def approve_request(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        duration_hours: float,
    ) -> dict[str, Any]:
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
        grant = self.create_grant(
            owner_user_id=owner_user_id,
            recipient_user_id=requester_user_id,
            recipient_key_id=None,
            duration_hours=duration_hours,
            reason="request_approved",
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
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=requester_user_id,
            grant_id=grant["id"],
            request_id=request_id,
            event_type="location_access_approved",
            metadata={"duration_hours": normalize_duration_hours(duration_hours)},
        )
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_display_label(owner_identity)
        self._send_metadata_notification(
            user_id=requester_user_id,
            notification_type="location_access_approved",
            title="Location request approved",
            body=f"{owner_label} approved your location request.",
            notification_tag=f"one-location-approved:{request_id}",
            request_url=_one_location_url(requestId=request_id, grantId=grant["id"]),
            data={
                "request_id": request_id,
                "grant_id": grant["id"],
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "owner_masked_phone": _mask_phone(owner_identity.get("phone_number"))
                if owner_identity
                else None,
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
        self._insert_event(
            owner_user_id=owner_user_id,
            actor_user_id=owner_user_id,
            recipient_user_id=str(row.get("requester_user_id") or "") or None,
            request_id=request_id,
            event_type="location_access_denied",
            metadata={},
        )
        owner_identity = self._identity_row(owner_user_id)
        owner_label = _identity_display_label(owner_identity)
        self._send_metadata_notification(
            user_id=str(row.get("requester_user_id") or ""),
            notification_type="location_access_denied",
            title="Location request denied",
            body=f"{owner_label} denied your location request.",
            notification_tag=f"one-location-denied:{request_id}",
            request_url=_one_location_url(requestId=request_id),
            data={
                "request_id": request_id,
                "owner_user_id": owner_user_id,
                "owner_display_label": owner_label,
                "owner_masked_phone": _mask_phone(owner_identity.get("phone_number"))
                if owner_identity
                else None,
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
              AND expires_at > NOW()
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
        owner_label = _identity_display_label(self._identity_row(owner_user_id))
        referring_identity = self._identity_row(referring_user_id)
        referring_label = _identity_display_label(referring_identity)
        if referral_payload:
            self._send_metadata_notification(
                user_id=referred_user_id,
                notification_type="location_referral_invite",
                title="Location referral pending",
                body=f"{referring_label} referred you into a location request.",
                notification_tag=f"one-location-referral:{referral_payload['id']}",
                request_url=_one_location_url(
                    requestId=request["id"], referralId=referral_payload["id"]
                ),
                data={
                    "request_id": request["id"],
                    "referral_id": referral_payload["id"],
                    "grant_id": grant_id,
                    "owner_user_id": owner_user_id,
                    "owner_display_label": owner_label,
                    "referring_user_id": referring_user_id,
                    "referring_display_label": referring_label,
                    "referring_masked_phone": _mask_phone(referring_identity.get("phone_number"))
                    if referring_identity
                    else None,
                },
            )
        return {"referral": referral_payload, "request": request}


def location_error_detail(exc: OneLocationAgentError) -> dict[str, str]:
    return {"code": exc.code, "message": exc.message}


def database_error_detail(exc: DatabaseExecutionError) -> dict[str, str]:
    return {
        "code": exc.code,
        "message": exc.details,
        "hint": exc.hint or "",
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
