"""Bounded final graph qualification; each statement has one authority snapshot."""

from hushh_mcp.services.connection_mutuals import PAGE_MUTUAL_CONNECTIONS_SQL
from hushh_mcp.services.directory_candidate_statement import DIRECTORY_PROFILE_ELIGIBILITY_SQL

QUALIFIED_DEGREES_SQL = """
WITH admitted AS MATERIALIZED (
    SELECT user_id, connection_list_shared FROM actor_profiles
    WHERE user_id = ANY(CAST(:admitted AS TEXT[])) AND public_profile_status = 'active'
), raw_edges AS (
    SELECT user_a_id AS source_id, user_b_id AS peer_id FROM connections
    WHERE status = 'active' AND user_a_id = ANY(CAST(:admitted AS TEXT[]))
    UNION ALL
    SELECT user_b_id AS source_id, user_a_id AS peer_id FROM connections
    WHERE status = 'active' AND user_b_id = ANY(CAST(:admitted AS TEXT[]))
), edges AS MATERIALIZED (
    SELECT e.source_id, e.peer_id FROM raw_edges e
    JOIN admitted peer ON peer.user_id = e.peer_id
    JOIN admitted source ON source.user_id = e.source_id
    WHERE e.peer_id <> :viewer AND NOT EXISTS (
        SELECT 1 FROM connection_requests b
        WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
          AND b.requester_user_id = ANY(ARRAY[:viewer, e.source_id, e.peer_id])
          AND b.addressee_user_id = ANY(ARRAY[:viewer, e.source_id, e.peer_id])
    )
    LIMIT :edge_limit
), first_degree AS MATERIALIZED (
    SELECT peer_id AS user_id FROM edges WHERE source_id = :viewer
), paths AS (
    SELECT user_id, 1 AS degree FROM first_degree
    UNION ALL
    SELECT e.peer_id, 2 FROM first_degree f JOIN edges e ON e.source_id = f.user_id
    WHERE :max_degree >= 2
    UNION ALL
    SELECT last.peer_id, 3 FROM first_degree f
    JOIN admitted p1 ON p1.user_id = f.user_id AND p1.connection_list_shared = TRUE
    JOIN edges middle ON middle.source_id = f.user_id
    JOIN admitted p2 ON p2.user_id = middle.peer_id AND p2.connection_list_shared = TRUE
    JOIN edges last ON last.source_id = middle.peer_id
    WHERE :max_degree >= 3 AND f.user_id <> middle.peer_id
      AND last.peer_id <> f.user_id
)
SELECT user_id, MIN(degree) AS degree, FALSE AS overflow FROM paths
WHERE user_id = ANY(CAST(:candidates AS TEXT[])) AND user_id <> :viewer
  AND (SELECT COUNT(*) FROM edges) < :edge_limit
GROUP BY user_id
UNION ALL
SELECT NULL, NULL, TRUE WHERE (SELECT COUNT(*) FROM edges) >= :edge_limit
"""

QUALIFIED_TARGET_ROWS_SQL = """
SELECT peer.user_id,
    CASE WHEN EXISTS (SELECT 1 FROM connections own_edge WHERE own_edge.status = 'active'
        AND ((own_edge.user_a_id = :viewer AND own_edge.user_b_id = peer.user_id)
          OR (own_edge.user_b_id = :viewer AND own_edge.user_a_id = peer.user_id)))
      THEN 1 ELSE 2 END AS degree
FROM actor_profiles target CROSS JOIN actor_profiles peer
WHERE target.user_id = :target AND target.public_profile_status = 'active'
  AND peer.user_id = ANY(CAST(:target_peer_ids AS TEXT[])) AND peer.public_profile_status = 'active'
  AND EXISTS (SELECT 1 FROM connections direct WHERE direct.status = 'active'
      AND ((direct.user_a_id = :viewer AND direct.user_b_id = :target)
        OR (direct.user_b_id = :viewer AND direct.user_a_id = :target)))
  AND EXISTS (SELECT 1 FROM connections shared WHERE shared.status = 'active'
      AND ((shared.user_a_id = :target AND shared.user_b_id = peer.user_id)
        OR (shared.user_b_id = :target AND shared.user_a_id = peer.user_id)))
  AND NOT EXISTS (SELECT 1 FROM connection_requests b
      WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
        AND b.requester_user_id = ANY(ARRAY[:viewer, :target, peer.user_id])
        AND b.addressee_user_id = ANY(ARRAY[:viewer, :target, peer.user_id]))
"""

# Only static, module-owned SQL fragments are composed here; values remain bound parameters.
QUALIFIED_SUMMARY_SQL = f"""
WITH qualified AS ({QUALIFIED_DEGREES_SQL}), mutual AS ({PAGE_MUTUAL_CONNECTIONS_SQL})
SELECT p.connection_list_shared,
       (SELECT degree FROM qualified WHERE user_id = :target) AS degree,
       EXISTS (SELECT 1 FROM qualified WHERE overflow) AS overflow,
       COALESCE(m.mutual_count, 0) AS mutual_count, m.preview_user_ids,
       (SELECT COUNT(*) FROM actor_profiles peer WHERE peer.user_id = ANY(CAST(:previews AS TEXT[]))
                 AND peer.public_profile_status = 'active') AS previews_active,
       CASE WHEN CAST(:target_peer_ids AS TEXT[]) IS NOT NULL THEN (
           SELECT LEAST(COUNT(*), :connection_count_limit)
           FROM ({QUALIFIED_TARGET_ROWS_SQL}) shared
           JOIN actor_profiles profile ON profile.user_id = shared.user_id
           WHERE profile.public_person_ref IS NOT NULL AND ({DIRECTORY_PROFILE_ELIGIBILITY_SQL})
       ) END AS visible_connection_count
FROM actor_profiles p LEFT JOIN mutual m ON m.candidate_id = p.user_id
WHERE p.user_id = :target AND p.public_profile_status = 'active'
  AND NOT EXISTS (SELECT 1 FROM connection_requests b
      WHERE b.status = 'rejected' AND b.metadata ->> 'blocked_by' IS NOT NULL
        AND ((b.requester_user_id = :viewer AND b.addressee_user_id = :target)
          OR (b.addressee_user_id = :viewer AND b.requester_user_id = :target)))
"""  # nosec B608
