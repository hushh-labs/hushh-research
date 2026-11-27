"""Resilient Postgres-persisted geofence rules for One Location (US-027, US-034).

Privacy invariant:
- Public place targets (`place_kind = 'public_place'`, e.g. an airport resolved
  via Google Places) may persist public coordinates for the arrival boundary.
- Home targets (`place_kind = 'saved_home'`) MUST keep `public_lat` and
  `public_lng` strictly NULL on the server. The client resolves Home locally
  from encrypted PKM (`lib/one-location/saved-locations.ts`) and triggers this
  service via atomic CAS (`WHERE status = 'armed'`) when arrival dwell completes.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from db.db_client import get_db
from hushh_mcp.operons.location.policy import (
    MAX_CHAT_LOCATION_SHARE_HOURS,
    MIN_LOCATION_SHARE_HOURS,
    TIMED_LOCATION_SHARE_DURATION_MODE,
    normalize_grant_precision,
)
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    _iso,
    _json_param,
    _loads_json,
)

logger = logging.getLogger(__name__)

GEOFENCE_TRIGGER_TYPES = ("share_on_arrival", "stop_on_arrival")
GEOFENCE_PLACE_KINDS = ("public_place", "saved_home")
DEFAULT_GEOFENCE_RADIUS_METERS = 250
MIN_GEOFENCE_RADIUS_METERS = 50
MAX_GEOFENCE_RADIUS_METERS = 5000
DEFAULT_GEOFENCE_RULE_TTL_HOURS = 72.0


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class OneLocationGeofenceService:
    """Owner-scoped geofence trigger lifecycle with atomic multi-tab CAS."""

    def __init__(self, agent_service: OneLocationAgentService | None = None) -> None:
        self._agent_service = agent_service

    def _agent(self) -> OneLocationAgentService:
        return self._agent_service or OneLocationAgentService()

    def _execute_one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params)
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params)
        return list(result.data or [])

    @staticmethod
    def _serialize_rule(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        recipient_ids = _loads_json(row.get("recipient_user_ids"))
        if not isinstance(recipient_ids, list):
            recipient_ids = []
        metadata = _loads_json(row.get("metadata"))
        if not isinstance(metadata, dict):
            metadata = {}
        place_kind = str(row.get("place_kind") or "public_place")
        return {
            "id": str(row.get("id") or ""),
            "ownerUserId": str(row.get("owner_user_id") or ""),
            "triggerType": str(row.get("trigger_type") or ""),
            "placeKind": place_kind,
            "placeLabel": str(row.get("place_label") or ""),
            "publicPlaceId": str(row.get("public_place_id") or "") or None,
            "publicLat": (
                None
                if place_kind == "saved_home" or row.get("public_lat") is None
                else float(row["public_lat"])
            ),
            "publicLng": (
                None
                if place_kind == "saved_home" or row.get("public_lng") is None
                else float(row["public_lng"])
            ),
            "radiusMeters": int(row.get("radius_meters") or DEFAULT_GEOFENCE_RADIUS_METERS),
            "recipientUserIds": [str(uid) for uid in recipient_ids if str(uid).strip()],
            "recipientNames": [
                str(name) for name in (metadata.get("recipientNames") or []) if str(name).strip()
            ],
            "shareDurationHours": (
                float(row["share_duration_hours"])
                if row.get("share_duration_hours") is not None
                else None
            ),
            "precision": str(row.get("precision") or "") or None,
            "status": str(row.get("status") or "armed"),
            "triggeredAt": _iso(row.get("triggered_at")),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "metadata": metadata,
        }

    def _expire_stale_rules(self, owner_user_id: str) -> None:
        self._execute_many(
            """
            UPDATE one_location_geofence_rules
            SET status = 'expired', updated_at = NOW()
            WHERE owner_user_id = :owner_user_id
              AND status = 'armed'
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
            RETURNING id
            """,
            {"owner_user_id": owner_user_id},
        )

    def create_rule(
        self,
        *,
        owner_user_id: str,
        trigger_type: str,
        place_kind: str,
        place_label: str,
        public_place_id: str | None = None,
        public_lat: float | None = None,
        public_lng: float | None = None,
        radius_meters: int = DEFAULT_GEOFENCE_RADIUS_METERS,
        recipient_user_ids: list[str] | None = None,
        recipient_names: list[str] | None = None,
        share_duration_hours: float | None = 1.0,
        precision: str | None = None,
        ttl_hours: float = DEFAULT_GEOFENCE_RULE_TTL_HOURS,
    ) -> dict[str, Any]:
        norm_trigger = str(trigger_type or "").strip().lower()
        if norm_trigger not in GEOFENCE_TRIGGER_TYPES:
            raise OneLocationAgentError(
                "LOCATION_GEOFENCE_TRIGGER_INVALID",
                "Geofence trigger must be share_on_arrival or stop_on_arrival.",
                status_code=422,
            )
        norm_place_kind = str(place_kind or "").strip().lower()
        if norm_place_kind not in GEOFENCE_PLACE_KINDS:
            raise OneLocationAgentError(
                "LOCATION_GEOFENCE_PLACE_KIND_INVALID",
                "Geofence place kind must be public_place or saved_home.",
                status_code=422,
            )
        cleaned_label = str(place_label or "").strip()[:140]
        if not cleaned_label:
            raise OneLocationAgentError(
                "LOCATION_GEOFENCE_PLACE_REQUIRED",
                "A destination place name is required.",
                status_code=422,
            )
        bounded_radius = max(
            MIN_GEOFENCE_RADIUS_METERS,
            min(int(radius_meters or DEFAULT_GEOFENCE_RADIUS_METERS), MAX_GEOFENCE_RADIUS_METERS),
        )

        # Privacy invariant: saved_home NEVER persists coordinates on server.
        stored_place_id: str | None = None
        stored_lat: float | None = None
        stored_lng: float | None = None
        if norm_place_kind == "public_place":
            stored_place_id = str(public_place_id or "").strip()[:200] or None
            if public_lat is not None and public_lng is not None:
                lat_val = float(public_lat)
                lng_val = float(public_lng)
                if not (-90.0 <= lat_val <= 90.0 and -180.0 <= lng_val <= 180.0):
                    raise OneLocationAgentError(
                        "LOCATION_GEOFENCE_COORDS_INVALID",
                        "Public place coordinates are out of range.",
                        status_code=422,
                    )
                stored_lat = lat_val
                stored_lng = lng_val

        cleaned_recipients = [
            str(uid).strip() for uid in (recipient_user_ids or []) if str(uid).strip()
        ]
        resolved_duration: float | None = None
        resolved_precision: str | None = None
        if norm_trigger == "share_on_arrival":
            if not cleaned_recipients:
                raise OneLocationAgentError(
                    "LOCATION_GEOFENCE_RECIPIENT_REQUIRED",
                    "Choose at least one person to share with on arrival.",
                    status_code=422,
                )
            raw_dur = float(share_duration_hours if share_duration_hours is not None else 1.0)
            if raw_dur < float(MIN_LOCATION_SHARE_HOURS) or raw_dur > float(
                MAX_CHAT_LOCATION_SHARE_HOURS
            ):
                raise OneLocationAgentError(
                    "LOCATION_DURATION_INVALID",
                    "Arrival share duration must be between 15 minutes and 8 hours.",
                    status_code=422,
                )
            resolved_duration = round(raw_dur, 2)
            try:
                resolved_precision = normalize_grant_precision(precision)
            except ValueError as exc:
                raise OneLocationAgentError(
                    "LOCATION_PRECISION_INVALID", str(exc), status_code=422
                ) from exc

        bounded_ttl = max(1.0, min(float(ttl_hours or DEFAULT_GEOFENCE_RULE_TTL_HOURS), 720.0))
        expires_at = _utcnow() + timedelta(hours=bounded_ttl)
        metadata: dict[str, Any] = {
            "recipientNames": [
                str(n).strip()[:80] for n in (recipient_names or []) if str(n).strip()
            ],
        }
        row = self._execute_one(
            """
            INSERT INTO one_location_geofence_rules (
              owner_user_id, trigger_type, place_kind, place_label,
              public_place_id, public_lat, public_lng, radius_meters,
              recipient_user_ids, share_duration_hours, precision,
              status, expires_at, metadata, created_at, updated_at
            )
            VALUES (
              :owner_user_id, :trigger_type, :place_kind, :place_label,
              :public_place_id, :public_lat, :public_lng, :radius_meters,
              CAST(:recipient_user_ids AS JSONB), :share_duration_hours, :precision,
              'armed', :expires_at, CAST(:metadata_json AS JSONB), NOW(), NOW()
            )
            RETURNING *
            """,
            {
                "owner_user_id": owner_user_id,
                "trigger_type": norm_trigger,
                "place_kind": norm_place_kind,
                "place_label": cleaned_label,
                "public_place_id": stored_place_id,
                "public_lat": stored_lat,
                "public_lng": stored_lng,
                "radius_meters": bounded_radius,
                "recipient_user_ids": json.dumps(cleaned_recipients),
                "share_duration_hours": resolved_duration,
                "precision": resolved_precision,
                "expires_at": expires_at,
                "metadata_json": _json_param(metadata),
            },
        )
        serialized = self._serialize_rule(row)
        if not serialized:
            raise OneLocationAgentError(
                "LOCATION_GEOFENCE_CREATE_FAILED",
                "Could not save the arrival rule.",
                status_code=500,
            )
        try:
            self._agent()._insert_event(
                owner_user_id=owner_user_id,
                actor_user_id=owner_user_id,
                event_type="location_geofence_created",
                metadata={
                    "rule_id": serialized["id"],
                    "trigger_type": norm_trigger,
                    "place_kind": norm_place_kind,
                    "place_label": cleaned_label,
                    "recipient_count": len(cleaned_recipients),
                },
                required=False,
            )
        except Exception:  # noqa: BLE001
            logger.warning("one_location.geofence.create_audit_failed")
        return serialized

    def list_rules(
        self,
        *,
        owner_user_id: str,
        status: str | None = "armed",
        limit: int = 25,
    ) -> list[dict[str, Any]]:
        self._expire_stale_rules(owner_user_id)
        bounded_limit = max(1, min(int(limit or 25), 50))
        if status:
            rows = self._execute_many(
                """
                SELECT *
                FROM one_location_geofence_rules
                WHERE owner_user_id = :owner_user_id
                  AND status = :status
                ORDER BY created_at DESC
                LIMIT :limit
                """,
                {"owner_user_id": owner_user_id, "status": status, "limit": bounded_limit},
            )
        else:
            rows = self._execute_many(
                """
                SELECT *
                FROM one_location_geofence_rules
                WHERE owner_user_id = :owner_user_id
                ORDER BY created_at DESC
                LIMIT :limit
                """,
                {"owner_user_id": owner_user_id, "limit": bounded_limit},
            )
        return [rule for row in rows if (rule := self._serialize_rule(row))]

    def cancel_rule(self, *, owner_user_id: str, rule_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            UPDATE one_location_geofence_rules
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = CAST(:rule_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'armed'
            RETURNING *
            """,
            {"rule_id": rule_id, "owner_user_id": owner_user_id},
        )
        if not row:
            existing = self._execute_one(
                """
                SELECT * FROM one_location_geofence_rules
                WHERE id = CAST(:rule_id AS UUID) AND owner_user_id = :owner_user_id
                LIMIT 1
                """,
                {"rule_id": rule_id, "owner_user_id": owner_user_id},
            )
            if not existing:
                raise OneLocationAgentError(
                    "LOCATION_GEOFENCE_NOT_FOUND",
                    "Arrival rule was not found.",
                    status_code=404,
                )
            return self._serialize_rule(existing) or {}
        serialized = self._serialize_rule(row) or {}
        try:
            self._agent()._insert_event(
                owner_user_id=owner_user_id,
                actor_user_id=owner_user_id,
                event_type="location_geofence_cancelled",
                metadata={"rule_id": rule_id, "place_label": serialized.get("placeLabel")},
                required=False,
            )
        except Exception:  # noqa: BLE001
            logger.warning("one_location.geofence.cancel_audit_failed")
        return serialized

    def _rearm_failed_trigger(self, *, rule_id: str, owner_user_id: str) -> None:
        """Revert a claimed trigger back to ``armed`` if its downstream action failed."""
        try:
            self._execute_one(
                """
                UPDATE one_location_geofence_rules
                SET status = 'armed', triggered_at = NULL, updated_at = NOW()
                WHERE id = CAST(:rule_id AS UUID)
                  AND owner_user_id = :owner_user_id
                  AND status = 'triggered'
                RETURNING id
                """,
                {"rule_id": rule_id, "owner_user_id": owner_user_id},
            )
        except Exception:  # noqa: BLE001
            logger.exception("one_location.geofence.rearm_after_failure_failed rule_id=%s", rule_id)

    def trigger_rule(
        self,
        *,
        owner_user_id: str,
        rule_id: str,
        initial_envelopes: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Atomically transition an armed geofence rule to ``triggered`` and execute its action.

        Uses a single SQL compare-and-swap (``WHERE status = 'armed'``) so
        concurrent browser tabs or foreground resume checks cannot double-fire.
        If the downstream action fails before completing, the rule is reverted
        to ``armed`` so retries remain safe and effective.
        """
        claimed = self._execute_one(
            """
            UPDATE one_location_geofence_rules
            SET status = 'triggered', triggered_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:rule_id AS UUID)
              AND owner_user_id = :owner_user_id
              AND status = 'armed'
              AND (expires_at IS NULL OR expires_at > NOW())
            RETURNING *
            """,
            {"rule_id": rule_id, "owner_user_id": owner_user_id},
        )
        if not claimed:
            existing = self._execute_one(
                """
                SELECT * FROM one_location_geofence_rules
                WHERE id = CAST(:rule_id AS UUID) AND owner_user_id = :owner_user_id
                LIMIT 1
                """,
                {"rule_id": rule_id, "owner_user_id": owner_user_id},
            )
            if not existing:
                raise OneLocationAgentError(
                    "LOCATION_GEOFENCE_NOT_FOUND",
                    "Arrival rule was not found.",
                    status_code=404,
                )
            serialized_existing = self._serialize_rule(existing) or {}
            if serialized_existing.get("status") == "triggered":
                return {
                    "rule": serialized_existing,
                    "alreadyTriggered": True,
                    "grants": [],
                    "revokedCount": 0,
                }
            raise OneLocationAgentError(
                "LOCATION_GEOFENCE_NOT_ARMED",
                "This arrival rule is no longer armed.",
                status_code=409,
            )

        rule = self._serialize_rule(claimed) or {}
        agent = self._agent()
        trigger_type = rule.get("triggerType")
        created_grants: list[dict[str, Any]] = []
        revoked_count = 0

        try:
            if trigger_type == "stop_on_arrival":
                revoke_result = agent.revoke_all_owner_grants(
                    owner_user_id=owner_user_id,
                    include_sos=False,
                    include_public_links=True,
                )
                revoked_count = int(revoke_result.get("revokedCount") or 0)
            elif trigger_type == "share_on_arrival":
                recipients = agent.list_verified_recipients(owner_user_id=owner_user_id)
                by_id = {str(r.get("userId") or ""): r for r in recipients if r.get("userId")}
                duration_hours = float(rule.get("shareDurationHours") or 1.0)
                precision = rule.get("precision")
                envelopes_map = initial_envelopes if isinstance(initial_envelopes, dict) else {}
                target_recipient_ids = list(rule.get("recipientUserIds") or [])
                for recipient_uid in target_recipient_ids:
                    rec = by_id.get(recipient_uid)
                    if not rec or not rec.get("keyId"):
                        continue
                    grant = agent.create_grant(
                        owner_user_id=owner_user_id,
                        recipient_user_id=recipient_uid,
                        recipient_key_id=str(rec.get("keyId") or ""),
                        duration_hours=duration_hours,
                        duration_mode=TIMED_LOCATION_SHARE_DURATION_MODE,
                        reason="geofence_arrival",
                        share_kind="share",
                        precision=precision,
                        require_recipient_phone_verified=False,
                        enforce_connection=True,
                    )
                    envelope_for_recipient = envelopes_map.get(recipient_uid)
                    if isinstance(envelope_for_recipient, dict) and grant.get("id"):
                        try:
                            agent.store_encrypted_envelope(
                                owner_user_id=owner_user_id,
                                grant_id=str(grant["id"]),
                                envelope=envelope_for_recipient,
                            )
                        except Exception:  # noqa: BLE001 - grant is still live; bridge publishes next fix
                            logger.warning("one_location.geofence.initial_envelope_store_failed")
                    created_grants.append(grant)
                if target_recipient_ids and not created_grants:
                    raise OneLocationAgentError(
                        "LOCATION_GEOFENCE_TRIGGER_FAILED",
                        "Could not start the arrival location share yet. Try again when recipients are available.",
                        status_code=503,
                    )
        except Exception:
            self._rearm_failed_trigger(rule_id=rule_id, owner_user_id=owner_user_id)
            raise

        try:
            agent._insert_event(
                owner_user_id=owner_user_id,
                actor_user_id=owner_user_id,
                event_type="location_geofence_triggered",
                metadata={
                    "rule_id": rule["id"],
                    "trigger_type": trigger_type,
                    "place_label": rule.get("placeLabel"),
                    "created_grant_count": len(created_grants),
                    "revoked_count": revoked_count,
                },
                required=False,
            )
        except Exception:  # noqa: BLE001
            logger.warning("one_location.geofence.trigger_audit_failed")

        return {
            "rule": rule,
            "alreadyTriggered": False,
            "grants": created_grants,
            "revokedCount": revoked_count,
        }


__all__ = [
    "DEFAULT_GEOFENCE_RADIUS_METERS",
    "DEFAULT_GEOFENCE_RULE_TTL_HOURS",
    "GEOFENCE_PLACE_KINDS",
    "GEOFENCE_TRIGGER_TYPES",
    "OneLocationGeofenceService",
]
