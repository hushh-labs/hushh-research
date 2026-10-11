-- Run only after reverting the application completion endpoint.
BEGIN;
ALTER TABLE vault_keys DROP COLUMN IF EXISTS one_business_profile_saved;
COMMIT;
