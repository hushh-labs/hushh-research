"""Location account-erasure SQL and FK order, composed by AccountService.

Target recipient references can be cleared only after the account tombstone.
All SQL runs on the caller's existing account-deletion transaction.
"""

from types import MappingProxyType

from sqlalchemy import text

LOCATION_RELATIONSHIP_ERASURE_TABLES = (
    "one_location_auto_approve_preferences",
    "one_location_visibility_exclusions",
    "one_location_visibility_preferences",
    "one_location_map_preferences",
    "one_location_network_connections",
    "one_location_check_in_targets",
    "one_location_check_in_operations",
    "one_location_events",
    "one_location_nearby_presences",
    "one_location_nearby_visits",
    "one_location_place_ratings",
    "one_location_sms_contacts",
    "one_location_referrals",
    "kai_location_referrals",
    "one_location_public_invite_submissions",
    "one_location_public_invites",
    "one_location_circle_invites",
    "one_location_circle_member_invites",
    "one_location_circle_memberships",
)

LOCATION_CLEANUP_QUERIES = MappingProxyType(
    {
        "one_location_nearby_check_in_preferences": text(
            "DELETE FROM one_location_nearby_check_in_preferences WHERE user_id = :user_id"
        ),
        "one_location_sos_voice_preferences": text(
            "DELETE FROM one_location_sos_voice_preferences WHERE user_id = :user_id"
        ),
        "one_location_access_requests": text(
            """
        DELETE FROM one_location_access_requests
        WHERE owner_user_id = :user_id
           OR requester_user_id = :user_id
           OR referred_by_user_id = :user_id
        """
        ),
        "one_location_auto_approve_preferences": text(
            "DELETE FROM one_location_auto_approve_preferences WHERE user_id = :user_id"
        ),
        "one_location_visibility_preferences": text(
            "DELETE FROM one_location_visibility_preferences WHERE owner_user_id = :user_id"
        ),
        "one_location_visibility_exclusions": text(
            """
        DELETE FROM one_location_visibility_exclusions
        WHERE owner_user_id = :user_id
           OR excluded_user_id = :user_id
        """
        ),
        "one_location_map_preferences": text(
            "DELETE FROM one_location_map_preferences WHERE user_id = :user_id"
        ),
        "one_location_network_connections": text(
            """
        DELETE FROM one_location_network_connections
        WHERE user_a_id = :user_id
           OR user_b_id = :user_id
           OR inviter_user_id = :user_id
           OR invitee_user_id = :user_id
        """
        ),
        "one_location_envelopes": text(
            """
        DELETE FROM one_location_envelopes
        WHERE owner_user_id = :user_id
           OR recipient_user_id = :user_id
        """
        ),
        "one_location_check_in_operations": text(
            "DELETE FROM one_location_check_in_operations WHERE owner_user_id=:user_id"
        ),
        "one_location_check_in_targets": text(
            "UPDATE one_location_check_in_targets SET recipient_user_id=NULL WHERE recipient_user_id=:user_id"
        ),
        "one_location_events": text(
            """
        DELETE FROM one_location_events
        WHERE owner_user_id = :user_id
           OR actor_user_id = :user_id
           OR recipient_user_id = :user_id
        """
        ),
        "one_location_nearby_presences": text(
            """
        DELETE FROM one_location_nearby_presences
        WHERE owner_user_id = :user_id
        """
        ),
        "one_location_nearby_visits": text(
            """
        DELETE FROM one_location_nearby_visits
        WHERE owner_user_id = :user_id
        """
        ),
        "one_location_place_ratings": text(
            """
        WITH removed AS (
          DELETE FROM one_location_place_ratings
          WHERE author_user_id = :user_id
          RETURNING place_id
        ), touched AS (
          SELECT DISTINCT place_id FROM removed
        )
        UPDATE one_location_place_rating_aggregates AS agg
        SET
          rating_count = COALESCE(fresh.rating_count, 0),
          rating_sum = COALESCE(fresh.rating_sum, 0),
          updated_at = NOW()
        FROM touched
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS rating_count, SUM(rating) AS rating_sum
          FROM one_location_place_ratings
          WHERE place_id = touched.place_id AND aggregatable
        ) AS fresh ON TRUE
        WHERE agg.place_id = touched.place_id
        """
        ),
        "one_location_sms_contacts": text(
            """
        DELETE FROM one_location_sms_contacts
        WHERE owner_user_id = :user_id
           OR contact_user_id = :user_id
        """
        ),
        "one_location_public_invite_submissions": text(
            """
        DELETE FROM one_location_public_invite_submissions
        WHERE owner_user_id = :user_id
           OR matched_user_id = :user_id
        """
        ),
        "one_location_public_invites": text(
            "DELETE FROM one_location_public_invites WHERE owner_user_id = :user_id"
        ),
        "one_location_circle_invites": text(
            """
        DELETE FROM one_location_circle_invites
        WHERE owner_user_id = :user_id
           OR claimed_by_user_id = :user_id
        """
        ),
        "one_location_circle_member_invites": text(
            """
        DELETE FROM one_location_circle_member_invites
        WHERE inviter_user_id = :user_id
           OR invitee_user_id = :user_id
        """
        ),
        "one_location_circle_memberships": text(
            "DELETE FROM one_location_circle_memberships WHERE user_id = :user_id"
        ),
        "one_location_recipient_keys": text(
            "DELETE FROM one_location_recipient_keys WHERE user_id = :user_id"
        ),
        "one_location_referrals": text(
            """
        DELETE FROM one_location_referrals
        WHERE owner_user_id = :user_id
           OR referring_user_id = :user_id
           OR referred_user_id = :user_id
        """
        ),
        "kai_location_referrals": text(
            """
        DELETE FROM kai_location_referrals
        WHERE owner_user_id = :user_id
           OR referrer_user_id = :user_id
           OR candidate_user_id = :user_id
        """
        ),
        "one_location_share_grants": text(
            """
        DELETE FROM one_location_share_grants
        WHERE owner_user_id = :user_id
           OR recipient_user_id = :user_id
        """
        ),
    }
)
