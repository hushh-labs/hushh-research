"""Dev account retirement transfers existing cleanup custody, never claims absence."""

from __future__ import annotations

import logging

from sqlalchemy import text

from hushh_mcp.runtime_settings import get_app_runtime_settings, get_firebase_credential_settings

logger = logging.getLogger(__name__)


class CloudRetirementReviewRequired(RuntimeError):
    def __init__(self, review: dict):
        super().__init__("Review the retained cloud cleanup before deleting this account")
        self.review = review

    def result(self) -> dict:
        from hushh_mcp.services.account_personal_agent_erasure import (
            PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
        )

        return {
            "success": False,
            "account_deleted": False,
            "error_code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
            "cleanup_provider": "user_gcp",
            "cloud_cleanup": {
                "state": "pending",
                "operation_id": self.review["operation_id"],
                "next_check_at": None,
                "owner_action_required": True,
                "retirement_review": self.review,
            },
        }


def _selected_dev() -> bool:
    return (
        get_app_runtime_settings().environment == "dev"
        and get_firebase_credential_settings().auth_project_id == "hushh-pda-dev"
    )


def available(conn) -> bool:
    if not _selected_dev():
        return False
    installed = conn.execute(
        text(
            "SELECT to_regprocedure('public.account_cloud_retirement_contract_version()') IS NOT NULL"
        )
    ).scalar_one()
    if installed is True:
        from db.hosted_custody_adoption import _successor_qualification
        from db.hosted_custody_qualification import (
            DEV_CUSTODY_DATABASE,
            DEV_CUSTODY_PRINCIPAL,
            DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
        )
        from db.legacy_cloud_removal_adoption import qualification_sql

        identity = conn.execute(
            text("""SELECT current_database(),current_user,session_user,
          encode(sha256(convert_to(system_identifier::text,'UTF8')),'hex') FROM pg_control_system()""")
        ).one()
        if tuple(identity) != (
            DEV_CUSTODY_DATABASE,
            DEV_CUSTODY_PRINCIPAL,
            DEV_CUSTODY_PRINCIPAL,
            DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
        ):
            raise RuntimeError("cloud retirement connected database is not qualified Dev")
        conn.execute(text(qualification_sql(resume_required=True)))
        conn.execute(text(_successor_qualification()))
    return installed is True


def review_in_transaction(conn, owner: str) -> dict | None:
    """Caller holds existing lifecycle locks; no provider request is made here."""
    if not available(conn):
        return None
    rows = (
        conn.execute(
            text("""SELECT attempt_id,recovery->>'planSha256' AS plan_sha256,
          recovery->'plan'->'project' AS project,
          (SELECT count(*) FROM jsonb_array_elements(recovery->'plan'->'resources') item
            WHERE item->>'authority' IS DISTINCT FROM 'retain_shared') AS resource_count
        FROM personal_agent_cloud_removals WHERE user_id=:owner
         AND completed_at IS NULL AND cancelled_at IS NULL
         AND public.account_cloud_retirement_ready(user_id,attempt_id)
        FOR UPDATE"""),
            {"owner": owner},
        )
        .mappings()
        .all()
    )
    if not rows:
        return None
    if len(rows) != 1:
        raise RuntimeError("multiple cloud cleanup operations require reconciliation")
    row = rows[0]
    return {
        "operation_id": row["attempt_id"],
        "plan_sha256": row["plan_sha256"],
        "project_id": row["project"]["projectId"],
        "project_number": row["project"]["projectNumber"],
        "resource_count": row["resource_count"],
    }


def bind_in_transaction(conn, *, owner: str, cleanup_id: str, review: dict) -> None:
    retained = conn.execute(
        text(
            "SELECT public.retain_account_cloud_retirement(:owner,CAST(:cleanup AS uuid),:digest)"
        ),
        {"owner": owner, "cleanup": cleanup_id, "digest": review["plan_sha256"]},
    ).scalar_one()
    if retained is not True:
        raise RuntimeError("cloud retirement review changed before custody transfer")


def review_for_owner(owner: str) -> dict | None:
    if not _selected_dev():
        return None
    from db.db_client import get_db_connection
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'"))
        AccountDeletionLifecycleService._lock_user_ids_in_transaction(conn, user_ids=(owner,))
        return review_in_transaction(conn, owner)


def local_erasure_ready(conn, owner: str) -> bool:
    return (
        available(conn)
        and conn.execute(
            text("SELECT public.account_cloud_retirement_local_erasure_ready(:owner)"),
            {"owner": owner},
        ).scalar_one()
        is True
    )


def summary_in_transaction(
    conn, owner: str | None = None, *, owner_hash: str | None = None, cleanup_id: str | None = None
) -> dict | None:
    if not available(conn):
        return None
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    if owner is not None:
        owner_hash = account_deletion_user_hash(owner)
    if not owner_hash or (owner is None and cleanup_id is None):
        raise ValueError("cleanup summary needs an exact retained operation")
    row = (
        conn.execute(
            text("""SELECT attempt_id,completed_at,
          (SELECT min(e->'receipt'->'coverage'->>'nextEligibleAt') FROM (
            SELECT DISTINCT ON (value->>'resource') value AS e
             FROM jsonb_array_elements(c.recovery->'events') WITH ORDINALITY x(value,n)
             WHERE value->>'stage'='observation' ORDER BY value->>'resource',n DESC
           ) latest WHERE e->'receipt'->>'status'='waiting_for_provider') AS next_check
        FROM personal_agent_cloud_removals c WHERE
          'sha256:'||encode(sha256(convert_to(user_id,'UTF8')),'hex')=:owner_hash
          AND retirement_handoff IS NOT NULL
          AND (:cleanup_id IS NULL OR retirement_handoff->>'cleanupOperation'=:cleanup_id)
          AND public.account_cloud_retirement_handoff_valid(user_id,retirement_handoff)
        ORDER BY created_at DESC LIMIT 1"""),
            {"owner_hash": owner_hash, "cleanup_id": cleanup_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return {
        "state": "completed" if row["completed_at"] else "pending",
        "operation_id": row["attempt_id"],
        "next_check_at": None if row["completed_at"] else row["next_check"],
        "owner_action_required": False,  # This is the retained operator continuation, not new owner consent.
    }


def cleanup_credential(recovery: dict) -> str:
    """Borrow only the bootstrap authority already named in the original plan."""
    from hushh_mcp.services.legacy_cloud_removal import _require
    from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token

    resources = [r for r in recovery["plan"]["resources"] if r["type"] == "bootstrap_access"]
    _require(len(resources) == 1 and resources[0]["authority"] == "owner_reviewed")
    return mint_bootstrap_token(bootstrap_sa=resources[0]["id"])


def verify_cleanup_authority(recovery: dict, reservation: dict) -> None:
    from hushh_mcp.services.legacy_cloud_removal import _require
    from hushh_mcp.services.legacy_cloud_removal_native import RecoverySession, verify_retired_plan

    token = cleanup_credential(recovery)
    project = recovery["plan"]["project"]["projectId"]
    with RecoverySession(token=token, project=project) as session:
        verify_retired_plan(session, reservation=reservation, recovery=recovery)
        permissions = {
            "cloudkms.cryptoKeyVersions.destroy",
            "cloudkms.cryptoKeyVersions.list",
            "resourcemanager.projects.getIamPolicy",
            "resourcemanager.projects.setIamPolicy",
            "iam.serviceAccounts.get",
            "iam.serviceAccounts.delete",
        }
        response = session.post(
            f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:testIamPermissions",
            json={"permissions": sorted(permissions)},
        )
        _require(
            response.status_code == 200
            and set(response.json().get("permissions", [])) == permissions,
            "CLOUD_REMOVAL_INDEPENDENT_AUTHORITY_UNAVAILABLE",
        )


def verify_reviewed_authority(owner: str, digest: str) -> None:
    """No account retirement without usable independent cleanup credentials."""
    from db.db_client import get_db_connection
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    with get_db_connection() as conn:
        AccountDeletionLifecycleService._lock_user_ids_in_transaction(conn, user_ids=(owner,))
        review = review_in_transaction(conn, owner)
        if review is None or review["plan_sha256"] != digest:
            raise RuntimeError("cloud retirement review changed")
        row = (
            conn.execute(
                text("""SELECT recovery,
          public.account_cloud_retirement_reservation(user_id,attempt_id) AS reservation
          FROM personal_agent_cloud_removals WHERE user_id=:owner AND attempt_id=:attempt"""),
                {"owner": owner, "attempt": review["operation_id"]},
            )
            .mappings()
            .one()
        )
        recovery, reservation = row["recovery"], row["reservation"]
    try:
        verify_cleanup_authority(recovery, reservation)
    except Exception as exc:
        logger.warning(
            "account_cloud_retirement.authority_unavailable error=%s", type(exc).__name__
        )
        # This is a definite pre-admission refusal. Preserve the account and its
        # normal cleanup/reconnection interface; never claim an uncertain DELETE.
        raise CloudRetirementReviewRequired(review) from exc
