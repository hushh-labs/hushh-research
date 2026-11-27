"""Public recommendations share the directory's authority and logical pagination."""

# ``profile`` is the canonical directory/metadata alias. Do not turn a pending
# request or a trusted edge into permission to recommend an unlisted profile.
# Mutual paths use the same block semantics as connection_mutuals.py.
PUBLIC_RECOMMENDATION_FILTER_SQL = """
profile.public_person_ref IS NOT NULL
AND (profile.directory_listed = TRUE OR (
    profile.directory_listed IS NULL AND EXISTS (
        SELECT 1 FROM vault_keys vault WHERE vault.user_id = profile.user_id
          AND vault.vault_status = 'active' AND vault.environment_enrolled_at IS NOT NULL)))
AND NOT EXISTS (
    SELECT 1 FROM connections direct WHERE direct.status = 'active'
      AND ((direct.user_a_id = :owner_user_id AND direct.user_b_id = profile.user_id)
        OR (direct.user_b_id = :owner_user_id AND direct.user_a_id = profile.user_id)))
AND NOT EXISTS (
    SELECT 1 FROM connections first_edge JOIN connections second_edge
      ON second_edge.status = 'active' AND (
        (second_edge.user_a_id = first_edge.user_a_id AND second_edge.user_b_id = profile.user_id)
        OR (second_edge.user_b_id = first_edge.user_a_id AND second_edge.user_a_id = profile.user_id)
        OR (second_edge.user_a_id = first_edge.user_b_id AND second_edge.user_b_id = profile.user_id)
        OR (second_edge.user_b_id = first_edge.user_b_id AND second_edge.user_a_id = profile.user_id))
    WHERE first_edge.status = 'active'
      AND :owner_user_id IN (first_edge.user_a_id, first_edge.user_b_id)
      AND profile.user_id NOT IN (first_edge.user_a_id, first_edge.user_b_id)
      AND NOT EXISTS (
        SELECT 1 FROM connection_requests blocked
        WHERE blocked.status = 'rejected' AND blocked.metadata ->> 'blocked_by' IS NOT NULL
          AND blocked.requester_user_id = ANY(
            ARRAY[:owner_user_id, first_edge.user_a_id, first_edge.user_b_id, profile.user_id])
          AND blocked.addressee_user_id = ANY(
            ARRAY[:owner_user_id, first_edge.user_a_id, first_edge.user_b_id, profile.user_id])))
"""
