-- migration: transactional=false
CREATE INDEX CONCURRENTLY IF NOT EXISTS wallet_universal_grant_audit ON wallet_card_access_audit(COALESCE(grant_id,profile_grant_id),created_at DESC,id DESC);
