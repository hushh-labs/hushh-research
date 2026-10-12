-- Refuse destructive rollback once any provenance/history exists; roll back code instead.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM wallet_card_registrations) OR EXISTS(SELECT 1 FROM wallet_card_access_audit) THEN
  RAISE EXCEPTION 'wallet_card_access_rollback_requires_empty_tables';
 END IF;
END $$;
DROP TRIGGER IF EXISTS wallet_cards_activate_after_commit ON pkm_domain_commits;
DROP TRIGGER IF EXISTS wallet_cards_domain_removed ON pkm_manifests;
DROP FUNCTION IF EXISTS activate_reserved_wallet_cards();
DROP FUNCTION IF EXISTS remove_wallet_card_registrations();
DROP TRIGGER IF EXISTS wallet_card_grant_guard ON wallet_card_access_grants;
DROP FUNCTION IF EXISTS guard_wallet_card_access_grant();
DROP TABLE wallet_card_access_audit;
DROP TABLE wallet_card_access_grants;
DROP TABLE wallet_card_share_requests;
DROP TABLE wallet_card_registrations;
COMMIT;
