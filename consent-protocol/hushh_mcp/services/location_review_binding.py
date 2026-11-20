"""Lock the exact live share shown during an explicit extension review."""

from typing import Any, NoReturn

from sqlalchemy import text


def lock_reviewed_extension(
    service: Any, *, owner: str, requester: str, request: dict, reviewed: dict
) -> dict | None:
    if str(request.get("extends_grant_id") or "") != str(reviewed.get("grant_id") or ""):
        return None
    conn = service._key_writer_connection
    # Preserve Circle -> membership -> grant lock ordering. Never acquire a
    # grant row before the relationship that authorizes its replacement.
    service._lock_circle_share_eligibility(
        conn, owner_user_id=owner, recipient_user_id=requester, requested_circle_id=None
    )
    row = (
        conn.execute(
            text("""SELECT * FROM one_location_share_grants
      WHERE id=CAST(:grant AS UUID) AND owner_user_id=:owner AND recipient_user_id=:requester
        AND status='active' AND (expires_at IS NULL OR expires_at>clock_timestamp())
        AND expires_at IS NOT DISTINCT FROM CAST(:expires AS timestamptz)
        AND COALESCE(metadata->>'share_kind','share')<>'sos' FOR UPDATE"""),
            {
                "grant": reviewed["grant_id"],
                "owner": owner,
                "requester": requester,
                "expires": reviewed.get("expires_at"),
            },
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


def reviewed_request_share(
    service: Any,
    *,
    request_row: dict,
    owner_user_id: str,
    requester_user_id: str,
    expected_requester_user_id: str,
    expected_request_revision: int | None,
    reviewed_extension: dict | None,
    automatic: bool,
) -> dict | None:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

    if requester_user_id != expected_requester_user_id or (
        expected_request_revision is not None
        and int(request_row.get("request_revision") or 1) != expected_request_revision
    ):
        raise OneLocationAgentError(
            "LOCATION_REQUEST_CHANGED",
            "This request changed. Review it again.",
            status_code=409,
        )
    reviewed_live_share = None
    if reviewed_extension is not None and expected_request_revision is not None and not automatic:
        from hushh_mcp.services.location_review_binding import lock_reviewed_extension

        reviewed_live_share = lock_reviewed_extension(
            service,
            owner=owner_user_id,
            requester=requester_user_id,
            request=request_row,
            reviewed=reviewed_extension,
        )
        if reviewed_live_share is None:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_CHANGED",
                "The share changed. Review it again.",
                status_code=409,
            )
    if (
        expected_request_revision is not None
        and request_row.get("extends_grant_id")
        and reviewed_live_share is None
    ):
        # Command receipts do not yet pin the mutable grant used by
        # extension arithmetic. Keep those approvals on the authored
        # review screen; never widen a confirmed timed command here.
        raise OneLocationAgentError(
            "LOCATION_EXTENSION_REVIEW_REQUIRED",
            "Review this extension against the current share before approving it.",
            status_code=409,
        )
    return reviewed_live_share


def reject_stale_denial(
    service: Any, *, owner_user_id: str, request_id: str, expected_request_revision: int | None
) -> NoReturn:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

    existing = service._execute_one(
        """
        SELECT status, expires_at, request_revision,
               (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS request_expired
        FROM one_location_access_requests
        WHERE id = CAST(:request_id AS UUID)
          AND owner_user_id = :owner_user_id
        LIMIT 1
        """,
        {"owner_user_id": owner_user_id, "request_id": request_id},
    )
    if (
        existing
        and expected_request_revision is not None
        and int(existing.get("request_revision") or 1) != expected_request_revision
    ):
        raise OneLocationAgentError(
            "LOCATION_REQUEST_CHANGED",
            "This request changed. Review it again.",
            status_code=409,
        )
    if existing and (
        str(existing.get("status") or "") == "expired" or bool(existing.get("request_expired"))
    ):
        raise OneLocationAgentError(
            "LOCATION_REQUEST_EXPIRED",
            "This location request has expired.",
            status_code=410,
        )
    raise OneLocationAgentError(
        "LOCATION_REQUEST_NOT_FOUND",
        "Pending location access request was not found.",
        status_code=404,
    )
