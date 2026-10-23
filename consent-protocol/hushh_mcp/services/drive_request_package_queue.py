"""Owning request-package queue and fenced evaluation leases, without model I/O."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_owner_search_store import _identity

MAX_BATCH = 6


def document_ref(position: int) -> str:
    return f"p{position}"


async def due_evaluations(store, limit=2, *, v1_only=False, provider_only=False):
    if (
        type(limit) is not int
        or not 1 <= limit <= 20
        or type(v1_only) is not bool
        or type(provider_only) is not bool
        or v1_only
        and provider_only
    ):
        raise ValueError("invalid evaluation limit")
    provider_filter = (
        """
        AND EXISTS(SELECT 1 FROM drive_packet_heads h
          WHERE h.packet_id=r.reusable_packet_id AND h.user_id=r.user_id
            AND h.packet_kind='provider_discovery')
    """
        if provider_only
        else ""
    )

    def operation(connection):
        rows = [
            dict(row)
            for row in connection.execute(
                text(
                    """WITH due AS (
                  SELECT j.job_id FROM drive_owner_search_jobs j
                  JOIN drive_share_requests r ON r.request_id=j.client_request_id
                    AND r.user_id=j.user_id
                  WHERE j.status='completed' AND j.incomplete_search=FALSE
                    AND r.agent_package_required=TRUE
                    AND (:v1_only=FALSE OR j.v1_statement_search=TRUE)
                    AND j.evaluation_status IN ('pending','running')
                    AND j.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
                    AND r.status='pending' AND r.access_stop_requested_at IS NULL
                    AND j.evaluation_next_at<=clock_timestamp()
                    AND (j.lease_id IS NULL OR j.lease_expires_at<=clock_timestamp())
                    AND NOT EXISTS(SELECT 1 FROM drive_bulk_shares b
                      WHERE b.user_id=j.user_id AND b.origin_request_id=r.request_id)
                    AND NOT EXISTS(SELECT 1 FROM drive_request_payment_orders o
                      WHERE o.request_id=r.request_id)
                  """
                    + provider_filter
                    + """
                  ORDER BY j.inspected_at,j.created_at,j.job_id
                  LIMIT :limit FOR UPDATE OF j SKIP LOCKED)
                UPDATE drive_owner_search_jobs j SET inspected_at=clock_timestamp()
                FROM due WHERE j.job_id=due.job_id RETURNING j.user_id,j.job_id"""
                ),
                {"limit": limit, "v1_only": v1_only},
            ).mappings()
        ]
        result = []
        for item in rows:
            request = store._row(
                connection,
                """SELECT r.* FROM drive_share_requests r JOIN drive_owner_search_jobs j
                  ON j.client_request_id=r.request_id AND j.user_id=r.user_id
                  WHERE j.job_id=:job AND j.user_id=:user""",
                {"job": item["job_id"], "user": item["user_id"]},
            )
            if (
                request
                and store.sharing._open_request(request).get("agent_package_required") is True
            ):
                result.append(item)
        return result

    return await store._transaction(operation)


def _evaluation_candidates(
    store, connection, row, checkpoint, request, user_id, identity, batch_size
):
    purpose = store.sharing._open_request(request)["purpose"]
    priority = store._v1_priority(connection, row, checkpoint, purpose)
    counts = (
        connection.execute(
            text("""SELECT count(*) AS remaining,
            count(*) FILTER (WHERE position=ANY(CAST(:priority AS integer[]))) AS prioritized
            FROM drive_owner_search_results
            WHERE user_id=:user AND job_id=:job AND evaluated_at IS NULL"""),
            {"user": user_id, "job": identity, "priority": priority},
        )
        .mappings()
        .one()
    )
    limit = min(batch_size, counts["prioritized"]) if counts["prioritized"] else batch_size
    candidates = []
    for candidate in connection.execute(
        text("""SELECT position,file_digest,metadata_envelope
            FROM drive_owner_search_results WHERE user_id=:user AND job_id=:job
            AND evaluated_at IS NULL
            ORDER BY array_position(CAST(:priority AS integer[]),position) NULLS LAST,
              position LIMIT :limit"""),
        {"user": user_id, "job": identity, "limit": limit, "priority": priority},
    ).mappings():
        position = candidate["position"]
        candidates.append(
            {
                "position": position,
                "document_ref": document_ref(position),
                "file_digest": candidate["file_digest"],
                "metadata": store.search_cipher.open(
                    candidate["metadata_envelope"],
                    user_id=user_id,
                    resource_id=f"{identity}:{position}",
                    purpose="owner-search-result",
                ),
            }
        )
    if checkpoint.get("evidence_route") in {"index", "hybrid"}:
        retained, budget = [], 0
        for candidate in candidates:
            size = candidate["metadata"].get("indexedEvidenceBytes", 128 * 1024)
            if retained and budget + size > 128 * 1024:
                break
            retained.append(candidate)
            budget += size
        candidates = retained
    return purpose, candidates, counts


def _claim_evaluation_locked(
    store, connection, *, user_id, identity, batch_size, v1_only, provider_only
):
    initial = store._owned(connection, user_id, identity)
    if provider_only and store._checkpoint(initial).get("provider_packet") is not True:
        return None
    if v1_only and initial["v1_statement_search"] is not True:
        return None
    request_id = str(initial["client_request_id"])
    store._gate(
        connection,
        user_id=user_id,
        request_id=request_id,
        generation=initial["connection_generation"],
    )
    row = store._owned(connection, user_id, identity, locked=True)
    if provider_only and store._checkpoint(row).get("provider_packet") is not True:
        return None
    if v1_only and row["v1_statement_search"] is not True:
        return None
    now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
    if (
        row["evaluation_status"] not in {"pending", "running"}
        or row["evaluation_next_at"] > now
        or row["lease_expires_at"] is not None
        and row["lease_expires_at"] > now
    ):
        return None
    request, checkpoint = store._request_current(connection, row)
    purpose, candidates, counts = _evaluation_candidates(
        store, connection, row, checkpoint, request, user_id, identity, batch_size
    )
    lease = str(uuid4())
    connection.execute(
        text("""UPDATE drive_owner_search_jobs SET evaluation_status='running',
            lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '120 seconds',
            evaluation_error_code=NULL,updated_at=clock_timestamp() WHERE job_id=:job"""),
        {"job": identity, "lease": lease},
    )
    return {
        "user_id": user_id,
        "job_id": identity,
        "request_id": request_id,
        "request_revision": request["revision"],
        "generation": row["connection_generation"],
        "lease_id": lease,
        "purpose": purpose,
        "checkpoint": checkpoint,
        "candidates": candidates,
        "remaining": counts["remaining"] - len(candidates),
        "candidate_count": row["matched"],
        "v1_statement_search": row["v1_statement_search"] is True,
    }


async def claim_evaluation(
    store, *, user_id, job_id, batch_size=MAX_BATCH, v1_only=False, provider_only=False
):
    if (
        type(batch_size) is not int
        or not 1 <= batch_size <= MAX_BATCH
        or type(v1_only) is not bool
        or type(provider_only) is not bool
        or v1_only
        and provider_only
    ):
        raise ValueError("invalid evaluation batch size")
    identity = _identity(job_id)

    return await store._transaction(
        lambda connection: _claim_evaluation_locked(
            store,
            connection,
            user_id=user_id,
            identity=identity,
            batch_size=batch_size,
            v1_only=v1_only,
            provider_only=provider_only,
        )
    )
