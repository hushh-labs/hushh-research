"""Location terminal workflow retention, preserving active Check-In plans."""

from typing import Any

from hushh_mcp.services.feed_location_policy import with_cleared_feed_receipts

PURGE_TERMINAL_SQL = """
            WITH stale_grants AS (
              SELECT id
              FROM one_location_share_grants
              WHERE ((
                  status = 'expired'
                  AND expires_at <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'revoked'
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                ))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR recipient_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_requests AS (
              SELECT id
              FROM one_location_access_requests
              WHERE ((
                  status IN ('approved', 'denied', 'cancelled')
                  AND COALESCE(resolved_at, requested_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'expired'
                  AND COALESCE(resolved_at, expires_at, requested_at)
                    <= NOW() - (:expired_request_hours * INTERVAL '1 hour')
                )
                OR approved_grant_id IN (SELECT id FROM stale_grants))
                AND (NOT (COALESCE(metadata,'{}'::jsonb) ? 'command_operations')
                     OR COALESCE(resolved_at, expires_at, requested_at) <= NOW()-INTERVAL '24 hours')
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR requester_user_id = :user_id
                  OR referred_by_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_referrals AS (
              SELECT id
              FROM one_location_referrals
              WHERE ((
                  status IN ('approved', 'denied', 'cancelled')
                  AND COALESCE(resolved_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR grant_id IN (SELECT id FROM stale_grants)
                OR request_id IN (SELECT id FROM stale_requests))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR referring_user_id = :user_id
                  OR referred_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_public_invites AS (
              SELECT id
              FROM one_location_public_invites
              WHERE ((
                  status = 'expired'
                  AND expires_at <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'revoked'
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                ))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_public_submissions AS (
              SELECT id
              FROM one_location_public_invite_submissions
              WHERE ((
                  status IN ('approved', 'denied', 'cancelled')
                  AND COALESCE(resolved_at, submitted_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR invite_id IN (SELECT id FROM stale_public_invites)
                OR request_id IN (SELECT id FROM stale_requests))
                AND (
                  :user_id IS NULL
                  OR owner_user_id = :user_id
                  OR matched_user_id = :user_id
                )
              LIMIT 500
            ),
            stale_circle_invites AS (
              SELECT id
              FROM one_location_circle_invites
              WHERE (
                (
                  status IN ('claimed', 'expired')
                  AND COALESCE(claimed_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'revoked'
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
              )
              AND (
                :user_id IS NULL
                OR owner_user_id = :user_id
                OR claimed_by_user_id = :user_id
              )
              LIMIT 500
            ),
            stale_named_circle_codes AS (
              SELECT id
              FROM one_location_circle_invite_codes
              WHERE (
                (
                  status IN ('expired', 'revoked')
                  AND COALESCE(revoked_at, updated_at, expires_at, created_at)
                    <= NOW() - (:hours * INTERVAL '1 hour')
                )
                OR (
                  status = 'active'
                  AND expires_at <= NOW() - (:hours * INTERVAL '1 hour')
                )
              )
              AND (
                :user_id IS NULL
                OR created_by_user_id = :user_id
              )
              LIMIT 500
            ),
            expired_named_circle_member_invite_candidates AS (
              SELECT invite.id
              FROM one_location_circle_member_invites invite
              WHERE invite.status = 'pending'
                AND invite.expires_at <= NOW()
                AND (
                  :user_id IS NULL
                  OR invite.inviter_user_id = :user_id
                  OR invite.invitee_user_id = :user_id
                )
              ORDER BY invite.expires_at, invite.id
              LIMIT 500
              FOR UPDATE SKIP LOCKED
            ),
            expired_named_circle_member_invites AS (
              UPDATE one_location_circle_member_invites invite
              SET status = 'expired',
                  updated_at = NOW()
              FROM expired_named_circle_member_invite_candidates candidate
              WHERE invite.id = candidate.id
              RETURNING invite.id
            ),
            stale_named_circle_member_invites AS (
              SELECT invite.id
              FROM one_location_circle_member_invites invite
              WHERE invite.status IN (
                  'accepted',
                  'declined',
                  'cancelled',
                  'expired'
                )
                AND COALESCE(
                  invite.responded_at,
                  invite.cancelled_at,
                  invite.updated_at,
                  invite.expires_at,
                  invite.created_at
                ) <= NOW() - (:hours * INTERVAL '1 hour')
                AND (
                  :user_id IS NULL
                  OR invite.inviter_user_id = :user_id
                  OR invite.invitee_user_id = :user_id
                )
                AND (SELECT COUNT(*) FROM expired_named_circle_member_invites) >= 0
              LIMIT 500
            ),
            deleted_events AS (
              DELETE FROM one_location_events e
              WHERE e.grant_id IN (SELECT id FROM stale_grants)
                 OR e.request_id IN (SELECT id FROM stale_requests)
                 OR e.referral_id IN (SELECT id FROM stale_referrals)
                 OR (
                   e.event_type IN (
                     'location_public_invite_created',
                     'location_public_invite_revoked',
                     'location_public_invite_submitted'
                   )
                   AND (
                     e.metadata->>'invite_id' IN (
                       SELECT id::text FROM stale_public_invites
                     )
                     OR e.metadata->>'submission_id' IN (
                       SELECT id::text FROM stale_public_submissions
                     )
                   )
                 )
                 OR (
                   e.event_type IN (
                     'location_circle_invite_created',
                     'location_circle_invite_claimed',
                     'location_circle_invite_revoked',
                     'location_one_network_joined'
                   )
                   AND e.metadata->>'invite_id' IN (
                     SELECT id::text FROM stale_circle_invites
                   )
                 )
              RETURNING id
            ),
            deleted_public_submissions AS (
              DELETE FROM one_location_public_invite_submissions s
              WHERE s.id IN (SELECT id FROM stale_public_submissions)
                AND (SELECT COUNT(*) FROM deleted_events) >= 0
              RETURNING id
            ),
            deleted_envelopes AS (
              DELETE FROM one_location_envelopes e
              WHERE e.grant_id IN (SELECT id FROM stale_grants)
                AND (SELECT COUNT(*) FROM deleted_public_submissions) >= 0
              RETURNING id
            ),
            deleted_referrals AS (
              DELETE FROM one_location_referrals r
              WHERE (
                  r.id IN (SELECT id FROM stale_referrals)
                  OR r.grant_id IN (SELECT id FROM stale_grants)
                  OR r.request_id IN (SELECT id FROM stale_requests)
                )
                AND (SELECT COUNT(*) FROM deleted_envelopes) >= 0
              RETURNING id
            ),
            deleted_requests AS (
              DELETE FROM one_location_access_requests req
              WHERE req.id IN (SELECT id FROM stale_requests)
                AND (SELECT COUNT(*) FROM deleted_referrals) >= 0
              RETURNING id
            ),
            feed_clear_candidates AS (
              SELECT g.id AS grant_id, g.recipient_user_id, g.recipient_cleared_at AS cleared_at
              FROM one_location_share_grants g
              WHERE g.id IN (SELECT id FROM stale_grants) AND g.recipient_cleared_at IS NOT NULL
            ),
            hidden_cleared_receipts AS (__CLEARED_FEED_RECEIPTS__),
            deleted_grants AS (
              DELETE FROM one_location_share_grants g
              WHERE g.id IN (SELECT id FROM stale_grants)
                AND (SELECT COUNT(*) FROM deleted_requests) >= 0
                AND (SELECT COUNT(*) FROM hidden_cleared_receipts) >= 0
              RETURNING id
            ),
            deleted_public_invites AS (
              DELETE FROM one_location_public_invites i
              WHERE i.id IN (SELECT id FROM stale_public_invites)
                AND (SELECT COUNT(*) FROM deleted_grants) >= 0
              RETURNING id
            ),
            deleted_circle_invites AS (
              DELETE FROM one_location_circle_invites i
              WHERE i.id IN (SELECT id FROM stale_circle_invites)
                AND (SELECT COUNT(*) FROM deleted_public_invites) >= 0
              RETURNING id
            ),
            deleted_named_circle_codes AS (
              DELETE FROM one_location_circle_invite_codes code
              WHERE code.id IN (SELECT id FROM stale_named_circle_codes)
                AND (SELECT COUNT(*) FROM deleted_circle_invites) >= 0
              RETURNING id
            ),
            deleted_named_circle_member_invites AS (
              DELETE FROM one_location_circle_member_invites invite
              WHERE invite.id IN (
                  SELECT id FROM stale_named_circle_member_invites
                )
                AND (SELECT COUNT(*) FROM deleted_named_circle_codes) >= 0
              RETURNING id
            )
            SELECT
              (SELECT COUNT(*) FROM deleted_grants) AS deleted_grants,
              (SELECT COUNT(*) FROM deleted_envelopes) AS deleted_envelopes,
              (SELECT COUNT(*) FROM deleted_requests) AS deleted_requests,
              (SELECT COUNT(*) FROM deleted_referrals) AS deleted_referrals,
              (SELECT COUNT(*) FROM deleted_public_invites) AS deleted_public_invites,
              (SELECT COUNT(*) FROM deleted_circle_invites) AS deleted_circle_invites,
              (SELECT COUNT(*) FROM deleted_named_circle_codes) AS deleted_named_circle_codes,
              (SELECT COUNT(*) FROM deleted_named_circle_member_invites)
                AS deleted_named_circle_member_invites,
              (SELECT COUNT(*) FROM deleted_public_submissions) AS deleted_public_submissions,
              (SELECT COUNT(*) FROM deleted_events) AS deleted_events
            """


def purge_terminal_work(
    service: Any,
    *,
    user_id: str | None = None,
    older_than_hours: float,
) -> dict[str, Any]:
    from hushh_mcp.services.one_location_agent_service import (
        LOCATION_EXPIRED_REQUEST_RETENTION_HOURS,
        LOCATION_TERMINAL_RETENTION_HOURS,
    )

    hours = max(1.0, min(float(older_than_hours or LOCATION_TERMINAL_RETENTION_HOURS), 168.0))
    row = (
        service._execute_one(
            with_cleared_feed_receipts(PURGE_TERMINAL_SQL),
            {
                "user_id": user_id,
                "hours": hours,
                "expired_request_hours": LOCATION_EXPIRED_REQUEST_RETENTION_HOURS,
            },
        )
        or {}
    )
    from hushh_mcp.services.location_check_in_operations import purge_check_in_operations

    purge_check_in_operations(service._execute_many, owner=user_id, hours=hours)
    return {
        "deleted_grants": int(row.get("deleted_grants") or 0),
        "deleted_envelopes": int(row.get("deleted_envelopes") or 0),
        "deleted_requests": int(row.get("deleted_requests") or 0),
        "deleted_referrals": int(row.get("deleted_referrals") or 0),
        "deleted_public_invites": int(row.get("deleted_public_invites") or 0),
        "deleted_circle_invites": int(row.get("deleted_circle_invites") or 0),
        "deleted_named_circle_codes": int(row.get("deleted_named_circle_codes") or 0),
        "deleted_named_circle_member_invites": int(
            row.get("deleted_named_circle_member_invites") or 0
        ),
        "deleted_public_submissions": int(row.get("deleted_public_submissions") or 0),
        "deleted_events": int(row.get("deleted_events") or 0),
        "retention_hours": hours,
    }
