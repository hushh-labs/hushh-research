"""Organizer admission and event control for production Nearby Check-In.

The production trust boundary is an organizer-issued, signed, one-time pass.
Only a SHA-256 digest of the pass JTI is stored. Passes are never logged or
persisted by the backend. Postgres is authoritative for replay protection and
event state so every Cloud Run instance observes the same decision.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import UUID

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.config import APP_SIGNING_KEY

_TOKEN_PREFIX = "olna1"  # noqa: S105 - public protocol identifier, not a secret
_TOKEN_ISSUER = "hushh-one-location"  # noqa: S105 - public issuer identifier
_TOKEN_AUDIENCE = "one-location-event-admission"  # noqa: S105 - public audience
_SIGNING_DOMAIN = b"hushh:one-location:event-admission:v1\0"


class EventAdmissionError(RuntimeError):
    """Stable, user-safe event-admission error."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class EventAdmissionContext:
    admission_claim_id: str
    event_id: str
    display_name: str
    venue_place_id: str
    venue_label: str
    venue_latitude: float
    venue_longitude: float
    radius_meters: int
    starts_at: datetime
    ends_at: datetime

    def public_payload(self) -> dict[str, Any]:
        return {
            "eventId": self.event_id,
            "displayName": self.display_name,
            "venue": {
                "placeId": self.venue_place_id,
                "label": self.venue_label,
            },
            "radiusMeters": self.radius_meters,
            "startsAt": self.starts_at,
            "endsAt": self.ends_at,
        }


def _utc(value: Any) -> datetime:
    if isinstance(value, datetime):
        return (
            value.replace(tzinfo=timezone.utc)
            if value.tzinfo is None
            else value.astimezone(timezone.utc)
        )
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return (
        parsed.replace(tzinfo=timezone.utc)
        if parsed.tzinfo is None
        else parsed.astimezone(timezone.utc)
    )


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _jti_hash(jti: str) -> str:
    return hashlib.sha256(jti.encode("utf-8")).hexdigest()


def _sign(encoded_payload: str) -> str:
    signature = hmac.new(
        APP_SIGNING_KEY.encode("utf-8"),
        _SIGNING_DOMAIN + encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return _b64url_encode(signature)


def _encode_pass(payload: dict[str, Any]) -> str:
    encoded_payload = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    return f"{_TOKEN_PREFIX}.{encoded_payload}.{_sign(encoded_payload)}"


def _decode_pass(raw_token: str, *, now: datetime) -> dict[str, Any]:
    token = str(raw_token or "").strip()
    if not token or len(token) > 2_048:
        raise EventAdmissionError(
            "NEARBY_ADMISSION_INVALID",
            "This event pass is invalid or expired.",
            status_code=404,
        )
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != _TOKEN_PREFIX:
        raise EventAdmissionError(
            "NEARBY_ADMISSION_INVALID",
            "This event pass is invalid or expired.",
            status_code=404,
        )
    encoded_payload, provided_signature = parts[1], parts[2]
    if not hmac.compare_digest(provided_signature, _sign(encoded_payload)):
        raise EventAdmissionError(
            "NEARBY_ADMISSION_INVALID",
            "This event pass is invalid or expired.",
            status_code=404,
        )
    try:
        payload = json.loads(_b64url_decode(encoded_payload).decode("utf-8"))
        issued_at = datetime.fromtimestamp(int(payload["iat"]), timezone.utc)
        not_before = datetime.fromtimestamp(int(payload["nbf"]), timezone.utc)
        expires_at = datetime.fromtimestamp(int(payload["exp"]), timezone.utc)
        UUID(str(payload["eventId"]))
        jti = str(payload["jti"])
    except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EventAdmissionError(
            "NEARBY_ADMISSION_INVALID",
            "This event pass is invalid or expired.",
            status_code=404,
        ) from exc
    if (
        payload.get("iss") != _TOKEN_ISSUER
        or payload.get("aud") != _TOKEN_AUDIENCE
        or not jti
        or len(jti) > 160
        or issued_at > now + timedelta(minutes=1)
        or now < not_before
        or now >= expires_at
    ):
        raise EventAdmissionError(
            "NEARBY_ADMISSION_INVALID",
            "This event pass is invalid or expired.",
            status_code=404,
        )
    return payload


def _context_from_row(row: dict[str, Any]) -> EventAdmissionContext:
    return EventAdmissionContext(
        admission_claim_id=str(row["admission_claim_id"]),
        event_id=str(row["event_id"]),
        display_name=str(row["display_name"]),
        venue_place_id=str(row["venue_place_id"]),
        venue_label=str(row["venue_label"]),
        venue_latitude=float(row["venue_latitude"]),
        venue_longitude=float(row["venue_longitude"]),
        radius_meters=int(row["radius_meters"]),
        starts_at=_utc(row["starts_at"]),
        ends_at=_utc(row["ends_at"]),
    )


class OneLocationEventAdmissionService:
    """Event admission policy with a Postgres replay-protection authority."""

    def __init__(self, *, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(timezone.utc))

    @staticmethod
    def _require_user(user_id: str) -> str:
        normalized = str(user_id or "").strip()
        if not normalized:
            raise EventAdmissionError(
                "NEARBY_ADMISSION_AUTH_REQUIRED",
                "Sign in to use an event pass.",
                status_code=401,
            )
        return normalized

    def claim(self, *, user_id: str, admission_token: str) -> dict[str, Any]:
        owner_user_id = self._require_user(user_id)
        now = self._now()
        payload = _decode_pass(admission_token, now=now)
        params = {
            "user_id": owner_user_id,
            "event_id": str(payload["eventId"]),
            "jti_hash": _jti_hash(str(payload["jti"])),
        }
        with get_db().engine.begin() as conn:
            result = (
                conn.execute(
                    text(
                        """
                    SELECT
                      claim.admission_claim_id,
                      claim.event_id,
                      claim.claimed_by_user_id,
                      claim.claimed_at,
                      claim.expires_at AS claim_expires_at,
                      event.display_name,
                      event.venue_place_id,
                      event.venue_label,
                      event.venue_latitude,
                      event.venue_longitude,
                      event.radius_meters,
                      event.starts_at,
                      event.ends_at,
                      event.status
                    FROM one_location_nearby_admission_claims claim
                    JOIN one_location_nearby_event_pilots event
                      ON event.event_id = claim.event_id
                    WHERE claim.jti_hash = :jti_hash
                      AND claim.event_id = CAST(:event_id AS UUID)
                    FOR UPDATE OF claim, event
                    """
                    ),
                    params,
                )
                .mappings()
                .first()
            )
            row = dict(result) if result is not None else None
            if (
                not row
                or str(row.get("status") or "") != "active"
                or _utc(row["starts_at"]) > now
                or _utc(row["ends_at"]) <= now
                or _utc(row["claim_expires_at"]) <= now
            ):
                raise EventAdmissionError(
                    "NEARBY_ADMISSION_INVALID",
                    "This event pass is invalid or expired.",
                    status_code=404,
                )
            claimed_by = str(row.get("claimed_by_user_id") or "").strip()
            if claimed_by and claimed_by != owner_user_id:
                raise EventAdmissionError(
                    "NEARBY_ADMISSION_INVALID",
                    "This event pass is invalid or expired.",
                    status_code=404,
                )
            idempotent_replay = claimed_by == owner_user_id
            if not idempotent_replay:
                updated = conn.execute(
                    text(
                        """
                        UPDATE one_location_nearby_admission_claims
                        SET claimed_by_user_id = :user_id, claimed_at = NOW()
                        WHERE admission_claim_id = :admission_claim_id
                          AND claimed_by_user_id IS NULL
                        RETURNING admission_claim_id
                        """
                    ),
                    {
                        "user_id": owner_user_id,
                        "admission_claim_id": row["admission_claim_id"],
                    },
                ).first()
                if not updated:
                    raise EventAdmissionError(
                        "NEARBY_ADMISSION_INVALID",
                        "This event pass is invalid or expired.",
                        status_code=404,
                    )
                conn.execute(
                    text(
                        """
                        INSERT INTO one_location_nearby_audit_events (
                          actor_user_id,
                          event_id,
                          action,
                          outcome
                        )
                        VALUES (
                          :user_id,
                          CAST(:event_id AS UUID),
                          'admission_claimed',
                          'succeeded'
                        )
                        """
                    ),
                    params,
                )

        context = _context_from_row(row)
        return {
            "admissionId": context.admission_claim_id,
            "event": context.public_payload(),
            "idempotentReplay": idempotent_replay,
        }

    def require_context(
        self,
        *,
        user_id: str,
        admission_claim_id: str,
    ) -> EventAdmissionContext:
        owner_user_id = self._require_user(user_id)
        try:
            normalized_claim_id = str(UUID(str(admission_claim_id or "").strip()))
        except (TypeError, ValueError, AttributeError) as exc:
            raise EventAdmissionError(
                "NEARBY_ADMISSION_REQUIRED",
                "Enter a valid event pass before checking in.",
                status_code=403,
            ) from exc
        result = get_db().execute_raw(
            """
            SELECT
              claim.admission_claim_id,
              claim.event_id,
              event.display_name,
              event.venue_place_id,
              event.venue_label,
              event.venue_latitude,
              event.venue_longitude,
              event.radius_meters,
              event.starts_at,
              event.ends_at
            FROM one_location_nearby_admission_claims claim
            JOIN one_location_nearby_event_pilots event
              ON event.event_id = claim.event_id
            WHERE claim.admission_claim_id = CAST(:admission_claim_id AS UUID)
              AND claim.claimed_by_user_id = :user_id
              AND claim.claimed_at IS NOT NULL
              AND claim.expires_at > NOW()
              AND event.status = 'active'
              AND event.starts_at <= NOW()
              AND event.ends_at > NOW()
            LIMIT 1
            """,
            {
                "admission_claim_id": normalized_claim_id,
                "user_id": owner_user_id,
            },
        )
        if not result.data:
            raise EventAdmissionError(
                "NEARBY_ADMISSION_REQUIRED",
                "Your event pass is no longer active.",
                status_code=403,
            )
        return _context_from_row(result.data[0])

    def has_active_event(self) -> bool:
        """Return the database-backed per-event kill-switch state."""

        result = get_db().execute_raw(
            """
            SELECT EXISTS (
              SELECT 1
              FROM one_location_nearby_event_pilots
              WHERE status = 'active'
                AND starts_at <= NOW()
                AND ends_at > NOW()
            ) AS available
            """
        )
        return bool(result.data and result.data[0].get("available"))

    def current_admission(self, *, user_id: str) -> dict[str, Any] | None:
        """Restore an already-claimed pass without returning the raw pass."""

        owner_user_id = self._require_user(user_id)
        result = get_db().execute_raw(
            """
            SELECT
              claim.admission_claim_id,
              claim.event_id,
              event.display_name,
              event.venue_place_id,
              event.venue_label,
              event.venue_latitude,
              event.venue_longitude,
              event.radius_meters,
              event.starts_at,
              event.ends_at
            FROM one_location_nearby_admission_claims claim
            JOIN one_location_nearby_event_pilots event
              ON event.event_id = claim.event_id
            WHERE claim.claimed_by_user_id = :user_id
              AND claim.claimed_at IS NOT NULL
              AND claim.expires_at > NOW()
              AND event.status = 'active'
              AND event.starts_at <= NOW()
              AND event.ends_at > NOW()
            ORDER BY claim.claimed_at DESC
            LIMIT 1
            """,
            {"user_id": owner_user_id},
        )
        if not result.data:
            return None
        context = _context_from_row(result.data[0])
        return {
            "admissionId": context.admission_claim_id,
            "event": context.public_payload(),
            "idempotentReplay": True,
        }

    def create_event(
        self,
        *,
        display_name: str,
        venue_place_id: str,
        venue_label: str,
        venue_latitude: float,
        venue_longitude: float,
        starts_at: datetime,
        ends_at: datetime,
        created_by_user_id: str | None = None,
        activate: bool = False,
    ) -> dict[str, Any]:
        result = get_db().execute_raw(
            """
            INSERT INTO one_location_nearby_event_pilots (
              display_name,
              venue_place_id,
              venue_label,
              venue_latitude,
              venue_longitude,
              status,
              starts_at,
              ends_at,
              created_by_user_id
            )
            VALUES (
              :display_name,
              :venue_place_id,
              :venue_label,
              :venue_latitude,
              :venue_longitude,
              :status,
              :starts_at,
              :ends_at,
              :created_by_user_id
            )
            RETURNING *
            """,
            {
                "display_name": " ".join(str(display_name or "").split()),
                "venue_place_id": str(venue_place_id or "").strip(),
                "venue_label": " ".join(str(venue_label or "").split()),
                "venue_latitude": float(venue_latitude),
                "venue_longitude": float(venue_longitude),
                "status": "active" if activate else "draft",
                "starts_at": _utc(starts_at),
                "ends_at": _utc(ends_at),
                "created_by_user_id": str(created_by_user_id or "").strip() or None,
            },
        )
        if not result.data:
            raise EventAdmissionError(
                "NEARBY_EVENT_WRITE_FAILED",
                "The event could not be created.",
                status_code=503,
            )
        return result.data[0]

    def set_event_status(self, *, event_id: str, status: str) -> dict[str, Any]:
        normalized_status = str(status or "").strip().lower()
        if normalized_status not in {"active", "paused", "closed"}:
            raise ValueError("status must be active, paused, or closed")
        normalized_event_id = str(UUID(event_id))
        with get_db().engine.begin() as conn:
            current_result = (
                conn.execute(
                    text(
                        """
                    SELECT *
                    FROM one_location_nearby_event_pilots
                    WHERE event_id = CAST(:event_id AS UUID)
                    FOR UPDATE
                    """
                    ),
                    {"event_id": normalized_event_id},
                )
                .mappings()
                .first()
            )
            if current_result is None:
                raise EventAdmissionError(
                    "NEARBY_EVENT_NOT_FOUND",
                    "The event was not found.",
                    status_code=404,
                )
            current = dict(current_result)
            current_status = str(current.get("status") or "")
            if current_status == "closed" and normalized_status != "closed":
                raise EventAdmissionError(
                    "NEARBY_EVENT_CLOSED",
                    "A closed event cannot be reopened.",
                    status_code=409,
                )
            if current_status == "draft" and normalized_status == "paused":
                raise EventAdmissionError(
                    "NEARBY_EVENT_STATUS_INVALID",
                    "A draft event cannot be paused.",
                    status_code=409,
                )
            updated_result = (
                conn.execute(
                    text(
                        """
                    UPDATE one_location_nearby_event_pilots
                    SET status = :status, updated_at = NOW()
                    WHERE event_id = CAST(:event_id AS UUID)
                    RETURNING *
                    """
                    ),
                    {
                        "event_id": normalized_event_id,
                        "status": normalized_status,
                    },
                )
                .mappings()
                .first()
            )
            if normalized_status in {"paused", "closed"}:
                conn.execute(
                    text(
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
                          WHERE event_id = CAST(:event_id AS UUID)
                            AND status = 'active'
                          RETURNING owner_user_id, event_id, version
                        )
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
                        """
                    ),
                    {"event_id": normalized_event_id},
                )
            updated = dict(updated_result) if updated_result is not None else None
        if not updated:
            raise EventAdmissionError(
                "NEARBY_EVENT_WRITE_FAILED",
                "The event status could not be updated.",
                status_code=503,
            )
        return updated

    def issue_admissions(self, *, event_id: str, count: int) -> list[str]:
        normalized_count = int(count)
        if normalized_count < 1 or normalized_count > 500:
            raise ValueError("count must be between 1 and 500")
        normalized_event_id = str(UUID(event_id))
        issued: list[str] = []
        with get_db().engine.begin() as conn:
            event_result = (
                conn.execute(
                    text(
                        """
                    SELECT event_id, starts_at, ends_at, status
                    FROM one_location_nearby_event_pilots
                    WHERE event_id = CAST(:event_id AS UUID)
                    FOR UPDATE
                    """
                    ),
                    {"event_id": normalized_event_id},
                )
                .mappings()
                .first()
            )
            if event_result is None:
                raise EventAdmissionError(
                    "NEARBY_EVENT_NOT_FOUND",
                    "The event was not found.",
                    status_code=404,
                )
            event = dict(event_result)
            if str(event.get("status") or "") == "closed":
                raise ValueError("cannot issue admissions for a closed event")
            now = self._now()
            not_before = min(now, _utc(event["starts_at"]))
            expires_at = _utc(event["ends_at"])
            if expires_at <= now:
                raise ValueError("cannot issue admissions for an ended event")
            for _ in range(normalized_count):
                jti = secrets.token_urlsafe(32)
                conn.execute(
                    text(
                        """
                        INSERT INTO one_location_nearby_admission_claims (
                          event_id,
                          jti_hash,
                          expires_at
                        )
                        VALUES (
                          CAST(:event_id AS UUID),
                          :jti_hash,
                          :expires_at
                        )
                        """
                    ),
                    {
                        "event_id": normalized_event_id,
                        "jti_hash": _jti_hash(jti),
                        "expires_at": expires_at,
                    },
                )
                issued.append(
                    _encode_pass(
                        {
                            "iss": _TOKEN_ISSUER,
                            "aud": _TOKEN_AUDIENCE,
                            "eventId": normalized_event_id,
                            "jti": jti,
                            "iat": int(now.timestamp()),
                            "nbf": int(not_before.timestamp()),
                            "exp": int(expires_at.timestamp()),
                        }
                    )
                )
        return issued
