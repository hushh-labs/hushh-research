"""Referral genealogy standings, independent of Location Circle permissions."""

from sqlalchemy import text

from db.db_client import get_db_connection

_RANKED = """
 WITH metrics AS (
  SELECT c.id,c.created_at,c.leader_user_id,
         COALESCE(h.handle,'Referral circle') AS circle_name,
         COUNT(m.user_id) FILTER (WHERE r.id IS NULL OR r.status NOT IN ('rejected','revoked','expired','ineligible')) AS member_count,
         COUNT(r.id) FILTER (WHERE r.status='qualified') AS qualified_count,
         COUNT(m.user_id) FILTER (WHERE r.status='qualified' OR (r.id IS NULL AND EXISTS(
          SELECT 1 FROM one_referral_events e JOIN vault_keys v ON v.user_id=e.user_id
           JOIN actor_identity_cache i ON i.user_id=e.user_id
          WHERE e.user_id=m.user_id AND e.event_type='product_usage'
            AND i.phone_verified AND v.setup_completed))) AS active_member_count
    FROM one_referral_network_circles c
    JOIN one_referral_network_members m ON m.circle_id=c.id
    LEFT JOIN one_referral_relationships r ON r.id=m.relationship_id
    LEFT JOIN one_referral_display_handles h ON h.user_id=c.leader_user_id
   GROUP BY c.id,h.handle
 ), ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY qualified_count DESC,created_at,id) AS rank FROM metrics
 )
 SELECT ranked.* FROM ranked
 LEFT JOIN one_referral_network_members own ON own.user_id=CAST(:uid AS TEXT) AND own.circle_id=ranked.id
 WHERE (:uid IS NULL OR own.circle_id=ranked.id) AND rank>:after
 ORDER BY rank LIMIT :limit
"""


def _entry(row):
    return {
        "circle_id": str(row.id),
        "circle_name": row.circle_name,
        "rank": row.rank,
        "member_count": row.member_count,
        "qualified_member_count": row.active_member_count,
        "contribution_count": row.qualified_count,
        "score": row.qualified_count,
    }


def get_network_leaderboard(*, limit=20, after_rank=0):
    with get_db_connection() as connection:
        rows = connection.execute(
            text(_RANKED),
            {"uid": None, "after": after_rank, "limit": limit + 1},
        ).fetchall()
    return {
        "teams": [_entry(row) for row in rows[:limit]],
        "next_after_rank": rows[limit - 1].rank if len(rows) > limit else None,
        "scoring_policy": "qualified_descendant_referrals",
        "competition_active": False,
    }


def get_network_circle(user_id: str):
    with get_db_connection() as connection:
        row = connection.execute(
            text(_RANKED),
            {"uid": user_id, "after": 0, "limit": 1},
        ).fetchone()
    return (
        {**_entry(row), "is_leader": row.leader_user_id == user_id} if row else {"circle_id": None}
    )
