"""Exact-owner lookup shared by account admission and read-only reporting."""

# Shared by SQLAlchemy and the async Metrics reader on its lifecycle guard.
EXACT_OWNER_IDENTITIES_SQL = """
SELECT requested.owner,
       CASE WHEN g.owner_id=requested.owner THEN g.identity_uid ELSE requested.owner END AS identity_uid
FROM unnest(CAST($1 AS text[])) AS requested(owner)
LEFT JOIN public.account_generations g ON g.owner_hash='sha256:'||encode(sha256(convert_to(requested.owner,'UTF8')),'hex')
LEFT JOIN public.account_deletion_tombstones t ON t.user_id_hash='sha256:'||encode(sha256(convert_to(requested.owner,'UTF8')),'hex')
WHERE t.user_id_hash IS NULL AND
      ((g.owner_id=requested.owner AND g.retired_at IS NULL) OR
       (g.owner_hash IS NULL AND requested.owner !~ '^acct_[0-9a-f]{32}$'))
"""
