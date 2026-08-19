"""Named Circle relationship service for One Location.

Joining a Circle is explicit relationship consent. Membership creates a
source-aware connection origin with every active Circle member, but never
creates a trusted edge, SMS selection, live-location grant, capability token,
or encrypted envelope. Every active member may invite an existing direct
connection without requiring another connection request or a code. Circle
governance (rename, removal, code rotation, and deletion) remains owner-only.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import uuid
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
# Nothing sets this any more -- connections are added outright rather than
# invited. It stays because the invitations written before that change are
# still readable, and accept/decline still refuse the ones that ran out.
CIRCLE_MEMBER_INVITE_TTL_HOURS = 72
CIRCLE_MEMBER_REINVITE_COOLDOWN_HOURS = 12
# How many people a member who does not own the Circle may put into it.
# Named for the pending invitations it used to count; adding is immediate now,
# so it counts the members they added who are still active. Same ceiling, same
# purpose -- one member cannot fill somebody else's Circle.
CIRCLE_NON_OWNER_PENDING_INVITE_LIMIT = 5
CIRCLE_MAX_PER_USER = 10
# Raised from 20 in migration 158. This constant is stamped onto a Circle at
# INSERT and never edited afterwards, so it governs new Circles only -- the
# migration lifts the stored ceiling on Circles that already carry the old
# default, which is what makes the higher limit real for accounts that
# already have Circles rather than only for ones created from here on.
CIRCLE_DEFAULT_MEMBER_LIMIT = 100
# The one system Circle this product provisions today.
#
# "Circle", not "Contacts": it sits in the Circles list beside Circles the
# person named themselves ("Family", "Climbing"), and a row reading like a
# contact list among Circles is the confusion the UAT report described.
SMS_SYSTEM_CIRCLE_NAME = "SMS Circle"

# What the product called it before. Rows still carrying this are renamed on
# the next bootstrap; a name the OWNER chose is never touched.
SMS_SYSTEM_CIRCLE_LEGACY_NAMES = ("SMS Contacts",)
CIRCLE_CODE_LENGTH = 12
CIRCLE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_CIRCLE_CODE_DOMAIN = b"one-location-circle-code:v1:"
_CIRCLE_CODE_DISPLAY_DOMAIN = b"one-location-circle-code-display:v1:"
_CIRCLE_CODE_VERSION = "derived-v1"
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


def _json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


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
    # One character is a name. The old two-character floor rejected a circle
    # called "A" from a Create button that gave no reason for staying dead.
    if len(name) < 1 or len(name) > 80:
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_NAME_INVALID",
            "Circle name must be between 1 and 80 characters.",
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

    def _code_for_invite_id(self, invite_id: str) -> str:
        """Derive a display code without persisting the plaintext code.

        The invite row UUID is non-secret. The app signing key supplies the
        entropy, so an authenticated active Circle member can re-read the
        current Circle code while a database-only compromise still exposes
        only the UUID, keyed digest, and derivation version.
        """

        normalized_invite_id = str(uuid.UUID(str(invite_id)))
        digest = hmac.new(
            self._key(),
            _CIRCLE_CODE_DISPLAY_DOMAIN + normalized_invite_id.encode("ascii"),
            hashlib.sha256,
        ).digest()
        value = int.from_bytes(digest, "big")
        characters: list[str] = []
        for _ in range(CIRCLE_CODE_LENGTH):
            value, index = divmod(value, len(CIRCLE_CODE_ALPHABET))
            characters.append(CIRCLE_CODE_ALPHABET[index])
        return format_circle_code("".join(reversed(characters)))

    def _invite_code_payload(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        metadata = _json_object(row.get("metadata")) or {}
        if metadata.get("codeVersion") != _CIRCLE_CODE_VERSION:
            return None
        invite_id = str(row.get("id") or "")
        display_code = self._code_for_invite_id(invite_id)
        expected_hash = self._code_hash(normalize_circle_code(display_code))
        stored_hash = str(row.get("code_hash") or "")
        if not stored_hash or not hmac.compare_digest(stored_hash, expected_hash):
            logger.warning(
                "one_location.circle_code_integrity_failed invite=%s",
                redact_log_field("invite_id", invite_id),
            )
            return None
        return {
            "id": invite_id,
            "circleId": str(row.get("circle_id") or ""),
            "code": display_code,
            "expiresAt": _iso(row.get("expires_at")),
        }

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
    def _lock_invitees(conn: Any, *, user_ids: list[str]) -> None:
        """Lock every person about to be added, in a fixed order.

        One statement rather than a call per person, so the order is the
        statement's and not the caller's; and taken before the connection rows
        because `accept_member_invite` locks a profile before a connection, and
        two paths that disagree about that order deadlock on the one pair they
        have in common.

        A missing profile is someone who has not finished setting up One. They
        are not named: which of your connections has finished onboarding is
        their business, not the business of whoever is adding them.
        """

        if not user_ids:
            return
        rows = _all(
            conn.execute(
                text(
                    """
                    SELECT user_id
                    FROM actor_profiles
                    WHERE user_id = ANY(CAST(:user_ids AS TEXT[]))
                    ORDER BY user_id
                    FOR UPDATE
                    """
                ),
                {"user_ids": sorted(user_ids)},
            )
        )
        ready = {str(row.get("user_id") or "") for row in rows}
        if any(user_id not in ready for user_id in user_ids):
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITEE_NOT_READY",
                "Someone you selected has not finished setting up One.",
                status_code=409,
            )

    @staticmethod
    def _assert_user_circle_capacity(
        conn: Any, *, user_id: str, adding_other: bool = False
    ) -> None:
        count_row = _first(
            conn.execute(
                text(
                    """
                    SELECT COUNT(*) AS circle_count
                    FROM one_location_circle_memberships membership
                    JOIN one_location_circles circle
                      ON circle.id = membership.circle_id
                     AND circle.status = 'active'
                     AND NOT circle.is_system
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
                (
                    # Deliberately unnamed. Adding people is now immediate, so
                    # this check runs against someone else's account, and how
                    # many Circles a person belongs to is their business --
                    # naming them would answer that question for anyone with a
                    # connection and a full Circle to test against.
                    "Someone you selected is already in as many Circles as One allows."
                    if adding_other
                    else f"You can belong to up to {CIRCLE_MAX_PER_USER} Circles."
                ),
                status_code=409,
            )

    @staticmethod
    def _circle_summary(row: dict[str, Any]) -> dict[str, Any]:
        owner_user_id = str(row.get("owner_user_id") or "")
        viewer_user_id = str(row.get("viewer_user_id") or "")
        # Membership role is presentation metadata, not the governance source
        # of truth. Owner-only capabilities follow the canonical Circle owner.
        is_owner = bool(owner_user_id and viewer_user_id == owner_user_id)
        role = "owner" if is_owner else "member"
        is_system = bool(row.get("is_system") or False)
        name = str(row.get("name") or "")
        # A system Circle is one person's private emergency list, but everyone
        # on it is a member of it, so it appears in THEIR Circles list too --
        # under the same product-chosen name as their own. Saying whose it is
        # turns three identical rows back into three distinct ones.
        if is_system and not is_owner:
            owner_name = str(row.get("owner_display_name") or "").strip()
            name = f"{owner_name}'s {name}" if owner_name else f"Shared {name}"
        return {
            "id": str(row.get("id") or ""),
            "name": name,
            "kind": str(row.get("kind") or "other"),
            "role": role,
            "isSystem": is_system,
            "memberCount": int(row.get("member_count") or 0),
            "memberLimit": int(row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT),
            "createdAt": _iso(row.get("created_at")),
            "updatedAt": _iso(row.get("updated_at")),
            "viewerCapabilities": {
                # Invite authority is intentionally separate from location,
                # SMS, rename, removal, and deletion authority.
                #
                # Except on a system Circle, which is one person's private
                # emergency list. Anyone on it could otherwise add other people
                # TO it -- a stranger invited by a member would receive the
                # owner's SOS alerts, at their address, and the owner never
                # chose them. Owner-controlled, or it is not an emergency list.
                "canInviteMembers": is_owner or not is_system,
                # And it has no shareable join code at all: that is the same
                # hole with a link attached.
                "canViewInviteCode": not is_system,
                "canRotateInviteCode": is_owner and not is_system,
                "canManageCircle": is_owner,
                "canModerateInvites": is_owner,
                # The ONLY thing a system Circle takes away. It is provisioned
                # by the product and depended on by SOS, so it is not the
                # owner's to delete -- every other owner power still applies:
                # rename, add members, remove members.
                #
                # Deliberately no roster restriction. An emergency Circle is a
                # group that should know it is a group: if something happens to
                # the owner, the people on that list are the ones who may need
                # to reach each other, and a roster only the owner can read is
                # useless at exactly the moment it is needed. So membership is
                # visible here on the same terms as any other Circle.
                #
                # Note this is visibility, not connection: seeing a name in a
                # roster is not a connection edge. `_connect_member_to_circle`
                # still only ever pairs a joiner with whoever invited them, so
                # members are listed together without being introduced.
                "canDeleteCircle": is_owner and not is_system,
            },
        }

    @staticmethod
    def _member_payload(row: dict[str, Any]) -> dict[str, Any]:
        display_name = str(row.get("display_name") or "").strip()
        relationship = str(row.get("relationship") or "none")
        key_id = str(row.get("key_id") or "").strip()
        public_key_jwk = _json_object(row.get("public_key_jwk"))
        can_receive_location = bool(key_id and public_key_jwk)
        return {
            "userId": str(row.get("user_id") or ""),
            "displayName": display_name or "Circle member",
            "photoUrl": str(row.get("custom_photo_url") or row.get("photo_url") or "") or None,
            "role": str(row.get("role") or "member"),
            "joinedAt": _iso(row.get("joined_at")),
            "phoneVerified": bool(row.get("phone_verified")),
            "secureLocationReady": can_receive_location,
            # Public recipient-key material is returned only to an authenticated
            # active member of this Circle. It lets shared web/iOS/Android UI
            # expand an explicitly selected Circle without relying on the
            # separate 50-person recommendation list.
            "keyId": key_id or None,
            "publicKeyJwk": public_key_jwk,
            "keyAlgorithm": str(row.get("algorithm") or "ECDH-P256-AES256-GCM"),
            "keyRegisteredAt": _iso(row.get("key_created_at")),
            "canReceiveLocation": can_receive_location,
            # Being in the same Circle is not being connected -- a joiner is
            # paired with whoever invited them and nobody else. Surfacing the
            # relationship here is what lets the roster offer the introduction
            # the Circle deliberately does not make by itself.
            "relationship": relationship,
            # 'self' and 'connected' have nothing to request; the two pending
            # states already have a request in flight. Phone verification is
            # required for the same reason it is everywhere else a connection
            # can start.
            "canConnect": (relationship == "none" and bool(row.get("phone_verified"))),
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
            "inviterDisplayName": inviter_name or "A Circle member",
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
        inviter_user_id: str | None = None,
    ) -> None:
        """Connect a joiner to whoever invited them, and to nobody else.

        Redeeming an invitation is the same consent shape as a connection
        request: one person offered, one accepted. So it produces exactly one
        connection, between exactly those two.

        This used to connect the joiner to every existing member, which meant a
        single join could connect people who had never chosen each other — one
        join into a full 20-person Circle created 19 connections, 18 of them
        between strangers. Restricting who may invite does not fix that; the
        fan-out does. Co-members who were never introduced can still share
        location with each other through the Circle itself, which is a sharing
        scope rather than a claim that everyone is connected.

        Two origins are written for the one pair: `circle_member`, which
        records the accepted invitation and outlives the Circle, and
        `named_circle`, which is Circle-scoped provenance revoked with the
        membership. Together they let the connection persist after someone
        leaves while the Circle still governs what it authorized.
        """

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
        active_member_ids = {str(row.get("user_id") or "").strip() for row in member_rows}
        if user_id not in active_member_ids:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_MEMBERSHIP_NOT_ACTIVE",
                "Circle membership is no longer active.",
                status_code=409,
            )
        inviter_id = str(inviter_user_id or "").strip()
        # An inviter who has since left introduces nobody: the joiner is in the
        # Circle and can share through it, but there is no live pair to record.
        if not inviter_id or inviter_id == user_id or inviter_id not in active_member_ids:
            return
        for kind, source_circle in (
            ("circle_member", None),
            ("named_circle", circle_id),
        ):
            ensure_connection_origin(
                conn,
                user_a_id=user_id,
                user_b_id=inviter_id,
                kind=kind,
                source_circle_id=source_circle,
            )

    def list_circles(self, *, user_id: str) -> list[dict[str, Any]]:
        try:
            result = self._db.execute_raw(
                """
                SELECT
                  c.id, c.name, c.kind, c.member_limit, c.is_system,
                  c.created_at, c.updated_at,
                  c.owner_user_id, :user_id AS viewer_user_id, mine.role,
                  owner_identity.display_name AS owner_display_name,
                  COUNT(active_members.user_id) AS member_count
                FROM one_location_circle_memberships mine
                JOIN one_location_circles c
                  ON c.id = mine.circle_id
                 AND c.status = 'active'
                LEFT JOIN actor_identity_cache owner_identity
                  ON owner_identity.user_id = c.owner_user_id
                LEFT JOIN one_location_circle_memberships active_members
                  ON active_members.circle_id = c.id
                 AND active_members.status = 'active'
                WHERE mine.user_id = :user_id
                  AND mine.status = 'active'
                GROUP BY c.id, mine.role, owner_identity.display_name
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
                  c.id, c.name, c.kind, c.member_limit, c.is_system,
                  c.created_at, c.updated_at,
                  c.owner_user_id, :user_id AS viewer_user_id, mine.role,
                  owner_identity.display_name AS owner_display_name,
                  active_code.id AS code_id,
                  active_code.circle_id AS code_circle_id,
                  active_code.code_hash,
                  active_code.expires_at AS code_expires_at,
                  active_code.metadata AS code_metadata,
                  COUNT(active_members.user_id) AS member_count
                FROM one_location_circles c
                LEFT JOIN actor_identity_cache owner_identity
                  ON owner_identity.user_id = c.owner_user_id
                JOIN one_location_circle_memberships mine
                  ON mine.circle_id = c.id
                 AND mine.user_id = :user_id
                 AND mine.status = 'active'
                LEFT JOIN one_location_circle_memberships active_members
                  ON active_members.circle_id = c.id
                 AND active_members.status = 'active'
                LEFT JOIN LATERAL (
                    SELECT
                      code.id, code.circle_id, code.code_hash,
                      code.expires_at, code.metadata
                    FROM one_location_circle_invite_codes code
                    WHERE code.circle_id = c.id
                      AND code.status = 'active'
                      AND code.expires_at > NOW()
                    ORDER BY code.created_at DESC
                    LIMIT 1
                ) active_code ON TRUE
                WHERE c.id = CAST(:circle_id AS UUID)
                  AND c.status = 'active'
                GROUP BY
                  c.id, mine.role, owner_identity.display_name,
                  active_code.id, active_code.circle_id,
                  active_code.code_hash, active_code.expires_at,
                  active_code.metadata
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
                  recipient_key.key_id, recipient_key.public_key_jwk,
                  recipient_key.algorithm,
                  recipient_key.created_at AS key_created_at,
                  CASE
                    WHEN membership.user_id = :viewer_user_id THEN 'self'
                    WHEN EXISTS (
                      SELECT 1
                      FROM connections c
                      WHERE c.status = 'active'
                        AND c.user_a_id = LEAST(:viewer_user_id, membership.user_id)
                        AND c.user_b_id = GREATEST(:viewer_user_id, membership.user_id)
                    ) THEN 'connected'
                    WHEN EXISTS (
                      SELECT 1
                      FROM connection_requests cr
                      WHERE cr.status = 'pending'
                        AND cr.requester_user_id = :viewer_user_id
                        AND cr.addressee_user_id = membership.user_id
                    ) THEN 'pending_outgoing'
                    WHEN EXISTS (
                      SELECT 1
                      FROM connection_requests cr
                      WHERE cr.status = 'pending'
                        AND cr.requester_user_id = membership.user_id
                        AND cr.addressee_user_id = :viewer_user_id
                    ) THEN 'pending_incoming'
                    ELSE 'none'
                  END AS relationship
                FROM one_location_circle_memberships membership
                LEFT JOIN actor_identity_cache identity
                  ON identity.user_id = membership.user_id
                LEFT JOIN LATERAL (
                    SELECT
                      key.key_id, key.public_key_jwk, key.algorithm,
                      key.created_at
                    FROM one_location_recipient_keys key
                    WHERE key.user_id = membership.user_id
                      AND key.status = 'active'
                    ORDER BY key.created_at DESC
                    LIMIT 1
                ) recipient_key ON TRUE
                WHERE membership.circle_id = CAST(:circle_id AS UUID)
                  AND membership.status = 'active'
                ORDER BY
                  CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END,
                  COALESCE(identity.display_name, membership.user_id)
                """,
                {"circle_id": cleaned_circle_id, "viewer_user_id": user_id},
            )
            circle = self._circle_summary(dict(summary_row))
            circle["members"] = [self._member_payload(row) for row in (members_result.data or [])]
            circle["activeInviteCode"] = self._invite_code_payload(
                {
                    "id": summary_row.get("code_id"),
                    "circle_id": summary_row.get("code_circle_id"),
                    "code_hash": summary_row.get("code_hash"),
                    "expires_at": summary_row.get("code_expires_at"),
                    "metadata": summary_row.get("code_metadata"),
                }
                if summary_row.get("code_id")
                else None
            )
            circle["inviteCodeNeedsOwnerRotation"] = bool(
                summary_row.get("code_id") and circle["activeInviteCode"] is None
            )
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

    def ensure_sms_system_circle(self, *, owner_user_id: str) -> dict[str, Any]:
        """Find-or-create this owner's SMS Circle and fold their contacts into it.

        Issue #5426: emergency SMS contacts stop being a private table
        (`one_location_sms_contacts`, migration 116) and become a real Circle on
        the Circles surface -- one the owner manages like any other, except it
        cannot be deleted, because SOS reads its roster.

        Idempotent by construction, because this runs on every bootstrap and
        potentially from more than one device at once:

          * The Circle is found before it is created, and migration 159's
            partial unique index makes "two system Circles for one owner"
            unrepresentable if two calls race.
          * Only contacts with NO membership row are inserted. A contact who was
            migrated and then deliberately removed carries a 'removed' row, so
            removing someone sticks instead of being undone on next login.

        `one_location_sms_contacts` is read, never emptied. It stays for one
        release as the record of who each owner picked, so backing this change
        out cannot lose anybody's emergency contacts.
        """

        owner = str(owner_user_id or "").strip()
        if not owner:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_OWNER_REQUIRED",
                "A signed-in owner is required.",
                status_code=403,
            )

        migrated: list[dict[str, Any]] = []
        try:
            with self._db.engine.begin() as conn:
                circle_id = self._find_system_circle_id(conn, owner)
                if not circle_id:
                    circle_id = self._insert_system_circle(conn, owner)
                else:
                    # Only a name this product chose. An owner who renamed
                    # theirs keeps it -- the rename heals our default, it does
                    # not overwrite a person's decision.
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circles
                            SET name = :name, updated_at = NOW()
                            WHERE id = CAST(:circle_id AS UUID)
                              AND name = ANY(:legacy_names)
                            """
                        ),
                        {
                            "circle_id": circle_id,
                            "name": SMS_SYSTEM_CIRCLE_NAME,
                            "legacy_names": list(SMS_SYSTEM_CIRCLE_LEGACY_NAMES),
                        },
                    )
                migrated = self._migrate_sms_contacts_into_circle(conn, owner, circle_id)

                # The owner invited every one of them, so the pair recorded is
                # owner <-> contact and nothing else. Contacts are never
                # introduced to each other -- see `_connect_member_to_circle`,
                # which pairs a joiner with their inviter only.
                for row in migrated:
                    contact_id = str(row.get("user_id") or "").strip()
                    if not contact_id or contact_id == owner:
                        continue
                    for kind, source_circle in (
                        ("circle_member", None),
                        ("named_circle", circle_id),
                    ):
                        ensure_connection_origin(
                            conn,
                            user_a_id=owner,
                            user_b_id=contact_id,
                            kind=kind,
                            source_circle_id=source_circle,
                        )

            if migrated:
                logger.info(
                    "one_location.sms_system_circle_migrated owner=%s count=%d",
                    redact_log_field("user_id", owner),
                    len(migrated),
                )
            return self.get_circle(user_id=owner, circle_id=circle_id)
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("ensure_system", exc) from exc

    @staticmethod
    def _find_system_circle_id(conn: Any, owner_user_id: str) -> str:
        row = _first(
            conn.execute(
                text(
                    """
                    SELECT id
                    FROM one_location_circles
                    WHERE owner_user_id = :owner_user_id
                      AND is_system
                      AND status = 'active'
                    LIMIT 1
                    """
                ),
                {"owner_user_id": owner_user_id},
            )
        )
        return str((row or {}).get("id") or "")

    def _insert_system_circle(self, conn: Any, owner_user_id: str) -> str:
        created = _first(
            conn.execute(
                text(
                    """
                    INSERT INTO one_location_circles (
                      owner_user_id, name, kind, status, member_limit,
                      is_system, created_at, updated_at, metadata
                    )
                    VALUES (
                      :owner_user_id, :name, 'other', 'active',
                      :member_limit, true, NOW(), NOW(), '{}'::jsonb
                    )
                    ON CONFLICT DO NOTHING
                    RETURNING id
                    """
                ),
                {
                    "owner_user_id": owner_user_id,
                    "name": SMS_SYSTEM_CIRCLE_NAME,
                    "member_limit": CIRCLE_DEFAULT_MEMBER_LIMIT,
                },
            )
        )
        circle_id = str((created or {}).get("id") or "")
        if not circle_id:
            # Lost the race with a concurrent bootstrap; the winner's Circle is
            # the one both callers should use.
            circle_id = self._find_system_circle_id(conn, owner_user_id)
        if not circle_id:
            raise RuntimeError("system circle insert returned no id")

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
                ON CONFLICT (circle_id, user_id) DO NOTHING
                """
            ),
            {"circle_id": circle_id, "user_id": owner_user_id},
        )
        return circle_id

    @staticmethod
    def _migrate_sms_contacts_into_circle(
        conn: Any, owner_user_id: str, circle_id: str
    ) -> list[dict[str, Any]]:
        return _all(
            conn.execute(
                text(
                    """
                    INSERT INTO one_location_circle_memberships (
                      circle_id, user_id, role, status, joined_at, updated_at,
                      metadata
                    )
                    SELECT
                      CAST(:circle_id AS UUID), sms.contact_user_id,
                      'member', 'active', NOW(), NOW(),
                      jsonb_build_object('migratedFrom', 'sms_contacts')
                    FROM one_location_sms_contacts sms
                    WHERE sms.owner_user_id = :owner_user_id
                      AND NOT EXISTS (
                        SELECT 1
                        FROM one_location_circle_memberships m
                        WHERE m.circle_id = CAST(:circle_id AS UUID)
                          AND m.user_id = sms.contact_user_id
                      )
                    ON CONFLICT (circle_id, user_id) DO NOTHING
                    RETURNING user_id
                    """
                ),
                {"circle_id": circle_id, "owner_user_id": owner_user_id},
            )
        )

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
        actor_user_id: str,
        circle_id: str,
        rotate: bool = False,
    ) -> dict[str, Any]:
        """Ensure the shared Circle code exists, or rotate it as the owner.

        A normal member request is idempotent and never invalidates a code
        another member may already be sharing. Rotation/revocation remains a
        Circle-owner governance action.
        """

        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            with self._db.engine.begin() as conn:
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              id, owner_user_id, member_limit
                            FROM one_location_circles circle
                            WHERE id = CAST(:circle_id AS UUID)
                              AND status = 'active'
                            FOR UPDATE
                            """
                        ),
                        {"circle_id": cleaned_circle_id},
                    )
                )
                membership_row = (
                    _first(
                        conn.execute(
                            text(
                                """
                                SELECT role
                                FROM one_location_circle_memberships
                                WHERE circle_id = CAST(:circle_id AS UUID)
                                  AND user_id = :actor_user_id
                                  AND status = 'active'
                                FOR UPDATE
                                """
                            ),
                            {
                                "circle_id": cleaned_circle_id,
                                "actor_user_id": actor_user_id,
                            },
                        )
                    )
                    if circle_row
                    else None
                )
                if not circle_row or not membership_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBERSHIP_REQUIRED",
                        "Only an active Circle member can access its invite code.",
                        status_code=403,
                    )
                if rotate and str(circle_row.get("owner_user_id") or "") != actor_user_id:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_OWNER_REQUIRED",
                        "Only the Circle owner can rotate the invite code.",
                        status_code=403,
                    )
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_invite_codes
                        SET status = 'expired', updated_at = NOW()
                        WHERE circle_id = CAST(:circle_id AS UUID)
                          AND status = 'active'
                          AND expires_at <= NOW()
                        """
                    ),
                    {"circle_id": cleaned_circle_id},
                )
                active_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              id, circle_id, code_hash, expires_at, metadata
                            FROM one_location_circle_invite_codes
                            WHERE circle_id = CAST(:circle_id AS UUID)
                              AND status = 'active'
                              AND expires_at > NOW()
                            FOR UPDATE
                            """
                        ),
                        {"circle_id": cleaned_circle_id},
                    )
                )
                active_payload = self._invite_code_payload(active_row)
                if active_payload and not rotate:
                    return active_payload
                if active_row and not rotate:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_CODE_ROTATION_REQUIRED",
                        "Ask the Circle owner to rotate the existing code before it can be shown.",
                        status_code=409,
                    )
                if active_row:
                    # Only an explicit owner rotation can invalidate a code that
                    # other members may already be sharing.
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circle_invite_codes
                            SET status = 'revoked', revoked_at = NOW(),
                                updated_at = NOW()
                            WHERE id = CAST(:invite_id AS UUID)
                              AND status = 'active'
                            """
                        ),
                        {"invite_id": str(active_row.get("id") or "")},
                    )
                invite_id = str(uuid.uuid4())
                display_code = self._code_for_invite_id(invite_id)
                code_hash = self._code_hash(normalize_circle_code(display_code))
                expires_at = datetime.now(timezone.utc) + timedelta(hours=CIRCLE_CODE_TTL_HOURS)
                invite_row = _first(
                    conn.execute(
                        text(
                            """
                            INSERT INTO one_location_circle_invite_codes (
                              id, circle_id, created_by_user_id, code_hash, status,
                              expires_at, max_uses, use_count, created_at,
                              updated_at, metadata
                            )
                            VALUES (
                              CAST(:invite_id AS UUID), CAST(:circle_id AS UUID),
                              :actor_user_id,
                              :code_hash, 'active', :expires_at, :max_uses, 0,
                              NOW(), NOW(), CAST(:metadata AS JSONB)
                            )
                            RETURNING
                              id, circle_id, code_hash, expires_at, metadata
                            """
                        ),
                        {
                            "invite_id": invite_id,
                            "circle_id": cleaned_circle_id,
                            "actor_user_id": actor_user_id,
                            "code_hash": code_hash,
                            "expires_at": expires_at,
                            "max_uses": max(
                                1,
                                int(circle_row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT)
                                - 1,
                            ),
                            "metadata": json.dumps(
                                {"codeVersion": _CIRCLE_CODE_VERSION},
                                separators=(",", ":"),
                            ),
                        },
                    )
                )
            logger.info(
                "one_location.circle_code_%s actor=%s",
                "rotated" if rotate else "created",
                redact_log_field("user_id", actor_user_id),
            )
            payload = self._invite_code_payload(invite_row)
            if not payload:
                raise RuntimeError("Circle invite code insert returned an invalid row.")
            return payload
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("create_code", exc) from exc

    def bootstrap_first_circle(
        self,
        *,
        user_id: str,
        name: str,
    ) -> dict[str, Any]:
        """Find-or-create the caller's own first Circle and return its live code.

        Onboarding needs a shareable code before the vault exists, and the three
        round trips the client used to make (list, create, mint) each required a
        vault owner token. This composes them server-side so onboarding can ask
        once, authenticated by Firebase alone.

        Deliberately the narrowest possible surface: it takes no circle id, so it
        can only ever act on a Circle the caller already owns or one it creates
        for them, and it never rotates -- a caller who already owns a Circle gets
        that Circle and the code it is already sharing. Every other Circle route
        keeps its vault-owner gate.
        """

        owned = next(
            (
                circle
                for circle in self.list_circles(user_id=user_id)
                if str(circle.get("role") or "") == "owner"
            ),
            None,
        )
        circle = owned or self.create_circle(
            owner_user_id=user_id,
            name=name,
            kind="family",
        )
        circle_id = str(circle.get("id") or "")
        if not circle_id:
            raise RuntimeError("Circle bootstrap resolved no circle id.")
        invite = self.create_invite_code(
            actor_user_id=user_id,
            circle_id=circle_id,
            rotate=False,
        )
        return {
            "circleId": circle_id,
            "circleName": str(circle.get("name") or name),
            "code": str(invite.get("code") or ""),
        }

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
                invite_locator = _first(
                    conn.execute(
                        text(
                            """
                            SELECT id, circle_id
                            FROM one_location_circle_invite_codes
                            WHERE code_hash = :code_hash
                            ORDER BY created_at DESC
                            LIMIT 1
                            """
                        ),
                        {"code_hash": code_hash},
                    )
                )
                if not invite_locator:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_CODE_INVALID",
                        "That Circle code is invalid or no longer available.",
                        status_code=404,
                    )
                circle_id = str(invite_locator.get("circle_id") or "")
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT id, owner_user_id, member_limit, status
                            FROM one_location_circles
                            WHERE id = CAST(:circle_id AS UUID)
                            FOR UPDATE
                            """
                        ),
                        {"circle_id": circle_id},
                    )
                )
                if not circle_row or str(circle_row.get("status") or "") != "active":
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_CODE_INVALID",
                        "That Circle code is invalid or no longer available.",
                        status_code=404,
                    )
                self._lock_user_circle_memberships(conn, user_id=user_id)
                invite_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              id, circle_id, status, expires_at,
                              max_uses, use_count, created_by_user_id
                            FROM one_location_circle_invite_codes
                            WHERE id = CAST(:invite_id AS UUID)
                              AND circle_id = CAST(:circle_id AS UUID)
                              AND code_hash = :code_hash
                            FOR UPDATE
                            """
                        ),
                        {
                            "invite_id": str(invite_locator.get("id") or ""),
                            "circle_id": circle_id,
                            "code_hash": code_hash,
                        },
                    )
                )
                now = datetime.now(timezone.utc)
                expires_at = (invite_row or {}).get("expires_at")
                if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if (
                    not invite_row
                    or str(invite_row.get("status") or "") != "active"
                    or not isinstance(expires_at, datetime)
                    or expires_at <= now
                    or int(invite_row.get("use_count") or 0) >= int(invite_row.get("max_uses") or 0)
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_CODE_INVALID",
                        "That Circle code is invalid or no longer available.",
                        status_code=404,
                    )
                invite_row["owner_user_id"] = circle_row.get("owner_user_id")
                invite_row["member_limit"] = circle_row.get("member_limit")
                invite_row["circle_status"] = circle_row.get("status")
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
                    # Whoever generated this code did the inviting, so they are
                    # the one person the joiner becomes connected to.
                    inviter_user_id=str(invite_row.get("created_by_user_id") or ""),
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
            circle = self.get_circle(user_id=user_id, circle_id=circle_id)
            if joined:
                # Best effort, and deliberately after the transaction: the
                # membership is already durable, so a push failure must never
                # undo a join that succeeded. Sending inside the transaction
                # would also notify on a row that could still roll back.
                try:
                    from hushh_mcp.services.push_notifications import (
                        send_circle_code_joined_push,
                    )

                    inviter_user_id = str(invite_row.get("created_by_user_id") or "")
                    # The joiner is now a member, so their display name is
                    # already in the detail payload -- no second lookup, and no
                    # raw identifier in a notification body.
                    joiner_name = next(
                        (
                            str(member.get("displayName") or "").strip()
                            for member in (circle.get("members") or [])
                            if str(member.get("userId") or "") == user_id
                        ),
                        "",
                    )
                    if inviter_user_id and inviter_user_id != user_id:
                        send_circle_code_joined_push(
                            inviter_user_id=inviter_user_id,
                            joiner_display_name=joiner_name or "Someone",
                            circle_id=circle_id,
                            circle_name=str(circle.get("name") or ""),
                        )
                except Exception:
                    logger.warning(
                        "one_location.circle_joined_push_failed circle=%s",
                        circle_id,
                        exc_info=True,
                    )
            return {
                "circle": circle,
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
        actor_user_id: str,
        circle_id: str,
    ) -> list[dict[str, Any]]:
        """List an active member's own connections eligible to invite.

        "Eligible" means an active connection of any provenance. Someone the
        member met through a Circle is a connection — they already appear in
        the connections list and can receive a location share — so excluding
        them here left the member unable to invite the very people a Circle
        introduced them to.
        """

        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            membership_result = self._db.execute_raw(
                """
                SELECT membership.user_id
                FROM one_location_circles circle
                JOIN one_location_circle_memberships membership
                  ON membership.circle_id = circle.id
                 AND membership.user_id = :actor_user_id
                 AND membership.status = 'active'
                WHERE circle.id = CAST(:circle_id AS UUID)
                  AND circle.status = 'active'
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "actor_user_id": actor_user_id,
                },
            )
            if not (membership_result.data or []):
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_MEMBERSHIP_REQUIRED",
                    "Only an active Circle member can invite people.",
                    status_code=403,
                )
            result = self._db.execute_raw(
                """
                SELECT DISTINCT
                  connection.id AS connection_id,
                  CASE
                    WHEN connection.user_a_id = :actor_user_id
                    THEN connection.user_b_id
                    ELSE connection.user_a_id
                  END AS user_id,
                  connection.created_at AS connected_at,
                  identity.display_name, identity.photo_url,
                  identity.custom_photo_url
                FROM one_location_circles circle
                JOIN one_location_circle_memberships actor_membership
                  ON actor_membership.circle_id = circle.id
                 AND actor_membership.user_id = :actor_user_id
                 AND actor_membership.status = 'active'
                JOIN connections connection
                  ON connection.status = 'active'
                 AND (
                   connection.user_a_id = :actor_user_id
                   OR connection.user_b_id = :actor_user_id
                  )
                -- Any live provenance makes someone invitable. A Circle
                -- co-member is a connection — they already appear in the
                -- connections list — so requiring `direct_request` here hid
                -- exactly the people a Circle was meant to introduce.
                JOIN connection_origins origin
                  ON origin.connection_id = connection.id
                 AND origin.status = 'active'
                LEFT JOIN actor_identity_cache identity
                  ON identity.user_id = CASE
                    WHEN connection.user_a_id = :actor_user_id
                    THEN connection.user_b_id
                    ELSE connection.user_a_id
                  END
                WHERE circle.id = CAST(:circle_id AS UUID)
                  AND circle.status = 'active'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM one_location_circle_memberships membership
                    WHERE membership.circle_id = circle.id
                      AND membership.user_id = CASE
                        WHEN connection.user_a_id = :actor_user_id
                        THEN connection.user_b_id
                        ELSE connection.user_a_id
                      END
                      AND (
                        membership.status = 'active'
                        OR (
                          membership.status = 'removed'
                          AND circle.owner_user_id <> :actor_user_id
                        )
                      )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM one_location_circle_member_invites invite
                    WHERE invite.circle_id = circle.id
                      AND invite.invitee_user_id = CASE
                        WHEN connection.user_a_id = :actor_user_id
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
                    "actor_user_id": actor_user_id,
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
        actor_user_id: str,
        circle_id: str,
    ) -> int:
        """Return display-only capacity after active members and pending reservations."""

        cleaned_circle_id = _clean_circle_id(circle_id)
        try:
            result = self._db.execute_raw(
                """
                SELECT
                  circle.owner_user_id, circle.member_limit,
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
                  ,
                  (
                    SELECT COUNT(*)
                    FROM one_location_circle_member_invites invite
                    WHERE invite.circle_id = circle.id
                      AND invite.inviter_user_id = :actor_user_id
                      AND invite.status = 'pending'
                      AND invite.expires_at > NOW()
                  ) AS actor_pending_invite_count
                FROM one_location_circles circle
                JOIN one_location_circle_memberships actor_membership
                  ON actor_membership.circle_id = circle.id
                 AND actor_membership.user_id = :actor_user_id
                 AND actor_membership.status = 'active'
                WHERE circle.id = CAST(:circle_id AS UUID)
                  AND circle.status = 'active'
                """,
                {
                    "circle_id": cleaned_circle_id,
                    "actor_user_id": actor_user_id,
                },
            )
            row = next(iter(result.data or []), None)
            if not row:
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_MEMBERSHIP_REQUIRED",
                    "Only an active Circle member can invite people.",
                    status_code=403,
                )
            reserved = int(row.get("active_member_count") or 0) + int(
                row.get("pending_invite_count") or 0
            )
            circle_remaining = max(
                0,
                int(row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT) - reserved,
            )
            if str(row.get("owner_user_id") or "") == actor_user_id:
                return circle_remaining
            actor_remaining = max(
                0,
                CIRCLE_NON_OWNER_PENDING_INVITE_LIMIT
                - int(row.get("actor_pending_invite_count") or 0),
            )
            return min(circle_remaining, actor_remaining)
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
        expire_stale: bool = True,
    ) -> list[dict[str, Any]]:
        """Return pending incoming invites or authorized outgoing invites."""

        if direction not in {"incoming", "outgoing"}:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_DIRECTION_INVALID",
                "Choose incoming or outgoing Circle invitations.",
                status_code=422,
            )
        cleaned_circle_id = _clean_circle_id(circle_id) if circle_id is not None else None
        try:
            if expire_stale:
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
                     AND circle.status = 'active'
                    JOIN one_location_circle_memberships viewer_membership
                      ON viewer_membership.circle_id = circle.id
                     AND viewer_membership.user_id = :user_id
                     AND viewer_membership.status = 'active'
                    LEFT JOIN actor_identity_cache inviter
                      ON inviter.user_id = invite.inviter_user_id
                    LEFT JOIN actor_identity_cache invitee
                      ON invitee.user_id = invite.invitee_user_id
                    WHERE (
                        CAST(:circle_id AS UUID) IS NULL
                        OR invite.circle_id = CAST(:circle_id AS UUID)
                      )
                      AND (
                        invite.inviter_user_id = :user_id
                        OR circle.owner_user_id = :user_id
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
                    OR invite.inviter_user_id = :user_id
                    OR circle.owner_user_id = :user_id
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
        actor_user_id: str,
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
        if actor_user_id in cleaned_invitee_user_ids:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_SELF_INVALID",
                "You are already in this Circle.",
                status_code=422,
            )
        added_user_ids: list[str] = []
        circle_name = ""
        try:
            with self._db.engine.begin() as conn:
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              circle.id, circle.name, circle.kind,
                              circle.owner_user_id, circle.member_limit,
                              circle.is_system
                            FROM one_location_circles circle
                            WHERE circle.id = CAST(:circle_id AS UUID)
                              AND circle.status = 'active'
                            FOR UPDATE OF circle
                            """
                        ),
                        {"circle_id": cleaned_circle_id},
                    )
                )
                actor_membership_row = (
                    _first(
                        conn.execute(
                            text(
                                """
                                SELECT
                                  actor_membership.role,
                                  actor_identity.display_name AS inviter_display_name
                                FROM one_location_circle_memberships actor_membership
                                LEFT JOIN actor_identity_cache actor_identity
                                  ON actor_identity.user_id = actor_membership.user_id
                                WHERE actor_membership.circle_id =
                                      CAST(:circle_id AS UUID)
                                  AND actor_membership.user_id = :actor_user_id
                                  AND actor_membership.status = 'active'
                                FOR UPDATE OF actor_membership
                                """
                            ),
                            {
                                "circle_id": cleaned_circle_id,
                                "actor_user_id": actor_user_id,
                            },
                        )
                    )
                    if circle_row
                    else None
                )
                if not circle_row or not actor_membership_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBERSHIP_REQUIRED",
                        "Only an active Circle member can invite people.",
                        status_code=403,
                    )
                circle_row["inviter_display_name"] = actor_membership_row.get(
                    "inviter_display_name"
                )
                # Before the connection rows below, not after: see
                # `_lock_invitees`. Everyone named in the request is locked,
                # including anyone who turns out to be ineligible further
                # down -- eligibility is decided after the lock, never by it.
                self._lock_invitees(conn, user_ids=cleaned_invitee_user_ids)
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
                target_membership_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT
                              user_id, status,
                              (
                                status = 'left'
                                AND ended_at IS NOT NULL
                                AND ended_at > NOW() - make_interval(
                                  hours => :reinvite_cooldown_hours
                                )
                              ) AS left_recently
                            FROM one_location_circle_memberships
                            WHERE circle_id = CAST(:circle_id AS UUID)
                              AND user_id = ANY(CAST(:invitee_user_ids AS TEXT[]))
                            ORDER BY user_id
                            FOR UPDATE
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "invitee_user_ids": cleaned_invitee_user_ids,
                            "reinvite_cooldown_hours": (CIRCLE_MEMBER_REINVITE_COOLDOWN_HOURS),
                        },
                    )
                )
                if any(str(row.get("status") or "") == "active" for row in target_membership_rows):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_ALREADY_MEMBER",
                        "One or more selected connections are already in the Circle.",
                        status_code=409,
                    )
                if str(circle_row.get("owner_user_id") or "") != actor_user_id and any(
                    str(row.get("status") or "") == "removed" for row in target_membership_rows
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBERSHIP_REMOVED",
                        "Only the Circle owner can invite someone they previously removed.",
                        status_code=403,
                    )
                # Leaving is that person saying no to this Circle specifically,
                # and it now costs a cooldown the way declining an invitation
                # does. Before adding was immediate, putting them back only
                # produced an invitation they could ignore, so add-leave-add
                # went nowhere. Now it completes -- so without this, leaving
                # could be undone the moment it happened, over and over, by
                # anyone still holding a connection.
                #
                # It binds the OWNER too. Every other rule here protects the
                # Circle from its members; this one protects a person from the
                # Circle, and the owner is who they are leaving.
                if any(bool(row.get("left_recently")) for row in target_membership_rows):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBER_LEFT_RECENTLY",
                        "Someone you selected recently left this Circle. Try again later.",
                        status_code=429,
                    )
                connection_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT
                              connection.id AS connection_id,
                              CASE
                                WHEN connection.user_a_id = :actor_user_id
                                THEN connection.user_b_id
                                ELSE connection.user_a_id
                              END AS user_id,
                              identity.display_name AS invitee_display_name
                            FROM connections connection
                            LEFT JOIN actor_identity_cache identity
                              ON identity.user_id = CASE
                                WHEN connection.user_a_id = :actor_user_id
                                THEN connection.user_b_id
                                ELSE connection.user_a_id
                              END
                            WHERE connection.status = 'active'
                              AND (
                                connection.user_a_id = :actor_user_id
                                OR connection.user_b_id = :actor_user_id
                              )
                              AND CASE
                                WHEN connection.user_a_id = :actor_user_id
                                THEN connection.user_b_id
                                ELSE connection.user_a_id
                              END = ANY(CAST(:invitee_user_ids AS TEXT[]))
                            ORDER BY connection.user_a_id, connection.user_b_id
                            FOR UPDATE OF connection
                            """
                        ),
                        {
                            "actor_user_id": actor_user_id,
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
                        "Every selected person must still be a connection.",
                        status_code=409,
                    )
                connection_ids = [str(row.get("connection_id") or "") for row in connection_rows]
                # Lock whatever provenance keeps each connection alive, of any
                # kind, so a concurrent revoke or Circle-leave cannot slip
                # between this check and the invite write. The kind no longer
                # matters: an active connection is an invitable connection.
                live_origin_rows = _all(
                    conn.execute(
                        text(
                            """
                            SELECT connection_id
                            FROM connection_origins
                            WHERE connection_id =
                                  ANY(CAST(:connection_ids AS UUID[]))
                              AND status = 'active'
                            ORDER BY connection_id
                            FOR UPDATE
                            """
                        ),
                        {"connection_ids": connection_ids},
                    )
                )
                live_origin_connection_ids = {
                    str(row.get("connection_id") or "") for row in live_origin_rows
                }
                if any(
                    connection_id not in live_origin_connection_ids
                    for connection_id in connection_ids
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
                        "Every selected person must still be a connection.",
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
                              invite.created_at, invite.updated_at,
                              invite.responded_at,
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
                              AND (
                                (
                                  invite.status = 'pending'
                                  AND invite.expires_at > NOW()
                                )
                                OR (
                                  invite.status IN (
                                    'declined', 'cancelled', 'expired'
                                  )
                                  AND invite.updated_at >
                                      NOW() - make_interval(
                                        hours => :reinvite_cooldown_hours
                                      )
                                )
                              )
                            ORDER BY invite.invitee_user_id
                            FOR UPDATE OF invite
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "invitee_user_ids": cleaned_invitee_user_ids,
                            "reinvite_cooldown_hours": (CIRCLE_MEMBER_REINVITE_COOLDOWN_HOURS),
                        },
                    )
                )
                pending_rows = [
                    row for row in existing_rows if str(row.get("status") or "") == "pending"
                ]
                # An open invitation used to be a reason to refuse: a second
                # person tapping invite had nothing to add, so it 409'd. Now
                # that tap makes them a member -- exactly the outcome accepting
                # that invitation would have produced -- so the invitation is
                # retired below instead of standing in the way of itself.
                pending_invite_ids = [str(row.get("id") or "") for row in pending_rows]
                # Everyone named here is an active direct connection of the
                # actor; the check above requires it. So everyone named here is
                # added, and nobody is left waiting.
                new_user_ids = list(cleaned_invitee_user_ids)
                if any(
                    str(row.get("invitee_user_id") or "") in new_user_ids
                    and str(row.get("status") or "") in {"declined", "cancelled", "expired"}
                    for row in existing_rows
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_COOLDOWN",
                        "This person recently responded to a Circle invitation. Try again later.",
                        status_code=429,
                    )
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
                              ,
                              (
                                SELECT COUNT(*)
                                FROM one_location_circle_member_invites invite
                                WHERE invite.circle_id =
                                      CAST(:circle_id AS UUID)
                                  AND invite.inviter_user_id = :actor_user_id
                                  AND invite.status = 'pending'
                                  AND invite.expires_at > NOW()
                              ) AS actor_pending_invite_count
                              ,
                              -- Adding is immediate, so counting a member's
                              -- open invitations bounds nothing: they could
                              -- fill someone else's Circle in one tap. What
                              -- replaces it counts the people they actually
                              -- put there who are still there.
                              (
                                SELECT COUNT(*)
                                FROM one_location_circle_memberships membership
                                WHERE membership.circle_id =
                                      CAST(:circle_id AS UUID)
                                  AND membership.status = 'active'
                                  AND membership.metadata->>'addedBy' =
                                      :actor_user_id
                              ) AS actor_added_member_count
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "actor_user_id": actor_user_id,
                        },
                    )
                )
                reserved_count = int((capacity_row or {}).get("active_member_count") or 0) + int(
                    (capacity_row or {}).get("pending_invite_count") or 0
                )
                member_limit = int(circle_row.get("member_limit") or CIRCLE_DEFAULT_MEMBER_LIMIT)
                if (
                    str(circle_row.get("owner_user_id") or "") != actor_user_id
                    and int((capacity_row or {}).get("actor_pending_invite_count") or 0)
                    + int((capacity_row or {}).get("actor_added_member_count") or 0)
                    + len(new_user_ids)
                    > CIRCLE_NON_OWNER_PENDING_INVITE_LIMIT
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_MEMBER_INVITE_LIMIT_REACHED",
                        (
                            "You can add up to "
                            f"{CIRCLE_NON_OWNER_PENDING_INVITE_LIMIT} people to a "
                            "Circle you do not own."
                        ),
                        status_code=409,
                    )
                is_system_circle = bool(circle_row.get("is_system"))
                # The capability flag above shapes the UI; this is the rule.
                # Only the owner may put someone on their emergency list.
                if is_system_circle and str(circle_row.get("owner_user_id") or "") != actor_user_id:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_SYSTEM_OWNER_ONLY",
                        "Only the owner can add people to this Circle.",
                        status_code=403,
                    )
                # Anyone being added who still holds an open invitation is
                # already inside `reserved_count` -- their invitation reserved
                # a seat. Counting them again would refuse a Circle with room
                # in it, on the strength of a seat the same person is about to
                # occupy for real.
                already_reserved = len(
                    {str(row.get("invitee_user_id") or "") for row in pending_rows}
                )
                if (
                    new_user_ids
                    and reserved_count + len(new_user_ids) - already_reserved > member_limit
                ):
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_CAPACITY_REACHED",
                        "This Circle does not have room for everyone you selected.",
                        status_code=409,
                    )
                circle_name = str(circle_row.get("name") or "")
                # Everyone here is already an active connection of the actor,
                # so nobody here needs to be asked a second time: an invitation
                # would put a 72-hour wait in front of a membership two people
                # had already earned the right to. The membership is written
                # now, and what acceptance used to do happens with it.
                for invitee_user_id in sorted(new_user_ids):
                    # Sorted to match the order `_lock_invitees` already took
                    # these people in, so the membership writes cannot reorder
                    # what the locks settled.
                    if not is_system_circle:
                        # A system Circle is exempt from the per-person Circle
                        # budget (`_assert_user_circle_capacity` excludes it),
                        # so being on somebody's emergency list never costs
                        # anyone a Circle of their own.
                        self._assert_user_circle_capacity(
                            conn, user_id=invitee_user_id, adding_other=True
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
                              'active', NOW(), NOW(), NULL,
                              jsonb_build_object(
                                'addedVia', :added_via,
                                'addedBy', :actor_user_id
                              )
                            )
                            ON CONFLICT (circle_id, user_id) DO UPDATE
                            SET role = 'member',
                                status = 'active',
                                joined_at = NOW(),
                                ended_at = NULL,
                                updated_at = NOW(),
                                metadata =
                                  one_location_circle_memberships.metadata
                                  || jsonb_build_object(
                                    'addedVia', :added_via,
                                    'addedBy', :actor_user_id
                                  )
                            """
                        ),
                        {
                            "circle_id": cleaned_circle_id,
                            "user_id": invitee_user_id,
                            "actor_user_id": actor_user_id,
                            "added_via": (
                                "sms_system_circle" if is_system_circle else "direct_add"
                            ),
                        },
                    )
                    if not is_system_circle:
                        # Skipped on a system Circle on purpose: those people
                        # are the owner's existing contacts, and being on an
                        # emergency list is not an introduction to the rest of
                        # it. Everywhere else this is what acceptance wrote --
                        # the Circle-scoped provenance that lets removal revoke
                        # exactly what the Circle authorized, and nothing more.
                        self._connect_member_to_circle(
                            conn,
                            circle_id=cleaned_circle_id,
                            user_id=invitee_user_id,
                            inviter_user_id=actor_user_id,
                        )
                    added_user_ids.append(invitee_user_id)
                if pending_invite_ids:
                    # Whatever invitation was open for these people, the
                    # membership it asked for now exists. Marking it accepted
                    # retires their card truthfully; leaving it pending would
                    # offer them a decision about something already settled.
                    conn.execute(
                        text(
                            """
                            UPDATE one_location_circle_member_invites
                            SET status = 'accepted',
                                responded_at = NOW(),
                                updated_at = NOW(),
                                metadata = COALESCE(metadata, '{}'::jsonb)
                                  || jsonb_build_object('resolvedBy', 'direct_add')
                            WHERE id = ANY(CAST(:invite_ids AS UUID[]))
                              AND status = 'pending'
                            """
                        ),
                        {"invite_ids": pending_invite_ids},
                    )
                logger.info(
                    "one_location.circle_members_added actor=%s circle_system=%s count=%d",
                    redact_log_field("user_id", actor_user_id),
                    is_system_circle,
                    len(added_user_ids),
                )
            if added_user_ids:
                from hushh_mcp.services.feed_service import FeedService
                from hushh_mcp.services.push_notifications import (
                    _lookup_display_name,
                    send_circle_member_added_push,
                )

                # Resolved once, and through the same ladder every other One
                # notification uses -- a raw uid sitting in display_name is
                # rejected in favour of an email handle. Being added to a
                # Circle without being asked is exactly the notification that
                # must never read "Someone".
                adder_label = _lookup_display_name(actor_user_id)
                for member_user_id in added_user_ids:
                    send_circle_member_added_push(
                        member_user_id=member_user_id,
                        added_by_user_id=actor_user_id,
                        added_by_display_name=adder_label,
                        circle_id=cleaned_circle_id,
                        circle_name=circle_name,
                    )
                    # Feed is a best-effort, post-commit projection: the
                    # membership is already durable, so a feed-write failure
                    # must never fail the add that produced it.
                    try:
                        FeedService().record_event(
                            user_id=member_user_id,
                            source_domain="location",
                            event_type="circle_member_added",
                            actor_label=adder_label or None,
                            metadata={
                                "circle_id": cleaned_circle_id,
                                "circle_name": circle_name,
                                "added_by_user_id": actor_user_id,
                                "added_by_label": adder_label,
                            },
                        )
                    except Exception:  # noqa: BLE001 - projection cannot roll back the add
                        logger.exception("one_location.circle_member_added_feed_projection_failed")
            return {
                # This endpoint no longer creates invitations. Both keys stay,
                # always empty, so every caller and client that reads them
                # keeps parsing the same shape it always did.
                "invites": [],
                "createdInviteIds": [],
                "addedUserIds": added_user_ids,
            }
        except OneLocationCircleError:
            raise
        except Exception as exc:
            raise self._safe_db_failure("create_member_invites", exc) from exc

    def create_member_invite(
        self,
        *,
        actor_user_id: str,
        circle_id: str,
        invitee_user_id: str,
    ) -> dict[str, Any]:
        """Compatibility wrapper around the atomic batch add contract.

        Kept for callers that still speak in one person at a time. There is no
        invitation to hand back any more, so `invite` is None and `added` says
        what actually happened.
        """

        result = self.create_member_invites(
            actor_user_id=actor_user_id,
            circle_id=circle_id,
            invitee_user_ids=[invitee_user_id],
        )
        added = list(result.get("addedUserIds") or [])
        return {
            "invite": None,
            "created": False,
            "added": invitee_user_id in added,
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
                invite_locator = _first(
                    conn.execute(
                        text(
                            """
                            SELECT id, circle_id
                            FROM one_location_circle_member_invites
                            WHERE id = CAST(:invite_id AS UUID)
                              AND invitee_user_id = :user_id
                            """
                        ),
                        {"invite_id": cleaned_invite_id, "user_id": user_id},
                    )
                )
                if not invite_locator:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_NOT_FOUND",
                        "Circle invitation not found.",
                        status_code=404,
                    )
                circle_id = str(invite_locator.get("circle_id") or "")
                circle_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT id, owner_user_id, member_limit, status, name, kind
                            FROM one_location_circles
                            WHERE id = CAST(:circle_id AS UUID)
                            FOR UPDATE
                            """
                        ),
                        {"circle_id": circle_id},
                    )
                )
                if not circle_row or str(circle_row.get("status") or "") != "active":
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                        "This Circle invitation is no longer available.",
                        status_code=409,
                    )
                self._lock_user_circle_memberships(conn, user_id=user_id)
                invite_row = _first(
                    conn.execute(
                        text(
                            """
                            SELECT
                              invite.id, invite.circle_id,
                              invite.inviter_user_id, invite.invitee_user_id,
                              invite.status, invite.expires_at,
                              inviter.display_name AS inviter_display_name,
                              invitee.display_name AS invitee_display_name,
                              invite.created_at, invite.responded_at
                            FROM one_location_circle_member_invites invite
                            LEFT JOIN actor_identity_cache inviter
                              ON inviter.user_id = invite.inviter_user_id
                            LEFT JOIN actor_identity_cache invitee
                              ON invitee.user_id = invite.invitee_user_id
                            WHERE invite.id = CAST(:invite_id AS UUID)
                              AND invite.circle_id = CAST(:circle_id AS UUID)
                              AND invite.invitee_user_id = :user_id
                            FOR UPDATE OF invite
                            """
                        ),
                        {
                            "invite_id": cleaned_invite_id,
                            "circle_id": circle_id,
                            "user_id": user_id,
                        },
                    )
                )
                if not invite_row:
                    raise OneLocationCircleError(
                        "LOCATION_CIRCLE_INVITE_NOT_FOUND",
                        "Circle invitation not found.",
                        status_code=404,
                    )
                invite_row["owner_user_id"] = circle_row.get("owner_user_id")
                invite_row["member_limit"] = circle_row.get("member_limit")
                invite_row["circle_status"] = circle_row.get("status")
                invite_row["circle_name"] = circle_row.get("name")
                invite_row["circle_kind"] = circle_row.get("kind")
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
                invite_status = str(invite_row.get("status") or "")
                if invite_status == "accepted":
                    if (
                        str(invite_row.get("circle_status") or "") != "active"
                        or not existing
                        or str(existing.get("status") or "") != "active"
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
                        inviter_user_id=str(invite_row.get("inviter_user_id") or ""),
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
                    if (
                        existing
                        and str(existing.get("status") or "") == "removed"
                        and str(invite_row.get("inviter_user_id") or "")
                        != str(invite_row.get("owner_user_id") or "")
                    ):
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_MEMBERSHIP_REMOVED",
                            "Only the Circle owner can restore this membership.",
                            status_code=403,
                        )
                    inviter_membership = _first(
                        conn.execute(
                            text(
                                """
                                SELECT user_id, role
                                FROM one_location_circle_memberships
                                WHERE circle_id = CAST(:circle_id AS UUID)
                                  AND user_id = :inviter_user_id
                                  AND status = 'active'
                                FOR UPDATE
                                """
                            ),
                            {
                                "circle_id": circle_id,
                                "inviter_user_id": str(invite_row.get("inviter_user_id") or ""),
                            },
                        )
                    )
                    if not inviter_membership:
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE",
                            "The inviter is no longer in this Circle.",
                            status_code=409,
                        )
                    # Transaction lock order is Circle/invite (above), exact
                    # canonical connection, its live origin, then membership.
                    # The origin check runs after the connection lock in a new
                    # statement/snapshot so a relationship revoked concurrently
                    # is observed rather than masked. Any active origin counts:
                    # a Circle co-member is a connection, so a Circle-sourced
                    # provenance is as valid an invitation basis as a direct
                    # request.
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
                    live_origin = _first(
                        conn.execute(
                            text(
                                """
                                SELECT id
                                FROM connection_origins
                                WHERE connection_id =
                                      CAST(:connection_id AS UUID)
                                  AND status = 'active'
                                FOR UPDATE
                                """
                            ),
                            {"connection_id": str(connection_row.get("id") or "")},
                        )
                    )
                    if not live_origin:
                        raise OneLocationCircleError(
                            "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED",
                            "Reconnect before accepting this Circle invitation.",
                            status_code=409,
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
                        inviter_user_id=str(invite_row.get("inviter_user_id") or ""),
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
        actor_user_id: str,
        invite_id: str,
    ) -> bool:
        cleaned_invite_id = _clean_invite_id(invite_id)
        try:
            result = self._db.execute_raw(
                """
                UPDATE one_location_circle_member_invites invite
                SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                FROM one_location_circles circle,
                     one_location_circle_memberships actor_membership
                WHERE invite.id = CAST(:invite_id AS UUID)
                  AND invite.circle_id = circle.id
                  AND actor_membership.circle_id = circle.id
                  AND actor_membership.user_id = :actor_user_id
                  AND actor_membership.status = 'active'
                  AND (
                    invite.inviter_user_id = :actor_user_id
                    OR circle.owner_user_id = :actor_user_id
                  )
                  AND circle.status = 'active'
                  AND invite.status = 'pending'
                RETURNING invite.id
                """,
                {
                    "invite_id": cleaned_invite_id,
                    "actor_user_id": actor_user_id,
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
                JOIN one_location_circle_memberships actor_membership
                  ON actor_membership.circle_id = circle.id
                 AND actor_membership.user_id = :actor_user_id
                 AND actor_membership.status = 'active'
                WHERE invite.id = CAST(:invite_id AS UUID)
                  AND (
                    invite.inviter_user_id = :actor_user_id
                    OR circle.owner_user_id = :actor_user_id
                  )
                """,
                {
                    "invite_id": cleaned_invite_id,
                    "actor_user_id": actor_user_id,
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
        """Preserve grants when an independent relationship still supports them.

        "Independent" excludes `circle_member`. That origin exists *because of*
        a Circle invitation, so it cannot be the reason a Circle-authorized
        grant outlives the Circle — if it were, removing someone from your
        Circle would silently keep their live location running, reattached as a
        connection-scoped share. Removal has one obvious meaning and this keeps
        it: the pair stays connected, the share the Circle authorized ends.

        A `direct_request` (or import/legacy invite) is independent: those two
        people connected on their own terms, so their share survives losing a
        Circle they happened to share.
        """

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
                     AND origin.origin_kind NOT IN (
                       'named_circle', 'circle_member'
                     )
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

    @staticmethod
    def end_memberships_for_disconnected_pair(
        conn: Any,
        *,
        user_a_id: str,
        user_b_id: str,
    ) -> list[dict[str, str]]:
        """Take two people out of each other's Circles when they disconnect.

        Runs on the CALLER's connection so it commits or rolls back with the
        disconnect itself. A membership that outlives the connection is not a
        stale row: `_lock_share_delivery` permits a delivery when there is an
        active non-Circle connection origin OR a shared active Circle, so the
        membership keeps the second arm of that OR true. Someone who removed
        you as a connection would keep receiving your live location, and -- SOS
        reads the system Circle's roster -- your address in an emergency.

        Only Circles OWNED by one of the two are touched. A third person's
        Circle that both happen to be in is left alone: they are both in it
        because that person put them there, and two members falling out is not
        the owner's decision to make. Either can leave it themselves.

        `removed`, not `left`: neither of them chose to go. It also means the
        owner is the only one who can put them back, which is right -- if they
        reconnect, it is the owner's Circle to re-offer.
        """

        user_a = str(user_a_id or "").strip()
        user_b = str(user_b_id or "").strip()
        if not user_a or not user_b or user_a == user_b:
            return []
        ended = _all(
            conn.execute(
                text(
                    """
                    UPDATE one_location_circle_memberships membership
                    SET status = 'removed',
                        ended_at = NOW(),
                        updated_at = NOW(),
                        metadata = COALESCE(membership.metadata, '{}'::jsonb)
                          || jsonb_build_object('endedBy', 'connection_removed')
                    FROM one_location_circles circle
                    WHERE circle.id = membership.circle_id
                      AND circle.status = 'active'
                      AND membership.status = 'active'
                      -- Never the owner's own row. The owner does not leave
                      -- their Circle by falling out with somebody in it.
                      AND membership.role = 'member'
                      AND (
                        (
                          circle.owner_user_id = :user_a
                          AND membership.user_id = :user_b
                        )
                        OR (
                          circle.owner_user_id = :user_b
                          AND membership.user_id = :user_a
                        )
                      )
                    RETURNING
                      membership.circle_id::text AS circle_id,
                      membership.user_id AS user_id
                    """
                ),
                {"user_a": user_a, "user_b": user_b},
            )
        )
        if not ended:
            return []
        for row in ended:
            circle_id = str(row.get("circle_id") or "")
            member_user_id = str(row.get("user_id") or "")
            if not circle_id or not member_user_id:
                continue
            # The same tail `_end_membership` runs, for the same reasons: a
            # shared bearer code the departing member may already know, the
            # invitations they authored, the Circle-scoped provenance, and the
            # grants the Circle authorized.
            conn.execute(
                text(
                    """
                    UPDATE one_location_circle_invite_codes
                    SET status = 'revoked', revoked_at = NOW(),
                        updated_at = NOW()
                    WHERE circle_id = CAST(:circle_id AS UUID)
                      AND status = 'active'
                    """
                ),
                {"circle_id": circle_id},
            )
            conn.execute(
                text(
                    """
                    UPDATE one_location_circle_member_invites
                    SET status = 'cancelled', cancelled_at = NOW(),
                        updated_at = NOW()
                    WHERE circle_id = CAST(:circle_id AS UUID)
                      AND inviter_user_id = :member_user_id
                      AND status = 'pending'
                    """
                ),
                {"circle_id": circle_id, "member_user_id": member_user_id},
            )
            revoke_circle_origins(
                conn,
                circle_id=circle_id,
                member_user_id=member_user_id,
            )
            OneLocationCircleService._reconcile_circle_sourced_grants(
                conn,
                circle_id=circle_id,
                member_user_id=member_user_id,
            )
            OneLocationCircleService._cleanup_ineligible_sms_contacts(
                conn,
                user_id=member_user_id,
            )
        logger.info(
            "one_location.circle_memberships_ended_on_disconnect count=%d",
            len(ended),
        )
        return [
            {
                "circleId": str(row.get("circle_id") or ""),
                "userId": str(row.get("user_id") or ""),
            }
            for row in ended
        ]

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
                # A shared bearer code may already be known by the departing
                # member, so revoke it atomically with the membership change.
                # Remaining members can ensure a fresh code on their next view.
                conn.execute(
                    text(
                        """
                        UPDATE one_location_circle_invite_codes
                        SET status = 'revoked', revoked_at = NOW(),
                            updated_at = NOW()
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
                          AND inviter_user_id = :target_user_id
                          AND status = 'pending'
                        """
                    ),
                    {
                        "circle_id": cleaned_circle_id,
                        "target_user_id": target_user_id,
                    },
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

    def _reject_system_circle_delete(self, circle_id: str) -> None:
        """Refuse deletion of a product-provisioned Circle.

        Deleting the SMS Circle is indistinguishable from silently switching
        emergency alerts off: nothing looks different until the moment it is
        needed. Members stay fully manageable -- only the container is fixed.
        """
        try:
            row = _first(
                self._db.execute_raw(
                    """
                    SELECT is_system
                    FROM one_location_circles
                    WHERE id = CAST(:circle_id AS UUID)
                      AND status = 'active'
                    """,
                    {"circle_id": circle_id},
                ).data
                or []
            )
        except Exception:
            # A read failure here must not become a way to delete: fall through
            # to the statement below, which the trigger still refuses.
            return
        if row and bool(row.get("is_system")):
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_SYSTEM_PROTECTED",
                "This Circle is used for emergency SMS alerts and cannot be deleted. "
                "You can still add or remove its members.",
                status_code=409,
            )

    def delete_circle(self, *, owner_user_id: str, circle_id: str) -> None:
        """Soft-delete an owned Circle. System Circles are refused.

        The database refuses this too (migration 159's trigger), and that is
        the guarantee -- "who may delete this row" is a property of the row, not
        of whichever code path reached it. This check exists so the API answers
        with a 409 and a sentence a person can act on, rather than surfacing a
        raw `restrict_violation` from a trigger as a 500.
        """
        cleaned_circle_id = _clean_circle_id(circle_id)
        self._reject_system_circle_delete(cleaned_circle_id)
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
