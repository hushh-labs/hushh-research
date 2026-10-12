BEGIN;
DROP TRIGGER IF EXISTS one_referral_attributions_notify ON one_referral_attributions;
DROP FUNCTION IF EXISTS one_referral_attribution_notify();
DROP INDEX IF EXISTS one_referral_attributions_owner_opened;
COMMIT;
