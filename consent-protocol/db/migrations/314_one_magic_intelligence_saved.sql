-- UI completion metadata only; no profile facts or ownership claims.
BEGIN;
ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS one_magic_intelligence_saved BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN vault_keys.one_magic_intelligence_saved IS
  'Monotonic completion of owner-reviewed personal Magic Intelligence. Set only after all supplied selected PKM receipts are confirmed. Independent of Business review and personality onboarding; contains no findings.';
COMMIT;
