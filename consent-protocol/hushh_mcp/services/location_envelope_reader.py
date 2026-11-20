"""Ciphertext reads recheck current grant and key in the same SQL snapshot."""

from typing import Any


def read_latest_envelope(
    service: Any, *, recipient_user_id: str, grant_id: str, allow_empty: bool = False
) -> dict[str, Any]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

    service._expire_stale_grants(recipient_user_id)
    grant_row = _authorized_grant(service, recipient_user_id, grant_id)
    row = service._execute_one(
        """
        SELECT latest.*
        FROM one_location_share_grants access
        LEFT JOIN LATERAL (
          SELECT * FROM one_location_envelopes envelope
          WHERE envelope.grant_id=access.id AND envelope.recipient_user_id=access.recipient_user_id
            AND envelope.recipient_key_id=access.recipient_key_id
          ORDER BY envelope.created_at DESC LIMIT 1
        ) latest ON TRUE
        WHERE access.id=CAST(:grant_id AS UUID) AND access.recipient_user_id=:recipient_user_id
          AND access.status='active' AND (access.expires_at IS NULL OR access.expires_at>clock_timestamp())
          AND EXISTS(SELECT 1 FROM one_location_recipient_keys key
            WHERE key.user_id=access.recipient_user_id AND key.key_id=access.recipient_key_id AND key.status='active')
        """,
        {"recipient_user_id": recipient_user_id, "grant_id": grant_id},
    )
    if row is None:
        raise OneLocationAgentError(
            "LOCATION_GRANT_NOT_ACTIVE", "Location share is no longer active.", status_code=410
        )
    if not row.get("id"):
        # "The share is live, the owner just hasn't published a point yet"
        # is a normal state on the happy path — the recipient opens One the
        # moment they are granted access, before the owner's first GPS fix
        # lands. Callers that opt in get that as a success with a null
        # envelope so it never surfaces as a failed request; callers that
        # do not keep the original 404 contract they already branch on.
        if allow_empty:
            return {
                "grant": service._grant_payload(grant_row),
                "envelope": None,
                "status": "awaiting_first_publish",
            }
        raise OneLocationAgentError(
            "LOCATION_ENVELOPE_MISSING",
            "The owner has not published an encrypted location envelope yet.",
            status_code=404,
        )
    service._insert_event(
        owner_user_id=str(grant_row.get("owner_user_id") or ""),
        actor_user_id=recipient_user_id,
        recipient_user_id=recipient_user_id,
        grant_id=grant_id,
        envelope_id=str(row.get("id") or "") or None,
        event_type="location_share_viewed",
        metadata={"status": "ciphertext_returned"},
    )
    return {
        "grant": service._grant_payload(grant_row),
        "envelope": service._envelope_payload(row),
        "status": "published",
    }


def _authorized_grant(service: Any, recipient_user_id: str, grant_id: str) -> dict[str, Any]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

    grant_row: dict[str, Any] | None = service._execute_one(
        """
        SELECT
          g.*,
          owner.display_name AS owner_display_name,
          owner.phone_number AS owner_phone_number,
          EXISTS (
            SELECT 1
            FROM one_location_recipient_keys active_key
            WHERE active_key.user_id = g.recipient_user_id
              AND active_key.key_id = g.recipient_key_id
              AND active_key.status = 'active'
          ) AS recipient_key_active
        FROM one_location_share_grants g
        LEFT JOIN actor_identity_cache owner ON owner.user_id = g.owner_user_id
        WHERE g.id = CAST(:grant_id AS UUID)
          AND g.recipient_user_id = :recipient_user_id
        LIMIT 1
        """,
        {"recipient_user_id": recipient_user_id, "grant_id": grant_id},
    )
    if not grant_row:
        raise OneLocationAgentError(
            "LOCATION_GRANT_NOT_FOUND", "No approved location share was found.", status_code=404
        )
    if str(grant_row.get("status") or "") != "active":
        raise OneLocationAgentError(
            "LOCATION_GRANT_NOT_ACTIVE", "Location share is not active.", status_code=410
        )
    if not bool(grant_row.get("recipient_key_active")):
        raise OneLocationAgentError(
            "LOCATION_GRANT_NOT_ACTIVE",
            "The secure recipient key changed. Ask the owner to share again.",
            status_code=410,
        )
    return grant_row
