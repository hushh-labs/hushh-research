"""Circle grant provenance reconciliation preserves independent access."""

from typing import Any

from sqlalchemy import text

DETACH_INDEPENDENT_GRANTS = """
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

REHOME_CIRCLE_GRANTS = """
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

REVOKE_CIRCLE_GRANTS = """
                WITH revoked AS (UPDATE one_location_share_grants share_grant
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE share_grant.source_circle_id = CAST(:circle_id AS UUID)
                  AND share_grant.status = 'active'
                  AND (
                    CAST(:member_user_id AS TEXT) IS NULL
                    OR share_grant.owner_user_id = :member_user_id
                    OR share_grant.recipient_user_id = :member_user_id
                  )
                RETURNING share_grant.id,share_grant.owner_user_id,share_grant.recipient_user_id,to_jsonb(share_grant)->'metadata' AS metadata
                ) INSERT INTO one_location_events(owner_user_id,actor_user_id,recipient_user_id,grant_id,event_type,metadata)
                SELECT owner_user_id,CAST(:event_actor AS TEXT),recipient_user_id,id,'location_share_revoked',
                  jsonb_build_object('reason',CAST(:cause AS TEXT),'circle_id',CAST(:circle_id AS TEXT),
                    'share_kind',COALESCE(metadata->>'share_kind','share'),
                    'counterpart_label',(SELECT left(a.display_name,160) FROM actor_identity_cache a WHERE a.user_id=revoked.recipient_user_id))
                FROM revoked
                """


def reconcile_circle_grants(
    conn: Any,
    *,
    circle_id: str,
    member_user_id: str | None = None,
    actor_user_id: str | None = None,
    cause: str = "circle_membership_ended",
) -> None:
    if cause not in {"circle_membership_ended", "circle_deleted", "connection_disconnected"}:
        raise ValueError("Unknown Circle grant transition")
    params = {"circle_id": circle_id, "member_user_id": str(member_user_id or "").strip() or None}
    conn.execute(text(DETACH_INDEPENDENT_GRANTS), params)
    conn.execute(text(REHOME_CIRCLE_GRANTS), params)
    conn.execute(
        text(REVOKE_CIRCLE_GRANTS), {**params, "event_actor": actor_user_id, "cause": cause}
    )


def end_membership_invitations(conn: Any, *, circle_id: str, member_user_id: str) -> None:
    """Revoke the departed member's bearer code and authored pending invites."""
    conn.execute(
        text("""UPDATE one_location_circle_invite_codes
        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
        WHERE circle_id = CAST(:circle_id AS UUID) AND status = 'active'"""),
        {"circle_id": circle_id},
    )
    conn.execute(
        text("""UPDATE one_location_circle_member_invites
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE circle_id = CAST(:circle_id AS UUID)
          AND inviter_user_id = :target_user_id AND status = 'pending'"""),
        {"circle_id": circle_id, "target_user_id": member_user_id},
    )


def end_circle_access(
    conn: Any,
    *,
    circle_id: str,
    actor_user_id: str | None,
    cause: str,
    origin_revoke: Any,
    grant_reconcile: Any,
    member_user_id: str | None = None,
    sms_cleanup: Any = None,
    owner_user_id: str | None = None,
    system_kind: str | None = None,
    sms_record: Any = None,
    affected_members: Any = (),
) -> None:
    if system_kind == "sms":
        if sms_record is None or owner_user_id is None or member_user_id is None:
            raise ValueError("SMS membership transition needs its locked relationship")
        sms_record(
            conn,
            owner_user_id=owner_user_id,
            contact_user_id=member_user_id,
            added=False,
            actor_user_id=actor_user_id,
        )
        conn.execute(
            text("""DELETE FROM one_location_sms_contacts
            WHERE owner_user_id=:owner AND contact_user_id=:contact"""),
            {"owner": owner_user_id, "contact": member_user_id},
        )
    if cause == "circle_membership_ended":
        if member_user_id is None:
            raise ValueError("Membership exit needs its locked member")
        end_membership_invitations(conn, circle_id=circle_id, member_user_id=member_user_id)
    origin = {"circle_id": circle_id}
    if member_user_id is not None:
        origin["member_user_id"] = member_user_id
    origin_revoke(conn, **origin)
    grant_reconcile(conn, **origin, actor_user_id=actor_user_id, cause=cause)
    if sms_cleanup is not None:
        if member_user_id is not None:
            sms_cleanup(conn, user_id=member_user_id)
        for member in affected_members:
            user_id = str(member.get("user_id") or "")
            if user_id:
                sms_cleanup(conn, user_id=user_id)
