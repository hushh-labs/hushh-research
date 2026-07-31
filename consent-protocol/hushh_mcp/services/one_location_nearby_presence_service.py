"""Privacy-bounded, short-lived nearby check-in presence for One Location.

This operon is deliberately separate from recipient-scoped live-location
grants. A fresh foreground GPS fix proves that the owner is near a public place
they selected, but the device point is never persisted. The selected public
place anchor is encrypted at rest and indexed only by a short-epoch,
server-keyed spatial token. Candidate tokens are a broad-phase optimization;
the service decrypts both anchors and performs an exact Haversine check before
returning a peer or authorizing a Connect request.

Postgres is authoritative today. ``NearbyPresenceStore`` is the replaceable
port for a future Redis/Memorystore active-presence index without changing the
API contract.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable, Protocol
from uuid import UUID

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.config import VAULT_DATA_KEY
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.one_location_event_admission_service import (
    EventAdmissionContext,
)

NEARBY_PRESENCE_CONSENT_VERSION = "one-location-nearby-presence-v1"
NEARBY_PRESENCE_DURATION_MINUTES = frozenset({30, 60, 120})
NEARBY_PRESENCE_DEFAULT_DURATION_MINUTES = 60
NEARBY_PRESENCE_RADIUS_METERS = 500
NEARBY_PRESENCE_MAX_ACCURACY_METERS = 100.0
NEARBY_PRESENCE_MAX_POINT_AGE_SECONDS = 300.0
NEARBY_PRESENCE_EVENT_MAX_POINT_AGE_SECONDS = 60.0
NEARBY_PRESENCE_FUTURE_TOLERANCE_SECONDS = 60.0
NEARBY_PRESENCE_ROSTER_LIMIT = 20
NEARBY_PRESENCE_CANDIDATE_LIMIT = 240

_CELL_EPOCH_SECONDS = 6 * 60 * 60
_CELL_TILE_ZOOM = 16
_MERCATOR_MAX_LATITUDE = 85.05112878
_EARTH_RADIUS_METERS = 6_371_000.0
_ANCHOR_ALGORITHM = "aes-256-gcm"
_ANCHOR_AAD_PREFIX = b"hushh:one-location-nearby-presence:anchor:v1\0"
_KEY_DERIVATION_SALT = b"hushh:one-location-nearby-presence:kdf:v1"
_ANCHOR_KEY_INFO = b"hushh:one-location-nearby-presence:anchor-encryption:v1"
_SPATIAL_CELL_KEY_INFO = b"hushh:one-location-nearby-presence:spatial-cell-token:v1"
_ROSTER_RANKING_KEY_INFO = b"hushh:one-location-nearby-presence:roster-ranking:v1"
_DEFAULT_NEARBY_DISPLAY_NAME = "One attendee"
_PHONE_LIKE_DISPLAY_NAME = re.compile(r"\+?[\d\s().-]{7,}")
_OPAQUE_IDENTIFIER_DISPLAY_NAME = re.compile(r"(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{20,}")


class NearbyPresenceError(RuntimeError):
    """Stable, user-safe nearby-presence error."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe_nearby_display_name(value: Any, *, owner_user_id: str) -> str:
    """Return a human name without exposing identity-cache identifiers."""

    source_value = str(value or "")
    if any(unicodedata.category(character) in {"Cc", "Cf"} for character in source_value):
        return _DEFAULT_NEARBY_DISPLAY_NAME

    raw_value = source_value.strip()
    if not raw_value:
        return _DEFAULT_NEARBY_DISPLAY_NAME

    display_name = " ".join(raw_value.split())
    if (
        len(display_name) > 80
        or display_name.casefold() == str(owner_user_id or "").strip().casefold()
        or "@" in display_name
        or _PHONE_LIKE_DISPLAY_NAME.fullmatch(display_name)
        or _OPAQUE_IDENTIFIER_DISPLAY_NAME.fullmatch(display_name)
    ):
        return _DEFAULT_NEARBY_DISPLAY_NAME

    try:
        UUID(display_name)
    except (TypeError, ValueError, AttributeError):
        return display_name
    return _DEFAULT_NEARBY_DISPLAY_NAME


class NearbyPresenceStore(Protocol):
    """Persistence port for the active nearby-presence read model."""

    def get_verified_profile(self, user_id: str) -> dict[str, Any] | None: ...

    def upsert_presence(
        self,
        *,
        user_id: str,
        admission_mode: str,
        event_id: str | None,
        admission_claim_id: str | None,
        allow_connection_requests: bool,
        consent_version: str,
        duration_minutes: int,
        radius_meters: int,
        anchor_envelope: dict[str, str],
        anchor_cell_epoch: int,
        anchor_cell_token: str,
    ) -> dict[str, Any]: ...

    def get_active_presence(self, user_id: str) -> dict[str, Any] | None: ...

    def read_active_candidates(
        self,
        *,
        viewer_user_id: str,
        viewer_version: int,
        cell_epochs: list[int],
        cell_tokens: list[str],
        roster_seed: str,
        limit: int,
    ) -> list[dict[str, Any]]: ...

    def read_connection_pair(
        self,
        *,
        viewer_user_id: str,
        participant_alias: str,
    ) -> list[dict[str, Any]]: ...

    def apply_safety_action(
        self,
        *,
        viewer_user_id: str,
        participant_alias: str,
        reason_code: str | None,
    ) -> bool: ...

    def checkout(self, user_id: str) -> bool: ...

    def purge_terminal(self, *, older_than_hours: float) -> dict[str, int]: ...


class PostgresNearbyPresenceStore:
    """Postgres adapter; contains no product policy beyond query scoping."""

    @staticmethod
    def _execute_one(sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    @staticmethod
    def _execute_many(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

    def _expire_due(self) -> int:
        row = self._execute_one(
            """
            WITH changed AS (
              UPDATE one_location_nearby_presences
              SET
                status = 'expired',
                anchor_ciphertext = NULL,
                anchor_iv = NULL,
                anchor_tag = NULL,
                anchor_algorithm = NULL,
                anchor_key_id = NULL,
                anchor_cell_epoch = NULL,
                anchor_cell_token = NULL,
                version = version + 1,
                updated_at = NOW()
              WHERE status = 'active' AND expires_at <= NOW()
              RETURNING owner_user_id, event_id, version
            ),
            audited AS (
              INSERT INTO one_location_nearby_audit_events (
                actor_user_id,
                event_id,
                action,
                outcome,
                presence_version
              )
              SELECT
                owner_user_id,
                event_id,
                'expired',
                'succeeded',
                version
              FROM changed
              RETURNING audit_id
            )
            SELECT COUNT(*) AS count FROM changed
            """
        )
        return int((row or {}).get("count") or 0)

    def get_verified_profile(self, user_id: str) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT user_id, display_name, phone_verified
            FROM actor_identity_cache
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": user_id},
        )

    def upsert_presence(
        self,
        *,
        user_id: str,
        admission_mode: str,
        event_id: str | None,
        admission_claim_id: str | None,
        allow_connection_requests: bool,
        consent_version: str,
        duration_minutes: int,
        radius_meters: int,
        anchor_envelope: dict[str, str],
        anchor_cell_epoch: int,
        anchor_cell_token: str,
    ) -> dict[str, Any]:
        self._expire_due()
        params = {
            "user_id": user_id,
            "admission_mode": admission_mode,
            "event_id": event_id,
            "admission_claim_id": admission_claim_id,
            "allow_connection_requests": bool(allow_connection_requests),
            "consent_version": consent_version,
            "duration_minutes": int(duration_minutes),
            "radius_meters": int(radius_meters),
            "anchor_ciphertext": anchor_envelope["ciphertext"],
            "anchor_iv": anchor_envelope["iv"],
            "anchor_tag": anchor_envelope["tag"],
            "anchor_algorithm": anchor_envelope["algorithm"],
            "anchor_key_id": anchor_envelope["key_id"],
            "anchor_cell_epoch": int(anchor_cell_epoch),
            "anchor_cell_token": anchor_cell_token,
        }
        with get_db().engine.begin() as conn:
            result = conn.execute(
                text(
                    """
                    WITH admission AS MATERIALIZED (
                      SELECT event.ends_at
                      FROM one_location_nearby_admission_claims claim
                      JOIN one_location_nearby_event_pilots event
                        ON event.event_id = claim.event_id
                      WHERE :admission_mode = 'event_pilot'
                        AND claim.admission_claim_id =
                          CAST(:admission_claim_id AS UUID)
                        AND claim.event_id = CAST(:event_id AS UUID)
                        AND claim.claimed_by_user_id = :user_id
                        AND claim.claimed_at IS NOT NULL
                        AND claim.expires_at > NOW()
                        AND event.status = 'active'
                        AND event.starts_at <= NOW()
                        AND event.ends_at > NOW()
                      FOR UPDATE OF claim, event
                    ),
                    upserted AS (
                      INSERT INTO one_location_nearby_presences (
                        owner_user_id,
                        participant_alias,
                        status,
                        audience,
                        admission_mode,
                        event_id,
                        admission_claim_id,
                        allow_connection_requests,
                        consent_version,
                        radius_meters,
                        anchor_ciphertext,
                        anchor_iv,
                        anchor_tag,
                        anchor_algorithm,
                        anchor_key_id,
                        anchor_cell_epoch,
                        anchor_cell_token,
                        checked_in_at,
                        expires_at,
                        checked_out_at,
                        version,
                        created_at,
                        updated_at
                      )
                      SELECT
                        :user_id,
                        gen_random_uuid(),
                        'active',
                        'all_opted_in',
                        :admission_mode,
                        CAST(:event_id AS UUID),
                        CAST(:admission_claim_id AS UUID),
                        :allow_connection_requests,
                        :consent_version,
                        :radius_meters,
                        :anchor_ciphertext,
                        :anchor_iv,
                        :anchor_tag,
                        :anchor_algorithm,
                        :anchor_key_id,
                        :anchor_cell_epoch,
                        :anchor_cell_token,
                        NOW(),
                        LEAST(
                          NOW() + (:duration_minutes * INTERVAL '1 minute'),
                          CASE
                            WHEN :admission_mode = 'event_pilot'
                              THEN (SELECT ends_at FROM admission)
                            ELSE NOW() + (:duration_minutes * INTERVAL '1 minute')
                          END
                        ),
                        NULL,
                        1,
                        NOW(),
                        NOW()
                      WHERE :admission_mode = 'uat_simulation'
                         OR EXISTS (SELECT 1 FROM admission)
                      ON CONFLICT (owner_user_id) DO UPDATE SET
                        participant_alias = gen_random_uuid(),
                        status = 'active',
                        audience = 'all_opted_in',
                        admission_mode = EXCLUDED.admission_mode,
                        event_id = EXCLUDED.event_id,
                        admission_claim_id = EXCLUDED.admission_claim_id,
                        allow_connection_requests =
                          EXCLUDED.allow_connection_requests,
                        consent_version = EXCLUDED.consent_version,
                        radius_meters = EXCLUDED.radius_meters,
                        anchor_ciphertext = EXCLUDED.anchor_ciphertext,
                        anchor_iv = EXCLUDED.anchor_iv,
                        anchor_tag = EXCLUDED.anchor_tag,
                        anchor_algorithm = EXCLUDED.anchor_algorithm,
                        anchor_key_id = EXCLUDED.anchor_key_id,
                        anchor_cell_epoch = EXCLUDED.anchor_cell_epoch,
                        anchor_cell_token = EXCLUDED.anchor_cell_token,
                        checked_in_at = NOW(),
                        expires_at = EXCLUDED.expires_at,
                        checked_out_at = NULL,
                        version = one_location_nearby_presences.version + 1,
                        updated_at = NOW()
                      RETURNING *
                    ),
                    audited AS (
                      INSERT INTO one_location_nearby_audit_events (
                        actor_user_id,
                        event_id,
                        action,
                        outcome,
                        presence_version
                      )
                      SELECT
                        owner_user_id,
                        event_id,
                        'checked_in',
                        'succeeded',
                        version
                      FROM upserted
                      RETURNING audit_id
                    )
                    SELECT * FROM upserted
                    """
                ),
                params,
            )
            mapped = result.mappings().first()
            row = dict(mapped) if mapped is not None else None
        if not row:
            if admission_mode == "event_pilot":
                raise NearbyPresenceError(
                    "NEARBY_ADMISSION_REQUIRED",
                    "Your event pass is no longer active.",
                    status_code=403,
                )
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_WRITE_FAILED",
                "Check-in could not be saved.",
                status_code=503,
            )
        return row

    def get_active_presence(self, user_id: str) -> dict[str, Any] | None:
        self._expire_due()
        return self._execute_one(
            """
            SELECT
              p.*,
              event.display_name AS event_display_name,
              event.venue_place_id AS event_venue_place_id,
              event.venue_label AS event_venue_label,
              event.starts_at AS event_starts_at,
              event.ends_at AS event_ends_at
            FROM one_location_nearby_presences p
            JOIN actor_identity_cache profile
              ON profile.user_id = p.owner_user_id
             AND profile.phone_verified = TRUE
            LEFT JOIN one_location_nearby_event_pilots event
              ON event.event_id = p.event_id
            WHERE p.owner_user_id = :user_id
              AND p.status = 'active'
              AND p.expires_at > NOW()
              AND (
                p.admission_mode = 'uat_simulation'
                OR (
                  p.admission_mode = 'event_pilot'
                  AND event.status = 'active'
                  AND event.starts_at <= NOW()
                  AND event.ends_at > NOW()
                )
              )
            LIMIT 1
            """,
            {"user_id": user_id},
        )

    def read_active_candidates(
        self,
        *,
        viewer_user_id: str,
        viewer_version: int,
        cell_epochs: list[int],
        cell_tokens: list[str],
        roster_seed: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not cell_epochs or not cell_tokens:
            return []
        self._expire_due()
        return self._execute_many(
            """
            WITH viewer AS MATERIALIZED (
              SELECT p.owner_user_id, p.admission_mode, p.event_id
              FROM one_location_nearby_presences p
              JOIN actor_identity_cache profile
                ON profile.user_id = p.owner_user_id
               AND profile.phone_verified = TRUE
              WHERE p.owner_user_id = :viewer_user_id
                AND p.version = :viewer_version
                AND p.status = 'active'
                AND p.expires_at > NOW()
                AND (
                  p.admission_mode = 'uat_simulation'
                  OR EXISTS (
                    SELECT 1
                    FROM one_location_nearby_event_pilots event
                    WHERE event.event_id = p.event_id
                      AND event.status = 'active'
                      AND event.starts_at <= NOW()
                      AND event.ends_at > NOW()
                  )
                )
              LIMIT 1
            )
            SELECT
              p.owner_user_id,
              p.participant_alias,
              p.allow_connection_requests,
              p.radius_meters,
              p.anchor_ciphertext,
              p.anchor_iv,
              p.anchor_tag,
              p.anchor_algorithm,
              p.anchor_key_id,
              p.version,
              COALESCE(NULLIF(TRIM(profile.display_name), ''), 'One attendee')
                AS display_name,
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM connections c
                  WHERE c.status = 'active'
                    AND c.user_a_id = LEAST(:viewer_user_id, p.owner_user_id)
                    AND c.user_b_id = GREATEST(:viewer_user_id, p.owner_user_id)
                ) THEN 'connected'
                WHEN EXISTS (
                  SELECT 1
                  FROM connection_requests cr
                  WHERE cr.status = 'pending'
                    AND cr.requester_user_id = :viewer_user_id
                    AND cr.addressee_user_id = p.owner_user_id
                ) THEN 'pending_outgoing'
                WHEN EXISTS (
                  SELECT 1
                  FROM connection_requests cr
                  WHERE cr.status = 'pending'
                    AND cr.requester_user_id = p.owner_user_id
                    AND cr.addressee_user_id = :viewer_user_id
                ) THEN 'pending_incoming'
                ELSE 'none'
              END AS relationship,
              hmac(
                p.participant_alias::TEXT,
                CAST(:roster_seed AS TEXT),
                'sha256'
              ) AS roster_rank
            FROM viewer
            JOIN one_location_nearby_presences p
              ON p.owner_user_id <> :viewer_user_id
             AND p.admission_mode = viewer.admission_mode
             AND (
               viewer.admission_mode = 'uat_simulation'
               OR p.event_id = viewer.event_id
             )
             AND p.status = 'active'
             AND p.expires_at > NOW()
             AND p.anchor_cell_epoch = ANY(:cell_epochs)
             AND p.anchor_cell_token = ANY(:cell_tokens)
            JOIN actor_identity_cache profile
              ON profile.user_id = p.owner_user_id
             AND profile.phone_verified = TRUE
            WHERE NOT EXISTS (
              SELECT 1
              FROM one_location_nearby_blocks block
              WHERE (
                  block.blocker_user_id = :viewer_user_id
                  AND block.blocked_user_id = p.owner_user_id
                )
                OR (
                  block.blocker_user_id = p.owner_user_id
                  AND block.blocked_user_id = :viewer_user_id
                )
            )
            ORDER BY roster_rank, p.participant_alias
            LIMIT :limit
            """,
            {
                "viewer_user_id": viewer_user_id,
                "viewer_version": int(viewer_version),
                "cell_epochs": cell_epochs,
                "cell_tokens": cell_tokens,
                "roster_seed": roster_seed,
                "limit": max(
                    NEARBY_PRESENCE_ROSTER_LIMIT,
                    min(int(limit), NEARBY_PRESENCE_CANDIDATE_LIMIT),
                ),
            },
        )

    def read_connection_pair(
        self,
        *,
        viewer_user_id: str,
        participant_alias: str,
    ) -> list[dict[str, Any]]:
        self._expire_due()
        return self._execute_many(
            """
            SELECT
              p.owner_user_id,
              p.participant_alias,
              p.allow_connection_requests,
              p.admission_mode,
              p.event_id,
              p.radius_meters,
              p.anchor_ciphertext,
              p.anchor_iv,
              p.anchor_tag,
              p.anchor_algorithm,
              p.anchor_key_id,
              p.version
            FROM one_location_nearby_presences p
            JOIN actor_identity_cache profile
              ON profile.user_id = p.owner_user_id
             AND profile.phone_verified = TRUE
            WHERE (
                p.owner_user_id = :viewer_user_id
                OR p.participant_alias = CAST(:participant_alias AS UUID)
              )
              AND p.status = 'active'
              AND p.expires_at > NOW()
              AND (
                p.admission_mode = 'uat_simulation'
                OR EXISTS (
                  SELECT 1
                  FROM one_location_nearby_event_pilots event
                  WHERE event.event_id = p.event_id
                    AND event.status = 'active'
                    AND event.starts_at <= NOW()
                    AND event.ends_at > NOW()
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM one_location_nearby_blocks block
                WHERE (
                    block.blocker_user_id = :viewer_user_id
                    AND block.blocked_user_id = p.owner_user_id
                  )
                  OR (
                    block.blocker_user_id = p.owner_user_id
                    AND block.blocked_user_id = :viewer_user_id
                  )
              )
            ORDER BY p.owner_user_id
            """,
            {
                "viewer_user_id": viewer_user_id,
                "participant_alias": participant_alias,
            },
        )

    def apply_safety_action(
        self,
        *,
        viewer_user_id: str,
        participant_alias: str,
        reason_code: str | None,
    ) -> bool:
        params = {
            "viewer_user_id": viewer_user_id,
            "participant_alias": participant_alias,
            "reason_code": reason_code,
        }
        with get_db().engine.begin() as conn:
            pair_result = (
                conn.execute(
                    text(
                        """
                    SELECT
                      p.owner_user_id,
                      p.participant_alias,
                      p.admission_mode,
                      p.event_id,
                      p.version
                    FROM one_location_nearby_presences p
                    WHERE (
                        p.owner_user_id = :viewer_user_id
                        OR p.participant_alias = CAST(:participant_alias AS UUID)
                      )
                      AND p.status = 'active'
                      AND p.expires_at > NOW()
                    ORDER BY p.owner_user_id
                    FOR UPDATE OF p
                    """
                    ),
                    params,
                )
                .mappings()
                .all()
            )
            rows = [dict(item) for item in pair_result]
            viewer = next(
                (row for row in rows if str(row.get("owner_user_id") or "") == viewer_user_id),
                None,
            )
            target = next(
                (
                    row
                    for row in rows
                    if str(row.get("participant_alias") or "") == participant_alias
                ),
                None,
            )
            if (
                not viewer
                or not target
                or str(target.get("owner_user_id") or "") == viewer_user_id
                or str(viewer.get("admission_mode") or "")
                != str(target.get("admission_mode") or "")
                or (
                    str(viewer.get("admission_mode") or "") == "event_pilot"
                    and str(viewer.get("event_id") or "") != str(target.get("event_id") or "")
                )
            ):
                return False
            target_user_id = str(target["owner_user_id"])
            pair = {
                "user_a": min(viewer_user_id, target_user_id),
                "user_b": max(viewer_user_id, target_user_id),
            }
            conn.execute(
                text(
                    """
                    SELECT pg_advisory_xact_lock(
                      hashtext(:user_a),
                      hashtext(:user_b)
                    )
                    """
                ),
                pair,
            )
            block_inserted = conn.execute(
                text(
                    """
                    INSERT INTO one_location_nearby_blocks (
                      blocker_user_id,
                      blocked_user_id
                    )
                    VALUES (:viewer_user_id, :target_user_id)
                    ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
                    RETURNING blocker_user_id
                    """
                ),
                {
                    "viewer_user_id": viewer_user_id,
                    "target_user_id": target_user_id,
                },
            ).first()
            conn.execute(
                text(
                    """
                    UPDATE connection_requests
                    SET status = 'cancelled', updated_at = NOW()
                    WHERE status = 'pending'
                      AND (
                        (
                          requester_user_id = :viewer_user_id
                          AND addressee_user_id = :target_user_id
                        )
                        OR (
                          requester_user_id = :target_user_id
                          AND addressee_user_id = :viewer_user_id
                        )
                      )
                    """
                ),
                {
                    "viewer_user_id": viewer_user_id,
                    "target_user_id": target_user_id,
                },
            )
            action = "blocked"
            report_inserted = None
            if reason_code is not None:
                report_inserted = conn.execute(
                    text(
                        """
                        INSERT INTO one_location_nearby_reports (
                          reporter_user_id,
                          reported_user_id,
                          event_id,
                          reason_code,
                          reporter_presence_version,
                          reported_presence_version
                        )
                        VALUES (
                          :viewer_user_id,
                          :target_user_id,
                          CAST(:event_id AS UUID),
                          :reason_code,
                          :viewer_version,
                          :target_version
                        )
                        ON CONFLICT DO NOTHING
                        RETURNING report_id
                        """
                    ),
                    {
                        "viewer_user_id": viewer_user_id,
                        "target_user_id": target_user_id,
                        "event_id": viewer.get("event_id"),
                        "reason_code": reason_code,
                        "viewer_version": int(viewer["version"]),
                        "target_version": int(target["version"]),
                    },
                ).first()
                action = "reported"
            if block_inserted or report_inserted:
                conn.execute(
                    text(
                        """
                        INSERT INTO one_location_nearby_audit_events (
                          actor_user_id,
                          target_user_id,
                          event_id,
                          action,
                          outcome,
                          presence_version
                        )
                        VALUES (
                          :viewer_user_id,
                          :target_user_id,
                          CAST(:event_id AS UUID),
                          :action,
                          'succeeded',
                          :viewer_version
                        )
                        """
                    ),
                    {
                        "viewer_user_id": viewer_user_id,
                        "target_user_id": target_user_id,
                        "event_id": viewer.get("event_id"),
                        "action": action,
                        "viewer_version": int(viewer["version"]),
                    },
                )
        return True

    def checkout(self, user_id: str) -> bool:
        row = self._execute_one(
            """
            WITH changed AS (
              UPDATE one_location_nearby_presences
              SET
                status = 'checked_out',
                anchor_ciphertext = NULL,
                anchor_iv = NULL,
                anchor_tag = NULL,
                anchor_algorithm = NULL,
                anchor_key_id = NULL,
                anchor_cell_epoch = NULL,
                anchor_cell_token = NULL,
                checked_out_at = NOW(),
                version = version + 1,
                updated_at = NOW()
              WHERE owner_user_id = :user_id
                AND status = 'active'
              RETURNING id, owner_user_id, event_id, version
            ),
            audited AS (
              INSERT INTO one_location_nearby_audit_events (
                actor_user_id,
                event_id,
                action,
                outcome,
                presence_version
              )
              SELECT
                owner_user_id,
                event_id,
                'checked_out',
                'succeeded',
                version
              FROM changed
              RETURNING audit_id
            )
            SELECT id FROM changed
            """,
            {"user_id": user_id},
        )
        return bool(row)

    def purge_terminal(self, *, older_than_hours: float) -> dict[str, int]:
        expired_count = self._expire_due()
        hours = max(1.0, min(float(older_than_hours), 24.0 * 30.0))
        deleted = self._execute_one(
            """
            WITH removed AS (
              DELETE FROM one_location_nearby_presences
              WHERE status <> 'active'
                AND COALESCE(checked_out_at, expires_at, updated_at)
                  <= NOW() - (:hours * INTERVAL '1 hour')
              RETURNING id
            )
            SELECT COUNT(*) AS count FROM removed
            """,
            {"hours": hours},
        )
        safety = self._execute_one(
            """
            WITH removed_reports AS (
              DELETE FROM one_location_nearby_reports
              WHERE expires_at <= NOW()
              RETURNING report_id
            ),
            removed_audit AS (
              DELETE FROM one_location_nearby_audit_events
              WHERE expires_at <= NOW()
              RETURNING audit_id
            ),
            removed_abuse AS (
              DELETE FROM one_location_nearby_abuse_windows
              WHERE expires_at <= NOW()
              RETURNING principal_user_id
            ),
            removed_admissions AS (
              DELETE FROM one_location_nearby_admission_claims claim
              WHERE claim.expires_at <= NOW()
                AND NOT EXISTS (
                  SELECT 1
                  FROM one_location_nearby_presences presence
                  WHERE presence.admission_claim_id =
                    claim.admission_claim_id
                )
              RETURNING admission_claim_id
            )
            SELECT
              (SELECT COUNT(*) FROM removed_reports) AS reports,
              (SELECT COUNT(*) FROM removed_audit) AS audit_events,
              (SELECT COUNT(*) FROM removed_abuse) AS abuse_windows,
              (SELECT COUNT(*) FROM removed_admissions) AS admissions
            """
        )
        return {
            "expired": expired_count,
            "deleted": int((deleted or {}).get("count") or 0),
            "reportsDeleted": int((safety or {}).get("reports") or 0),
            "auditEventsDeleted": int((safety or {}).get("audit_events") or 0),
            "abuseWindowsDeleted": int((safety or {}).get("abuse_windows") or 0),
            "admissionClaimsDeleted": int((safety or {}).get("admissions") or 0),
        }


def _normalize_captured_at(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def _distance_meters(
    *,
    origin_lat: float,
    origin_lng: float,
    destination_lat: float,
    destination_lng: float,
) -> float:
    """Numerically clamped Haversine distance."""

    lat1 = math.radians(origin_lat)
    lat2 = math.radians(destination_lat)
    delta_lat = math.radians(destination_lat - origin_lat)
    delta_lng = math.radians(destination_lng - origin_lng)
    haversine = (
        math.sin(delta_lat / 2.0) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lng / 2.0) ** 2
    )
    clamped = max(0.0, min(1.0, haversine))
    return _EARTH_RADIUS_METERS * (
        2.0 * math.atan2(math.sqrt(clamped), math.sqrt(max(0.0, 1.0 - clamped)))
    )


def _valid_coordinates(*, lat: float, lng: float) -> bool:
    return (
        math.isfinite(lat)
        and math.isfinite(lng)
        and -90.0 <= lat <= 90.0
        and -180.0 <= lng <= 180.0
    )


def _derived_key(info: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_KEY_DERIVATION_SALT,
        info=info,
    ).derive(bytes.fromhex(VAULT_DATA_KEY))


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii")


def _b64decode(value: Any) -> bytes:
    return base64.urlsafe_b64decode(str(value or "").encode("ascii"))


def _anchor_key() -> bytes:
    return _derived_key(_ANCHOR_KEY_INFO)


def _anchor_key_id() -> str:
    return hashlib.sha256(_anchor_key()).hexdigest()[:16]


def _anchor_aad(owner_user_id: Any) -> bytes:
    normalized_owner = str(owner_user_id or "").strip()
    if not normalized_owner:
        raise ValueError("anchor owner is required")
    return _ANCHOR_AAD_PREFIX + normalized_owner.encode("utf-8")


def _encrypt_anchor(anchor: dict[str, Any], *, owner_user_id: str) -> dict[str, str]:
    plaintext = json.dumps(
        anchor,
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")
    nonce = os.urandom(12)
    encrypted = AESGCM(_anchor_key()).encrypt(
        nonce,
        plaintext,
        _anchor_aad(owner_user_id),
    )
    return {
        "ciphertext": _b64encode(encrypted[:-16]),
        "iv": _b64encode(nonce),
        "tag": _b64encode(encrypted[-16:]),
        "algorithm": _ANCHOR_ALGORITHM,
        "key_id": _anchor_key_id(),
    }


def _decrypt_anchor(row: dict[str, Any]) -> dict[str, Any]:
    if str(row.get("anchor_algorithm") or "") != _ANCHOR_ALGORITHM:
        raise ValueError("unsupported anchor algorithm")
    if not hmac.compare_digest(
        str(row.get("anchor_key_id") or ""),
        _anchor_key_id(),
    ):
        raise ValueError("unknown anchor key")
    plaintext = AESGCM(_anchor_key()).decrypt(
        _b64decode(row.get("anchor_iv")),
        _b64decode(row.get("anchor_ciphertext")) + _b64decode(row.get("anchor_tag")),
        _anchor_aad(row.get("owner_user_id")),
    )
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid anchor")
    lat = float(value.get("latitude"))
    lng = float(value.get("longitude"))
    if not _valid_coordinates(lat=lat, lng=lng):
        raise ValueError("invalid anchor coordinates")
    value["latitude"] = lat
    value["longitude"] = lng
    return value


def _cell_epoch(now: datetime) -> int:
    return int(now.timestamp() // _CELL_EPOCH_SECONDS)


def _tile_xy(*, lat: float, lng: float) -> tuple[int, int]:
    normalized_lat = max(
        -_MERCATOR_MAX_LATITUDE,
        min(_MERCATOR_MAX_LATITUDE, float(lat)),
    )
    normalized_lng = ((float(lng) + 180.0) % 360.0) - 180.0
    scale = 1 << _CELL_TILE_ZOOM
    x = int(math.floor(((normalized_lng + 180.0) / 360.0) * scale)) % scale
    lat_radians = math.radians(normalized_lat)
    mercator = math.asinh(math.tan(lat_radians))
    y = int(math.floor((1.0 - mercator / math.pi) / 2.0 * scale))
    return x, max(0, min(scale - 1, y))


def _cell_token(*, epoch: int, x: int, y: int) -> str:
    secret = _derived_key(_SPATIAL_CELL_KEY_INFO)
    material = (f"one-location-nearby-cell-v1\0{int(epoch)}\0{int(x)}\0{int(y)}").encode("utf-8")
    return hmac.new(secret, material, hashlib.sha256).hexdigest()


def _longitude_ranges(*, lng: float, delta: float) -> list[tuple[float, float]]:
    if delta >= 180.0:
        return [(-180.0, 180.0)]
    minimum = lng - delta
    maximum = lng + delta
    if minimum < -180.0:
        return [(minimum + 360.0, 180.0), (-180.0, maximum)]
    if maximum > 180.0:
        return [(minimum, 180.0), (-180.0, maximum - 360.0)]
    return [(minimum, maximum)]


def _tile_cover(
    *,
    lat: float,
    lng: float,
    radius_meters: float,
) -> set[tuple[int, int]]:
    """Return every z16 tile intersecting a conservative radius bounding box."""

    bounded_lat = max(
        -_MERCATOR_MAX_LATITUDE,
        min(_MERCATOR_MAX_LATITUDE, float(lat)),
    )
    angular = max(0.0, float(radius_meters)) / _EARTH_RADIUS_METERS
    latitude_delta = math.degrees(angular)
    minimum_lat = max(
        -_MERCATOR_MAX_LATITUDE,
        bounded_lat - latitude_delta,
    )
    maximum_lat = min(
        _MERCATOR_MAX_LATITUDE,
        bounded_lat + latitude_delta,
    )
    cosine = abs(math.cos(math.radians(bounded_lat)))
    longitude_delta = (
        180.0
        if cosine <= 1e-9
        else math.degrees(math.asin(min(1.0, max(0.0, math.sin(angular) / cosine))))
    )
    scale = 1 << _CELL_TILE_ZOOM
    tiles: set[tuple[int, int]] = set()
    for minimum_lng, maximum_lng in _longitude_ranges(
        lng=lng,
        delta=longitude_delta,
    ):
        x_start, y_bottom = _tile_xy(lat=minimum_lat, lng=minimum_lng)
        x_end, y_top = _tile_xy(lat=maximum_lat, lng=maximum_lng)
        if minimum_lng == -180.0 and maximum_lng == 180.0:
            x_values = range(scale)
        elif x_start <= x_end:
            x_values = range(x_start, x_end + 1)
        else:
            x_values = list(range(x_start, scale)) + list(range(0, x_end + 1))
        for x in x_values:
            for y in range(min(y_top, y_bottom), max(y_top, y_bottom) + 1):
                tiles.add((int(x), int(y)))
    return tiles


def _candidate_cell_tokens(
    *,
    lat: float,
    lng: float,
    radius_meters: int,
    now: datetime,
) -> tuple[list[int], list[str]]:
    epochs = [_cell_epoch(now), _cell_epoch(now) - 1]
    tiles = _tile_cover(lat=lat, lng=lng, radius_meters=radius_meters)
    tokens = [_cell_token(epoch=epoch, x=x, y=y) for epoch in epochs for x, y in sorted(tiles)]
    return epochs, tokens


def _roster_seed(now: datetime) -> str:
    """One global epoch sample prevents colluding viewers from unioning pages."""

    material = f"one-location-nearby-roster-v1\0{_cell_epoch(now)}".encode("utf-8")
    return hmac.new(
        _derived_key(_ROSTER_RANKING_KEY_INFO),
        material,
        hashlib.sha256,
    ).hexdigest()


def _presence_payload(row: dict[str, Any], anchor: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": "active",
        "audience": str(row.get("audience") or "all_opted_in"),
        "admissionMode": str(row.get("admission_mode") or "uat_simulation"),
        "allowConnectionRequests": bool(row.get("allow_connection_requests")),
        "consentVersion": str(row.get("consent_version") or NEARBY_PRESENCE_CONSENT_VERSION),
        "radiusMeters": int(row.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS),
        "checkedInAt": row.get("checked_in_at"),
        "expiresAt": row.get("expires_at"),
        "placeLabel": str(anchor.get("label") or "Selected place"),
    }
    if str(row.get("admission_mode") or "") == "event_pilot":
        payload["event"] = {
            "eventId": str(row.get("event_id") or ""),
            "displayName": str(row.get("event_display_name") or ""),
            "venue": {
                "placeId": str(row.get("event_venue_place_id") or ""),
                "label": str(row.get("event_venue_label") or ""),
            },
            "startsAt": row.get("event_starts_at"),
            "endsAt": row.get("event_ends_at"),
            "radiusMeters": int(row.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS),
        }
    return payload


class OneLocationNearbyPresenceService:
    """Policy layer for nearby check-in, discovery, checkout, and Connect."""

    def __init__(
        self,
        *,
        store: NearbyPresenceStore | None = None,
        connections_factory: Callable[[], ConnectionsService] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store or PostgresNearbyPresenceStore()
        self._connections_factory = connections_factory or ConnectionsService
        self._now = now or (lambda: datetime.now(timezone.utc))

    @staticmethod
    def _require_user(user_id: str) -> str:
        normalized = str(user_id or "").strip()
        if not normalized:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_AUTH_REQUIRED",
                "Sign in to use nearby check-in.",
                status_code=401,
            )
        return normalized

    def _require_verified_profile(self, user_id: str) -> None:
        profile = self._store.get_verified_profile(user_id)
        if not profile or not bool(profile.get("phone_verified")):
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_PHONE_VERIFICATION_REQUIRED",
                "Verify your phone number before appearing to nearby people.",
                status_code=403,
            )

    def check_in(
        self,
        *,
        user_id: str,
        place_id: str,
        place_label: str,
        current_lat: float,
        current_lng: float,
        place_lat: float,
        place_lng: float,
        accuracy_m: float | None,
        captured_at: datetime,
        duration_minutes: int,
        consent_accepted: bool,
        allow_connection_requests: bool,
        event_context: EventAdmissionContext | None = None,
    ) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        if not consent_accepted:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_CONSENT_REQUIRED",
                "Confirm nearby visibility before checking in.",
                status_code=422,
            )
        normalized_place_id = str(
            event_context.venue_place_id if event_context else place_id or ""
        ).strip()
        if not normalized_place_id:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_PLACE_REQUIRED",
                "Choose a nearby place before checking in.",
                status_code=422,
            )
        normalized_duration = int(duration_minutes)
        if normalized_duration not in NEARBY_PRESENCE_DURATION_MINUTES:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_DURATION_INVALID",
                "Choose 30 minutes, 1 hour, or 2 hours.",
                status_code=422,
            )
        self._require_verified_profile(owner_user_id)

        point_time = _normalize_captured_at(captured_at)
        now = self._now()
        age_seconds = (now - point_time).total_seconds()
        maximum_point_age = (
            NEARBY_PRESENCE_EVENT_MAX_POINT_AGE_SECONDS
            if event_context
            else NEARBY_PRESENCE_MAX_POINT_AGE_SECONDS
        )
        if (
            age_seconds > maximum_point_age
            or age_seconds < -NEARBY_PRESENCE_FUTURE_TOLERANCE_SECONDS
        ):
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_LOCATION_STALE",
                "Refresh your location and try checking in again.",
                status_code=422,
            )

        if accuracy_m is None:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_LOCATION_TOO_COARSE",
                "A precise location reading is needed for this check-in.",
                status_code=422,
            )
        normalized_accuracy = float(accuracy_m)
        if (
            not math.isfinite(normalized_accuracy)
            or normalized_accuracy < 0
            or normalized_accuracy > NEARBY_PRESENCE_MAX_ACCURACY_METERS
        ):
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_LOCATION_TOO_COARSE",
                "Turn on precise location, then try again.",
                status_code=422,
            )

        normalized_current_lat = float(current_lat)
        normalized_current_lng = float(current_lng)
        normalized_place_lat = float(event_context.venue_latitude if event_context else place_lat)
        normalized_place_lng = float(event_context.venue_longitude if event_context else place_lng)
        if not _valid_coordinates(
            lat=normalized_current_lat,
            lng=normalized_current_lng,
        ) or not _valid_coordinates(
            lat=normalized_place_lat,
            lng=normalized_place_lng,
        ):
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_LOCATION_INVALID",
                "The selected place could not be verified.",
                status_code=422,
            )

        distance = _distance_meters(
            origin_lat=normalized_current_lat,
            origin_lng=normalized_current_lng,
            destination_lat=normalized_place_lat,
            destination_lng=normalized_place_lng,
        )
        # Accuracy is uncertainty, not extra admission radius. Requiring the
        # uncertainty envelope to fit keeps the effective geofence at 500 m.
        if distance + normalized_accuracy > NEARBY_PRESENCE_RADIUS_METERS:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_OUTSIDE_RADIUS",
                "Choose a place closer to your current location.",
                status_code=422,
            )

        anchor = {
            "placeId": normalized_place_id,
            "label": str(
                event_context.venue_label if event_context else place_label or "Selected place"
            ).strip()[:300],
            "latitude": normalized_place_lat,
            "longitude": normalized_place_lng,
        }
        envelope = _encrypt_anchor(anchor, owner_user_id=owner_user_id)
        tile_x, tile_y = _tile_xy(
            lat=normalized_place_lat,
            lng=normalized_place_lng,
        )
        epoch = _cell_epoch(now)
        self._store.upsert_presence(
            user_id=owner_user_id,
            admission_mode="event_pilot" if event_context else "uat_simulation",
            event_id=event_context.event_id if event_context else None,
            admission_claim_id=(event_context.admission_claim_id if event_context else None),
            allow_connection_requests=bool(allow_connection_requests),
            consent_version=NEARBY_PRESENCE_CONSENT_VERSION,
            duration_minutes=normalized_duration,
            radius_meters=NEARBY_PRESENCE_RADIUS_METERS,
            anchor_envelope=envelope,
            anchor_cell_epoch=epoch,
            anchor_cell_token=_cell_token(epoch=epoch, x=tile_x, y=tile_y),
        )
        return self.get_state(user_id=owner_user_id)

    def get_state(self, *, user_id: str) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        self._require_verified_profile(owner_user_id)
        row = self._store.get_active_presence(owner_user_id)
        if not row:
            return {"presence": None, "attendees": []}
        try:
            viewer_anchor = _decrypt_anchor(row)
        except Exception as exc:
            self._store.checkout(owner_user_id)
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_UNAVAILABLE",
                "This check-in could not be restored. Please check in again.",
                status_code=503,
            ) from exc

        now = self._now()
        radius_meters = int(row.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS)
        epochs, tokens = _candidate_cell_tokens(
            lat=float(viewer_anchor["latitude"]),
            lng=float(viewer_anchor["longitude"]),
            radius_meters=radius_meters,
            now=now,
        )
        candidates = self._store.read_active_candidates(
            viewer_user_id=owner_user_id,
            viewer_version=int(row.get("version") or 0),
            cell_epochs=epochs,
            cell_tokens=tokens,
            roster_seed=_roster_seed(now),
            limit=NEARBY_PRESENCE_CANDIDATE_LIMIT,
        )
        attendees: list[dict[str, Any]] = []
        for candidate in candidates:
            try:
                anchor = _decrypt_anchor(candidate)
            except Exception:
                continue
            candidate_radius = int(candidate.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS)
            if _distance_meters(
                origin_lat=float(viewer_anchor["latitude"]),
                origin_lng=float(viewer_anchor["longitude"]),
                destination_lat=float(anchor["latitude"]),
                destination_lng=float(anchor["longitude"]),
            ) > min(radius_meters, candidate_radius):
                continue
            relationship = str(candidate.get("relationship") or "none")
            if relationship not in {
                "none",
                "pending_outgoing",
                "pending_incoming",
                "connected",
            }:
                relationship = "none"
            allows_requests = bool(candidate.get("allow_connection_requests"))
            attendees.append(
                {
                    "participantAlias": str(candidate.get("participant_alias") or ""),
                    "displayName": _safe_nearby_display_name(
                        candidate.get("display_name"),
                        owner_user_id=str(candidate.get("owner_user_id") or ""),
                    ),
                    "relationship": relationship,
                    "canConnect": allows_requests and relationship == "none",
                }
            )
            if len(attendees) >= NEARBY_PRESENCE_ROSTER_LIMIT:
                break
        return {
            "presence": _presence_payload(row, viewer_anchor),
            "attendees": attendees,
        }

    def checkout(self, *, user_id: str) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        self._store.checkout(owner_user_id)
        return {"presence": None, "attendees": [], "checkedOut": True}

    def request_connection(
        self,
        *,
        user_id: str,
        participant_alias: str,
    ) -> dict[str, str]:
        owner_user_id = self._require_user(user_id)
        self._require_verified_profile(owner_user_id)
        raw_alias = str(participant_alias or "").strip()
        try:
            normalized_alias = str(UUID(raw_alias))
        except (TypeError, ValueError, AttributeError):
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )

        rows = self._store.read_connection_pair(
            viewer_user_id=owner_user_id,
            participant_alias=normalized_alias,
        )
        viewer = next(
            (row for row in rows if str(row.get("owner_user_id") or "") == owner_user_id),
            None,
        )
        target = next(
            (row for row in rows if str(row.get("participant_alias") or "") == normalized_alias),
            None,
        )
        if (
            not viewer
            or not target
            or str(target.get("owner_user_id") or "") == owner_user_id
            or not bool(target.get("allow_connection_requests"))
            or str(viewer.get("admission_mode") or "") != str(target.get("admission_mode") or "")
            or (
                str(viewer.get("admission_mode") or "") == "event_pilot"
                and str(viewer.get("event_id") or "") != str(target.get("event_id") or "")
            )
        ):
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )
        try:
            viewer_anchor = _decrypt_anchor(viewer)
            target_anchor = _decrypt_anchor(target)
        except Exception as exc:
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            ) from exc
        if _distance_meters(
            origin_lat=float(viewer_anchor["latitude"]),
            origin_lng=float(viewer_anchor["longitude"]),
            destination_lat=float(target_anchor["latitude"]),
            destination_lng=float(target_anchor["longitude"]),
        ) > min(
            int(viewer.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS),
            int(target.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS),
        ):
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )

        request = self._connections_factory().create_request_from_nearby_alias(
            owner_user_id,
            participant_alias=normalized_alias,
            requester_presence_version=int(viewer.get("version") or 0),
            target_presence_version=int(target.get("version") or 0),
        )
        if not request:
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )
        relationship = str(request.get("relationship") or "")
        if relationship not in {
            "connected",
            "pending_outgoing",
            "pending_incoming",
        }:
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )
        return {"relationship": relationship}

    def block(
        self,
        *,
        user_id: str,
        participant_alias: str,
    ) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        self._require_verified_profile(owner_user_id)
        normalized_alias = self._normalize_participant_alias(participant_alias)
        if not self._store.apply_safety_action(
            viewer_user_id=owner_user_id,
            participant_alias=normalized_alias,
            reason_code=None,
        ):
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )
        return self.get_state(user_id=owner_user_id)

    def report(
        self,
        *,
        user_id: str,
        participant_alias: str,
        reason_code: str,
    ) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        self._require_verified_profile(owner_user_id)
        normalized_alias = self._normalize_participant_alias(participant_alias)
        normalized_reason = str(reason_code or "").strip().lower()
        if normalized_reason not in {
            "spam",
            "harassment",
            "unsafe_behavior",
            "other",
        }:
            raise NearbyPresenceError(
                "NEARBY_REPORT_REASON_INVALID",
                "Choose a report reason.",
                status_code=422,
            )
        if not self._store.apply_safety_action(
            viewer_user_id=owner_user_id,
            participant_alias=normalized_alias,
            reason_code=normalized_reason,
        ):
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            )
        return self.get_state(user_id=owner_user_id)

    @staticmethod
    def _normalize_participant_alias(participant_alias: str) -> str:
        raw_alias = str(participant_alias or "").strip()
        try:
            return str(UUID(raw_alias))
        except (TypeError, ValueError, AttributeError) as exc:
            raise NearbyPresenceError(
                "NEARBY_ATTENDEE_UNAVAILABLE",
                "This person is no longer available.",
                status_code=404,
            ) from exc

    def purge_terminal(self, *, older_than_hours: float = 12.0) -> dict[str, int]:
        return self._store.purge_terminal(older_than_hours=older_than_hours)


__all__ = [
    "NEARBY_PRESENCE_CONSENT_VERSION",
    "NEARBY_PRESENCE_DEFAULT_DURATION_MINUTES",
    "NEARBY_PRESENCE_DURATION_MINUTES",
    "NEARBY_PRESENCE_RADIUS_METERS",
    "NearbyPresenceError",
    "NearbyPresenceStore",
    "OneLocationNearbyPresenceService",
    "PostgresNearbyPresenceStore",
]
