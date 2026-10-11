-- Permanent UI completion only; no profile facts, ownership claims or answers.
BEGIN;
ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS one_business_profile_saved BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN vault_keys.one_business_profile_saved IS
  'Monotonic completion of the owner-reviewed business suggestion. Set only after all selected PKM writes have committed; independent of personality onboarding and Magic Intelligence.';
COMMIT;
