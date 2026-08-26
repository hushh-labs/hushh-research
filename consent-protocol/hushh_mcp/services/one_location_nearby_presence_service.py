"""Privacy-bounded, short-lived nearby check-in presence for One Location.

This operon is deliberately separate from recipient-scoped live-location
grants. A fresh foreground GPS fix proves that the owner is plausibly at a
public place they selected, and is then discarded. Only that *place's*
coordinates are retained, as short-lived authenticated ciphertext indexed by a
short-epoch, server-keyed spatial token. Candidate tokens are a broad-phase
optimization; the service decrypts both place anchors and performs an exact
Haversine check before returning a peer or authorizing a Connect request.

Anchoring on the venue rather than the receiver reading is what lets the same
500 m guarantee hold on a 10 m native GPS fix and a 2 km browser fix alike:
co-presence is a property of the places two people chose, not of how well their
hardware happened to locate them. It also means the owner's true position is
never persisted in any form.

Postgres is authoritative today. ``NearbyPresenceStore`` is the replaceable
port for a future Redis/Memorystore active-presence index without changing the
API contract.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
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

from db.db_client import get_db
from hushh_mcp.config import VAULT_DATA_KEY
from hushh_mcp.services.connections_service import ConnectionsService

logger = logging.getLogger(__name__)

NEARBY_PRESENCE_CONSENT_VERSION = "one-location-nearby-presence-v3"
NEARBY_PRESENCE_DURATION_MINUTES = frozenset({30, 60, 120})
NEARBY_PRESENCE_DEFAULT_DURATION_MINUTES = 60
NEARBY_PRESENCE_RADIUS_METERS = 500
# Co-presence is anchored to the *selected place*, not the reported point, so a
# coarse fix can no longer smear the geofence. Accuracy is therefore only a
# plausibility signal: it bounds how far the owner may be from the place they
# claim. A browser on wifi/IP trilateration routinely reports 1-5 km, which the
# previous 100 m ceiling rejected outright -- that made the whole flow (places
# included) unreachable on desktop web and indoors. The ceiling now matches the
# API contract bound (`accuracyM <= 5000`), and the tolerance below caps how
# much slack a coarse reading may actually buy.
NEARBY_PRESENCE_MAX_ACCURACY_METERS = 5_000.0
NEARBY_PRESENCE_MAX_ACCURACY_TOLERANCE_METERS = 2_000.0
NEARBY_PRESENCE_MAX_POINT_AGE_SECONDS = 300.0
NEARBY_PRESENCE_FUTURE_TOLERANCE_SECONDS = 60.0
NEARBY_PRESENCE_ROSTER_LIMIT = 20
NEARBY_PRESENCE_CANDIDATE_LIMIT = 240

# The reported point is client-supplied and cannot be attested, so nothing above
# stops an account from claiming a place on the other side of the world. What
# *can* be checked is continuity: consecutive check-ins have to be reachable
# from one another at a speed a person could actually travel. This does not make
# a single check-in honest -- it makes a roaming attack cost real time, which is
# the difference between "appear anywhere instantly" and "move like a human".
# Faster than a commercial jet is treated as impossible.
NEARBY_PRESENCE_MAX_TRAVEL_SPEED_KMH = 900.0
# Re-checking in at the same venue, or one next door, must never trip the guard:
# below this the elapsed time is meaningless and the speed term explodes.
NEARBY_PRESENCE_TELEPORT_GRACE_METERS = 750.0
#
# Still missing before this should reach a general production audience:
#
#   * Device attestation (Play Integrity / App Attest) on the check-in write.
#     This is the only control that makes a *single* check-in trustworthy; the
#     continuity guard above only makes a *sequence* of them expensive. Needs
#     native plumbing on both platforms, so it is not a server-side change.
#   * A daily distinct-place cap. The guard forces an attacker to move at
#     human speed, but says nothing about how many places they visit over a
#     day. Enforcing that needs check-in history, and the table keeps one row
#     per owner -- so it needs a migration, deliberately deferred here.
#   * Report/block, so a blocked pair can never match into the same roster.
#
# Until those exist, production admission is cohort-gated in the route layer.

_CELL_EPOCH_SECONDS = 6 * 60 * 60
_CELL_TILE_ZOOM = 16
_MERCATOR_MAX_LATITUDE = 85.05112878
_EARTH_RADIUS_METERS = 6_371_000.0
_ANCHOR_ALGORITHM = "aes-256-gcm"
_ANCHOR_SCHEMA_VERSION = 3
# v3 stores the coordinates of the place the owner explicitly selected instead
# of their captured GPS point. Co-presence becomes exact (two people at the same
# venue always match, whatever their receiver reported) and the owner's true
# position is never persisted at all. `_decrypt_anchor` rejects both the old
# schema version and the old coordinate kind, and `get_state` checks the consent
# version before it ever decrypts, so v2 rows are checked out rather than read.
_ANCHOR_COORDINATE_KIND = "selected_place_point_v1"
_ANCHOR_AAD_PREFIX = b"hushh:one-location-nearby-presence:check-in-point:v2\0"
_KEY_DERIVATION_SALT = b"hushh:one-location-nearby-presence:kdf:v1"
_ANCHOR_KEY_INFO = b"hushh:one-location-nearby-presence:check-in-point-encryption:v2"
_SPATIAL_CELL_KEY_INFO = b"hushh:one-location-nearby-presence:spatial-cell-token:v2"
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
        allow_connection_requests: bool,
        consent_version: str,
        duration_minutes: int,
        radius_meters: int,
        anchor_envelope: dict[str, str],
        anchor_cell_epoch: int,
        anchor_cell_token: str,
    ) -> dict[str, Any]: ...

    def get_active_presence(self, user_id: str) -> dict[str, Any] | None: ...

    def get_last_presence(self, user_id: str) -> dict[str, Any] | None: ...

    def read_active_candidates(
        self,
        *,
        viewer_user_id: str,
        viewer_version: int,
        consent_version: str,
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
        consent_version: str,
    ) -> list[dict[str, Any]]: ...

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
              RETURNING id
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
        allow_connection_requests: bool,
        consent_version: str,
        duration_minutes: int,
        radius_meters: int,
        anchor_envelope: dict[str, str],
        anchor_cell_epoch: int,
        anchor_cell_token: str,
    ) -> dict[str, Any]:
        self._expire_due()
        row = self._execute_one(
            """
            INSERT INTO one_location_nearby_presences (
              owner_user_id,
              participant_alias,
              status,
              audience,
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
            VALUES (
              :user_id,
              gen_random_uuid(),
              'active',
              'all_opted_in',
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
              NOW() + (:duration_minutes * INTERVAL '1 minute'),
              NULL,
              1,
              NOW(),
              NOW()
            )
            ON CONFLICT (owner_user_id) DO UPDATE SET
              participant_alias = gen_random_uuid(),
              status = 'active',
              audience = 'all_opted_in',
              allow_connection_requests = EXCLUDED.allow_connection_requests,
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
              expires_at = NOW() + (:duration_minutes * INTERVAL '1 minute'),
              checked_out_at = NULL,
              version = one_location_nearby_presences.version + 1,
              updated_at = NOW()
            RETURNING *
            """,
            {
                "user_id": user_id,
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
            },
        )
        if not row:
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
            SELECT p.*
            FROM one_location_nearby_presences p
            JOIN actor_identity_cache profile
              ON profile.user_id = p.owner_user_id
             AND profile.phone_verified = TRUE
            WHERE p.owner_user_id = :user_id
              AND p.status = 'active'
              AND p.expires_at > NOW()
            LIMIT 1
            """,
            {"user_id": user_id},
        )

    def get_last_presence(self, user_id: str) -> dict[str, Any] | None:
        """The owner's most recent check-in, whatever state it ended in.

        Deliberately not `get_active_presence`: the continuity guard has to see
        a check-in the owner has already checked out of or let expire, which
        that query filters away. The table keeps one row per owner, so this is
        the previous check-in until it is overwritten or `purge_terminal`
        removes it.
        """

        return self._execute_one(
            """
            SELECT p.*
            FROM one_location_nearby_presences p
            WHERE p.owner_user_id = :user_id
            LIMIT 1
            """,
            {"user_id": user_id},
        )

    def read_active_candidates(
        self,
        *,
        viewer_user_id: str,
        viewer_version: int,
        consent_version: str,
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
              SELECT p.owner_user_id
              FROM one_location_nearby_presences p
              JOIN actor_identity_cache profile
                ON profile.user_id = p.owner_user_id
               AND profile.phone_verified = TRUE
              WHERE p.owner_user_id = :viewer_user_id
                AND p.version = :viewer_version
                AND p.consent_version = :consent_version
                AND p.status = 'active'
                AND p.expires_at > NOW()
              LIMIT 1
            )
            SELECT
              p.owner_user_id,
              p.participant_alias,
              p.consent_version,
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
             AND p.status = 'active'
             AND p.consent_version = :consent_version
             AND p.expires_at > NOW()
             AND p.anchor_cell_epoch = ANY(:cell_epochs)
             AND p.anchor_cell_token = ANY(:cell_tokens)
            JOIN actor_identity_cache profile
              ON profile.user_id = p.owner_user_id
             AND profile.phone_verified = TRUE
            ORDER BY roster_rank, p.participant_alias
            LIMIT :limit
            """,
            {
                "viewer_user_id": viewer_user_id,
                "viewer_version": int(viewer_version),
                "consent_version": consent_version,
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
        consent_version: str,
    ) -> list[dict[str, Any]]:
        self._expire_due()
        return self._execute_many(
            """
            SELECT
              p.owner_user_id,
              p.participant_alias,
              p.consent_version,
              p.allow_connection_requests,
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
              AND p.consent_version = :consent_version
              AND p.status = 'active'
              AND p.expires_at > NOW()
            ORDER BY p.owner_user_id
            """,
            {
                "viewer_user_id": viewer_user_id,
                "participant_alias": participant_alias,
                "consent_version": consent_version,
            },
        )

    def checkout(self, user_id: str) -> bool:
        row = self._execute_one(
            """
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
            RETURNING id
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
        return {
            "expired": expired_count,
            "deleted": int((deleted or {}).get("count") or 0),
        }


def _normalize_captured_at(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def _normalize_optional_timestamp(value: Any) -> datetime | None:
    """UTC-normalize a stored timestamp, tolerating a driver that returns text."""

    if isinstance(value, datetime):
        return _normalize_captured_at(value)
    if isinstance(value, str) and value.strip():
        try:
            return _normalize_captured_at(
                datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            )
        except ValueError:
            return None
    return None


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
    if value.get("schemaVersion") != _ANCHOR_SCHEMA_VERSION:
        raise ValueError("unsupported anchor schema")
    if value.get("coordinateKind") != _ANCHOR_COORDINATE_KIND:
        raise ValueError("unsupported anchor coordinate kind")
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
    raw_lat = float(lat)
    normalized_lat = max(
        -_MERCATOR_MAX_LATITUDE,
        min(_MERCATOR_MAX_LATITUDE, raw_lat),
    )
    normalized_lng = ((float(lng) + 180.0) % 360.0) - 180.0
    scale = 1 << _CELL_TILE_ZOOM
    if raw_lat > _MERCATOR_MAX_LATITUDE:
        return 0, 0
    if raw_lat < -_MERCATOR_MAX_LATITUDE:
        return 0, scale - 1
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

    geodesic_lat = max(-90.0, min(90.0, float(lat)))
    angular = max(0.0, float(radius_meters)) / _EARTH_RADIUS_METERS
    latitude_delta = math.degrees(angular)
    geodesic_minimum_lat = max(-90.0, geodesic_lat - latitude_delta)
    geodesic_maximum_lat = min(90.0, geodesic_lat + latitude_delta)
    scale = 1 << _CELL_TILE_ZOOM
    tiles: set[tuple[int, int]] = set()

    # Web Mercator has no finite representation beyond +/-85.051 degrees.
    # Collapse each polar cap into one broad-phase bucket, then keep exact
    # Haversine distance authoritative after decryption. Add the cap bucket to
    # crossing covers so pairs on opposite sides of the Mercator edge cannot be
    # lost before the exact check.
    if geodesic_maximum_lat > _MERCATOR_MAX_LATITUDE:
        tiles.add((0, 0))
    if geodesic_minimum_lat < -_MERCATOR_MAX_LATITUDE:
        tiles.add((0, scale - 1))

    minimum_lat = max(-_MERCATOR_MAX_LATITUDE, geodesic_minimum_lat)
    maximum_lat = min(_MERCATOR_MAX_LATITUDE, geodesic_maximum_lat)
    if minimum_lat > maximum_lat:
        return tiles

    cosine = abs(math.cos(math.radians(geodesic_lat)))
    crosses_pole = abs(geodesic_lat) + latitude_delta >= 90.0
    longitude_delta = (
        180.0
        if crosses_pole or cosine <= 1e-9
        else math.degrees(math.asin(min(1.0, max(0.0, math.sin(angular) / cosine))))
    )
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


def _anchor_coordinate(anchor: dict[str, Any], field: str) -> float | None:
    try:
        value = float(anchor[field])
    except (KeyError, TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _iso(value: Any) -> str | None:
    """Stringify a DB-driver datetime before it leaves this service.

    Check-in state reaches the live voice agent via "Save My Soul"; a raw
    datetime surviving into a tool result crashes the session's plain
    json.dumps with no result ever reaching the user.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return str(value.astimezone(timezone.utc).isoformat())
    return str(value)


def _presence_payload(row: dict[str, Any], anchor: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "active",
        "audience": str(row.get("audience") or "all_opted_in"),
        "allowConnectionRequests": bool(row.get("allow_connection_requests")),
        "consentVersion": str(row.get("consent_version") or NEARBY_PRESENCE_CONSENT_VERSION),
        "radiusMeters": int(row.get("radius_meters") or NEARBY_PRESENCE_RADIUS_METERS),
        "checkedInAt": _iso(row.get("checked_in_at")),
        "expiresAt": _iso(row.get("expires_at")),
        "placeLabel": str(anchor.get("label") or "Selected place"),
        # The owner's OWN anchor, returned only to the owner. It is the public
        # venue they picked, and the map needs it to keep showing where they
        # checked in after a reload -- distinct from where they now stand.
        # Nobody else's anchor is ever serialized; see the roster payload.
        "placeLat": _anchor_coordinate(anchor, "latitude"),
        "placeLng": _anchor_coordinate(anchor, "longitude"),
    }


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

    def _require_reachable_from_last_check_in(
        self,
        *,
        owner_user_id: str,
        place_lat: float,
        place_lng: float,
        now: datetime,
    ) -> None:
        """Reject a check-in the owner could not physically have travelled to.

        Everything else in this flow trusts a client-supplied point, so an
        account can claim any single place. Consecutive claims, though, have to
        be consistent with each other -- and that is checkable server-side with
        no attestation. An account that checked in in London ten minutes ago is
        not in Sydney now.

        Fails open on our own data problems (no previous row, unreadable
        anchor, unusable timestamp). A decryption bug must not lock people out
        of a feature they are using honestly; the roaming attack this closes is
        the deliberate one, and it needs a *readable* previous anchor to be
        detected at all.
        """

        try:
            previous = self._store.get_last_presence(owner_user_id)
        except Exception:  # noqa: BLE001 - continuity is a guard, not a gate
            return
        if not previous:
            return
        try:
            anchor = _decrypt_anchor(previous)
        except Exception:  # noqa: BLE001 - see docstring
            return

        previous_lat = anchor.get("latitude")
        previous_lng = anchor.get("longitude")
        if not isinstance(previous_lat, (int, float)) or not isinstance(previous_lng, (int, float)):
            return

        previous_at = _normalize_optional_timestamp(previous.get("checked_in_at"))
        if previous_at is None:
            return

        distance_meters = _distance_meters(
            origin_lat=float(previous_lat),
            origin_lng=float(previous_lng),
            destination_lat=place_lat,
            destination_lng=place_lng,
        )
        if (
            not math.isfinite(distance_meters)
            or distance_meters <= NEARBY_PRESENCE_TELEPORT_GRACE_METERS
        ):
            return

        elapsed_seconds = (now - previous_at).total_seconds()
        # A non-positive gap with real distance is itself impossible, so clamp
        # rather than divide by zero -- the speed below then trips the guard.
        elapsed_hours = max(elapsed_seconds, 1.0) / 3600.0
        speed_kmh = (distance_meters / 1000.0) / elapsed_hours
        if speed_kmh <= NEARBY_PRESENCE_MAX_TRAVEL_SPEED_KMH:
            return

        logger.warning(
            "nearby_presence.teleport_rejected owner=%s distance_km=%.1f elapsed_s=%.0f speed_kmh=%.0f",
            owner_user_id,
            distance_meters / 1000.0,
            elapsed_seconds,
            speed_kmh,
        )
        raise NearbyPresenceError(
            "NEARBY_PRESENCE_IMPLAUSIBLE_TRAVEL",
            "That place is too far from your last check-in to be reachable yet. "
            "Check in again once you have actually arrived.",
            status_code=422,
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
    ) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        if not consent_accepted:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_CONSENT_REQUIRED",
                "Confirm nearby visibility before checking in.",
                status_code=422,
            )
        normalized_place_id = str(place_id or "").strip()
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
        if (
            age_seconds > NEARBY_PRESENCE_MAX_POINT_AGE_SECONDS
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
                "Your location reading is too broad to place you. "
                "Turn on precise location, then try again.",
                status_code=422,
            )

        normalized_current_lat = float(current_lat)
        normalized_current_lng = float(current_lng)
        normalized_place_lat = float(place_lat)
        normalized_place_lng = float(place_lng)
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
        # The geofence now lives in two places that cannot be smeared by a coarse
        # receiver: the place list the owner chose from is itself restricted to a
        # 500 m circle around this same point, and co-presence is measured
        # place-to-place below. So this check only asks "is the owner plausibly at
        # the place they claim?" -- accuracy widens that envelope instead of
        # shrinking the geofence. The old `distance + accuracy` form double-counted
        # the radius and made any fix coarser than 100 m unable to confirm a place
        # it legitimately sat on. Tolerance is capped so a deliberately coarse
        # reading cannot buy unlimited reach.
        tolerance = min(
            normalized_accuracy,
            NEARBY_PRESENCE_MAX_ACCURACY_TOLERANCE_METERS,
        )
        if distance > NEARBY_PRESENCE_RADIUS_METERS + tolerance:
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_OUTSIDE_RADIUS",
                "Choose a place closer to your current location.",
                status_code=422,
            )

        self._require_reachable_from_last_check_in(
            owner_user_id=owner_user_id,
            place_lat=normalized_place_lat,
            place_lng=normalized_place_lng,
            now=now,
        )

        # Anchor on the selected place, never the captured point: it makes the
        # roster exact regardless of receiver quality and keeps the owner's real
        # position out of storage entirely.
        anchor = {
            "schemaVersion": _ANCHOR_SCHEMA_VERSION,
            "coordinateKind": _ANCHOR_COORDINATE_KIND,
            "label": str(place_label or "Selected place").strip()[:300],
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
        if str(row.get("consent_version") or "") != NEARBY_PRESENCE_CONSENT_VERSION:
            self._store.checkout(owner_user_id)
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
            consent_version=NEARBY_PRESENCE_CONSENT_VERSION,
            cell_epochs=epochs,
            cell_tokens=tokens,
            roster_seed=_roster_seed(now),
            limit=NEARBY_PRESENCE_CANDIDATE_LIMIT,
        )
        attendees: list[dict[str, Any]] = []
        for candidate in candidates:
            if str(candidate.get("consent_version") or "") != NEARBY_PRESENCE_CONSENT_VERSION:
                continue
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
            consent_version=NEARBY_PRESENCE_CONSENT_VERSION,
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
            or str(viewer.get("consent_version") or "") != NEARBY_PRESENCE_CONSENT_VERSION
            or str(target.get("consent_version") or "") != NEARBY_PRESENCE_CONSENT_VERSION
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
