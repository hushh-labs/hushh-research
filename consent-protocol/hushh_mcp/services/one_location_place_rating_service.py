"""Rate the place you just left.

Nearby check-in is engineered so that no durable link between a person and a
venue survives: the place anchor is authenticated ciphertext, ``checkout()``
NULLs every anchor column, and terminal rows are purged within hours. A rating
cannot exist under that rule, so this module draws the line explicitly rather
than eroding it quietly:

``one_location_nearby_visits``
    An encrypted, short-lived ledger of completed visits. Same envelope
    strength as the presence anchor, its own AAD prefix so the two ciphertext
    families can never be swapped by a coding error, plus a server-keyed
    equality token so "same venue?" and "how many distinct places today?" can
    be answered without decrypting. Purged at ``expires_at``.

``one_location_place_ratings``
    A plaintext place id, permanently, one row per (author, place). Created
    only when its author accepts ``one-location-place-rating-v1`` -- a named
    consent whose fourth line says, in words, that being at the place is what
    makes them eligible to rate it.

The rating is **private to its author**. No read path in this module returns an
author identifier next to a place id, no review text is stored here at all (the
author's note lives in their own vault, client-side encrypted), and the only
cross-user projection is an anonymous count and average that is withheld
entirely below :data:`PLACE_RATING_PUBLICATION_MIN_COUNT` and reported in
buckets so polling cannot recover an individual rating by subtraction.

The visit ledger has a second job. ``checkout()`` destroys the presence
anchor, which is also the input to the teleport-continuity guard -- so before
this module existed, checking out disarmed that guard until the next check-in
wrote a new anchor. :meth:`OneLocationPlaceRatingService.last_continuity_point`
is what lets the guard survive a checkout.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Protocol

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from db.db_client import get_db
from hushh_mcp.config import VAULT_DATA_KEY
from hushh_mcp.operons.location.place_rating_policy import (
    PLACE_RATING_PUBLICATION_MIN_COUNT,
    bucket_rating_count,
    google_write_review_url,
    is_aggregatable_category,
    normalize_place_id,
    normalize_place_label,
    normalize_rating,
    publishable_average,
)

logger = logging.getLogger(__name__)

# The word "public" is in the string on purpose. A version bump must be legible
# to the person re-reading it, not only to the code comparing it.
PLACE_RATING_CONSENT_VERSION = "one-location-place-rating-v1"

# How long after a check-in the place stays rateable.
#
# The single number that trades reach against how long the private link lives.
# 72 hours loses the Monday lunch remembered on Friday, which is most of them;
# 30 days keeps an encrypted movement trail far longer than the feature needs.
# Seven days of an encrypted, user-scoped, auto-purged row is the trade taken.
PLACE_RATING_VISIT_TTL_HOURS = 168.0

PLACE_RATING_HISTORY_LIMIT = 50

_VISIT_ALGORITHM = "aes-256-gcm"
_VISIT_SCHEMA_VERSION = 1
_KEY_DERIVATION_SALT = b"hushh:one-location-place-rating:kdf:v1"
_VISIT_KEY_INFO = b"hushh:one-location-place-rating:visit-place-encryption:v1"
_VISIT_TOKEN_KEY_INFO = b"hushh:one-location-place-rating:visit-place-token:v1"
_VISIT_AAD_PREFIX = b"hushh:one-location-place-rating:visit-place:v1\0"


class PlaceRatingError(RuntimeError):
    """Stable, user-safe place-rating error."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


# ---------------------------------------------------------------------------
# Envelope helpers
# ---------------------------------------------------------------------------


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


def _visit_key() -> bytes:
    return _derived_key(_VISIT_KEY_INFO)


def _visit_key_id() -> str:
    return hashlib.sha256(_visit_key()).hexdigest()[:16]


def _visit_aad(owner_user_id: Any) -> bytes:
    normalized_owner = str(owner_user_id or "").strip()
    if not normalized_owner:
        raise ValueError("visit owner is required")
    return _VISIT_AAD_PREFIX + normalized_owner.encode("utf-8")


def place_token(place_id: str) -> str:
    """Keyed equality token for a provider place id.

    Deterministic so two visits to one venue collide, keyed so the mapping is
    not reproducible by anyone without the deployment key. It is **not** an
    anonymiser -- anyone holding the key and a list of places can invert it. It
    exists so equality and distinct-place counting cost no decryption.
    """
    return hmac.new(
        _derived_key(_VISIT_TOKEN_KEY_INFO),
        place_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]


def _encrypt_visit_place(payload: dict[str, Any], *, owner_user_id: str) -> dict[str, str]:
    plaintext = json.dumps(
        payload,
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")
    nonce = os.urandom(12)
    encrypted = AESGCM(_visit_key()).encrypt(nonce, plaintext, _visit_aad(owner_user_id))
    return {
        "ciphertext": _b64encode(encrypted[:-16]),
        "iv": _b64encode(nonce),
        "tag": _b64encode(encrypted[-16:]),
        "algorithm": _VISIT_ALGORITHM,
        "key_id": _visit_key_id(),
    }


def _decrypt_visit_place(row: dict[str, Any]) -> dict[str, Any]:
    if str(row.get("place_algorithm") or "") != _VISIT_ALGORITHM:
        raise ValueError("unsupported visit algorithm")
    if not hmac.compare_digest(str(row.get("place_key_id") or ""), _visit_key_id()):
        raise ValueError("unknown visit key")
    plaintext = AESGCM(_visit_key()).decrypt(
        _b64decode(row.get("place_iv")),
        _b64decode(row.get("place_ciphertext")) + _b64decode(row.get("place_tag")),
        _visit_aad(row.get("owner_user_id")),
    )
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != _VISIT_SCHEMA_VERSION:
        raise ValueError("unsupported visit schema")
    return value


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat()
    return None


# ---------------------------------------------------------------------------
# Store port
# ---------------------------------------------------------------------------


class PlaceRatingStore(Protocol):
    def insert_visit(self, **kwargs: Any) -> dict[str, Any] | None: ...

    def end_open_visits(self, *, user_id: str, ended_at: datetime) -> dict[str, Any] | None: ...

    def get_rateable_visit(
        self, *, user_id: str, place_token_value: str, not_before: datetime
    ) -> dict[str, Any] | None: ...

    def list_rateable_visits(
        self, *, user_id: str, not_before: datetime, limit: int
    ) -> list[dict[str, Any]]: ...

    def latest_visit(self, *, user_id: str) -> dict[str, Any] | None: ...

    def mark_visit_rated(self, *, visit_id: Any, rated_at: datetime) -> None: ...

    def upsert_rating(self, **kwargs: Any) -> dict[str, Any] | None: ...

    def list_ratings(self, *, user_id: str, limit: int) -> list[dict[str, Any]]: ...

    def delete_rating(self, *, user_id: str, place_id: str) -> dict[str, Any] | None: ...

    def recompute_aggregate(self, *, place_id: str) -> dict[str, Any] | None: ...

    def read_aggregate(self, *, place_id: str) -> dict[str, Any] | None: ...

    def purge_expired_visits(self) -> int: ...


class PostgresPlaceRatingStore:
    """Postgres adapter; contains no product policy beyond query scoping."""

    @staticmethod
    def _execute_one(sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    @staticmethod
    def _execute_many(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

    def insert_visit(
        self,
        *,
        user_id: str,
        envelope: dict[str, str],
        place_token_value: str,
        checked_in_at: datetime,
        expires_at: datetime,
    ) -> dict[str, Any] | None:
        # ON CONFLICT on the partial unique index: re-checking into the same
        # venue while the first visit is still open refreshes it rather than
        # opening a second reviewable row, or one afternoon at one cafe becomes
        # three prompts.
        return self._execute_one(
            """
            INSERT INTO one_location_nearby_visits (
              owner_user_id, place_ciphertext, place_iv, place_tag,
              place_algorithm, place_key_id, place_token,
              checked_in_at, expires_at, created_at, updated_at
            ) VALUES (
              :user_id, :ciphertext, :iv, :tag,
              :algorithm, :key_id, :place_token,
              :checked_in_at, :expires_at, NOW(), NOW()
            )
            ON CONFLICT (owner_user_id, place_token) WHERE ended_at IS NULL
            DO UPDATE SET
              place_ciphertext = EXCLUDED.place_ciphertext,
              place_iv = EXCLUDED.place_iv,
              place_tag = EXCLUDED.place_tag,
              place_algorithm = EXCLUDED.place_algorithm,
              place_key_id = EXCLUDED.place_key_id,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW()
            RETURNING id
            """,
            {
                "user_id": user_id,
                "ciphertext": envelope["ciphertext"],
                "iv": envelope["iv"],
                "tag": envelope["tag"],
                "algorithm": envelope["algorithm"],
                "key_id": envelope["key_id"],
                "place_token": place_token_value,
                "checked_in_at": checked_in_at,
                "expires_at": expires_at,
            },
        )

    def end_open_visits(self, *, user_id: str, ended_at: datetime) -> dict[str, Any] | None:
        return self._execute_one(
            """
            UPDATE one_location_nearby_visits
            SET ended_at = :ended_at, updated_at = NOW()
            WHERE owner_user_id = :user_id AND ended_at IS NULL
            RETURNING id, owner_user_id, place_ciphertext, place_iv, place_tag,
                      place_algorithm, place_key_id, place_token,
                      checked_in_at, ended_at, expires_at
            """,
            {"user_id": user_id, "ended_at": ended_at},
        )

    def get_rateable_visit(
        self, *, user_id: str, place_token_value: str, not_before: datetime
    ) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT id, owner_user_id, place_ciphertext, place_iv, place_tag,
                   place_algorithm, place_key_id, place_token, checked_in_at,
                   ended_at, expires_at
            FROM one_location_nearby_visits
            WHERE owner_user_id = :user_id
              AND place_token = :place_token
              AND checked_in_at >= :not_before
              AND expires_at > NOW()
            ORDER BY checked_in_at DESC
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "place_token": place_token_value,
                "not_before": not_before,
            },
        )

    def list_rateable_visits(
        self, *, user_id: str, not_before: datetime, limit: int
    ) -> list[dict[str, Any]]:
        return self._execute_many(
            """
            SELECT id, owner_user_id, place_ciphertext, place_iv, place_tag,
                   place_algorithm, place_key_id, place_token, checked_in_at,
                   ended_at, expires_at
            FROM one_location_nearby_visits
            WHERE owner_user_id = :user_id
              AND rated_at IS NULL
              AND checked_in_at >= :not_before
              AND expires_at > NOW()
            ORDER BY checked_in_at DESC
            LIMIT :limit
            """,
            {"user_id": user_id, "not_before": not_before, "limit": limit},
        )

    def latest_visit(self, *, user_id: str) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT id, owner_user_id, place_ciphertext, place_iv, place_tag,
                   place_algorithm, place_key_id, place_token, checked_in_at,
                   ended_at, expires_at
            FROM one_location_nearby_visits
            WHERE owner_user_id = :user_id
            ORDER BY checked_in_at DESC
            LIMIT 1
            """,
            {"user_id": user_id},
        )

    def mark_visit_rated(self, *, visit_id: Any, rated_at: datetime) -> None:
        self._execute_one(
            """
            UPDATE one_location_nearby_visits
            SET rated_at = :rated_at, updated_at = NOW()
            WHERE id = :visit_id
            RETURNING id
            """,
            {"visit_id": visit_id, "rated_at": rated_at},
        )

    def upsert_rating(
        self,
        *,
        user_id: str,
        place_id: str,
        place_label: str,
        place_category: str | None,
        rating: int,
        aggregatable: bool,
        consent_version: str,
        source_visit_id: Any,
        visited_at: Any,
    ) -> dict[str, Any] | None:
        return self._execute_one(
            """
            INSERT INTO one_location_place_ratings (
              author_user_id, place_id, place_label, place_category, rating,
              aggregatable, consent_version, consent_accepted_at,
              source_visit_id, visited_at, visit_count, revision,
              created_at, updated_at
            ) VALUES (
              :user_id, :place_id, :place_label, :place_category, :rating,
              :aggregatable, :consent_version, NOW(),
              :source_visit_id, :visited_at, 1, 1, NOW(), NOW()
            )
            ON CONFLICT (author_user_id, place_id) DO UPDATE SET
              place_label = EXCLUDED.place_label,
              place_category = EXCLUDED.place_category,
              rating = EXCLUDED.rating,
              aggregatable = EXCLUDED.aggregatable,
              consent_version = EXCLUDED.consent_version,
              consent_accepted_at = NOW(),
              source_visit_id = EXCLUDED.source_visit_id,
              visited_at = EXCLUDED.visited_at,
              visit_count = one_location_place_ratings.visit_count + 1,
              revision = one_location_place_ratings.revision + 1,
              updated_at = NOW()
            RETURNING id, place_id, place_label, place_category, rating,
                      aggregatable, consent_version, visited_at, visit_count,
                      revision, created_at, updated_at
            """,
            {
                "user_id": user_id,
                "place_id": place_id,
                "place_label": place_label,
                "place_category": place_category,
                "rating": rating,
                "aggregatable": aggregatable,
                "consent_version": consent_version,
                "source_visit_id": source_visit_id,
                "visited_at": visited_at,
            },
        )

    def list_ratings(self, *, user_id: str, limit: int) -> list[dict[str, Any]]:
        return self._execute_many(
            """
            SELECT id, place_id, place_label, place_category, rating,
                   aggregatable, consent_version, visited_at, visit_count,
                   revision, created_at, updated_at
            FROM one_location_place_ratings
            WHERE author_user_id = :user_id
            ORDER BY updated_at DESC
            LIMIT :limit
            """,
            {"user_id": user_id, "limit": limit},
        )

    def delete_rating(self, *, user_id: str, place_id: str) -> dict[str, Any] | None:
        return self._execute_one(
            """
            DELETE FROM one_location_place_ratings
            WHERE author_user_id = :user_id AND place_id = :place_id
            RETURNING id, place_id
            """,
            {"user_id": user_id, "place_id": place_id},
        )

    def recompute_aggregate(self, *, place_id: str) -> dict[str, Any] | None:
        # Recomputed from the rows, never incremented. An increment drifts the
        # moment one write is retried, and an aggregate that still counts a
        # deleted rating has not deleted it.
        return self._execute_one(
            """
            INSERT INTO one_location_place_rating_aggregates (
              place_id, rating_count, rating_sum, updated_at
            )
            SELECT
              :place_id,
              COALESCE(COUNT(*), 0),
              COALESCE(SUM(rating), 0),
              NOW()
            FROM one_location_place_ratings
            WHERE place_id = :place_id AND aggregatable
            ON CONFLICT (place_id) DO UPDATE SET
              rating_count = EXCLUDED.rating_count,
              rating_sum = EXCLUDED.rating_sum,
              updated_at = NOW()
            RETURNING place_id, rating_count, rating_sum
            """,
            {"place_id": place_id},
        )

    def read_aggregate(self, *, place_id: str) -> dict[str, Any] | None:
        return self._execute_one(
            """
            SELECT place_id, rating_count, rating_sum
            FROM one_location_place_rating_aggregates
            WHERE place_id = :place_id
            LIMIT 1
            """,
            {"place_id": place_id},
        )

    def purge_expired_visits(self) -> int:
        row = self._execute_one(
            """
            WITH removed AS (
              DELETE FROM one_location_nearby_visits
              WHERE expires_at <= NOW()
              RETURNING id
            )
            SELECT COUNT(*) AS count FROM removed
            """
        )
        return int((row or {}).get("count") or 0)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class OneLocationPlaceRatingService:
    """Policy for recording visits and rating the places they happened at."""

    def __init__(
        self,
        *,
        store: PlaceRatingStore | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._store: PlaceRatingStore = store or PostgresPlaceRatingStore()
        self._now = now or _utcnow

    # -- visits ------------------------------------------------------------

    def record_visit(
        self,
        *,
        user_id: str,
        place_id: Any,
        place_label: Any,
        latitude: Any = None,
        longitude: Any = None,
        place_category: Any = None,
        checked_in_at: datetime | None = None,
    ) -> None:
        """Log a check-in as a rateable visit.

        Callers treat this as best-effort. It is invoked from ``check_in()``,
        and a failure to write a rating ledger must never fail somebody's
        check-in -- the same fail-open discipline the continuity guard already
        applies for the same reason.
        """
        normalized_place_id = normalize_place_id(place_id)
        normalized_label = normalize_place_label(place_label)
        moment = checked_in_at or self._now()
        payload = {
            "schemaVersion": _VISIT_SCHEMA_VERSION,
            "placeId": normalized_place_id,
            "label": normalized_label,
            "category": (str(place_category).strip().lower() or None) if place_category else None,
        }
        # Coordinates ride in the same envelope because the continuity guard
        # needs them after checkout has destroyed the presence anchor. They are
        # the venue's published point, not the person's position -- the same
        # value Saved Places already holds.
        if isinstance(latitude, (int, float)) and isinstance(longitude, (int, float)):
            payload["latitude"] = float(latitude)
            payload["longitude"] = float(longitude)

        self._store.insert_visit(
            user_id=user_id,
            envelope=_encrypt_visit_place(payload, owner_user_id=user_id),
            place_token_value=place_token(normalized_place_id),
            checked_in_at=moment,
            expires_at=moment + timedelta(hours=PLACE_RATING_VISIT_TTL_HOURS),
        )

    def end_visit(self, *, user_id: str, ended_at: datetime | None = None) -> dict[str, Any] | None:
        """Close the open visit and describe what may now be rated."""
        row = self._store.end_open_visits(user_id=user_id, ended_at=ended_at or self._now())
        if not row:
            return None
        try:
            place = _decrypt_visit_place(row)
        except Exception:  # noqa: BLE001 - an unreadable visit simply offers no prompt
            return None
        return self._visit_payload(row, place)

    def list_rateable_visits(self, *, user_id: str, limit: int = 5) -> list[dict[str, Any]]:
        not_before = self._now() - timedelta(hours=PLACE_RATING_VISIT_TTL_HOURS)
        rows = self._store.list_rateable_visits(
            user_id=user_id, not_before=not_before, limit=max(1, min(int(limit), 20))
        )
        payloads: list[dict[str, Any]] = []
        for row in rows:
            try:
                payloads.append(self._visit_payload(row, _decrypt_visit_place(row)))
            except Exception:  # noqa: BLE001 - skip what cannot be read
                continue
        return payloads

    def last_continuity_point(self, *, user_id: str) -> dict[str, Any] | None:
        """The most recent visit's venue point, for the teleport guard.

        ``checkout()`` NULLs every anchor column on the presence row, and
        ``_decrypt_anchor`` raises on a NULL algorithm, so the guard's
        catch-and-return meant that after any explicit checkout the next
        check-in had no continuity check at all. This survives checkout, so it
        does.
        """
        row = self._store.latest_visit(user_id=user_id)
        if not row:
            return None
        try:
            place = _decrypt_visit_place(row)
        except Exception:  # noqa: BLE001 - a guard, not a gate
            return None
        latitude = place.get("latitude")
        longitude = place.get("longitude")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            return None
        return {
            "latitude": float(latitude),
            "longitude": float(longitude),
            "checkedInAt": row.get("checked_in_at"),
        }

    def purge_expired_visits(self) -> dict[str, int]:
        return {"purged": self._store.purge_expired_visits()}

    # -- ratings -----------------------------------------------------------

    def submit_rating(
        self,
        *,
        user_id: str,
        place_id: Any,
        rating: Any,
        consent_version: Any,
        consent_accepted: Any,
        place_label: Any = None,
        place_category: Any = None,
    ) -> dict[str, Any]:
        if not bool(consent_accepted):
            raise PlaceRatingError(
                "PLACE_RATING_CONSENT_REQUIRED",
                "Accept the rating terms before saving.",
                status_code=422,
            )
        # The client sends the version it displayed; the server checks it.
        # `check_in()` may stamp its own version because a presence lasts an
        # hour, but a rating is permanent -- a stale client must not be able to
        # publish under a promise it never showed anybody.
        if str(consent_version or "").strip() != PLACE_RATING_CONSENT_VERSION:
            raise PlaceRatingError(
                "PLACE_RATING_CONSENT_VERSION_UNSUPPORTED",
                "This app version can't save ratings. Update and try again.",
                status_code=409,
            )
        try:
            normalized_rating = normalize_rating(rating)
        except ValueError as exc:
            raise PlaceRatingError("PLACE_RATING_INVALID", str(exc), status_code=422) from exc
        try:
            normalized_place_id = normalize_place_id(place_id)
        except ValueError as exc:
            raise PlaceRatingError(
                "PLACE_RATING_PLACE_REQUIRED", str(exc), status_code=422
            ) from exc

        not_before = self._now() - timedelta(hours=PLACE_RATING_VISIT_TTL_HOURS)
        visit = self._store.get_rateable_visit(
            user_id=user_id,
            place_token_value=place_token(normalized_place_id),
            not_before=not_before,
        )
        if not visit:
            # Physical presence is the whole basis of eligibility. Without it
            # this is an unauthenticated opinion about a business, which is a
            # different product with a different legal shape.
            raise PlaceRatingError(
                "PLACE_RATING_VISIT_REQUIRED",
                "Check in at this place before rating it.",
                status_code=403,
            )

        try:
            visit_place = _decrypt_visit_place(visit)
        except Exception as exc:  # noqa: BLE001
            raise PlaceRatingError(
                "PLACE_RATING_VISIT_UNREADABLE",
                "That visit can no longer be rated.",
                status_code=410,
            ) from exc

        # The label and category come from the recorded visit, not the request.
        # A client-supplied label would let one account rate "Bag Maker" and
        # have it stored as something else entirely.
        resolved_label = normalize_place_label(visit_place.get("label") or place_label)
        resolved_category = visit_place.get("category") or (
            str(place_category).strip().lower() if place_category else None
        )
        aggregatable = is_aggregatable_category(resolved_category)

        row = self._store.upsert_rating(
            user_id=user_id,
            place_id=normalized_place_id,
            place_label=resolved_label,
            place_category=resolved_category,
            rating=normalized_rating,
            aggregatable=aggregatable,
            consent_version=PLACE_RATING_CONSENT_VERSION,
            source_visit_id=visit.get("id"),
            visited_at=visit.get("checked_in_at"),
        )
        if not row:
            raise PlaceRatingError(
                "PLACE_RATING_WRITE_FAILED",
                "Couldn't save your rating.",
                status_code=503,
            )

        self._store.mark_visit_rated(visit_id=visit.get("id"), rated_at=self._now())
        self._store.recompute_aggregate(place_id=normalized_place_id)
        return self._rating_payload(row)

    def list_own_ratings(self, *, user_id: str, limit: int = 25) -> dict[str, Any]:
        bounded = max(1, min(int(limit), PLACE_RATING_HISTORY_LIMIT))
        rows = self._store.list_ratings(user_id=user_id, limit=bounded)
        return {"ratings": [self._rating_payload(row) for row in rows]}

    def delete_rating(self, *, user_id: str, place_id: Any) -> dict[str, Any]:
        try:
            normalized_place_id = normalize_place_id(place_id)
        except ValueError as exc:
            raise PlaceRatingError(
                "PLACE_RATING_PLACE_REQUIRED", str(exc), status_code=422
            ) from exc
        removed = self._store.delete_rating(user_id=user_id, place_id=normalized_place_id)
        if not removed:
            raise PlaceRatingError(
                "PLACE_RATING_NOT_FOUND",
                "You haven't rated that place.",
                status_code=404,
            )
        # In the same call as the delete, or the average keeps reporting a
        # rating that no longer exists -- which is not a deletion.
        self._store.recompute_aggregate(place_id=normalized_place_id)
        return {"placeId": normalized_place_id, "deleted": True}

    def place_summary(self, *, place_id: Any) -> dict[str, Any]:
        """The anonymous projection. Holds no user reference of any kind."""
        normalized_place_id = normalize_place_id(place_id)
        row = self._store.read_aggregate(place_id=normalized_place_id) or {}
        count = row.get("rating_count") or 0
        total = row.get("rating_sum") or 0
        return {
            "placeId": normalized_place_id,
            "average": publishable_average(rating_count=count, rating_sum=total),
            "countBucket": bucket_rating_count(count),
            "minimumRaters": PLACE_RATING_PUBLICATION_MIN_COUNT,
        }

    # -- payloads ----------------------------------------------------------

    def _visit_payload(self, row: dict[str, Any], place: dict[str, Any]) -> dict[str, Any]:
        place_id_value = str(place.get("placeId") or "")
        return {
            "visitId": str(row.get("id") or ""),
            "placeId": place_id_value,
            "placeLabel": place.get("label"),
            "placeCategory": place.get("category"),
            "visitedAt": _iso(row.get("checked_in_at")),
            "expiresAt": _iso(row.get("expires_at")),
            "googleReviewUrl": google_write_review_url(place_id_value),
            "consentVersion": PLACE_RATING_CONSENT_VERSION,
        }

    def _rating_payload(self, row: dict[str, Any]) -> dict[str, Any]:
        # Deliberately no author field of any kind. This payload is returned
        # only to its own author, and the shape is what stops a future public
        # read path from having one to leak.
        place_id_value = str(row.get("place_id") or "")
        return {
            "id": str(row.get("id") or ""),
            "placeId": place_id_value,
            "placeLabel": row.get("place_label"),
            "rating": int(row.get("rating") or 0),
            "countsTowardAverage": bool(row.get("aggregatable")),
            "consentVersion": row.get("consent_version"),
            "consentCurrent": str(row.get("consent_version") or "") == PLACE_RATING_CONSENT_VERSION,
            "visitedAt": _iso(row.get("visited_at")),
            "visitCount": int(row.get("visit_count") or 1),
            "revision": int(row.get("revision") or 1),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "googleReviewUrl": google_write_review_url(place_id_value),
        }
