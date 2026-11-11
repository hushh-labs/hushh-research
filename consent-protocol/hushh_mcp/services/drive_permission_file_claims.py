"""One existing durable file fence shared by all permission mutation lanes."""

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError


def _owner(*, operation=None, share=None, position=None, recipient=None, removal=None):
    return {
        "operation": operation,
        "share": share,
        "position": position,
        "recipient": recipient,
        "removal": removal,
    }


def has_unclaimed_uncertainty(connection):
    return connection.execute(
        text("""SELECT EXISTS(
        SELECT 1 FROM drive_bulk_share_effects e WHERE (e.state IN ('dispatching','unknown') OR (e.state='failed' AND e.safe_error_code='permission_outcome_unknown'))
          AND NOT EXISTS(SELECT 1 FROM drive_share_file_claims c WHERE c.bulk_share_id=e.share_id AND c.bulk_position=e.position AND c.bulk_recipient_user_id=e.recipient_user_id)
        UNION ALL SELECT 1 FROM drive_request_bulk_removals r WHERE r.state IN ('dispatching','unknown')
          AND NOT EXISTS(SELECT 1 FROM drive_share_file_claims c WHERE c.removal_id=r.removal_id))""")
    ).scalar_one()


def claim_file(connection, lock, *, reconcile=False, **owner):
    params = {"lock": lock, **_owner(**owner)}
    # Upgrade fence: old uncertain writes must adopt a keyed claim through GET-only
    # reconciliation before any fresh writer can overtake their missing claim.
    if not reconcile and has_unclaimed_uncertainty(connection):
        return False
    result = connection.execute(
        text("""INSERT INTO drive_share_file_claims AS c
        (file_lock_hmac,operation_id,bulk_share_id,bulk_position,bulk_recipient_user_id,removal_id)
        VALUES (:lock,:operation,:share,:position,:recipient,:removal)
        ON CONFLICT(file_lock_hmac) DO UPDATE SET file_lock_hmac=EXCLUDED.file_lock_hmac
        WHERE c.erased_at IS NULL AND ROW(c.operation_id,c.bulk_share_id,c.bulk_position,c.bulk_recipient_user_id,c.removal_id)
        IS NOT DISTINCT FROM ROW(EXCLUDED.operation_id,EXCLUDED.bulk_share_id,EXCLUDED.bulk_position,EXCLUDED.bulk_recipient_user_id,EXCLUDED.removal_id)
        RETURNING file_lock_hmac"""),
        params,
    ).first()
    if result:
        return True
    fence = connection.execute(
        text("SELECT erased_at FROM drive_share_file_claims WHERE file_lock_hmac=:lock"), params
    ).scalar_one_or_none()
    if fence is not None:
        raise DriveSharingError("permission_requires_google_management")
    return False


def require_file_claim(connection, lock, **owner):
    if (
        connection.execute(
            text("""SELECT 1 FROM drive_share_file_claims WHERE file_lock_hmac=:lock AND erased_at IS NULL
        AND operation_id IS NOT DISTINCT FROM CAST(:operation AS uuid)
        AND bulk_share_id IS NOT DISTINCT FROM CAST(:share AS uuid)
        AND bulk_position IS NOT DISTINCT FROM CAST(:position AS integer)
        AND bulk_recipient_user_id IS NOT DISTINCT FROM CAST(:recipient AS text)
        AND removal_id IS NOT DISTINCT FROM CAST(:removal AS uuid)"""),
            {"lock": lock, **_owner(**owner)},
        ).first()
        is None
    ):
        raise DriveSharingError("permission_job_superseded")


def seed_uncertain_claims(connection, cipher, *, participant=None, limit=10000):
    """Adopt existing sealed uncertainty without OAuth reads or provider writes.

    Used before erasure and by release preflight. Conflicting claims are never
    stolen; the transaction refuses until the operator reconciles that conflict.
    """
    rows = (
        connection.execute(
            text("""SELECT e.share_id,e.position,e.recipient_user_id,b.user_id,
        f.metadata_envelope,f.source_job_id,f.source_position FROM drive_bulk_share_effects e
        JOIN drive_bulk_shares b ON b.share_id=e.share_id
        JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
        WHERE (e.state IN ('dispatching','unknown') OR (e.state='failed' AND e.safe_error_code='permission_outcome_unknown'))
        AND (:participant IS NULL OR b.user_id=:participant OR e.recipient_user_id=:participant)
        AND NOT EXISTS(SELECT 1 FROM drive_share_file_claims c WHERE c.bulk_share_id=e.share_id AND c.bulk_position=e.position AND c.bulk_recipient_user_id=e.recipient_user_id)
        ORDER BY e.share_id,e.position,e.recipient_user_id LIMIT :limit FOR UPDATE OF e"""),
            {"participant": participant, "limit": limit + 1},
        )
        .mappings()
        .all()
    )
    if len(rows) > limit:
        raise DriveSharingError("permission_claim_adoption_limit")
    adopted = 0
    for row in rows:
        file = cipher.open(
            row["metadata_envelope"],
            user_id=row["user_id"],
            resource_id=f"{row['source_job_id']}:{row['source_position']}",
            purpose="owner-search-result",
        )
        if not claim_file(
            connection,
            cipher.file_lock(file["id"]),
            share=str(row["share_id"]),
            position=row["position"],
            recipient=row["recipient_user_id"],
            reconcile=True,
        ):
            raise DriveSharingError("permission_requires_google_management")
        adopted += 1
    rows = (
        connection.execute(
            text("""SELECT r.* FROM drive_request_bulk_removals r
        WHERE r.state IN ('dispatching','unknown') AND (:participant IS NULL OR r.user_id=:participant OR r.recipient_user_id=:participant)
        AND NOT EXISTS(SELECT 1 FROM drive_share_file_claims c WHERE c.removal_id=r.removal_id)
        ORDER BY r.removal_id LIMIT :limit FOR UPDATE OF r"""),
            {"participant": participant, "limit": limit + 1},
        )
        .mappings()
        .all()
    )
    if len(rows) > limit:
        raise DriveSharingError("permission_claim_adoption_limit")
    for row in rows:
        plan = cipher.open(
            row["plan_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["removal_id"]),
            purpose="bulk-removal-plan",
        )
        if not claim_file(
            connection,
            cipher.file_lock(plan["file_id"]),
            removal=str(row["removal_id"]),
            reconcile=True,
        ):
            raise DriveSharingError("permission_requires_google_management")
        adopted += 1
    return adopted
