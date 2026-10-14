-- Publication reconciliation: companion rollback for the forward migration
-- activated in UAT in replay mode as 322_one_referral_usd_catalogue.sql.
-- Replay creates no ledger entry.
-- Upstream assigned 322 to wallet sharing and 337 to initial Contacts onboarding;
-- this publication uses 338.
-- Original normalized SQL SHA-256: fcaa42b4217f4c06109c70c8c7b8784be761d0e8b130286fafa52dd56efce349
-- The original transition and exact-match guards below are retained.
-- Restore v2; retain v3 and all earned entitlements as historical records.
BEGIN;
LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;
DO $rollback_322$
BEGIN
  IF EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version = 2 AND activated_at IS NOT NULL AND retired_at IS NULL)
     AND EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version = 3 AND retired_at IS NOT NULL) THEN
    NULL;
  ELSIF EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version = 3 AND activated_at IS NOT NULL AND retired_at IS NULL)
     AND EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version = 2 AND activated_at IS NOT NULL AND retired_at IS NOT NULL) THEN
    UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = 3;
    UPDATE one_referral_program_settings SET retired_at = NULL WHERE version = 2;
  ELSE
    RAISE EXCEPTION 'rollback 322: expected active v3 and retired v2';
  END IF;
  IF (SELECT COUNT(*) FROM one_referral_program_settings WHERE activated_at IS NOT NULL AND retired_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'rollback 322: expected exactly one active settings version';
  END IF;
END
$rollback_322$;
COMMIT;
