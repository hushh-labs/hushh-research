"""Generation-bound Firebase SDK writes, without retaining SDK values or secrets.

Dispatch commits before HTTP. Uncertainty blocks replacement enrollment until
reconciled; expiry never authorizes another SDK call. The caller supplies the
captured application owner, never a freshly resolved owner for an old job.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, Literal, TypeVar
from uuid import uuid4

from google.auth.transport.requests import AuthorizedSession
from requests.adapters import HTTPAdapter
from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_user_hash,
    settle_cleanup_database_call,
)
from hushh_mcp.services.account_generation_service import (
    AccountGenerationRefused,
    AccountGenerationService,
)

logger = logging.getLogger(__name__)
T = TypeVar("T")
Purpose = Literal[
    "display_name", "welcome_marker", "phone_unlink", "sso_claims", "sso_create", "sso_offboarding"
]
_IDENTITY_ORIGIN = "https://identitytoolkit.googleapis.com"
_RESPONSE_LIMIT = 32 * 1024


class FirebaseMutationTransportError(RuntimeError):
    """A remote mutation is unconfirmed; contains no provider body or values."""


class FirebaseMutationRejected(RuntimeError):
    """Explicit local refusal before a provider mutation is sent."""


def _update_identity(app, firebase_uid: str, fields: dict) -> None:
    """One physical administrator POST, using the supported Identity Platform API.

    Firebase Admin's default client retries mutation POSTs after read/status
    failures. Use an owned session rather than changing that shared SDK client.
    https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/update
    """
    project = str(getattr(app, "project_id", ""))
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,62}", project) or not 1 <= len(firebase_uid) <= 128:
        raise ValueError("identity mutation configuration invalid")
    if set(fields) not in (
        {"displayName"},
        {"customAttributes"},
        {"customAttributes", "validSince"},
        {"customAttributes", "validSince", "disableUser"},
    ) and not (set(fields) == {"deleteProvider"} and fields["deleteProvider"] == ["phone"]):
        raise ValueError("identity mutation fields invalid")
    with AuthorizedSession(app.credential.get_credential(), max_refresh_attempts=0) as session:
        session.trust_env = False
        session.mount("https://", HTTPAdapter(max_retries=0))
        session.mount("http://", HTTPAdapter(max_retries=0))
        with session.post(
            f"{_IDENTITY_ORIGIN}/v1/projects/{project}/accounts:update",
            json={"localId": firebase_uid, **fields},
            timeout=4,
            allow_redirects=False,
            stream=True,
        ) as response:
            if response.status_code != 200:
                raise FirebaseMutationTransportError("identity mutation outcome unconfirmed")
            body = bytearray()
            for chunk in response.iter_content(chunk_size=4096):
                body.extend(chunk)
                if len(body) > _RESPONSE_LIMIT:
                    raise FirebaseMutationTransportError("identity mutation outcome unconfirmed")
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeError):
                raise FirebaseMutationTransportError(
                    "identity mutation outcome unconfirmed"
                ) from None
            if not isinstance(payload, dict) or payload.get("localId") != firebase_uid:
                raise FirebaseMutationTransportError("identity mutation outcome unconfirmed")


def set_display_name(app, firebase_uid: str, value: str) -> None:
    _update_identity(app, firebase_uid, {"displayName": value})


def set_welcome_claims(app, firebase_uid: str, claims: dict) -> None:
    value = json.dumps(claims, separators=(",", ":"), allow_nan=False)
    if len(value.encode("utf-8")) > 1000:
        raise ValueError("identity claims exceed provider bound")
    _update_identity(app, firebase_uid, {"customAttributes": value})


def has_independent_signin(user) -> bool:
    return any(
        getattr(provider, "provider_id", "")
        in {"google.com", "apple.com", "password", "microsoft.com"}
        for provider in (getattr(user, "provider_data", None) or [])
    )


def unlink_phone(app, firebase_uid: str, expected_phone: str) -> None:
    from firebase_admin import auth

    from api.utils.firebase_admin import assert_firebase_identity_mutation_allowed

    assert_firebase_identity_mutation_allowed(app)
    user = auth.get_user(firebase_uid, app=app)
    if user.phone_number is None:
        return
    if user.phone_number != expected_phone:
        raise FirebaseMutationTransportError("phone identity changed")
    if not has_independent_signin(user):
        raise FirebaseMutationTransportError("independent recovery required")
    _update_identity(app, firebase_uid, {"deleteProvider": ["phone"]})
    if auth.get_user(firebase_uid, app=app).phone_number is not None:
        raise FirebaseMutationTransportError("phone unlink unconfirmed")


@dataclass(frozen=True, slots=True)
class FirebaseMutationPermit:
    operation_id: str
    owner_hash: str
    identity_hash: str
    settlement_nonce: str
    firebase_uid: str


@dataclass(frozen=True, slots=True)
class FirebaseMutationResult(Generic[T]):
    value: T
    settled: bool


async def reserve_phone_unlink(
    conn,
    *,
    owner_id: str,
    identity_uid: str,
    generation: int,
    authority_project: str,
    proof_owner_id: str,
    reserve: bool = True,
) -> FirebaseMutationPermit | None:
    """Reserve the exact verified proof identity in the binding transaction.

    Unlike a profile write, possession of the phone authorizes unlinking only
    that credential. The caller holds all account lifecycle barriers and has
    consumed the owner-bound, fresh-proof transfer intent.
    """
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,62}", authority_project):
        raise ValueError("identity mutation configuration invalid")
    identity_hash = account_deletion_user_hash(identity_uid)
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,199))", identity_hash)
    current = await conn.fetchrow(
        "SELECT generation,retired_at,owner_id FROM account_generations WHERE identity_hash=$1 ORDER BY generation DESC LIMIT 1",
        identity_hash,
    )
    if (
        current
        and (
            current["retired_at"] is not None
            or current["generation"] != generation
            or current["owner_id"] != proof_owner_id
        )
    ) or (not current and (generation != 0 or proof_owner_id != identity_uid)):
        raise AccountGenerationRefused("identity_generation_changed")
    if not reserve:
        return None
    permit = FirebaseMutationPermit(
        str(uuid4()),
        account_deletion_user_hash(owner_id),
        identity_hash,
        str(uuid4()),
        identity_uid,
    )
    await conn.execute(
        """INSERT INTO account_firebase_mutations
        (operation_id,owner_hash,identity_hash,authority_project,purpose,settlement_nonce)
        VALUES($1::uuid,$2,$3,$4,'phone_unlink',$5::uuid)""",
        permit.operation_id,
        permit.owner_hash,
        identity_hash,
        authority_project,
        permit.settlement_nonce,
    )
    return permit


def begin(
    owner_id: str, *, purpose: Purpose, authority_project: str
) -> FirebaseMutationPermit | None:
    if purpose not in {
        "display_name",
        "welcome_marker",
        "phone_unlink",
        "sso_claims",
        "sso_create",
        "sso_offboarding",
    } or not re.fullmatch(r"[a-z][a-z0-9-]{4,62}", authority_project):
        raise ValueError("identity mutation configuration invalid")
    owner_hash = account_deletion_user_hash(owner_id)
    with get_db_connection() as conn:
        conn.execute(text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
        conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
        conn.execute(text("SET LOCAL lock_timeout='3000ms'"))
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=(owner_id,))
        if conn.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash=:owner)"
            ),
            {"owner": owner_hash},
        ).scalar_one():
            raise AccountGenerationRefused("account_retired")
        installed = conn.execute(
            text("SELECT to_regclass('public.account_firebase_mutations') IS NOT NULL")
        ).scalar_one()
        if installed is not True:
            # Compatibility while generation zero still owns the environment.
            # Deployment must drain these consumers before enabling enrollment.
            if (
                installed is not False
                or purpose.startswith("sso_")
                or re.fullmatch(r"acct_[0-9a-f]{32}", owner_id)
                or (os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() == "true")
            ):
                raise AccountGenerationRefused("generation_schema_unavailable")
            return None
        firebase_uid = AccountGenerationService.identity_in_transaction(conn, owner_id)
        if purpose.startswith("sso_") and firebase_uid != owner_id:
            raise AccountGenerationRefused("sso_replacement_enrollment_unsupported")
        identity_hash = account_deletion_user_hash(firebase_uid)
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:identity,199))"),
            {"identity": identity_hash},
        )
        permit = FirebaseMutationPermit(
            str(uuid4()), owner_hash, identity_hash, str(uuid4()), firebase_uid
        )
        conn.execute(
            text("""INSERT INTO account_firebase_mutations
            (operation_id,owner_hash,identity_hash,authority_project,purpose,settlement_nonce)
            VALUES(CAST(:operation AS uuid),:owner,:identity,:project,:purpose,CAST(:nonce AS uuid))"""),
            {
                "operation": permit.operation_id,
                "owner": owner_hash,
                "identity": identity_hash,
                "project": authority_project,
                "purpose": purpose,
                "nonce": permit.settlement_nonce,
            },
        )
    return permit


def settle(
    permit: FirebaseMutationPermit, outcome: Literal["succeeded", "rejected", "uncertain"]
) -> None:
    if outcome not in {"succeeded", "rejected", "uncertain"}:
        raise ValueError("identity mutation outcome invalid")
    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='5000ms'"))
        conn.execute(text("SET LOCAL lock_timeout='3000ms'"))
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:identity,199))"),
            {"identity": permit.identity_hash},
        )
        changed = conn.execute(
            text("""UPDATE account_firebase_mutations SET state=:outcome,
            settled_at=CASE WHEN :outcome='uncertain' THEN NULL ELSE clock_timestamp() END
            WHERE operation_id=CAST(:operation AS uuid) AND owner_hash=:owner
             AND identity_hash=:identity AND settlement_nonce=CAST(:nonce AS uuid)
             AND state IN ('dispatched','uncertain') RETURNING operation_id"""),
            {
                "operation": permit.operation_id,
                "owner": permit.owner_hash,
                "identity": permit.identity_hash,
                "nonce": permit.settlement_nonce,
                "outcome": outcome,
            },
        ).first()
        if changed is None:
            raise AccountGenerationRefused("identity_mutation_settlement_changed")


def _run(
    owner_id: str, purpose: Purpose, authority_project: str, operation: Callable[[str], T]
) -> FirebaseMutationResult[T]:
    permit = begin(owner_id, purpose=purpose, authority_project=authority_project)
    try:
        value = operation(permit.firebase_uid if permit else owner_id)
    except FirebaseMutationRejected:
        if permit:
            settle(permit, "rejected")
        raise
    except Exception:
        if permit:
            try:
                settle(permit, "uncertain")
            except Exception:
                logger.warning("identity.mutation.settlement_pending")
        # Transport exceptions may follow acceptance. Never assert rejection
        # or retry merely from a generic exception or an HTTP status.
        raise FirebaseMutationTransportError("identity mutation outcome unconfirmed") from None
    if permit:
        try:
            settle(permit, "succeeded")
        except Exception:
            logger.warning("identity.mutation.settlement_pending")
            return FirebaseMutationResult(value, settled=False)
    return FirebaseMutationResult(value, settled=True)


async def run(
    owner_id: str, *, purpose: Purpose, authority_project: str, operation: Callable[[str], T]
) -> FirebaseMutationResult[T]:
    # Join dispatch, SDK call and receipt together even if HTTP is cancelled.
    return await settle_cleanup_database_call(_run, owner_id, purpose, authority_project, operation)


def _execute_prepared(
    permit: FirebaseMutationPermit, operation: Callable[[str], T]
) -> FirebaseMutationResult[T]:
    try:
        value = operation(permit.firebase_uid)
    except Exception:
        settle(permit, "uncertain")
        raise FirebaseMutationTransportError("identity mutation outcome unconfirmed") from None
    settle(permit, "succeeded")
    return FirebaseMutationResult(value, settled=True)


async def run_prepared(
    permit: FirebaseMutationPermit, operation: Callable[[str], T]
) -> FirebaseMutationResult[T]:
    return await settle_cleanup_database_call(_execute_prepared, permit, operation)
