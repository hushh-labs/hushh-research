"""Page-bound shared-neighbor projection over the authoritative active graph."""

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

MUTUAL_CONNECTIONS_SQL = """
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
SELECT candidate_id, COUNT(DISTINCT peer_id) AS mutual_count,
       MIN(peer_id) AS preview_user_id
FROM visible_shared
GROUP BY candidate_id
"""
