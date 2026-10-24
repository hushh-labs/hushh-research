"""Environment-local ownership admission; never remap retained work to a new owner.

Firebase UID is an external identity. An application owner is the immutable
generation captured when a request is admitted. Only this HTTP identity boundary
may select a current owner. Jobs, consent tokens and callbacks keep their original
owner, and continue through the existing tombstone admission checks.

Re-enrollment is not enabled by this module. Its public route, frontend principal
split, custom-auth bindings and generation-aware deployment must be qualified
together before an owner can activate a replacement.
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_user_hash,
)


class AccountGenerationRefused(RuntimeError):
    """The verified identity cannot admit the requested application generation."""


@dataclass(frozen=True, slots=True)
class AccountPrincipal:
    firebase_uid: str
    owner_id: str
    generation: int


def _auth_time(claims: Mapping[str, Any]) -> int:
    value = claims.get("auth_time")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise AccountGenerationRefused("fresh_identity_required")
    return value


def _uid(claims: Mapping[str, Any]) -> str:
    value = claims.get("uid")
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or value != value.strip():
        raise AccountGenerationRefused("identity_binding_invalid")
    return value


def validate_principal(
    claims: Mapping[str, Any], row: Mapping[str, Any] | None, *, lane: str, now: float | None = None
) -> AccountPrincipal:
    """Use claims already verified for signature, issuer, audience and revocation."""
    identity = _uid(claims)
    if row is None:
        # Compatibility is limited to generation zero. The caller must still
        # run its ordinary account-tombstone check before issuing authority.
        return AccountPrincipal(identity, identity, 0)
    if row["retired_at"] is not None:
        raise AccountGenerationRefused("account_retired")
    generation = row["generation"]
    owner = row["owner_id"]
    if (
        not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 0
        or not isinstance(owner, str)
        or not owner
        or row["identity_hash"] != account_deletion_user_hash(identity)
        or row["identity_uid"] != identity
        or row["owner_hash"] != account_deletion_user_hash(owner)
    ):
        raise AccountGenerationRefused("identity_binding_invalid")
    if generation:
        authenticated_at = _auth_time(claims)
        if authenticated_at <= row["admitted_after"] or authenticated_at > (
            time.time() if now is None else now
        ):
            raise AccountGenerationRefused("generation_reauthentication_required")
        firebase = claims.get("firebase")
        provider = firebase.get("sign_in_provider") if isinstance(firebase, Mapping) else None
        # Exchanging an old custom token gives it a fresh auth_time. Require
        # that token's captured application owner AND environment, never just
        # its new issue/authentication time. Global Firebase claims are unused.
        if provider == "custom":
            if (
                claims.get("hussh_account_owner") != owner
                or claims.get("hussh_account_lane") != lane
            ):
                raise AccountGenerationRefused("custom_generation_binding_required")
        elif provider not in {"google.com", "apple.com", "microsoft.com", "password"}:
            raise AccountGenerationRefused("generation_authentication_unsupported")
    return AccountPrincipal(identity, owner, generation)


class AccountGenerationService:
    """One SQL authority, shared by lifecycle and authenticated admission."""

    @staticmethod
    def identity_in_transaction(conn, owner_id: str) -> str:
        """Map the captured owner while its caller holds lifecycle barriers.

        The generation schema must already be installed. Never use this map
        alone to authorize a later external-identity mutation.
        """
        row = (
            conn.execute(
                text(
                    "SELECT identity_uid,owner_id,retired_at FROM account_generations WHERE owner_hash=:owner_hash"
                ),
                {"owner_hash": account_deletion_user_hash(owner_id)},
            )
            .mappings()
            .first()
        )
        if row is not None:
            if (
                row["retired_at"] is not None
                or row["owner_id"] != owner_id
                or not row["identity_uid"]
            ):
                raise AccountGenerationRefused("account_retired")
            return row["identity_uid"]
        if re.fullmatch(r"acct_[0-9a-f]{32}", owner_id):
            raise AccountGenerationRefused("generation_binding_missing")
        return owner_id

    @staticmethod
    def resolve_verified_identity(claims: Mapping[str, Any], *, lane: str) -> AccountPrincipal:
        identity = _uid(claims)
        with get_db_connection() as conn:
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            # A genuinely older schema supports generation zero only. Query
            # failure is never treated as schema absence or legacy eligibility.
            installed = conn.execute(
                text("SELECT to_regclass('public.account_generations') IS NOT NULL")
            ).scalar_one()
            row = None
            if installed is True:
                row = (
                    conn.execute(
                        text("""SELECT * FROM account_generations WHERE identity_hash=:identity_hash
                    ORDER BY generation DESC LIMIT 1"""),
                        {"identity_hash": account_deletion_user_hash(identity)},
                    )
                    .mappings()
                    .first()
                )
            elif installed is not False:
                raise AccountGenerationRefused("generation_schema_unavailable")
        return validate_principal(claims, row, lane=lane)

    @staticmethod
    def firebase_identity_for_owner(owner_id: str) -> str:
        """Map an exact active owner for SDK reads, never UID→latest owner.

        This return value is NOT authority for a deferred SDK mutation. Such a
        mutation needs a generation-bound dispatch/settlement boundary observed
        by retirement; replacements remain disabled until that path qualifies.
        """
        if AccountDeletionLifecycleService.is_tombstoned(owner_id):
            raise AccountGenerationRefused("account_retired")
        with get_db_connection() as conn:
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            installed = conn.execute(
                text("SELECT to_regclass('public.account_generations') IS NOT NULL")
            ).scalar_one()
            if installed is True:
                return AccountGenerationService.identity_in_transaction(conn, owner_id)
            if installed is not False:
                raise AccountGenerationRefused("generation_schema_unavailable")
        # Opaque replacement IDs cannot enter legacy fallback, even if a row
        # is missing. Existing Firebase UIDs retain their exact value.
        if re.fullmatch(r"acct_[0-9a-f]{32}", owner_id):
            raise AccountGenerationRefused("generation_binding_missing")
        return owner_id

    @staticmethod
    def custom_session_binding(owner_id: str, *, lane: str) -> tuple[str, dict[str, str]]:
        """Stamp captured authority, never infer a latest owner at token exchange.

        A mint completing after retirement still names the retired owner; the
        replacement-generation verifier refuses it even with a new auth_time.
        These are custom-token claims, not global Firebase user claims.
        """
        if not re.fullmatch(r"[a-z0-9_-]{1,32}", lane):
            raise AccountGenerationRefused("generation_lane_invalid")
        identity = AccountGenerationService.firebase_identity_for_owner(owner_id)
        return identity, {"hussh_account_owner": owner_id, "hussh_account_lane": lane}

    @staticmethod
    def start_fresh(
        claims: Mapping[str, Any],
        *,
        previous_generation: int,
        cleanup_operation: str,
        enrollment_operation: str,
        now: float | None = None,
    ) -> AccountPrincipal:
        """Explicit enrollment after exact cleanup and independently fresh sign-in.

        Generic custom tokens, including device/passkey/review tokens, cannot
        authorize enrollment. Email custom enrollment needs a separate
        purpose-bound challenge and does not enter this federated port.
        """
        identity = _uid(claims)
        authenticated_at = _auth_time(claims)
        current_time = time.time() if now is None else now
        firebase = claims.get("firebase")
        provider = firebase.get("sign_in_provider") if isinstance(firebase, Mapping) else None
        if (
            provider not in {"google.com", "apple.com", "microsoft.com"}
            or authenticated_at < current_time - 300
            or authenticated_at > current_time
            or isinstance(previous_generation, bool)
            or not isinstance(previous_generation, int)
            or previous_generation < 0
        ):
            raise AccountGenerationRefused("fresh_identity_required")
        cleanup, enrollment = str(UUID(cleanup_operation)), str(UUID(enrollment_operation))
        with get_db_connection() as conn:
            conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
            conn.execute(text("SET LOCAL lock_timeout='3000ms'"))
            result = conn.execute(
                text("""SELECT public.enroll_account_generation(:identity,:previous,
                CAST(:cleanup AS uuid),CAST(:enrollment AS uuid),:authenticated_at)"""),
                {
                    "identity": identity,
                    "previous": previous_generation,
                    "cleanup": cleanup,
                    "enrollment": enrollment,
                    "authenticated_at": authenticated_at,
                },
            ).scalar_one()
        if not isinstance(result, dict):
            raise AccountGenerationRefused("generation_enrollment_not_ready")
        return AccountPrincipal(identity, result["owner_id"], result["generation"])
