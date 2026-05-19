from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from api.utils.fcm_messages import build_push_message
from api.utils.firebase_admin import ensure_firebase_admin
from db.db_client import DatabaseExecutionError, get_db

logger = logging.getLogger(__name__)

LocationContactTier = Literal["family", "friend"]
LocationShareStatus = Literal["active", "expired", "deactivated", "revoked"]
LocationAccessRequestStatus = Literal["pending", "approved", "denied", "auto_approved"]

MAX_FAMILY_CONTACTS = 3
MAX_FRIEND_CONTACTS = 7
MAX_SHARE_HOURS = 24
FRESH_FIX_WINDOW = timedelta(minutes=10)
TOKEN_BYTES = 32
PUBLIC_LIVE_POLL_INTERVAL_MS = 10_000
PUBLIC_LIVE_STALE_AFTER_SECONDS = 90
COORDINATE_METADATA_KEYS = {
    "lat",
    "latitude",
    "lng",
    "lon",
    "long",
    "longitude",
    "accuracy",
    "accuracy_m",
    "heading",
    "speed",
    "coordinates",
    "location",
}


class KaiLocationError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


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
        if not raw:
            return _utcnow()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise KaiLocationError(
                "LOCATION_TIMESTAMP_INVALID",
                f"{field_name} must be an ISO-8601 timestamp.",
                status_code=422,
            ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validate_point(point: dict[str, Any], *, require_fresh: bool) -> dict[str, Any]:
    try:
        latitude = float(point.get("latitude"))
        longitude = float(point.get("longitude"))
    except (TypeError, ValueError) as exc:
        raise KaiLocationError(
            "LOCATION_POINT_INVALID",
            "A valid latitude and longitude are required.",
            status_code=422,
        ) from exc

    if latitude < -90 or latitude > 90 or longitude < -180 or longitude > 180:
        raise KaiLocationError(
            "LOCATION_POINT_INVALID",
            "Latitude or longitude is outside the valid GPS range.",
            status_code=422,
        )

    captured_at = _parse_datetime(point.get("captured_at") or point.get("capturedAt"), field_name="captured_at")
    if require_fresh and _utcnow() - captured_at > FRESH_FIX_WINDOW:
        raise KaiLocationError(
            "LOCATION_FIX_STALE",
            "A fresh GPS fix is required before sharing location.",
            status_code=409,
        )

    def optional_float(name: str) -> float | None:
        raw = point.get(name)
        if raw is None or raw == "":
            return None
        try:
            return float(raw)
        except (TypeError, ValueError) as exc:
            raise KaiLocationError(
                "LOCATION_POINT_INVALID",
                f"{name} must be a number.",
                status_code=422,
            ) from exc

    accuracy_m = optional_float("accuracy_m")
    if accuracy_m is None:
        accuracy_m = optional_float("accuracyM")
    heading_deg = optional_float("heading_deg")
    if heading_deg is None:
        heading_deg = optional_float("headingDeg")
    speed_mps = optional_float("speed_mps")
    if speed_mps is None:
        speed_mps = optional_float("speedMps")
    source_platform = str(point.get("source_platform") or point.get("sourcePlatform") or "web").strip().lower()
    if source_platform not in {"web", "ios", "android", "native", "unknown"}:
        source_platform = "unknown"

    return {
        "latitude": latitude,
        "longitude": longitude,
        "accuracy_m": accuracy_m,
        "heading_deg": heading_deg,
        "speed_mps": speed_mps,
        "captured_at": captured_at,
        "source_platform": source_platform,
    }


def _redact_coordinate_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key).strip().lower()
            if normalized_key in COORDINATE_METADATA_KEYS:
                continue
            redacted[str(key)] = _redact_coordinate_metadata(item)
        return redacted
    if isinstance(value, list):
        return [_redact_coordinate_metadata(item) for item in value]
    return value


def _json_param(value: dict[str, Any] | None) -> str:
    return json.dumps(_redact_coordinate_metadata(value or {}), separators=(",", ":"))


def _contact_limit(tier: str) -> int:
    return MAX_FAMILY_CONTACTS if tier == "family" else MAX_FRIEND_CONTACTS


def _build_request_url(request_id: str) -> str:
    base = (
        os.getenv("NEXT_PUBLIC_APP_URL")
        or os.getenv("APP_PUBLIC_URL")
        or os.getenv("FRONTEND_BASE_URL")
        or ""
    ).strip().rstrip("/")
    path = f"/kai/location?requestId={request_id}"
    return f"{base}{path}" if base else path


def _public_live_payload(*, row: dict[str, Any] | None, latest: dict[str, Any] | None = None) -> dict[str, Any]:
    server_time = _utcnow()
    share_status = str(row.get("status") or "") if row else "invalid"
    live_mode = bool(row.get("live_mode")) if row else False
    stopped_at = None
    if row:
        stopped_at = row.get("revoked_at") or row.get("deactivated_at")
    captured_at = latest.get("capturedAt") if latest else None
    freshness_seconds = None
    if captured_at:
        try:
            captured = _parse_datetime(captured_at, field_name="captured_at")
            freshness_seconds = max(0, int((server_time - captured).total_seconds()))
        except KaiLocationError:
            freshness_seconds = None
    return {
        "transport": "gcp_polling",
        "pollIntervalMs": PUBLIC_LIVE_POLL_INTERVAL_MS,
        "staleAfterSeconds": PUBLIC_LIVE_STALE_AFTER_SECONDS,
        "serverTime": _iso(server_time),
        "isLive": share_status == "active" and live_mode and latest is not None,
        "freshnessSeconds": freshness_seconds,
        "stoppedAt": _iso(stopped_at),
    }


class KaiLocationService:
    def _execute_one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params)
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params)
        return result.data or []

    @staticmethod
    def _contact_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "displayName": str(row.get("display_name") or ""),
            "tier": str(row.get("tier") or "friend"),
            "autoApprove": bool(row.get("auto_approve")),
            "status": str(row.get("status") or "active"),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
        }

    @staticmethod
    def _latest_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "latitude": float(row.get("latitude")),
            "longitude": float(row.get("longitude")),
            "accuracyM": row.get("accuracy_m"),
            "headingDeg": row.get("heading_deg"),
            "speedMps": row.get("speed_mps"),
            "capturedAt": _iso(row.get("captured_at")),
            "sourcePlatform": str(row.get("source_platform") or "unknown"),
            "updatedAt": _iso(row.get("updated_at")),
        }

    @staticmethod
    def _share_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "contactId": str(row.get("contact_id") or "") or None,
            "contactDisplayName": str(row.get("contact_display_name") or "") or None,
            "contactTier": str(row.get("contact_tier") or "") or None,
            "contactAutoApprove": bool(row.get("contact_auto_approve")) if row.get("contact_auto_approve") is not None else None,
            "status": str(row.get("status") or "active"),
            "liveMode": bool(row.get("live_mode")),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "lastViewedAt": _iso(row.get("last_viewed_at")),
            "deactivatedAt": _iso(row.get("deactivated_at")),
            "revokedAt": _iso(row.get("revoked_at")),
        }

    @staticmethod
    def _request_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "id": str(row.get("id") or ""),
            "shareId": str(row.get("share_id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "contactId": str(row.get("contact_id") or "") or None,
            "contactDisplayName": str(row.get("contact_display_name") or "") or None,
            "contactTier": str(row.get("contact_tier") or "") or None,
            "status": str(row.get("status") or "pending"),
            "requesterLabel": str(row.get("requester_label") or "") or None,
            "requesterMessage": str(row.get("requester_message") or "") or None,
            "requestedAt": _iso(row.get("requested_at")),
            "resolvedAt": _iso(row.get("resolved_at")),
            "renewedShareId": str(row.get("renewed_share_id") or "") or None,
        }

    def _insert_event(
        self,
        *,
        owner_user_id: str,
        event_type: str,
        contact_id: str | None = None,
        share_id: str | None = None,
        request_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        try:
            self._execute_one(
                """
                INSERT INTO kai_location_events (
                  owner_user_id, contact_id, share_id, request_id, event_type, metadata, created_at
                )
                VALUES (
                  :owner_user_id, CAST(:contact_id AS UUID), CAST(:share_id AS UUID),
                  CAST(:request_id AS UUID), :event_type, CAST(:metadata_json AS JSONB), NOW()
                )
                """,
                {
                    "owner_user_id": owner_user_id,
                    "contact_id": contact_id,
                    "share_id": share_id,
                    "request_id": request_id,
                    "event_type": event_type,
                    "metadata_json": _json_param(metadata),
                },
            )
        except Exception as exc:
            logger.warning("kai.location.event_insert_failed type=%s error=%s", event_type, exc)

    def _expire_stale_update_sessions(self, owner_user_id: str) -> None:
        self._execute_many(
            """
            UPDATE kai_location_update_sessions
            SET status = 'expired', updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND status = 'active'
              AND expires_at <= NOW()
            RETURNING id
            """,
            {"owner_user_id": owner_user_id},
        )

    def _revoke_update_sessions_if_no_active_shares(self, owner_user_id: str) -> None:
        row = self._execute_one(
            """
            SELECT COUNT(*) AS active_count
            FROM kai_location_shares
            WHERE owner_user_id = :owner_user_id
              AND status = 'active'
              AND expires_at > NOW()
            """,
            {"owner_user_id": owner_user_id},
        )
        if int(row.get("active_count") or 0) > 0:
            return
        revoked = self._execute_many(
            """
            UPDATE kai_location_update_sessions
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING id
            """,
            {"owner_user_id": owner_user_id},
        )
        for row in revoked:
            self._insert_event(
                owner_user_id=owner_user_id,
                event_type="UPDATE_SESSION_REVOKED",
                metadata={"session_id": str(row.get("id") or ""), "reason": "no_active_shares"},
            )

    def upsert_latest_point(
        self,
        *,
        owner_user_id: str,
        point: dict[str, Any],
        require_fresh: bool = False,
    ) -> dict[str, Any]:
        normalized = _validate_point(point, require_fresh=require_fresh)
        row = self._execute_one(
            """
            INSERT INTO kai_location_latest (
              owner_user_id, latitude, longitude, accuracy_m, heading_deg, speed_mps,
              captured_at, source_platform, updated_at
            )
            VALUES (
              :owner_user_id, :latitude, :longitude, :accuracy_m, :heading_deg, :speed_mps,
              :captured_at, :source_platform, NOW()
            )
            ON CONFLICT (owner_user_id) DO UPDATE SET
              latitude = EXCLUDED.latitude,
              longitude = EXCLUDED.longitude,
              accuracy_m = EXCLUDED.accuracy_m,
              heading_deg = EXCLUDED.heading_deg,
              speed_mps = EXCLUDED.speed_mps,
              captured_at = EXCLUDED.captured_at,
              source_platform = EXCLUDED.source_platform,
              updated_at = NOW()
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, **normalized},
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            event_type="LOCATION_UPDATED",
            metadata={"source_platform": normalized["source_platform"]},
        )
        payload = self._latest_payload(row)
        if not payload:
            raise KaiLocationError("LOCATION_UPDATE_FAILED", "Could not store the latest location.", status_code=500)
        return payload

    def create_contact(
        self,
        *,
        owner_user_id: str,
        display_name: str,
        tier: LocationContactTier,
        auto_approve: bool,
    ) -> dict[str, Any]:
        normalized_name = str(display_name or "").strip()
        if len(normalized_name) < 1 or len(normalized_name) > 120:
            raise KaiLocationError("CONTACT_NAME_INVALID", "Recipient name is required.", status_code=422)
        normalized_tier = str(tier or "").strip().lower()
        if normalized_tier not in {"family", "friend"}:
            raise KaiLocationError("CONTACT_TIER_INVALID", "Recipient tier must be family or friend.", status_code=422)
        normalized_auto_approve = bool(auto_approve and normalized_tier == "family")

        count_row = self._execute_one(
            """
            SELECT COUNT(*) AS active_count
            FROM kai_location_contacts
            WHERE owner_user_id = :owner_user_id
              AND tier = :tier
              AND status = 'active'
            """,
            {"owner_user_id": owner_user_id, "tier": normalized_tier},
        )
        if int(count_row.get("active_count") or 0) >= _contact_limit(normalized_tier):
            raise KaiLocationError(
                "CONTACT_LIMIT_REACHED",
                "You can keep up to 3 family members and 7 friends active for location sharing.",
                status_code=409,
            )

        row = self._execute_one(
            """
            INSERT INTO kai_location_contacts (
              owner_user_id, display_name, tier, auto_approve, status, metadata, created_at, updated_at
            )
            VALUES (
              :owner_user_id, :display_name, :tier, :auto_approve, 'active',
              '{}'::jsonb, NOW(), NOW()
            )
            RETURNING *
            """,
            {
                "owner_user_id": owner_user_id,
                "display_name": normalized_name,
                "tier": normalized_tier,
                "auto_approve": normalized_auto_approve,
            },
        )
        contact = self._contact_payload(row)
        if not contact:
            raise KaiLocationError("CONTACT_CREATE_FAILED", "Could not create the recipient.", status_code=500)
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=contact["id"],
            event_type="CONTACT_CREATED",
            metadata={"tier": normalized_tier, "auto_approve": normalized_auto_approve},
        )
        return contact

    def update_contact(
        self,
        *,
        owner_user_id: str,
        contact_id: str,
        display_name: str | None = None,
        auto_approve: bool | None = None,
    ) -> dict[str, Any]:
        existing = self._execute_one(
            """
            SELECT *
            FROM kai_location_contacts
            WHERE id = CAST(:contact_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            """,
            {"owner_user_id": owner_user_id, "contact_id": contact_id},
        )
        if not existing:
            raise KaiLocationError("CONTACT_NOT_FOUND", "Recipient was not found.", status_code=404)
        tier = str(existing.get("tier") or "friend")
        next_name = str(display_name if display_name is not None else existing.get("display_name") or "").strip()
        if len(next_name) < 1 or len(next_name) > 120:
            raise KaiLocationError("CONTACT_NAME_INVALID", "Recipient name is required.", status_code=422)
        next_auto = bool(auto_approve) if auto_approve is not None else bool(existing.get("auto_approve"))
        if tier != "family":
            next_auto = False
        row = self._execute_one(
            """
            UPDATE kai_location_contacts
            SET display_name = :display_name,
                auto_approve = :auto_approve,
                updated_at = NOW()
            WHERE id = CAST(:contact_id AS UUID)
              AND owner_user_id = :owner_user_id
            RETURNING *
            """,
            {
                "owner_user_id": owner_user_id,
                "contact_id": contact_id,
                "display_name": next_name,
                "auto_approve": next_auto,
            },
        )
        contact = self._contact_payload(row)
        if not contact:
            raise KaiLocationError("CONTACT_UPDATE_FAILED", "Could not update the recipient.", status_code=500)
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=contact_id,
            event_type="CONTACT_UPDATED",
            metadata={"auto_approve": next_auto},
        )
        return contact

    def revoke_contact(self, *, owner_user_id: str, contact_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE kai_location_contacts
            SET status = 'revoked',
                auto_approve = FALSE,
                revoked_at = COALESCE(revoked_at, NOW()),
                updated_at = NOW()
            WHERE id = CAST(:contact_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "contact_id": contact_id},
        )
        if not row:
            raise KaiLocationError("CONTACT_NOT_FOUND", "Recipient was not found.", status_code=404)
        revoked_shares = self._execute_many(
            """
            UPDATE kai_location_shares
            SET status = 'revoked',
                revoked_at = COALESCE(revoked_at, NOW()),
                updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND contact_id = CAST(:contact_id AS UUID)
              AND status = 'active'
            RETURNING id
            """,
            {"owner_user_id": owner_user_id, "contact_id": contact_id},
        )
        for share in revoked_shares:
            self._insert_event(
                owner_user_id=owner_user_id,
                contact_id=contact_id,
                share_id=str(share.get("id") or ""),
                event_type="SHARE_REVOKED",
                metadata={"reason": "contact_revoked"},
            )
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=contact_id,
            event_type="CONTACT_REVOKED",
            metadata={"revoked_active_shares": len(revoked_shares)},
        )
        self._revoke_update_sessions_if_no_active_shares(owner_user_id)
        contact = self._contact_payload(row)
        if not contact:
            raise KaiLocationError("CONTACT_REVOKE_FAILED", "Could not revoke the recipient.", status_code=500)
        return contact

    def list_owner_state(self, *, owner_user_id: str) -> dict[str, Any]:
        self._expire_stale_update_sessions(owner_user_id)
        contacts = self._execute_many(
            """
            SELECT *
            FROM kai_location_contacts
            WHERE owner_user_id = :owner_user_id
            ORDER BY
              CASE status WHEN 'active' THEN 0 ELSE 1 END,
              CASE tier WHEN 'family' THEN 0 ELSE 1 END,
              created_at DESC
            """,
            {"owner_user_id": owner_user_id},
        )
        shares = self._execute_many(
            """
            SELECT
              s.*,
              c.display_name AS contact_display_name,
              c.tier AS contact_tier,
              c.auto_approve AS contact_auto_approve
            FROM kai_location_shares s
            LEFT JOIN kai_location_contacts c ON c.id = s.contact_id
            WHERE s.owner_user_id = :owner_user_id
            ORDER BY s.created_at DESC
            LIMIT 50
            """,
            {"owner_user_id": owner_user_id},
        )
        requests = self._execute_many(
            """
            SELECT
              r.*,
              c.display_name AS contact_display_name,
              c.tier AS contact_tier
            FROM kai_location_access_requests r
            LEFT JOIN kai_location_contacts c ON c.id = r.contact_id
            WHERE r.owner_user_id = :owner_user_id
            ORDER BY
              CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
              r.requested_at DESC
            LIMIT 50
            """,
            {"owner_user_id": owner_user_id},
        )
        latest = self._execute_one(
            "SELECT * FROM kai_location_latest WHERE owner_user_id = :owner_user_id",
            {"owner_user_id": owner_user_id},
        )
        return {
            "contacts": [self._contact_payload(row) for row in contacts],
            "shares": [self._share_payload(row) for row in shares],
            "accessRequests": [self._request_payload(row) for row in requests],
            "latest": self._latest_payload(latest),
            "limits": {"family": MAX_FAMILY_CONTACTS, "friend": MAX_FRIEND_CONTACTS},
        }

    def create_share(
        self,
        *,
        owner_user_id: str,
        contact_id: str,
        point: dict[str, Any],
        duration_hours: float = MAX_SHARE_HOURS,
        live_mode: bool = True,
    ) -> dict[str, Any]:
        try:
            duration = float(duration_hours)
        except (TypeError, ValueError) as exc:
            raise KaiLocationError("SHARE_DURATION_INVALID", "durationHours must be a number.", status_code=422) from exc
        if duration <= 0 or duration > MAX_SHARE_HOURS:
            raise KaiLocationError("SHARE_DURATION_INVALID", "Location links can be active for at most 24 hours.", status_code=422)

        contact = self._execute_one(
            """
            SELECT *
            FROM kai_location_contacts
            WHERE id = CAST(:contact_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'active'
            """,
            {"owner_user_id": owner_user_id, "contact_id": contact_id},
        )
        if not contact:
            raise KaiLocationError("CONTACT_NOT_FOUND", "Create an active recipient before sharing location.", status_code=404)

        latest = self.upsert_latest_point(owner_user_id=owner_user_id, point=point, require_fresh=True)
        token = _new_token()
        row = self._execute_one(
            """
            INSERT INTO kai_location_shares (
              owner_user_id, contact_id, token_hash, status, live_mode,
              expires_at, created_at, updated_at
            )
            VALUES (
              :owner_user_id, CAST(:contact_id AS UUID), :token_hash, 'active', :live_mode,
              NOW() + (:duration_hours * INTERVAL '1 hour'), NOW(), NOW()
            )
            RETURNING
              *,
              :contact_display_name AS contact_display_name,
              :contact_tier AS contact_tier,
              :contact_auto_approve AS contact_auto_approve
            """,
            {
                "owner_user_id": owner_user_id,
                "contact_id": contact_id,
                "token_hash": _token_hash(token),
                "live_mode": bool(live_mode),
                "duration_hours": duration,
                "contact_display_name": contact.get("display_name"),
                "contact_tier": contact.get("tier"),
                "contact_auto_approve": contact.get("auto_approve"),
            },
        )
        share = self._share_payload(row)
        if not share:
            raise KaiLocationError("SHARE_CREATE_FAILED", "Could not create the location share.", status_code=500)
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=contact_id,
            share_id=share["id"],
            event_type="SHARE_CREATED",
            metadata={"duration_hours": duration, "live_mode": bool(live_mode)},
        )
        return {"share": share, "token": token, "latest": latest}

    def revoke_share(self, *, owner_user_id: str, share_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE kai_location_shares
            SET status = 'revoked',
                revoked_at = COALESCE(revoked_at, NOW()),
                updated_at = NOW()
            WHERE id = CAST(:share_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status IN ('active', 'expired', 'deactivated')
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "share_id": share_id},
        )
        if not row:
            raise KaiLocationError("SHARE_NOT_FOUND", "Location share was not found.", status_code=404)
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=str(row.get("contact_id") or "") or None,
            share_id=share_id,
            event_type="SHARE_REVOKED",
            metadata={"reason": "owner_revoked"},
        )
        self._revoke_update_sessions_if_no_active_shares(owner_user_id)
        share = self._share_payload(row)
        if not share:
            raise KaiLocationError("SHARE_REVOKE_FAILED", "Could not revoke the share.", status_code=500)
        return share

    def stop_active_shares(self, *, owner_user_id: str) -> dict[str, Any]:
        rows = self._execute_many(
            """
            UPDATE kai_location_shares
            SET status = 'revoked',
                revoked_at = COALESCE(revoked_at, NOW()),
                updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND status = 'active'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id},
        )
        for row in rows:
            self._insert_event(
                owner_user_id=owner_user_id,
                contact_id=str(row.get("contact_id") or "") or None,
                share_id=str(row.get("id") or "") or None,
                event_type="SHARE_REVOKED",
                metadata={"reason": "owner_stop_live_location"},
            )
        self._revoke_update_sessions_if_no_active_shares(owner_user_id)
        return {
            "shares": [self._share_payload(row) for row in rows],
            "stoppedCount": len(rows),
        }

    def resolve_public_share(self, *, token: str) -> dict[str, Any]:
        normalized_token = str(token or "").strip()
        if not normalized_token:
            return {"state": "invalid", "canRequestAccess": False, "share": None, "latest": None, "live": None}
        row = self._execute_one(
            """
            SELECT
              s.*,
              c.display_name AS contact_display_name,
              c.tier AS contact_tier,
              c.auto_approve AS contact_auto_approve,
              c.status AS contact_status
            FROM kai_location_shares s
            LEFT JOIN kai_location_contacts c ON c.id = s.contact_id
            WHERE s.token_hash = :token_hash
            LIMIT 1
            """,
            {"token_hash": _token_hash(normalized_token)},
        )
        if not row:
            return {"state": "invalid", "canRequestAccess": False, "share": None, "latest": None, "live": None}

        status_value = str(row.get("status") or "active")
        share_id = str(row.get("id") or "")
        owner_user_id = str(row.get("owner_user_id") or "")
        expires_at = row.get("expires_at")
        if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        is_expired = isinstance(expires_at, datetime) and expires_at <= _utcnow()

        if status_value == "active" and is_expired:
            row = self._execute_one(
                """
                UPDATE kai_location_shares
                SET status = 'deactivated',
                    deactivated_at = COALESCE(deactivated_at, NOW()),
                    updated_at = NOW()
                WHERE id = CAST(:share_id AS UUID)
                RETURNING
                  *,
                  :contact_display_name AS contact_display_name,
                  :contact_tier AS contact_tier,
                  :contact_auto_approve AS contact_auto_approve
                """,
                {
                    "share_id": share_id,
                    "contact_display_name": row.get("contact_display_name"),
                    "contact_tier": row.get("contact_tier"),
                    "contact_auto_approve": row.get("contact_auto_approve"),
                },
            ) or row
            self._insert_event(
                owner_user_id=owner_user_id,
                contact_id=str(row.get("contact_id") or "") or None,
                share_id=share_id,
                event_type="SHARE_DEACTIVATED",
                metadata={"reason": "expired_public_open"},
            )
            self._revoke_update_sessions_if_no_active_shares(owner_user_id)
            return {
                "state": "expired",
                "canRequestAccess": True,
                "share": self._share_payload(row),
                "latest": None,
                "live": _public_live_payload(row=row, latest=None),
            }

        if status_value != "active":
            return {
                "state": status_value,
                "canRequestAccess": status_value in {"expired", "deactivated"},
                "share": self._share_payload(row),
                "latest": None,
                "live": _public_live_payload(row=row, latest=None),
            }

        updated_row = self._execute_one(
            """
            UPDATE kai_location_shares
            SET last_viewed_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:share_id AS UUID)
            RETURNING
              *,
              :contact_display_name AS contact_display_name,
              :contact_tier AS contact_tier,
              :contact_auto_approve AS contact_auto_approve
            """,
            {
                "share_id": share_id,
                "contact_display_name": row.get("contact_display_name"),
                "contact_tier": row.get("contact_tier"),
                "contact_auto_approve": row.get("contact_auto_approve"),
            },
        ) or row
        latest = self._execute_one(
            "SELECT * FROM kai_location_latest WHERE owner_user_id = :owner_user_id",
            {"owner_user_id": owner_user_id},
        )
        latest_payload = self._latest_payload(latest)
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=str(updated_row.get("contact_id") or "") or None,
            share_id=share_id,
            event_type="SHARE_VIEWED",
            metadata={"status": "active"},
        )
        return {
            "state": "active",
            "canRequestAccess": False,
            "share": self._share_payload(updated_row),
            "latest": latest_payload,
            "live": _public_live_payload(row=updated_row, latest=latest_payload),
        }

    def request_access(
        self,
        *,
        token: str,
        requester_label: str | None = None,
        requester_message: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        share_row = self._execute_one(
            """
            SELECT
              s.*,
              c.display_name AS contact_display_name,
              c.tier AS contact_tier,
              c.auto_approve AS contact_auto_approve,
              c.status AS contact_status
            FROM kai_location_shares s
            LEFT JOIN kai_location_contacts c ON c.id = s.contact_id
            WHERE s.token_hash = :token_hash
            LIMIT 1
            """,
            {"token_hash": _token_hash(str(token or "").strip())},
        )
        if not share_row:
            raise KaiLocationError("SHARE_NOT_FOUND", "This location link is no longer valid.", status_code=404)

        owner_user_id = str(share_row.get("owner_user_id") or "")
        share_id = str(share_row.get("id") or "")
        contact_id = str(share_row.get("contact_id") or "") or None
        contact_tier = str(share_row.get("contact_tier") or "")
        share_status = str(share_row.get("status") or "")
        expires_at = _parse_datetime(share_row.get("expires_at"), field_name="expires_at")
        contact_active = str(share_row.get("contact_status") or "revoked") == "active"
        auto_approve = bool(share_row.get("contact_auto_approve")) and contact_tier == "family" and contact_active

        if share_status == "revoked":
            raise KaiLocationError("SHARE_REVOKED", "This location link has been revoked.", status_code=410)
        if share_status == "active" and expires_at > _utcnow():
            raise KaiLocationError(
                "SHARE_STILL_ACTIVE",
                "This location link is still active and does not need a new access request.",
                status_code=409,
            )

        if auto_approve:
            request_row = self._execute_one(
                """
                INSERT INTO kai_location_access_requests (
                  share_id, owner_user_id, contact_id, status, requester_label,
                  requester_message, requested_at, resolved_at, renewed_share_id, metadata
                )
                VALUES (
                  CAST(:share_id AS UUID), :owner_user_id, CAST(:contact_id AS UUID),
                  'auto_approved', :requester_label, :requester_message, NOW(), NOW(),
                  CAST(:share_id AS UUID), CAST(:metadata_json AS JSONB)
                )
                RETURNING *
                """,
                {
                    "share_id": share_id,
                    "owner_user_id": owner_user_id,
                    "contact_id": contact_id,
                    "requester_label": (requester_label or "").strip()[:120] or None,
                    "requester_message": (requester_message or "").strip()[:500] or None,
                    "metadata_json": _json_param(metadata),
                },
            )
            renewed_share = self._execute_one(
                """
                UPDATE kai_location_shares
                SET status = 'active',
                    expires_at = NOW() + INTERVAL '24 hours',
                    deactivated_at = NULL,
                    revoked_at = NULL,
                    updated_at = NOW()
                WHERE id = CAST(:share_id AS UUID)
                RETURNING
                  *,
                  :contact_display_name AS contact_display_name,
                  :contact_tier AS contact_tier,
                  :contact_auto_approve AS contact_auto_approve
                """,
                {
                    "share_id": share_id,
                    "contact_display_name": share_row.get("contact_display_name"),
                    "contact_tier": share_row.get("contact_tier"),
                    "contact_auto_approve": share_row.get("contact_auto_approve"),
                },
            )
            self._insert_event(
                owner_user_id=owner_user_id,
                contact_id=contact_id,
                share_id=share_id,
                request_id=str(request_row.get("id") or "") if request_row else None,
                event_type="ACCESS_AUTO_APPROVED",
                metadata={"tier": "family"},
            )
            public_view = self.resolve_public_share(token=token)
            return {
                "status": "auto_approved",
                "accessRequest": self._request_payload(request_row),
                "share": self._share_payload(renewed_share),
                "publicView": public_view,
            }

        existing = self._execute_one(
            """
            SELECT
              r.*,
              c.display_name AS contact_display_name,
              c.tier AS contact_tier
            FROM kai_location_access_requests r
            LEFT JOIN kai_location_contacts c ON c.id = r.contact_id
            WHERE r.share_id = CAST(:share_id AS UUID)
              AND r.status = 'pending'
            ORDER BY r.requested_at DESC
            LIMIT 1
            """,
            {"share_id": share_id},
        )
        if existing:
            return {
                "status": "pending",
                "accessRequest": self._request_payload(existing),
                "share": self._share_payload(share_row),
                "publicView": None,
            }

        request_row = self._execute_one(
            """
            INSERT INTO kai_location_access_requests (
              share_id, owner_user_id, contact_id, status, requester_label,
              requester_message, requested_at, metadata
            )
            VALUES (
              CAST(:share_id AS UUID), :owner_user_id, CAST(:contact_id AS UUID),
              'pending', :requester_label, :requester_message, NOW(),
              CAST(:metadata_json AS JSONB)
            )
            RETURNING
              *,
              :contact_display_name AS contact_display_name,
              :contact_tier AS contact_tier
            """,
            {
                "share_id": share_id,
                "owner_user_id": owner_user_id,
                "contact_id": contact_id,
                "requester_label": (requester_label or "").strip()[:120] or None,
                "requester_message": (requester_message or "").strip()[:500] or None,
                "metadata_json": _json_param(metadata),
                "contact_display_name": share_row.get("contact_display_name"),
                "contact_tier": share_row.get("contact_tier"),
            },
        )
        request_id = str(request_row.get("id") or "") if request_row else ""
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=contact_id,
            share_id=share_id,
            request_id=request_id or None,
            event_type="ACCESS_REQUESTED",
            metadata={"tier": contact_tier or None, "auto_approve": False},
        )
        self._send_location_access_request_notification(
            owner_user_id=owner_user_id,
            request_id=request_id,
            contact_display_name=str(share_row.get("contact_display_name") or "Someone"),
        )
        return {
            "status": "pending",
            "accessRequest": self._request_payload(request_row),
            "share": self._share_payload(share_row),
            "publicView": None,
        }

    def approve_access_request(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        request_row = self._execute_one(
            """
            SELECT
              r.*,
              c.display_name AS contact_display_name,
              c.tier AS contact_tier
            FROM kai_location_access_requests r
            LEFT JOIN kai_location_contacts c ON c.id = r.contact_id
            WHERE r.id = CAST(:request_id AS UUID)
              AND r.owner_user_id = :owner_user_id
              AND r.status = 'pending'
            LIMIT 1
            """,
            {"owner_user_id": owner_user_id, "request_id": request_id},
        )
        if not request_row:
            raise KaiLocationError("ACCESS_REQUEST_NOT_FOUND", "Pending access request was not found.", status_code=404)
        share_id = str(request_row.get("share_id") or "")
        share_row = self._execute_one(
            """
            UPDATE kai_location_shares
            SET status = 'active',
                expires_at = NOW() + INTERVAL '24 hours',
                deactivated_at = NULL,
                updated_at = NOW()
            WHERE id = CAST(:share_id AS UUID)
              AND owner_user_id = :owner_user_id
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "share_id": share_id},
        )
        resolved = self._execute_one(
            """
            UPDATE kai_location_access_requests
            SET status = 'approved',
                resolved_at = NOW(),
                renewed_share_id = CAST(:share_id AS UUID)
            WHERE id = CAST(:request_id AS UUID)
            RETURNING
              *,
              :contact_display_name AS contact_display_name,
              :contact_tier AS contact_tier
            """,
            {
                "request_id": request_id,
                "share_id": share_id,
                "contact_display_name": request_row.get("contact_display_name"),
                "contact_tier": request_row.get("contact_tier"),
            },
        )
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=str(request_row.get("contact_id") or "") or None,
            share_id=share_id,
            request_id=request_id,
            event_type="ACCESS_APPROVED",
            metadata={"duration_hours": 24},
        )
        return {"accessRequest": self._request_payload(resolved), "share": self._share_payload(share_row)}

    def deny_access_request(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        resolved = self._execute_one(
            """
            UPDATE kai_location_access_requests
            SET status = 'denied',
                resolved_at = NOW()
            WHERE id = CAST(:request_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'pending'
            RETURNING *
            """,
            {"owner_user_id": owner_user_id, "request_id": request_id},
        )
        if not resolved:
            raise KaiLocationError("ACCESS_REQUEST_NOT_FOUND", "Pending access request was not found.", status_code=404)
        self._insert_event(
            owner_user_id=owner_user_id,
            contact_id=str(resolved.get("contact_id") or "") or None,
            share_id=str(resolved.get("share_id") or "") or None,
            request_id=request_id,
            event_type="ACCESS_DENIED",
            metadata={},
        )
        return self._request_payload(resolved) or {}

    def issue_update_session(self, *, owner_user_id: str) -> dict[str, Any]:
        active = self._execute_one(
            """
            SELECT COUNT(*) AS active_count
            FROM kai_location_shares
            WHERE owner_user_id = :owner_user_id
              AND status = 'active'
              AND expires_at > NOW()
            """,
            {"owner_user_id": owner_user_id},
        )
        if int(active.get("active_count") or 0) <= 0:
            raise KaiLocationError(
                "NO_ACTIVE_LOCATION_SHARES",
                "Create an active location share before starting live updates.",
                status_code=409,
            )
        token = _new_token()
        row = self._execute_one(
            """
            INSERT INTO kai_location_update_sessions (
              owner_user_id, session_token_hash, status, expires_at, created_at, updated_at, metadata
            )
            VALUES (
              :owner_user_id, :session_token_hash, 'active',
              NOW() + INTERVAL '24 hours', NOW(), NOW(), '{}'::jsonb
            )
            RETURNING id, expires_at
            """,
            {"owner_user_id": owner_user_id, "session_token_hash": _token_hash(token)},
        )
        session_id = str(row.get("id") or "") if row else ""
        self._insert_event(
            owner_user_id=owner_user_id,
            event_type="UPDATE_SESSION_CREATED",
            metadata={"session_id": session_id},
        )
        return {
            "token": token,
            "expiresAt": _iso(row.get("expires_at") if row else None),
            "endpointPath": "/api/kai/location/updates",
        }

    def update_with_session(self, *, session_token: str, point: dict[str, Any]) -> dict[str, Any]:
        token = str(session_token or "").strip()
        if not token:
            raise KaiLocationError("LOCATION_UPDATE_TOKEN_MISSING", "Missing location update token.", status_code=401)
        session = self._execute_one(
            """
            SELECT *
            FROM kai_location_update_sessions
            WHERE session_token_hash = :session_token_hash
              AND status = 'active'
            LIMIT 1
            """,
            {"session_token_hash": _token_hash(token)},
        )
        if not session:
            raise KaiLocationError("LOCATION_UPDATE_TOKEN_INVALID", "Invalid location update token.", status_code=401)
        owner_user_id = str(session.get("owner_user_id") or "")
        expires_at = session.get("expires_at")
        if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if isinstance(expires_at, datetime) and expires_at <= _utcnow():
            self._execute_one(
                """
                UPDATE kai_location_update_sessions
                SET status = 'expired', updated_at = NOW()
                WHERE id = CAST(:session_id AS UUID)
                """,
                {"session_id": str(session.get("id") or "")},
            )
            raise KaiLocationError("LOCATION_UPDATE_TOKEN_EXPIRED", "Location update session expired.", status_code=401)

        active = self._execute_one(
            """
            SELECT COUNT(*) AS active_count
            FROM kai_location_shares
            WHERE owner_user_id = :owner_user_id
              AND status = 'active'
              AND expires_at > NOW()
            """,
            {"owner_user_id": owner_user_id},
        )
        if int(active.get("active_count") or 0) <= 0:
            self._revoke_update_sessions_if_no_active_shares(owner_user_id)
            raise KaiLocationError("NO_ACTIVE_LOCATION_SHARES", "No active location shares remain.", status_code=403)

        latest = self.upsert_latest_point(owner_user_id=owner_user_id, point=point, require_fresh=False)
        self._execute_one(
            """
            UPDATE kai_location_update_sessions
            SET last_used_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:session_id AS UUID)
            """,
            {"session_id": str(session.get("id") or "")},
        )
        return {"ok": True, "latest": latest}

    def _send_location_access_request_notification(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        contact_display_name: str,
    ) -> None:
        if not request_id:
            return
        try:
            db = get_db()
            rows = db.execute_raw(
                "SELECT token, platform FROM user_push_tokens WHERE user_id = :user_id",
                {"user_id": owner_user_id},
            ).data or []
            if not rows:
                return
            configured, _ = ensure_firebase_admin()
            if not configured:
                return
            from firebase_admin import messaging

            request_url = _build_request_url(request_id)
            message_data = {
                "type": "location_access_request",
                "request_id": request_id,
                "user_id": owner_user_id,
                "request_url": request_url,
                "deep_link": f"/kai/location?requestId={request_id}",
                "notification_tag": f"location-access-request:{request_id}",
                "notification_category": "LOCATION_ACCESS_REQUEST",
            }
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
                    title="Location access request",
                    body=f"{contact_display_name or 'Someone'} is asking to view your KAI location again.",
                    request_url=request_url,
                    notification_tag=message_data["notification_tag"],
                    show_alert=True,
                )
                try:
                    messaging.send(message)
                except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                    db.execute_raw("DELETE FROM user_push_tokens WHERE token = :token", {"token": token})
                except Exception as exc:
                    logger.warning("Location access FCM send failed user=%s: %s", owner_user_id, exc)
        except Exception as exc:
            logger.warning("Location access notification skipped user=%s: %s", owner_user_id, exc)


def location_error_detail(exc: KaiLocationError) -> dict[str, str]:
    return {"code": exc.code, "message": exc.message}


def database_error_detail(exc: DatabaseExecutionError) -> dict[str, str]:
    return {
        "code": exc.code,
        "message": exc.details,
        "hint": exc.hint or "",
    }
