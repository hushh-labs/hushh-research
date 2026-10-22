-- migration: transactional=false
CREATE INDEX CONCURRENTLY IF NOT EXISTS wallet_payment_grants_owner_history ON wallet_card_access_grants(owner_user_id,created_at DESC,id);
