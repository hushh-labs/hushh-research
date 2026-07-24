"""Named Circle relationship service for One Location.

Joining a Circle is explicit relationship consent. Membership creates a
source-aware connection origin with every active Circle member, but never
creates a trusted edge, SMS selection, live-location grant, capability token,
or encrypted envelope. Targeted invitations let owners invite an existing
direct connection without requiring another connection request or a code.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from db.db_client import DatabaseClient, get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.connection_graph_service import (
    ensure_connection_origin,
    revoke_circle_origins,
)
from mcp_modules.log_redaction import redact_log_field

logger = logging.getLogger(__name__)

CIRCLE_CODE_TTL_HOURS = 72
CIRCLE_MEMBER_INVITE_TTL_HOURS = 72
CIRCLE_MAX_PER_USER = 10
CIRCLE_DEFAULT_MEMBER_LIMIT = 20
CIRCLE_CODE_LENGTH = 12
CIRCLE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_CIRCLE_CODE_DOMAIN = b"one-location-circle-code:v1:"
_CIRCLE_CODE_RE = re.compile(r"^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$")
_CIRCLE_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


class OneLocationCircleError(RuntimeError):
    """Stable, client-safe Circle workflow failure."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def normalize_circle_code(value: str) -> str:
    """Normalize a human-entered code without accepting ambiguous characters."""

    normalized = "".join(ch for ch in str(value or "").upper() if ch.isalnum())
    if not _CIRCLE_CODE_RE.fullmatch(normalized):
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_CODE_INVALID",
            "That Circle code is invalid or no longer available.",
            status_code=404,
        )
    return normalized


def format_circle_code(value: str) -> str:
    normalized = normalize_circle_code(value)
    return "-".join(normalized[index : index + 4] for index in range(0, len(normalized), 4))


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _row_dict(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    if isinstance(row, dict):
        return dict(row)
    mapping = getattr(row, "_mapping", None)
    return dict(mapping) if mapping is not None else None


def _first(result: Any) -> dict[str, Any] | None:
    row = result.fetchone()
    return _row_dict(row)


def _all(result: Any) -> list[dict[str, Any]]:
    return [payload for row in result.fetchall() if (payload := _row_dict(row)) is not None]


def _clean_circle_id(value: str) -> str:
    circle_id = str(value or "").strip()
    if not _CIRCLE_ID_RE.fullmatch(circle_id):
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_NOT_FOUND",
            "Circle not found.",
            status_code=404,
        )
    return circle_id


def _clean_invite_id(value: str) -> str:
    invite_id = str(value or "").strip()
    if not _CIRCLE_ID_RE.fullmatch(invite_id):
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_INVITE_NOT_FOUND",
            "Circle invitation not found.",
            status_code=404,
        )
    return invite_id


def _clean_user_id(value: str) -> str:
    user_id = str(value or "").strip()
    if not user_id or len(user_id) > 160:
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_MEMBER_INVALID",
            "Choose a valid connection to invite.",
            status_code=422,
        )
    return user_id


def _clean_name(value: str) -> str:
    name = " ".join(str(value or "").split())
    if len(name) < 2 or len(name) > 80:
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_NAME_INVALID",
            "Circle name must be between 2 and 80 characters.",
            status_code=422,
        )
    return name


def _clean_kind(value: str | None) -> str:
    kind = str(value or "other").strip().lower()
    if kind not in {"family", "friends", "other"}:
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_KIND_INVALID",
            "Choose Family, Friends, or Other.",
            status_code=422,
        )
    return kind


class OneLocationCircleService:
    """Owns named Circle state and atomic membership transitions."""

    def __init__(
        self,
        *,
        db: DatabaseClient | None = None,
        hmac_key: str | None = None,
    ) -> None:
        self._db = db or get_db()
        self._hmac_key = hmac_key

    def _key(self) -> bytes:
        value = self._hmac_key or get_core_security_settings().app_signing_key
        return value.encode("utf-8")

    def _code_hash(self, normalized_code: str) -> str:
        return hmac.new(
            self._key(),
            _CIRCLE_CODE_DOMAIN + normalized_code.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def _new_code() -> str:
        raw = "".join(secrets.choice(CIRCLE_CODE_ALPHABET) for _ in range(CIRCLE_CODE_LENGTH))
        return format_circle_code(raw)

    def _safe_db_failure(self, operation: str, exc: Exception) -> OneLocationCircleError:
        logger.warning(
            "one_location.circle_db_failed operation=%s error_type=%s",
            operation,
            exc.__class__.__name__,
        )
        return OneLocationCircleError(
            "LOCATION_CIRCLE_UNAVAILABLE",
            "Circle service is temporarily unavailable. Please try again.",
            status_code=503,
        )

    @staticmethod
    def _lock_user_circle_memberships(conn: Any, *, user_id: str) -> None:
        """Serialize create/join capacity checks for one user in Postgres.

        Postgres is the shared coordination tier today. This row-lock seam can
        later move to a Redis/Memorystore distributed lock without changing the
        Circle API contract.
        """

        actor = _first(
            conn.execute(
                text(
                    """
                    SELECT user_id
                    FROM actor_profiles
                    WHERE user_id = :user_id
                    FOR UPDATE
                    """
                ),
                {"user_id": user_id},
            )
        )
        if not actor:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_ACCOUNT_NOT_READY",
                "Finish setting up One before managing Circles.",
                status_code=409,
            )

    @staticmethod
    def _assert_user_circle_capacity(conn: Any, *, user_id: str) -> None:
        count_row = _first(
            conn.execute(
                text(
                    """
                    SELECT COUNT(*) AS circle_count
                    FROM one_location_circle_memberships membership
                    JOIN one_location_circles circle
                      ON circle.id = membership.circle_id
                     AND circle.status = 'active'
                    WHERE membership.user_id = :user_id
                      AND membership.status = 'active'
                    """
                ),
                {"user_id": user_id},
            )
        )
        if int((count_row or {}).get("circle_count") or 0) >= CIRCLE_MAX_PER_USER:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_LIMIT_REACHED",
                f"You can belong to up to {CIRCLE_MAX_PER_USER} Circles.",
                status_code=409,
            )

    @staticmethod
    def _circle_summary(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(row.get("id") or ""),
            "name": str(row.get("name") or ""),
            "kind": str(row.get("kind") or "other"),
            "role": str(row.get("role") or "member"),
            "memberCount": int(row.get("member_count") or 0),
            "memberLimit": int(row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
        }

    @staticmethod
    def _member_payload(row: dict[str, Any]) -> dict[str, Any]:
        display_name = str(row.get("display_name") or "").strip()
        return {
            "userId": str(row.get("user_id") or ""),
            "displayName": display_name or "Circle member",
            "photoUrl": str(row.get("custom_photo_url") or row.get("photo_url") or "") or None,
            "role": str(row.get("role") or "member"),
            "joinedAt": _iso(row.get("joined_at")),
            "phoneVerified": bool(row.get("phone_verified")),
            "secureLocationReady": bool(row.get("secure_location_ready")),
        }

    @staticmethod
    def _member_invite_payload(row: dict[str, Any]) -> dict[str, Any]:
        invitee_name = str(row.get("invitee_display_name") or "").strip()
        inviter_name = str(row.get("inviter_display_name") or "").strip()
        return {
            "id": str(row.get("id") or ""),
            "circleId": str(row.get("circle_id") or ""),
            "circleName": str(row.get("circle_name") or ""),
            "circleKind": str(row.get("circle_kind") or "other"),
            "inviterUserId": str(row.get("inviter_user_id") or ""),
            "inviterDisplayName": inviter_name or "A Circle owner",
            "inviteeUserId": str(row.get("invitee_user_id") or ""),
            "inviteeDisplayName": invitee_name or "Connection",
            "status": str(row.get("status") or "pending"),
            "expiresAt": _iso(row.get("expires_at")),
            "createdAt": _iso(row.get("created_at")),
            "respondedAt": _iso(row.get("responded_at")),
        }

    @staticmethod
    def _eligible_connection_payload(row: dict[str, Any]) -> dict[str, Any]:
        display_name = str(row.get("display_name") or "").strip()
        return {
            "connectionId": str(row.get("connection_id") or ""),
            "userId": str(row.get("user_id") or ""),
            "displayName": display_name or "Connection",
            "photoUrl": str(row.get("custom_photo_url") or row.get("photo_url") or "") or None,
            "connectedAt": _iso(row.get("connected_at")),
        }

    @staticmethod
    def _connect_member_to_circle(
        conn: Any,
        *,
        circle_id: str,
        user_id: str,
    ) -> None:
        """Create bounded, source-aware Circle origins in the same transaction."""

        member_rows = _all(
            conn.execute(
                text(
                    """
                    SELECT user_id
                    FROM one_location_circle_memberships
                    WHERE circle_id = CAST(:circle_id AS UUID)
                      AND status = 'active'
                    ORDER BY user_id
                    FOR UPDATE
                    """
                ),
                {"circle_id": circle_id},
            )
        )
        if user_id not in {str(row.get("user_id") or "").strip() for row in member_rows}:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_MEMBERSHIP_NOT_ACTIVE",
                "Circle membership is no longer active.",
                status_code=409,
            )
        for member_user_id in sorted(
            {
                str(row.get("user_id") or "").strip()
                for row in member_rows
                if str(row.get("user_id") or "").strip()
                and str(row.get("user_id") or "").strip() != user_id
            }
        ):
            ensure_connection_origin(
                conn,
                user_a_id=user_id,
                user_b_id=member_user_id,
                kind="named_circle",
                source_circle_id=circle_id,
            )

    def list_circles(self, *, user_id: str) -> list[dict[str, Any]]:
        try:
            result = self._db.execute_raw(
                """
                SELECT
                  c.id, c.name, c.kind, c.member_limit, c.created_at, c.updated_at,
                  mine.role,
                  COUNT(active_members.user_id) AS member_count
                FROM one_location_circle_memberships mine
                JOIN one_location_circles c
                  ON c.id = mine.circle_id
                 AND c.status = 'active'
                LEFT JOIN one_location_circle_memberships active_members
                  ON active_members.circle_id = c.id
                 AND active_members.status = 'active'
                WHERE mine.user_id = :user_id
                  AND mine.status = 'active'
                GROUP BY c.id, mine.role
                ORDER BY c.updated_at DESC, c.created_at DESC
                """,
                {"user_id": user_id},
            )
            return [self._circle_summary(row) for row in (result.data or [])]
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("list", exc) from exc

    def get_circle(self, *, user_id: str, circle_id: str) -> dict[str, Any]:
        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            summary_result = self._db.execute_raw(
                """
                SELECT
                  c.id, c.name, c.kind, c.member_limit, c.created_at, c.updated_at,
                  mine.role,
                  COUNT(active_members.user_id) AS member_count
                FROM one_location_circles c
                JOIN one_location_circle_memberships mine
                  ON mine.circle_id = c.id
                 AND mine.user_id = :user_id
                 AND mine.status = 'active'
                LEFT JOIN one_location_circle_memberships active_members
                  ON active_members.circle_id = c.id
                 AND active_members.status = 'active'
                WHERE c.id = CAST(:circle_id AS UUID)
                  AND c.status = 'active'
                GROUP BY c.id, mine.role
                """,
                {"user_id": user_id, "circle_id": cleaned_circle_id},
            )
            summary_row = next(iter(summary_result.data or []), None)
            if not summary_row:
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_NOT_FOUND",
                    "Circle not found.",
                    status_code=404,
                )
            members_result = self._db.execute_raw(
                """
                SELECT
                  membership.user_id, membership.role, membership.joined_at,
                  identity.display_name, identity.photo_url,
                  identity.custom_photo_url, identity.phone_verified,
                  EXISTS (
                    SELECT 1
                    FROM one_location_recipient_keys key
                    WHERE key.user_id = membership.user_id
                      AND key.status = 'active'
                  ) AS secure_location_ready
                FROM one_location_circle_memberships membership
                LEFT JOIN actor_identity_cache identity
                  ON identity.user_id = membership.user_id
                WHERE membership.circle_id = CAST(:circle_id AS UUID)
                  AND membership.status = 'active'
                ORDER BY
                  CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
                  COALESCE(identity.display_name, membership.user_id)
                """,
                {"circle_id": cleaned_circle_id},
            )
            circle = self._circle_summary(dict(summary_row))
            circle["members"] = [self._member_payload(row) for row in (members_result.data or [])]
            return circle
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("detail", exc) from exc

    def create_circle(
        self,
        *,
        owner_user_id: str,
        name: str,
        kind: str | None = None,
    ) -> dict[str, Any]:
        cleaned_name = _clean_name(name)
        cleaned_kind = _clean_kind(kind)
        try:
            with self._db.engine.begin() as conn:
                self._lock_user_circle_memberships(
                    conn,
                    user_id=owner_user_id,
                )
                self._assert_user_circle_capacity(
                    conn,
                    user_id=owner_user_id,
                )
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            INSERT INTO one_location_circles (
                              owner_user_id, name, kind, status, member_limit,
                              created_at, updated_at, metadata
                            )
                            VALUES (
                              :owner_user_id, :name, :kind, 'active',
                              :member_limit, NOW(), NOW(), '{}'::jsonb
                            )
                            RETURNING id
                            """
                        ),
                        {
                            "owner_user_id": owner_user_id,
                            "name": cleaned_name,
                            "kind": cleaned_kind,
                            "member_limit": CIRCLE_DEFAULT_MEMBER_LIMIT,
                        },
                    )
                )
                circle_id = str((circle_row or {}).get("id") or "")
                if not circle_id:
                    raise RuntimeError("circle insert returned no id")
                conn.execute(
                    text(
                        """
                        INSERT INTO one_location_circle_memberships (
                          circle_id, user_id, role, status, joined_at, updated_at,
                          metadata
                        )
                        VALUES (
                          CAST(:circle_id AS UUID), :user_id, 'owner', 'active',
                          NOW(), NOW(), '{}'::jsonb
                        )
                        """
                    ),
                    {"circle_id": circle_id, "user_id": owner_user_id},
                )
            logger.info(
                "one_location.circle_created owner=%s",
                redact_log_field("user_id", owner_user_id),
            )
            return self.get_circle(user_id=owner_user_id, circle_id=circle_id)
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("create", exc) from exc

    def update_circle(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
        name: str | None = None,
        kind: str | None = None,
    ) -> dict[str, Any]:
        cleaned_circle_id = _clean_circle_id(circle_id)
        cleaned_name = _clean_name(name) if name is not None else None
        cleaned_kind = _clean_kind(kind) if kind is not None else None
        if cleaned_name is None and cleaned_kind is None:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_UPDATE_EMPTY",
                "Change the Circle name or type before saving.",
                status_code=422,
            )
        try:
            result = self._db.execute_raw(
                """
                UPDATE one_location_circles
                SET name = COALESCE(:name, name),
                    kind = COALESCE(:kind, kind),
                    updated_at = NOW()
                WHERE id = CAST(:circle_id AS UUID)
                  AND owner_user_id = :owner_user_id
                  AND status = 'active'
                RETURNING id
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "owner_user_id": owner_user_id,
                    "name": cleaned_name,
                    "kind": cleaned_kind,
                },
            )
            if not (result.data or []):
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_OWNER_REQUIRED",
                    "Only the Circle owner can make this change.",
                    status_code=403,
                )
            return self.get_circle(
                user_id=owner_user_id,
                circle_id=cleaned_circle_id,
            )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("update", exc) from exc

    def create_invite_code(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
    ) -> dict[str, Any]:
        cleaned_circle_id = _clean_circle_id(circle_id)
        display_code = self._new_code()
        normalized_code = normalize_circle_code(display_code)
        code_hash = self._code_hash(normalized_code)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=CIRCLE_CODE_TTL_HOURS)
        try:
            with self._db.engine.begin() as conn:
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT id, member_limit
                            FROM one_location_circles
                            WHERE id = CAST(:circle_id AS UUID)
                              AND owner_user_id = :owner_user_id
                              AND status = 'active'
                            FOR UPDATE
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "owner_user_id": owner_user_id,
                        },
                    )
                )
                if not circle_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_OWNER_REQUIRED",
                        "Only the Circle owner can create an invite code.",
                        status_code=403,
                    )
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_invite_codes
                        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                        WHERE circle_id = CAST(:circle_id AS UUID)
                          AND status = 'active'
                        """
                    ),
                    {"circle_id": cleaned_circle_id},
                )
                invite_row = _first(
                    conn.execute(
                        text(
                            """
                            INSERT INTO one_location_circle_invite_codes (
                              circle_id, created_by_user_id, code_hash, status,
                              expires_at, max_uses, use_count, created_at,
                              updated_at, metadata
                            )
                            VALUES (
                              CAST(:circle_id AS UUID), :owner_user_id,
                              :code_hash, 'active', :expires_at, :max_uses, 0,
                              NOW(), NOW(), '{}'::jsonb
                            )
                            RETURNING id, expires_at
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "owner_user_id": owner_user_id,
                            "code_hash": code_hash,
                            "expires_at": expires_at,
                            "max_uses": max(
                                1,
                                int(circle_row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT)
                                - 1,
                            ),
                        },
                    )
                )
            logger.info(
                "one_location.circle_code_rotated owner=%s",
                redact_log_field("user_id", owner_user_id),
            )
            return {
                "id": str((invite_row or {}).get("id") or ""),
                "circleId": cleaned_circle_id,
                "code": display_code,
                "expiresAt": _iso((invite_row or {}).get("expires_at")),
            }
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("create_code", exc) from exc

    def resolve_invite_code(
        self,
        *,
        user_id: str,
        code: str,
    ) -> dict[str, Any]:
        normalized_code = normalize_circle_code(code)
        code_hash = self._code_hash(normalized_code)
        try:
            result = self._db.execute_raw(
                """
                SELECT
                  circle.name, circle.kind, code.expires_at,
                  identity.display_name AS owner_display_name,
                  COUNT(membership.user_id) AS member_count,
                  BOOL_OR(
                    membership.user_id = :user_id
                    AND membership.status = 'active'
                  ) AS already_member
                FROM one_location_circle_invite_codes code
                JOIN one_location_circles circle
                  ON circle.id = code.circle_id
                 AND circle.status = 'active'
                LEFT JOIN actor_identity_cache identity
                  ON identity.user_id = circle.owner_user_id
                LEFT JOIN one_location_circle_memberships membership
                  ON membership.circle_id = circle.id
                 AND membership.status = 'active'
                WHERE code.code_hash = :code_hash
                  AND code.status = 'active'
                  AND code.expires_at > NOW()
                  AND code.use_count < code.max_uses
                GROUP BY
                  circle.id, circle.name, circle.kind, code.expires_at,
                  identity.display_name
                """,
                {"code_hash": code_hash, "user_id": user_id},
            )
            row = next(iter(result.data or []), None)
            if not row:
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_CODE_INVALID",
                    "That Circle code is invalid or no longer available.",
                    status_code=404,
                )
            return {
                "name": str(row.get("name") or ""),
                "kind": str(row.get("kind") or "other"),
                "ownerDisplayName": str(row.get("owner_display_name") or "A Circle owner"),
                "memberCount": int(row.get("member_count") or 0),
                "expiresAt": _iso(row.get("expires_at")),
                "alreadyMember": bool(row.get("already_member")),
            }
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("resolve_code", exc) from exc

    def join_circle(self, *, user_id: str, code: str) -> dict[str, Any]:
        normalized_code = normalize_circle_code(code)
        code_hash = self._code_hash(normalized_code)
        circle_id = ""
        joined = False
        try:
            with self._db.engine.begin() as conn:
                self._lock_user_circle_memberships(conn, user_id=user_id)
                invite_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              code.id, code.circle_id, code.status,
                              code.expires_at, code.max_uses, code.use_count,
                              circle.owner_user_id, circle.member_limit,
                              circle.status AS circle_status
                            FROM one_location_circle_invite_codes code
                            JOIN one_location_circles circle
                              ON circle.id = code.circle_id
                            WHERE code.code_hash = :code_hash
                            FOR UPDATE OF code, circle
                            """
                        ),
                        {"code_hash": code_hash},
                    )
                )
                now = datetime.now(timezone.utc)
                expires_at = (invite_row or {}).get("expires_at")
                if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if (
                    not invite_row
                    or str(invite_row.get("status") or "") != "active"
                    or str(invite_row.get("circle_status") or "") != "active"
                    or not isinstance(expires_at, datetime)
                    or expires_at <= now
                    or int(invite_row.get("use_count") or 0) >= int(invite_row.get("max_uses") or 0)
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_CODE_INVALID",
                        "That Circle code is invalid or no longer available.",
                        status_code=404,
                    )
                circle_id = str(invite_row.get("circle_id") or "")
                existing = _first(
                    conn.execute(
                        text(
                            """
                            SELECT role, status
                            FROM one_location_circle_memberships
                            WHERE circle_id = CAST(:circle_id AS UUID)
                              AND user_id = :user_id
                            FOR UPDATE
                            """
                        ),
                        {"circle_id": circle_id, "user_id": user_id},
                    )
                )
                if existing and str(existing.get("status") or "") == "removed":
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBERSHIP_REMOVED",
                        "The Circle owner removed this membership.",
                        status_code=403,
                    )
                if existing and str(existing.get("status") or "") == "active":
                    joined = False
                else:
                    self._assert_user_circle_capacity(conn, user_id=user_id)
                    count_row = _first(
                        conn.execute(
                            text(
                                """
                                SELECT
                                  (
                                    SELECT COUNT(*)
                                    FROM one_location_circle_memberships membership
                                    WHERE membership.circle_id =
                                          CAST(:circle_id AS UUID)
                                      AND membership.status = 'active'
                                  )
                                  +
                                  (
                                    SELECT COUNT(*)
                                    FROM one_location_circle_member_invites invite
                                    WHERE invite.circle_id =
                                          CAST(:circle_id AS UUID)
                                      AND invite.status = 'pending'
                                      AND invite.expires_at > NOW()
                                      AND invite.invitee_user_id <> :user_id
                                      AND NOT EXISTS (
                                        SELECT 1
                                        FROM one_location_circle_memberships membership
                                        WHERE membership.circle_id = invite.circle_id
                                          AND membership.user_id =
                                              invite.invitee_user_id
                                          AND membership.status = 'active'
                                      )
                                  ) AS member_count
                                """
                            ),
                            {"circle_id": circle_id, "user_id": user_id},
                        )
                    )
                    if int((count_row or {}).get("member_count") or 0) >= int(
                        invite_row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT
                    ):
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_FULL",
                            "This Circle is full.",
                            status_code=409,
                        )
                    conn.execute(
                        text(
                            """
                            INSERT INTO one_location_circle_memberships (
                              circle_id, user_id, role, status, joined_at,
                              updated_at, ended_at, metadata
                            )
                            VALUES (
                              CAST(:circle_id AS UUID), :user_id, 'member',
                              'active', NOW(), NOW(), NULL, '{}'::jsonb
                            )
                            ON CONFLICT (circle_id, user_id) DO UPDATE SET
                              role = 'member',
                              status = 'active',
                              joined_at = NOW(),
                              updated_at = NOW(),
                              ended_at = NULL
                            """
                        ),
                        {"circle_id": circle_id, "user_id": user_id},
                    )
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circle_invite_codes
                            SET use_count = use_count + 1,
                                status = CASE
                                  WHEN use_count + 1 >= max_uses
                                  THEN 'expired'
                                  ELSE status
                                END,
                                updated_at = NOW()
                            WHERE id = CAST(:invite_id AS UUID)
                            """
                        ),
                        {"invite_id": str(invite_row.get("id") or "")},
                    )
                    joined = True
                self._connect_member_to_circle(
                    conn,
                    circle_id=circle_id,
                    user_id=user_id,
                )
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_member_invites
                        SET status = 'accepted', responded_at = NOW(),
                            updated_at = NOW()
                        WHERE circle_id = CAST(:circle_id AS UUID)
                          AND invitee_user_id = :user_id
                          AND status = 'pending'
                        """
                    ),
                    {"circle_id": circle_id, "user_id": user_id},
                )
            logger.info(
                "one_location.circle_joined member=%s joined=%s",
                redact_log_field("user_id", user_id),
                joined,
            )
            return {
                "circle": self.get_circle(user_id=user_id, circle_id=circle_id),
                "joined": joined,
            }
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("join", exc) from exc

    def revoke_invite_code(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
    ) -> None:
        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            result = self._db.execute_raw(
                """
                UPDATE one_location_circle_invite_codes code
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                FROM one_location_circles circle
                WHERE code.circle_id = circle.id
                  AND circle.id = CAST(:circle_id AS UUID)
                  AND circle.owner_user_id = :owner_user_id
                  AND circle.status = 'active'
                  AND code.status = 'active'
                RETURNING code.id
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "owner_user_id": owner_user_id,
                },
            )
            if not (result.data or []):
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_CODE_NOT_FOUND",
                    "No active Circle code was found.",
                    status_code=404,
                )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("revoke_code", exc) from exc

    def list_eligible_direct_connections(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
    ) -> list[dict[str, Any]]:
        """List direct connections an owner may invite to this Circle."""

        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            owner_result = self._db.execute_raw(
                """
                SELECT id
                FROM one_location_circles
                WHERE id = CAST(:circle_id AS UUID)
                  AND owner_user_id = :owner_user_id
                  AND status = 'active'
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "owner_user_id": owner_user_id,
                },
            )
            if not (owner_result.data or []):
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_OWNER_REQUIRED",
                    "Only the Circle owner can invite members.",
                    status_code=403,
                )
            result = self._db.execute_raw(
                """
                SELECT DISTINCT
                  connection.id AS connection_id,
                  CASE
                    WHEN connection.user_a_id = :owner_user_id
                    THEN connection.user_b_id
                    ELSE connection.user_a_id
                  END AS user_id,
                  connection.created_at AS connected_at,
                  identity.display_name, identity.photo_url,
                  identity.custom_photo_url
                FROM one_location_circles circle
                JOIN connections connection
                  ON connection.status = 'active'
                 AND (
                   connection.user_a_id = :owner_user_id
                   OR connection.user_b_id = :owner_user_id
                 )
                JOIN connection_origins origin
                  ON origin.connection_id = connection.id
                 AND origin.origin_kind = 'direct_request'
                 AND origin.status = 'active'
                LEFT JOIN actor_identity_cache identity
                  ON identity.user_id = CASE
                    WHEN connection.user_a_id = :owner_user_id
                    THEN connection.user_b_id
                    ELSE connection.user_a_id
                  END
                WHERE circle.id = CAST(:circle_id AS UUID)
                  AND circle.owner_user_id = :owner_user_id
                  AND circle.status = 'active'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM one_location_circle_memberships membership
                    WHERE membership.circle_id = circle.id
                      AND membership.user_id = CASE
                        WHEN connection.user_a_id = :owner_user_id
                        THEN connection.user_b_id
                        ELSE connection.user_a_id
                      END
                      AND membership.status = 'active'
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM one_location_circle_member_invites invite
                    WHERE invite.circle_id = circle.id
                      AND invite.invitee_user_id = CASE
                        WHEN connection.user_a_id = :owner_user_id
                        THEN connection.user_b_id
                        ELSE connection.user_a_id
                      END
                      AND invite.status = 'pending'
                      AND invite.expires_at > NOW()
                  )
                ORDER BY identity.display_name NULLS LAST
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "owner_user_id": owner_user_id,
                },
            )
            return [self._eligible_connection_payload(row) for row in (result.data or [])]
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("list_eligible_connections", exc) from exc

    def get_remaining_invite_capacity(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
    ) -> int:
        """Return display-only capacity after active members and pending reservations."""

        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            result = self._db.execute_raw(
                """
                SELECT
                  circle.member_limit,
                  (
                    SELECT COUNT(*)
                    FROM one_location_circle_memberships membership
                    WHERE membership.circle_id = circle.id
                      AND membership.status = 'active'
                  ) AS active_member_count,
                  (
                    SELECT COUNT(*)
                    FROM one_location_circle_member_invites invite
                    WHERE invite.circle_id = circle.id
                      AND invite.status = 'pending'
                      AND invite.expires_at > NOW()
                      AND NOT EXISTS (
                        SELECT 1
                        FROM one_location_circle_memberships membership
                        WHERE membership.circle_id = invite.circle_id
                          AND membership.user_id = invite.invitee_user_id
                          AND membership.status = 'active'
                      )
                  ) AS pending_invite_count
                FROM one_location_circles circle
                WHERE circle.id = CAST(:circle_id AS UUID)
                  AND circle.owner_user_id = :owner_user_id
                  AND circle.status = 'active'
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "owner_user_id": owner_user_id,
                },
            )
            row = next(iter(result.data or []), None)
            if not row:
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_OWNER_REQUIRED",
                    "Only the Circle owner can invite members.",
                    status_code=403,
                )
            reserved = int(row.get("active_member_count") or 0) + int(
                row.get("pending_invite_count") or 0
            )
            return max(
                0,
                int(row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT) - reserved,
            )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("remaining_invite_capacity", exc) from exc

    def list_member_invites(
        self,
        *,
        user_id: str,
        circle_id: str | None = None,
        direction: str = "incoming",
    ) -> list[dict[str, Any]]:
        """Return pending incoming invites or an owner's pending outgoing invites."""

        if direction not in {"incoming", "outgoing"}:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_DIRECTION_INVALID",
                "Choose incoming or outgoing Circle invitations.",
                status_code=422,
            )
        cleaned_circle_id = _clean_circle_id(circle_id) if circle_id is not None else None
        try:
            self._db.execute_raw(
                """
                UPDATE one_location_circle_member_invites
                SET status = 'expired', updated_at = NOW()
                WHERE status = 'pending'
                  AND expires_at <= NOW()
                  AND (
                    invitee_user_id = :user_id
                    OR inviter_user_id = :user_id
                  )
                """,
                {"user_id": user_id},
            )
            if direction == "incoming":
                result = self._db.execute_raw(
                    """
                    SELECT
                      invite.id, invite.circle_id, invite.inviter_user_id,
                      invite.invitee_user_id, invite.status, invite.expires_at,
                      invite.created_at, invite.responded_at,
                      circle.name AS circle_name, circle.kind AS circle_kind,
                      inviter.display_name AS inviter_display_name,
                      invitee.display_name AS invitee_display_name
                    FROM one_location_circle_member_invites invite
                    JOIN one_location_circles circle
                      ON circle.id = invite.circle_id
                     AND circle.status = 'active'
                    LEFT JOIN actor_identity_cache inviter
                      ON inviter.user_id = invite.inviter_user_id
                    LEFT JOIN actor_identity_cache invitee
                      ON invitee.user_id = invite.invitee_user_id
                    WHERE invite.invitee_user_id = :user_id
                      AND invite.status = 'pending'
                      AND invite.expires_at > NOW()
                    ORDER BY invite.created_at DESC
                    """,
                    {"user_id": user_id},
                )
            else:
                result = self._db.execute_raw(
                    """
                    SELECT
                      invite.id, invite.circle_id, invite.inviter_user_id,
                      invite.invitee_user_id, invite.status, invite.expires_at,
                      invite.created_at, invite.responded_at,
                      circle.name AS circle_name, circle.kind AS circle_kind,
                      inviter.display_name AS inviter_display_name,
                      invitee.display_name AS invitee_display_name
                    FROM one_location_circle_member_invites invite
                    JOIN one_location_circles circle
                      ON circle.id = invite.circle_id
                     AND circle.owner_user_id = :user_id
                     AND circle.status = 'active'
                    LEFT JOIN actor_identity_cache inviter
                      ON inviter.user_id = invite.inviter_user_id
                    LEFT JOIN actor_identity_cache invitee
                      ON invitee.user_id = invite.invitee_user_id
                    WHERE (
                        CAST(:circle_id AS UUID) IS NULL
                        OR invite.circle_id = CAST(:circle_id AS UUID)
                      )
                      AND invite.status = 'pending'
                      AND invite.expires_at > NOW()
                    ORDER BY invite.created_at DESC
                    """,
                    {"user_id": user_id, "circle_id": cleaned_circle_id},
                )
            return [self._member_invite_payload(row) for row in (result.data or [])]
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("list_member_invites", exc) from exc

    def get_member_invite(
        self,
        *,
        user_id: str,
        invite_id: str,
    ) -> dict[str, Any]:
        cleaned_invite_id = _clean_invite_id(invite_id)
        try:
            result = self._db.execute_raw(
                """
                SELECT
                  invite.id, invite.circle_id, invite.inviter_user_id,
                  invite.invitee_user_id, invite.status, invite.expires_at,
                  invite.created_at, invite.responded_at,
                  circle.name AS circle_name, circle.kind AS circle_kind,
                  inviter.display_name AS inviter_display_name,
                  invitee.display_name AS invitee_display_name
                FROM one_location_circle_member_invites invite
                JOIN one_location_circles circle
                  ON circle.id = invite.circle_id
                LEFT JOIN actor_identity_cache inviter
                  ON inviter.user_id = invite.inviter_user_id
                LEFT JOIN actor_identity_cache invitee
                  ON invitee.user_id = invite.invitee_user_id
                WHERE invite.id = CAST(:invite_id AS UUID)
                  AND (
                    invite.invitee_user_id = :user_id
                    OR (
                      invite.inviter_user_id = :user_id
                      AND circle.owner_user_id = :user_id
                    )
                  )
                """,
                {"invite_id": cleaned_invite_id, "user_id": user_id},
            )
            row = next(iter(result.data or []), None)
            if not row:
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_INVITE_NOT_FOUND",
                    "Circle invitation not found.",
                    status_code=404,
                )
            return self._member_invite_payload(row)
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("get_member_invite", exc) from exc

    def create_member_invites(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
        invitee_user_ids: list[str],
    ) -> dict[str, Any]:
        """Atomically reserve and create targeted invitations for direct connections."""

        cleaned_circle_id = _clean_circle_id(circle_id)
        cleaned_invitee_user_ids = list(
            dict.fromkeys(_clean_user_id(user_id) for user_id in invitee_user_ids)
        )
        if not cleaned_invitee_user_ids or len(cleaned_invitee_user_ids) > 20:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_BATCH_INVALID",
                "Choose between 1 and 20 connections to invite.",
                status_code=422,
            )
        if owner_user_id in cleaned_invitee_user_ids:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_SELF_INVALID",
                "You are already the Circle owner.",
                status_code=422,
            )
        expires_at = datetime.now(timezone.utc) + timedelta(hours=CIRCLE_MEMBER_INVITE_TTL_HOURS)
        created_invite_ids: list[str] = []
        payloads: list[dict[str, Any]] = []
        try:
            with self._db.engine.begin() as conn:
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              circle.id, circle.name, circle.kind,
                              circle.member_limit,
                              owner_identity.display_name AS inviter_display_name
                            FROM one_location_circles circle
                            LEFT JOIN actor_identity_cache owner_identity
                              ON owner_identity.user_id = circle.owner_user_id
                            WHERE circle.id = CAST(:circle_id AS UUID)
                              AND circle.owner_user_id = :owner_user_id
                              AND circle.status = 'active'
                            FOR UPDATE OF circle
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "owner_user_id": owner_user_id,
                        },
                    )
                )
                if not circle_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_OWNER_REQUIRED",
                        "Only the Circle owner can invite members.",
                        status_code=403,
                    )
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_member_invites
                        SET status = 'expired', updated_at = NOW()
                        WHERE circle_id = CAST(:circle_id AS UUID)
                          AND status = 'pending'
                          AND expires_at <= NOW()
                        """
                    ),
                    {"circle_id": cleaned_circle_id},
                )
                active_target_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT user_id
                            FROM one_location_circle_memberships
                            WHERE circle_id = CAST(:circle_id AS UUID)
                              AND user_id = ANY(CAST(:invitee_user_ids AS TEXT[]))
                              AND status = 'active'
                            ORDER BY user_id
                            FOR UPDATE
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "invitee_user_ids": cleaned_invitee_user_ids,
                        },
                    )
                )
                if active_target_rows:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_ALREADY_MEMBER",
                        "One or more selected connections are already in the Circle.",
                        status_code=409,
                    )
                connection_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT
                              connection.id AS connection_id,
                              CASE
                                WHEN connection.user_a_id = :owner_user_id
                                THEN connection.user_b_id
                                ELSE connection.user_a_id
                              END AS user_id,
                              identity.display_name AS invitee_display_name
                            FROM connections connection
                            LEFT JOIN actor_identity_cache identity
                              ON identity.user_id = CASE
                                WHEN connection.user_a_id = :owner_user_id
                                THEN connection.user_b_id
                                ELSE connection.user_a_id
                              END
                            WHERE connection.status = 'active'
                              AND (
                                connection.user_a_id = :owner_user_id
                                OR connection.user_b_id = :owner_user_id
                              )
                              AND CASE
                                WHEN connection.user_a_id = :owner_user_id
                                THEN connection.user_b_id
                                ELSE connection.user_a_id
                              END = ANY(CAST(:invitee_user_ids AS TEXT[]))
                            ORDER BY connection.user_a_id, connection.user_b_id
                            FOR UPDATE OF connection
                            """
                        ),
                        {
                            "owner_user_id": owner_user_id,
                            "invitee_user_ids": cleaned_invitee_user_ids,
                        },
                    )
                )
                direct_by_user_id = {str(row.get("user_id") or ""): row for row in connection_rows}
                missing_connection = [
                    user_id
                    for user_id in cleaned_invitee_user_ids
                    if user_id not in direct_by_user_id
                ]
                if missing_connection:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
                        "Every selected person must still be a direct connection.",
                        status_code=409,
                    )
                connection_ids = [str(row.get("connection_id") or "") for row in connection_rows]
                direct_origin_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT connection_id
                            FROM connection_origins
                            WHERE connection_id =
                                  ANY(CAST(:connection_ids AS UUID[]))
                              AND origin_kind = 'direct_request'
                              AND status = 'active'
                            ORDER BY connection_id
                            FOR UPDATE
                            """
                        ),
                        {"connection_ids": connection_ids},
                    )
                )
                direct_origin_connection_ids = {
                    str(row.get("connection_id") or "") for row in direct_origin_rows
                }
                if any(
                    connection_id not in direct_origin_connection_ids
                    for connection_id in connection_ids
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
                        "Every selected person must still be a direct connection.",
                        status_code=409,
                    )
                existing_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT
                              invite.id, invite.circle_id,
                              invite.inviter_user_id, invite.invitee_user_id,
                              invite.status, invite.expires_at,
                              invite.created_at, invite.responded_at,
                              circle.name AS circle_name,
                              circle.kind AS circle_kind,
                              inviter.display_name AS inviter_display_name,
                              invitee.display_name AS invitee_display_name
                            FROM one_location_circle_member_invites invite
                            JOIN one_location_circles circle
                              ON circle.id = invite.circle_id
                            LEFT JOIN actor_identity_cache inviter
                              ON inviter.user_id = invite.inviter_user_id
                            LEFT JOIN actor_identity_cache invitee
                              ON invitee.user_id = invite.invitee_user_id
                            WHERE invite.circle_id = CAST(:circle_id AS UUID)
                              AND invite.invitee_user_id =
                                  ANY(CAST(:invitee_user_ids AS TEXT[]))
                              AND invite.status = 'pending'
                              AND invite.expires_at > NOW()
                            ORDER BY invite.invitee_user_id
                            FOR UPDATE OF invite
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "invitee_user_ids": cleaned_invitee_user_ids,
                        },
                    )
                )
                existing_by_user_id = {
                    str(row.get("invitee_user_id") or ""): row for row in existing_rows
                }
                new_user_ids = [
                    user_id
                    for user_id in cleaned_invitee_user_ids
                    if user_id not in existing_by_user_id
                ]
                capacity_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              (
                                SELECT COUNT(*)
                                FROM one_location_circle_memberships membership
                                WHERE membership.circle_id =
                                      CAST(:circle_id AS UUID)
                                  AND membership.status = 'active'
                              ) AS active_member_count,
                              (
                                SELECT COUNT(*)
                                FROM one_location_circle_member_invites invite
                                WHERE invite.circle_id = CAST(:circle_id AS UUID)
                                  AND invite.status = 'pending'
                                  AND invite.expires_at > NOW()
                                  AND NOT EXISTS (
                                    SELECT 1
                                    FROM one_location_circle_memberships membership
                                    WHERE membership.circle_id = invite.circle_id
                                      AND membership.user_id =
                                          invite.invitee_user_id
                                      AND membership.status = 'active'
                                  )
                              ) AS pending_invite_count
                            """
                        ),
                        {"circle_id": cleaned_circle_id},
                    )
                )
                reserved_count = int((capacity_row or {}).get("active_member_count") or 0) + int(
                    (capacity_row or {}).get("pending_invite_count") or 0
                )
                member_limit = int(circle_row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT)
                if new_user_ids and reserved_count + len(new_user_ids) > member_limit:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_CAPACITY_REACHED",
                        "This Circle does not have room for all selected invitations.",
                        status_code=409,
                    )
                for invitee_user_id in new_user_ids:
                    invite_row = _first(
                        conn.execute(
                            text(
                                """
                                INSERT INTO one_location_circle_member_invites (
                                  circle_id, inviter_user_id, invitee_user_id,
                                  status, expires_at, created_at, updated_at,
                                  metadata
                                )
                                VALUES (
                                  CAST(:circle_id AS UUID), :owner_user_id,
                                  :invitee_user_id, 'pending', :expires_at,
                                  NOW(), NOW(), '{}'::jsonb
                                )
                                RETURNING
                                  id, circle_id, inviter_user_id,
                                  invitee_user_id, status, expires_at,
                                  created_at, responded_at
                                """
                            ),
                            {
                                "circle_id": cleaned_circle_id,
                                "owner_user_id": owner_user_id,
                                "invitee_user_id": invitee_user_id,
                                "expires_at": expires_at,
                            },
                        )
                    )
                    if not invite_row:
                        raise RuntimeError("Circle member invitation insert returned no row.")
                    invite_row["circle_name"] = str(circle_row.get("name") or "")
                    invite_row["circle_kind"] = str(circle_row.get("kind") or "other")
                    invite_row["inviter_display_name"] = str(
                        circle_row.get("inviter_display_name") or ""
                    )
                    invite_row["invitee_display_name"] = str(
                        direct_by_user_id[invitee_user_id].get("invitee_display_name") or ""
                    )
                    existing_by_user_id[invitee_user_id] = invite_row
                    created_invite_ids.append(str(invite_row.get("id") or ""))
                payloads = [
                    self._member_invite_payload(existing_by_user_id[invitee_user_id])
                    for invitee_user_id in cleaned_invitee_user_ids
                ]
            if created_invite_ids:
                from hushh_mcp.services.push_notifications import (
                    send_circle_member_invite_push,
                )

                created_ids = set(created_invite_ids)
                for payload in payloads:
                    if str(payload.get("id") or "") not in created_ids:
                        continue
                    send_circle_member_invite_push(
                        invitee_user_id=str(payload.get("inviteeUserId") or ""),
                        inviter_user_id=owner_user_id,
                        circle_id=cleaned_circle_id,
                        invite_id=str(payload.get("id") or ""),
                    )
            logger.info(
                "one_location.circle_members_invited owner=%s requested=%s created=%s",
                redact_log_field("user_id", owner_user_id),
                len(cleaned_invitee_user_ids),
                len(created_invite_ids),
            )
            return {
                "invites": payloads,
                "createdInviteIds": created_invite_ids,
            }
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("create_member_invites", exc) from exc

    def create_member_invite(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
        invitee_user_id: str,
    ) -> dict[str, Any]:
        """Compatibility wrapper around the atomic batch invitation contract."""

        result = self.create_member_invites(
            owner_user_id=owner_user_id,
            circle_id=circle_id,
            invitee_user_ids=[invitee_user_id],
        )
        invite = result["invites"][0]
        return {
            "invite": invite,
            "created": str(invite.get("id") or "") in set(result.get("createdInviteIds") or []),
        }

    def accept_member_invite(
        self,
        *,
        user_id: str,
        invite_id: str,
    ) -> dict[str, Any]:
        """Accept a targeted invitation and atomically establish Circle origins."""

        cleaned_invite_id = _clean_invite_id(invite_id)
        circle_id = ""
        joined = False
        accepted = False
        try:
            with self._db.engine.begin() as conn:
                self._lock_user_circle_memberships(conn, user_id=user_id)
                invite_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              invite.id, invite.circle_id,
                              invite.inviter_user_id, invite.invitee_user_id,
                              invite.status, invite.expires_at,
                              circle.owner_user_id, circle.member_limit,
                              circle.status AS circle_status,
                              circle.name AS circle_name,
                              circle.kind AS circle_kind,
                              inviter.display_name AS inviter_display_name,
                              invitee.display_name AS invitee_display_name,
                              invite.created_at, invite.responded_at
                            FROM one_location_circle_member_invites invite
                            JOIN one_location_circles circle
                              ON circle.id = invite.circle_id
                            LEFT JOIN actor_identity_cache inviter
                              ON inviter.user_id = invite.inviter_user_id
                            LEFT JOIN actor_identity_cache invitee
                              ON invitee.user_id = invite.invitee_user_id
                            WHERE invite.id = CAST(:invite_id AS UUID)
                              AND invite.invitee_user_id = :user_id
                            FOR UPDATE OF invite, circle
                            """
                        ),
                        {"invite_id": cleaned_invite_id, "user_id": user_id},
                    )
                )
                if not invite_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_NOT_FOUND",
                        "Circle invitation not found.",
                        status_code=404,
                    )
                circle_id = str(invite_row.get("circle_id") or "")
                invite_status = str(invite_row.get("status") or "")
                if invite_status == "accepted":
                    active_membership = _first(
                        conn.execute(
                            text(
                                """
                                SELECT user_id
                                FROM one_location_circle_memberships
                                WHERE circle_id = CAST(:circle_id AS UUID)
                                  AND user_id = :user_id
                                  AND status = 'active'
                                FOR UPDATE
                                """
                            ),
                            {"circle_id": circle_id, "user_id": user_id},
                        )
                    )
                    if (
                        str(invite_row.get("circle_status") or "") != "active"
                        or not active_membership
                    ):
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                            "This Circle invitation no longer represents an active membership.",
                            status_code=409,
                        )
                    self._connect_member_to_circle(
                        conn,
                        circle_id=circle_id,
                        user_id=user_id,
                    )
                else:
                    expires_at = invite_row.get("expires_at")
                    if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
                        expires_at = expires_at.replace(tzinfo=timezone.utc)
                    if (
                        invite_status != "pending"
                        or str(invite_row.get("circle_status") or "") != "active"
                    ):
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                            "This Circle invitation is no longer available.",
                            status_code=409,
                        )
                    if not isinstance(expires_at, datetime) or expires_at <= datetime.now(
                        timezone.utc
                    ):
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_INVITE_EXPIRED",
                            "This Circle invitation has expired.",
                            status_code=410,
                        )
                    if str(invite_row.get("owner_user_id") or "") != str(
                        invite_row.get("inviter_user_id") or ""
                    ):
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                            "This Circle invitation is no longer available.",
                            status_code=409,
                        )
                    # Transaction lock order is Circle/invite (above), exact
                    # canonical connection, direct origin, then membership.
                    # The origin check runs after the connection lock in a new
                    # statement/snapshot so a concurrent direct removal cannot
                    # be masked by another active Circle origin.
                    connection_row = _first(
                        conn.execute(
                            text(
                                """
                                SELECT connection.id
                                FROM connections connection
                                WHERE connection.status = 'active'
                                  AND (
                                    (
                                      connection.user_a_id = :inviter_user_id
                                      AND connection.user_b_id = :user_id
                                    )
                                    OR (
                                      connection.user_b_id = :inviter_user_id
                                      AND connection.user_a_id = :user_id
                                    )
                                  )
                                FOR UPDATE OF connection
                                """
                            ),
                            {
                                "inviter_user_id": str(invite_row.get("inviter_user_id") or ""),
                                "user_id": user_id,
                            },
                        )
                    )
                    if not connection_row:
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
                            "Reconnect before accepting this Circle invitation.",
                            status_code=409,
                        )
                    direct_origin = _first(
                        conn.execute(
                            text(
                                """
                                SELECT id
                                FROM connection_origins
                                WHERE connection_id =
                                      CAST(:connection_id AS UUID)
                                  AND origin_kind = 'direct_request'
                                  AND status = 'active'
                                FOR UPDATE
                                """
                            ),
                            {"connection_id": str(connection_row.get("id") or "")},
                        )
                    )
                    if not direct_origin:
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
                            "Reconnect before accepting this Circle invitation.",
                            status_code=409,
                        )
                    existing = _first(
                        conn.execute(
                            text(
                                """
                                SELECT role, status
                                FROM one_location_circle_memberships
                                WHERE circle_id = CAST(:circle_id AS UUID)
                                  AND user_id = :user_id
                                FOR UPDATE
                                """
                            ),
                            {"circle_id": circle_id, "user_id": user_id},
                        )
                    )
                    if existing and str(existing.get("status") or "") == "active":
                        joined = False
                    else:
                        self._assert_user_circle_capacity(conn, user_id=user_id)
                        count_row = _first(
                            conn.execute(
                                text(
                                    """
                                    SELECT
                                      (
                                        SELECT COUNT(*)
                                        FROM one_location_circle_memberships membership
                                        WHERE membership.circle_id =
                                              CAST(:circle_id AS UUID)
                                          AND membership.status = 'active'
                                      )
                                      +
                                      (
                                        SELECT COUNT(*)
                                        FROM one_location_circle_member_invites invite
                                        WHERE invite.circle_id =
                                              CAST(:circle_id AS UUID)
                                          AND invite.status = 'pending'
                                          AND invite.expires_at > NOW()
                                          AND invite.invitee_user_id <> :user_id
                                          AND NOT EXISTS (
                                            SELECT 1
                                            FROM one_location_circle_memberships membership
                                            WHERE membership.circle_id =
                                                  invite.circle_id
                                              AND membership.user_id =
                                                  invite.invitee_user_id
                                              AND membership.status = 'active'
                                          )
                                      ) AS member_count
                                    """
                                ),
                                {"circle_id": circle_id, "user_id": user_id},
                            )
                        )
                        if int((count_row or {}).get("member_count") or 0) >= int(
                            invite_row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT
                        ):
                            raise OneLocationCircleError(
                                "LOCATION_CIRCLE_FULL",
                                "This Circle is full.",
                                status_code=409,
                            )
                        conn.execute(
                            text(
                                """
                                INSERT INTO one_location_circle_memberships (
                                  circle_id, user_id, role, status, joined_at,
                                  updated_at, ended_at, metadata
                                )
                                VALUES (
                                  CAST(:circle_id AS UUID), :user_id, 'member',
                                  'active', NOW(), NOW(), NULL, '{}'::jsonb
                                )
                                ON CONFLICT (circle_id, user_id) DO UPDATE SET
                                  role = 'member',
                                  status = 'active',
                                  joined_at = NOW(),
                                  updated_at = NOW(),
                                  ended_at = NULL
                                """
                            ),
                            {"circle_id": circle_id, "user_id": user_id},
                        )
                        joined = True
                    self._connect_member_to_circle(
                        conn,
                        circle_id=circle_id,
                        user_id=user_id,
                    )
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circle_member_invites
                            SET status = 'accepted', responded_at = NOW(),
                                updated_at = NOW()
                            WHERE id = CAST(:invite_id AS UUID)
                              AND status = 'pending'
                            """
                        ),
                        {"invite_id": cleaned_invite_id},
                    )
                    accepted = True
                    invite_row["status"] = "accepted"
                    invite_row["responded_at"] = datetime.now(timezone.utc)
            return {
                "circle": self.get_circle(user_id=user_id, circle_id=circle_id),
                "invite": self._member_invite_payload(invite_row or {}),
                "accepted": accepted,
                "joined": joined,
            }
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("accept_member_invite", exc) from exc

    def decline_member_invite(
        self,
        *,
        user_id: str,
        invite_id: str,
    ) -> dict[str, Any]:
        cleaned_invite_id = _clean_invite_id(invite_id)
        try:
            result = self._db.execute_raw(
                """
                UPDATE one_location_circle_member_invites
                SET status = 'declined', responded_at = NOW(), updated_at = NOW()
                WHERE id = CAST(:invite_id AS UUID)
                  AND invitee_user_id = :user_id
                  AND status = 'pending'
                  AND expires_at > NOW()
                RETURNING id
                """,
                {"invite_id": cleaned_invite_id, "user_id": user_id},
            )
            if result.data or []:
                return self.get_member_invite(user_id=user_id, invite_id=cleaned_invite_id)
            existing = self._db.execute_raw(
                """
                SELECT status
                FROM one_location_circle_member_invites
                WHERE id = CAST(:invite_id AS UUID)
                  AND invitee_user_id = :user_id
                """,
                {"invite_id": cleaned_invite_id, "user_id": user_id},
            )
            row = next(iter(existing.data or []), None)
            if row and str(row.get("status") or "") == "declined":
                return self.get_member_invite(user_id=user_id, invite_id=cleaned_invite_id)
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                "This Circle invitation is no longer available.",
                status_code=409 if row else 404,
            )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("decline_member_invite", exc) from exc

    def cancel_member_invite(
        self,
        *,
        owner_user_id: str,
        invite_id: str,
    ) -> bool:
        cleaned_invite_id = _clean_invite_id(invite_id)
        try:
            result = self._db.execute_raw(
                """
                UPDATE one_location_circle_member_invites invite
                SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                FROM one_location_circles circle
                WHERE invite.id = CAST(:invite_id AS UUID)
                  AND invite.circle_id = circle.id
                  AND circle.owner_user_id = :owner_user_id
                  AND circle.status = 'active'
                  AND invite.status = 'pending'
                RETURNING invite.id
                """,
                {
                    "invite_id": cleaned_invite_id,
                    "owner_user_id": owner_user_id,
                },
            )
            if result.data or []:
                return True
            existing = self._db.execute_raw(
                """
                SELECT invite.status
                FROM one_location_circle_member_invites invite
                JOIN one_location_circles circle
                  ON circle.id = invite.circle_id
                WHERE invite.id = CAST(:invite_id AS UUID)
                  AND circle.owner_user_id = :owner_user_id
                """,
                {
                    "invite_id": cleaned_invite_id,
                    "owner_user_id": owner_user_id,
                },
            )
            row = next(iter(existing.data or []), None)
            if row and str(row.get("status") or "") == "cancelled":
                return False
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                "This Circle invitation is no longer available.",
                status_code=409 if row else 404,
            )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("cancel_member_invite", exc) from exc

    @staticmethod
    def _cleanup_ineligible_sms_contacts(conn: Any, *, user_id: str) -> None:
        conn.execute(
            text(
                """
                DELETE FROM one_location_sms_contacts sms
                WHERE (
                    sms.owner_user_id = :user_id
                    OR sms.contact_user_id = :user_id
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM connections connection
                    WHERE connection.status = 'active'
                      AND (
                        (
                          connection.user_a_id = sms.owner_user_id
                          AND connection.user_b_id = sms.contact_user_id
                        )
                        OR (
                          connection.user_b_id = sms.owner_user_id
                          AND connection.user_a_id = sms.contact_user_id
                        )
                      )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM one_location_circle_memberships first_member
                    JOIN one_location_circle_memberships second_member
                      ON second_member.circle_id = first_member.circle_id
                     AND second_member.user_id = sms.contact_user_id
                     AND second_member.status = 'active'
                    JOIN one_location_circles circle
                      ON circle.id = first_member.circle_id
                     AND circle.status = 'active'
                    WHERE first_member.user_id = sms.owner_user_id
                      AND first_member.status = 'active'
                  )
                """
            ),
            {"user_id": user_id},
        )

    @staticmethod
    def _reconcile_circle_sourced_grants(
        conn: Any,
        *,
        circle_id: str,
        member_user_id: str | None = None,
    ) -> None:
        """Preserve grants when another active relationship origin still supports them."""

        params = {
            "circle_id": circle_id,
            "member_user_id": str(member_user_id or "").strip() or None,
        }
        conn.execute(
            text(
                """
                UPDATE one_location_share_grants share_grant
                SET source_circle_id = NULL, updated_at = NOW()
                WHERE share_grant.source_circle_id = CAST(:circle_id AS UUID)
                  AND share_grant.status = 'active'
                  AND (
                    CAST(:member_user_id AS TEXT) IS NULL
                    OR share_grant.owner_user_id = :member_user_id
                    OR share_grant.recipient_user_id = :member_user_id
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM connections connection
                    JOIN connection_origins origin
                      ON origin.connection_id = connection.id
                     AND origin.status = 'active'
                     AND origin.origin_kind <> 'named_circle'
                    WHERE connection.status = 'active'
                      AND (
                        (
                          connection.user_a_id = share_grant.owner_user_id
                          AND connection.user_b_id = share_grant.recipient_user_id
                        )
                        OR (
                          connection.user_b_id = share_grant.owner_user_id
                          AND connection.user_a_id = share_grant.recipient_user_id
                        )
                      )
                  )
                """
            ),
            params,
        )
        conn.execute(
            text(
                """
                WITH replacements AS (
                  SELECT
                    share_grant.id AS grant_id,
                    MIN(origin.source_circle_id::text)::uuid AS replacement_circle_id
                  FROM one_location_share_grants share_grant
                  JOIN connections connection
                    ON connection.status = 'active'
                   AND (
                     (
                       connection.user_a_id = share_grant.owner_user_id
                       AND connection.user_b_id = share_grant.recipient_user_id
                     )
                     OR (
                       connection.user_b_id = share_grant.owner_user_id
                       AND connection.user_a_id = share_grant.recipient_user_id
                     )
                   )
                  JOIN connection_origins origin
                    ON origin.connection_id = connection.id
                   AND origin.status = 'active'
                   AND origin.origin_kind = 'named_circle'
                   AND origin.source_circle_id IS NOT NULL
                   AND origin.source_circle_id <> CAST(:circle_id AS UUID)
                  WHERE share_grant.source_circle_id = CAST(:circle_id AS UUID)
                    AND share_grant.status = 'active'
                    AND (
                      CAST(:member_user_id AS TEXT) IS NULL
                      OR share_grant.owner_user_id = :member_user_id
                      OR share_grant.recipient_user_id = :member_user_id
                    )
                  GROUP BY share_grant.id
                )
                UPDATE one_location_share_grants share_grant
                SET source_circle_id = replacements.replacement_circle_id,
                    updated_at = NOW()
                FROM replacements
                WHERE share_grant.id = replacements.grant_id
                """
            ),
            params,
        )
        conn.execute(
            text(
                """
                UPDATE one_location_share_grants share_grant
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE share_grant.source_circle_id = CAST(:circle_id AS UUID)
                  AND share_grant.status = 'active'
                  AND (
                    CAST(:member_user_id AS TEXT) IS NULL
                    OR share_grant.owner_user_id = :member_user_id
                    OR share_grant.recipient_user_id = :member_user_id
                  )
                """
            ),
            params,
        )

    def _end_membership(
        self,
        *,
        actor_user_id: str,
        circle_id: str,
        target_user_id: str,
        status: str,
    ) -> None:
        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            with self._db.engine.begin() as conn:
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT owner_user_id
                            FROM one_location_circles
                            WHERE id = CAST(:circle_id AS UUID)
                              AND status = 'active'
                            FOR UPDATE
                            """
                        ),
                        {"circle_id": cleaned_circle_id},
                    )
                )
                if not circle_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_NOT_FOUND",
                        "Circle not found.",
                        status_code=404,
                    )
                owner_user_id = str(circle_row.get("owner_user_id") or "")
                if status == "removed":
                    if actor_user_id != owner_user_id:
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_OWNER_REQUIRED",
                            "Only the Circle owner can remove a member.",
                            status_code=403,
                        )
                    if target_user_id == owner_user_id:
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_OWNER_REMOVE_INVALID",
                            "The Circle owner cannot be removed.",
                            status_code=422,
                        )
                elif actor_user_id != target_user_id:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_LEAVE_INVALID",
                        "You can only leave your own Circle membership.",
                        status_code=403,
                    )
                elif target_user_id == owner_user_id:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_OWNER_LEAVE_INVALID",
                        "Delete the Circle instead of leaving it.",
                        status_code=422,
                    )
                membership_row = _first(
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circle_memberships
                            SET status = :status, ended_at = NOW(), updated_at = NOW()
                            WHERE circle_id = CAST(:circle_id AS UUID)
                              AND user_id = :target_user_id
                              AND role = 'member'
                              AND status = 'active'
                            RETURNING user_id
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "target_user_id": target_user_id,
                            "status": status,
                        },
                    )
                )
                if not membership_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBER_NOT_FOUND",
                        "Circle member not found.",
                        status_code=404,
                    )
                revoke_circle_origins(
                    conn,
                    circle_id=cleaned_circle_id,
                    member_user_id=target_user_id,
                )
                self._reconcile_circle_sourced_grants(
                    conn,
                    circle_id=cleaned_circle_id,
                    member_user_id=target_user_id,
                )
                self._cleanup_ineligible_sms_contacts(
                    conn,
                    user_id=target_user_id,
                )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("end_membership", exc) from exc

    def remove_member(
        self,
        *,
        owner_user_id: str,
        circle_id: str,
        member_user_id: str,
    ) -> None:
        self._end_membership(
            actor_user_id=owner_user_id,
            circle_id=circle_id,
            target_user_id=str(member_user_id or "").strip(),
            status="removed",
        )

    def leave_circle(self, *, user_id: str, circle_id: str) -> None:
        self._end_membership(
            actor_user_id=user_id,
            circle_id=circle_id,
            target_user_id=user_id,
            status="left",
        )

    def delete_circle(self, *, owner_user_id: str, circle_id: str) -> None:
        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            with self._db.engine.begin() as conn:
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circles
                            SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
                            WHERE id = CAST(:circle_id AS UUID)
                              AND owner_user_id = :owner_user_id
                              AND status = 'active'
                            RETURNING id
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "owner_user_id": owner_user_id,
                        },
                    )
                )
                if not circle_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_OWNER_REQUIRED",
                        "Only the Circle owner can delete it.",
                        status_code=403,
                    )
                member_rows = _all(
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circle_memberships
                            SET status = 'removed', ended_at = NOW(), updated_at = NOW()
                            WHERE circle_id = CAST(:circle_id AS UUID)
                              AND status = 'active'
                            RETURNING user_id
                            """
                        ),
                        {"circle_id": cleaned_circle_id},
                    )
                )
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_invite_codes
                        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                        WHERE circle_id = CAST(:circle_id AS UUID)
                          AND status = 'active'
                        """
                    ),
                    {"circle_id": cleaned_circle_id},
                )
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_member_invites
                        SET status = 'cancelled', cancelled_at = NOW(),
                            updated_at = NOW()
                        WHERE circle_id = CAST(:circle_id AS UUID)
                          AND status = 'pending'
                        """
                    ),
                    {"circle_id": cleaned_circle_id},
                )
                revoke_circle_origins(
                    conn,
                    circle_id=cleaned_circle_id,
                )
                self._reconcile_circle_sourced_grants(
                    conn,
                    circle_id=cleaned_circle_id,
                )
                for member in member_rows:
                    member_user_id = str(member.get("user_id") or "")
                    if member_user_id:
                        self._cleanup_ineligible_sms_contacts(
                            conn,
                            user_id=member_user_id,
                        )
            logger.info(
                "one_location.circle_deleted owner=%s",
                redact_log_field("user_id", owner_user_id),
            )
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("delete", exc) from exc
