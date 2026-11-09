"""Page-bound shared-neighbor projection over the authoritative active graph."""

from hushh_mcp.services.directory_candidate_statement import DIRECTORY_PROFILE_ELIGIBILITY_SQL

# Applied inside the canonical directory, before live-account filtering and
# logical pagination. Values are bound; ``profile`` is that directory's alias.
MUTUAL_DIRECTORY_FILTER_SQL = """
profile.user_id <> :mutual_target_user_id
AND EXISTS (
    SELECT 1 FROM connections viewer_edge
    WHERE viewer_edge.status = 'active'
      AND ((viewer_edge.user_a_id = :owner_user_id AND viewer_edge.user_b_id = profile.user_id)
        OR (viewer_edge.user_b_id = :owner_user_id AND viewer_edge.user_a_id = profile.user_id))
)
AND EXISTS (
    SELECT 1 FROM connections target_edge
    WHERE target_edge.status = 'active'
      AND ((target_edge.user_a_id = :mutual_target_user_id AND target_edge.user_b_id = profile.user_id)
        OR (target_edge.user_b_id = :mutual_target_user_id AND target_edge.user_a_id = profile.user_id))
)
AND NOT EXISTS (
    SELECT 1 FROM connection_requests blocked
    WHERE blocked.status = 'rejected' AND blocked.metadata ->> 'blocked_by' IS NOT NULL
      AND blocked.requester_user_id = ANY(ARRAY[:owner_user_id, profile.user_id, :mutual_target_user_id])
      AND blocked.addressee_user_id = ANY(ARRAY[:owner_user_id, profile.user_id, :mutual_target_user_id])
)
"""

_MUTUAL_GRAPH_SQL = """
WITH viewer_peers AS (
    SELECT CASE WHEN user_a_id = :user_id THEN user_b_id ELSE user_a_id END AS peer_id
    FROM connections
    WHERE status = 'active' AND (user_a_id = :user_id OR user_b_id = :user_id)
), shared AS (
    SELECT DISTINCT p.peer_id,
           CASE WHEN c.user_a_id = p.peer_id THEN c.user_b_id ELSE c.user_a_id END AS candidate_id
    FROM viewer_peers p
    JOIN connections c ON c.status = 'active'
      AND (c.user_a_id = p.peer_id OR c.user_b_id = p.peer_id)
), visible_shared AS (
    SELECT s.* FROM shared s
    WHERE s.candidate_id = ANY(CAST(:page_user_ids AS TEXT[]))
      AND s.candidate_id <> :user_id AND s.peer_id <> :user_id
      AND s.peer_id <> s.candidate_id
      AND NOT EXISTS (
          SELECT 1 FROM connection_requests b
          WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
            AND b.requester_user_id = ANY(ARRAY[:user_id, s.peer_id, s.candidate_id])
            AND b.addressee_user_id = ANY(ARRAY[:user_id, s.peer_id, s.candidate_id])
      )
)
"""

MUTUAL_CONNECTIONS_SQL = (
    _MUTUAL_GRAPH_SQL
    + """
SELECT candidate_id, COUNT(DISTINCT peer_id) AS mutual_count,
       MIN(peer_id) AS preview_user_id
FROM visible_shared
GROUP BY candidate_id
"""  # nosec B608 -- module-owned literals; request values remain bound.
)

PAGE_MUTUAL_CONNECTIONS_SQL = (
    _MUTUAL_GRAPH_SQL
    + """
SELECT candidate_id, COUNT(DISTINCT peer_id) AS mutual_count,
       (ARRAY_AGG(DISTINCT peer_id ORDER BY peer_id))[1:2] AS preview_user_ids
FROM visible_shared GROUP BY candidate_id
"""  # nosec B608 -- module-owned literals; request values remain bound.
)

# Public metadata only, bounded by the already-paginated candidate IDs. Both
# reads use this same projection so a changed edge/block never leaves stale
# portraits attached to a current count.
PAGE_ROW_METADATA_SQL = f"""
WITH mutual AS ({PAGE_MUTUAL_CONNECTIONS_SQL})
SELECT profile.user_id AS candidate_id,
       profile.public_person_ref::TEXT AS public_person_ref,
       CASE
         WHEN EXISTS (SELECT 1 FROM connections c WHERE c.status = 'active'
           AND ((c.user_a_id = :user_id AND c.user_b_id = profile.user_id)
             OR (c.user_b_id = :user_id AND c.user_a_id = profile.user_id))) THEN 'connected'
         WHEN EXISTS (SELECT 1 FROM connection_requests r WHERE r.status = 'pending'
           AND r.requester_user_id = :user_id AND r.addressee_user_id = profile.user_id) THEN 'pending_outgoing'
         WHEN EXISTS (SELECT 1 FROM connection_requests r WHERE r.status = 'pending'
           AND r.addressee_user_id = :user_id AND r.requester_user_id = profile.user_id) THEN 'pending_incoming'
         ELSE 'none' END AS relationship,
       COALESCE(m.mutual_count, 0) AS mutual_count,
       COALESCE(m.preview_user_ids, ARRAY[]::TEXT[]) AS preview_user_ids,
       NOT EXISTS (
         SELECT 1 FROM jsonb_each_text(CAST(:preview_refs AS JSONB)) expected
         WHERE NOT EXISTS (SELECT 1 FROM actor_profiles peer
           WHERE peer.user_id = expected.key AND peer.public_profile_status = 'active'
             AND peer.public_person_ref::TEXT = expected.value)
       ) AS previews_valid
FROM actor_profiles profile LEFT JOIN mutual m ON m.candidate_id = profile.user_id
WHERE profile.user_id = ANY(CAST(:page_user_ids AS TEXT[]))
  AND ({DIRECTORY_PROFILE_ELIGIBILITY_SQL})
  AND NOT EXISTS (SELECT 1 FROM connection_requests b
    WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
      AND ((b.requester_user_id = :user_id AND b.addressee_user_id = profile.user_id)
        OR (b.addressee_user_id = :user_id AND b.requester_user_id = profile.user_id)))
"""  # nosec B608 -- module-owned static fragments; all values bound.
