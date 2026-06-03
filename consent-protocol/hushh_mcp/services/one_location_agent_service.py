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
LOCATION_TERMINAL_RETENTION_HOURS = 12


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
    "location_referral_invite",
    "location_public_invite_created",
    "location_public_invite_revoked",
    "location_public_invite_submitted",
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
    "location_referral_invite",
}
ONE_LOCATION_PUBLIC_ACTIVITY_TYPES = {
    "location_public_invite_created",
    "location_public_invite_revoked",
    "location_public_invite_submitted",
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
    path = f"/one/location/request/{token}"
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

    def _optional_signal_rows(
        self,
        *,
        signal_name: str,
        sql: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        try:
            return self._execute_many(sql, params or {})
        except Exception as exc:
            logger.debug(
                "one.location.kai_circle_signal_unavailable signal=%s error=%s",
                signal_name,
                exc,
            )
            return []

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
    ) -> None:
        grant_rows = self._optional_signal_rows(
            signal_name="one_location_grants",
            sql="""
            SELECT owner_user_id, recipient_user_id, status, created_at, updated_at,
                   expires_at, revoked_at
            FROM one_location_share_grants
            WHERE owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id
            ORDER BY created_at DESC
            LIMIT 100
            """,
            params={"owner_user_id": owner_user_id},
        )
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

        request_rows = self._optional_signal_rows(
            signal_name="one_location_requests",
            sql="""
            SELECT owner_user_id, requester_user_id, referred_by_user_id, status,
                   requested_at, resolved_at
            FROM one_location_access_requests
            WHERE owner_user_id = :owner_user_id OR requester_user_id = :owner_user_id
            ORDER BY requested_at DESC
            LIMIT 100
            """,
            params={"owner_user_id": owner_user_id},
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

        referral_rows = self._optional_signal_rows(
            signal_name="one_location_referrals",
            sql="""
            SELECT owner_user_id, referring_user_id, referred_user_id, status,
                   created_at, resolved_at
            FROM one_location_referrals
            WHERE owner_user_id = :owner_user_id
               OR referring_user_id = :owner_user_id
               OR referred_user_id = :owner_user_id
            ORDER BY created_at DESC
            LIMIT 100
            """,
            params={"owner_user_id": owner_user_id},
        )
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
    ) -> None:
        rows = self._optional_signal_rows(
            signal_name="consent_audit",
            sql="""
            SELECT user_id, agent_id, action, issued_at
            FROM consent_audit
            WHERE user_id = :owner_user_id OR agent_id = :owner_user_id
            ORDER BY issued_at DESC
            LIMIT 100
            """,
            params={"owner_user_id": owner_user_id},
        )
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

    def _add_mutual_kai_relationship_signals(
        self,
        *,
        owner_user_id: str,
        recipient_ids: set[str],
        signals: dict[str, dict[str, Any]],
    ) -> None:
        rows = self._optional_signal_rows(
            signal_name="mutual_kai_relationships",
            sql="""
            SELECT rel.investor_user_id, rel.status, rel.created_at, rel.updated_at,
                   rp.user_id AS ria_user_id
            FROM advisor_investor_relationships rel
            JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
            WHERE rel.status IN ('approved', 'request_pending', 'discovered')
            ORDER BY COALESCE(rel.updated_at, rel.created_at) DESC
            LIMIT 500
            """,
            params={"owner_user_id": owner_user_id},
        )
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
    ) -> None:
        rows = self._optional_signal_rows(
            signal_name="advisor_investor_relationships",
            sql="""
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
            LEFT JOIN relationship_share_grants share
              ON share.relationship_id = rel.id
             AND share.status = 'active'
            WHERE rel.investor_user_id = :owner_user_id
               OR rp.user_id = :owner_user_id
            ORDER BY COALESCE(rel.consent_granted_at, rel.updated_at, rel.created_at) DESC
            LIMIT 100
            """,
            params={"owner_user_id": owner_user_id},
        )
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
            if status == "approved" or share_status == "active":
                self._add_recommendation_reason(
                    signal,
                    code="approved_professional_relationship",
                    label="Approved advisor/investor relationship",
                    weight=38,
                )
                signal["trusted"] = True
            elif status == "request_pending":
                self._add_recommendation_reason(
                    signal,
                    code="pending_professional_relationship",
                    label="Pending advisor/investor relationship",
                    weight=20,
                )
            else:
                self._add_recommendation_reason(
                    signal,
                    code="professional_graph_proximity",
                    label="Advisor/investor network connection",
                    weight=16,
                )
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
    ) -> None:
        rows = self._optional_signal_rows(
            signal_name="ria_firm_memberships",
            sql="""
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
            params={"owner_user_id": owner_user_id},
        )
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
    ) -> None:
        rows = self._optional_signal_rows(
            signal_name="marketplace_public_profiles",
            sql="""
            SELECT user_id, profile_type, headline, strategy_summary,
                   verification_badge, metadata, updated_at, created_at
            FROM marketplace_public_profiles
            WHERE is_discoverable = TRUE
            ORDER BY updated_at DESC
            LIMIT 200
            """,
            params={"owner_user_id": owner_user_id},
        )
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
    ) -> None:
        rows = self._optional_signal_rows(
            signal_name="runtime_persona_state",
            sql="""
            SELECT user_id, last_active_persona, updated_at
            FROM runtime_persona_state
            WHERE user_id <> :owner_user_id
            ORDER BY updated_at DESC
            LIMIT 200
            """,
            params={"owner_user_id": owner_user_id},
        )
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
    ) -> list[dict[str, Any]]:
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
                    label="Ready for encrypted location sharing",
                    weight=28,
                )
            else:
                self._add_recommendation_reason(
                    signal,
                    code="recipient_key_missing",
                    label="Needs to open One Location once",
                    weight=4,
                )

        self._add_one_location_history_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
        )
        self._add_prior_consent_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
        )
        self._add_mutual_kai_relationship_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
        )
        self._add_professional_network_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
        )
        self._add_organization_membership_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
        )
        self._add_marketplace_profile_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
        )
        self._add_persona_signals(
            owner_user_id=owner_user_id,
            recipient_ids=recipient_ids,
            signals=signals,
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
            if not can_receive:
                category = "needs_setup"
                tier = "setup_needed"
                trust_level = "setup_needed"
                category_label = "Needs setup"
                summary = "They need to open One Location once before encrypted sharing."
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
                summary = "Verified KAI member with recipient encryption ready."

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
            return {
                "status": str(row.get("status") or "active"),
                "durationHours": float(row.get("duration_hours") or 0),
                "expiresAt": _iso(row.get("expires_at")),
                "ownerLabel": safe_label or PUBLIC_INVITE_DEFAULT_OWNER_LABEL,
            }
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
        elif event_type == "location_referral_invite":
            title = f"Referral added for {recipient_label}"
        elif event_type == "location_public_invite_created":
            title = "Request link created"
        elif event_type == "location_public_invite_revoked":
            title = "Request link closed"
        elif event_type == "location_public_invite_submitted":
            title = f"Response from {visitor_label}"

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

    def _expire_stale_grants(self, user_id: str) -> None:
        retention_cutoff = _utcnow() - timedelta(hours=LOCATION_TERMINAL_RETENTION_HOURS)
        expired = self._execute_many(
            """
            UPDATE one_location_share_grants
            SET status = 'expired', updated_at = NOW()
            WHERE status = 'active'
              AND expires_at <= NOW()
              AND (owner_user_id = :user_id OR recipient_user_id = :user_id)
            RETURNING id, owner_user_id, recipient_user_id, expires_at
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
        self._purge_terminal_work(user_id=user_id)

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
            )
            SELECT
              (SELECT COUNT(*) FROM deleted_grants) AS deleted_grants,
              (SELECT COUNT(*) FROM deleted_envelopes) AS deleted_envelopes,
              (SELECT COUNT(*) FROM deleted_requests) AS deleted_requests,
              (SELECT COUNT(*) FROM deleted_referrals) AS deleted_referrals,
              (SELECT COUNT(*) FROM deleted_public_invites) AS deleted_public_invites,
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
            "deleted_public_submissions": int(row.get("deleted_public_submissions") or 0),
            "deleted_events": int(row.get("deleted_events") or 0),
            "retention_hours": hours,
        }

    def purge_terminal_work(
        self, *, older_than_hours: float = LOCATION_TERMINAL_RETENTION_HOURS
    ) -> dict[str, Any]:
        return self._purge_terminal_work(user_id=None, older_than_hours=older_than_hours)

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
        recipients = [payload for row in rows if (payload := self._recipient_payload(row))]
        return self._apply_kai_circle_recommendations(
            owner_user_id=owner_user_id,
            recipients=recipients,
        )

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
        return {"invite": invite}

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
                        "intake_only": True,
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
                "intake_only": True,
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
        return {"submission": self._public_submission_payload(row, public=True)}

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
