"""Pinned Firebase erasure within the existing account-deletion journal.

Only fresh, explicitly isolated Dev requests are admitted. Historical requests
retain their original policy. A dispatched request is never replayed.
"""

from __future__ import annotations

import json
import logging
from uuid import uuid4

from google.auth.transport.requests import AuthorizedSession
from requests.adapters import HTTPAdapter
from sqlalchemy import text

from api.utils.firebase_admin import (
    assert_firebase_identity_mutation_allowed,
    get_firebase_auth_app,
)
from db.db_client import get_db_connection
from hushh_mcp.runtime_settings import get_app_runtime_settings, get_firebase_credential_settings

logger = logging.getLogger(__name__)


def selected_project(conn) -> str | None:
    selected = get_firebase_credential_settings().auth_project_id
    if not selected:
        return None
    # Later environments require their own qualified schema and rollout.
    if selected != "hushh-pda-dev" or get_app_runtime_settings().environment != "dev":
        raise RuntimeError("isolated Firebase erasure environment is not qualified")
    installed = conn.execute(
        text(
            "SELECT to_regprocedure('public.account_firebase_erasure_contract_version()') IS NOT NULL"
        )
    ).scalar_one()
    if (
        installed is not True
        or conn.execute(
            text("SELECT public.account_firebase_erasure_contract_version()")
        ).scalar_one()
        != 1
    ):
        raise RuntimeError("isolated Firebase erasure contract is required")
    return selected


def prepare_authority(conn, *, owner: str, identity: str, cleanup_id: str) -> dict | None:
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    selected = selected_project(conn)
    if selected is None:
        return None
    identity_hash = account_deletion_user_hash(identity)
    conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:identity,199))"),
        {"identity": identity_hash},
    )
    row = (
        conn.execute(
            text("""SELECT generation,owner_id,identity_uid,retired_at
        FROM account_generations WHERE identity_hash=:identity
        ORDER BY generation DESC LIMIT 1"""),
            {"identity": identity_hash},
        )
        .mappings()
        .first()
    )
    if (
        row
        and (
            row["owner_id"] != owner
            or row["identity_uid"] != identity
            or row["retired_at"] is not None
        )
    ) or (not row and owner != identity):
        raise RuntimeError("isolated Firebase erasure owner changed")
    if (
        conn.execute(
            text("SELECT public.account_firebase_mutations_settled(:identity)"),
            {"identity": identity_hash},
        ).scalar_one()
        is not True
    ):
        raise RuntimeError("identity mutation needs reconciliation")
    return {
        "version": 1,
        "projectId": selected,
        "identityHash": identity_hash,
        "ownerHash": account_deletion_user_hash(owner),
        "accountGeneration": row["generation"] if row else 0,
        "cleanupId": cleanup_id,
    }


def phone_intent_project(uid: str, phone_digest: str) -> str | None:
    """A historical phone intent never inherits the selected Auth realm."""
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    with get_db_connection() as conn:
        return conn.execute(
            text("""SELECT to_jsonb(t)->>'firebase_cleanup_project'
            FROM account_deletion_tombstones t WHERE user_id_hash=:identity
              AND firebase_uid=:uid AND cleanup_intent_kind='phone_orphan'
              AND expected_phone_digest=:phone_digest AND cleanup_status<>'completed'"""),
            {"identity": account_deletion_user_hash(uid), "uid": uid, "phone_digest": phone_digest},
        ).scalar_one_or_none()


def insert_phone_intents(conn, *, user_ids: tuple[str, ...], phone_digest: str) -> bool | None:
    """None keeps legacy insertion; isolated inserts pin their own realm."""
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    project = selected_project(conn)
    if project is None:
        return None
    persisted = True
    for uid in user_ids:
        result = conn.execute(
            text("""INSERT INTO account_deletion_tombstones
            (user_id_hash,firebase_uid,cleanup_intent_kind,expected_phone_digest,cleanup_status,
             cleanup_next_attempt_at,deleted_at,updated_at,firebase_cleanup_project)
            VALUES(:identity,:uid,'phone_orphan',:phone_digest,'pending',now()+interval '1 minute',now(),now(),:project)
            ON CONFLICT(user_id_hash) DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid,
             expected_phone_digest=EXCLUDED.expected_phone_digest,cleanup_status='pending',
             cleanup_next_attempt_at=EXCLUDED.cleanup_next_attempt_at,cleanup_claimed_at=NULL,
             cleanup_claim_token=NULL,cleanup_last_outcome=NULL,cleanup_last_failure_class=NULL,
             cleanup_last_classification=NULL,updated_at=now()
            WHERE account_deletion_tombstones.cleanup_intent_kind='phone_orphan'
             AND account_deletion_tombstones.cleanup_status='completed'
             AND account_deletion_tombstones.firebase_cleanup_project=EXCLUDED.firebase_cleanup_project"""),
            {
                "identity": account_deletion_user_hash(uid),
                "uid": uid,
                "phone_digest": phone_digest,
                "project": project,
            },
        )
        persisted = result.rowcount == 1 and persisted
    return persisted


def _checkpoint(claim, *, update: dict | None = None) -> dict:
    from hushh_mcp.services import account_deletion_provider_journal as journal

    with get_db_connection() as conn:
        journal._lock_claim(conn, claim)
        row = (
            conn.execute(
                text("""SELECT firebase_erasure_authority,firebase_erasure_checkpoint
            FROM account_deletion_tombstones WHERE user_id_hash=:owner_hash"""),
                journal._parameters(claim),
            )
            .mappings()
            .one()
        )
        if row["firebase_erasure_authority"] != claim.firebase_erasure_authority:
            raise journal.ProviderCleanupClaimLost("Firebase erasure authority changed")
        if update is not None:
            # SQL checks the exact lease, settled provider inventory, mutation
            # fence and monotonic transition; provider calls stay outside SQL.
            conn.execute(
                text("""UPDATE account_deletion_tombstones SET
                firebase_erasure_checkpoint=CAST(:checkpoint AS jsonb),updated_at=now()
                WHERE user_id_hash=:owner_hash"""),
                {**journal._parameters(claim), "checkpoint": json.dumps(update)},
            )
            return update
        return row["firebase_erasure_checkpoint"]


def _read_identity(app, uid: str):
    from firebase_admin import auth

    try:
        return auth.get_user(uid, app=app)
    except auth.UserNotFoundError:
        return None


def _delete_once(app, uid: str) -> None:
    """One physical POST, following account_firebase_mutations transport policy."""
    with AuthorizedSession(app.credential.get_credential(), max_refresh_attempts=0) as session:
        session.trust_env = False
        session.mount("https://", HTTPAdapter(max_retries=0))
        session.mount("http://", HTTPAdapter(max_retries=0))
        with session.post(
            f"https://identitytoolkit.googleapis.com/v1/projects/{app.project_id}/accounts:delete",
            json={"localId": uid},
            timeout=4,
            allow_redirects=False,
            stream=True,
        ) as response:
            if response.status_code != 200:
                raise RuntimeError("Firebase erasure request outcome unconfirmed")


async def ensure_identity_absent(claim) -> None:
    from hushh_mcp.services import account_deletion_provider_journal as journal
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        account_deletion_user_hash,
    )
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        settle_cleanup_database_call as join,
    )

    authority = claim.firebase_erasure_authority
    if authority is None:
        return
    if (
        authority.get("projectId") != "hushh-pda-dev"
        or authority.get("identityHash") != account_deletion_user_hash(claim.firebase_uid)
        or authority.get("ownerHash") != account_deletion_user_hash(claim.owner_id)
        or authority.get("cleanupId") != claim.cleanup_id
    ):
        raise journal.ProviderCleanupNotReady("Firebase erasure authority mismatch")
    app = get_firebase_auth_app()
    assert_firebase_identity_mutation_allowed(app)
    if app.project_id != authority["projectId"]:
        raise journal.ProviderCleanupNotReady("Firebase erasure project changed")
    checkpoint = await join(_checkpoint, claim)
    if checkpoint["state"] == "absent":
        return
    user = await join(_read_identity, app, claim.firebase_uid)
    if user is not None and checkpoint["state"] == "prepared":
        if user.uid != claim.firebase_uid:
            raise journal.ProviderCleanupNotReady("Firebase identity changed")
        checkpoint = {
            "state": "dispatched",
            "requestId": str(uuid4()),
            "identityCreatedAt": user.user_metadata.creation_timestamp,
        }
        await join(_checkpoint, claim, update=checkpoint)
        try:
            await join(_delete_once, app, claim.firebase_uid)
        except Exception as exc:
            # An uncertain POST is reconciled by readback, never sent again.
            logger.warning(
                "account_deletion.firebase_request_unconfirmed error=%s", type(exc).__name__
            )
        user = await join(_read_identity, app, claim.firebase_uid)
    if user is not None:
        raise journal.ProviderCleanupNotReady("Firebase erasure needs native reconciliation")
    await join(
        _checkpoint,
        claim,
        update={**checkpoint, "state": "absent", "observation": "USER_NOT_FOUND"},
    )
