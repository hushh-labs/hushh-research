-- A strict, resumable pre-vault choice for the Connections setup route.
-- It deliberately stores no Gemini key, credential reference, vault key, or
-- access token. A BYOK selection is only a pending preference until the
-- person completes setup and saves a key through the encrypted vault path.
BEGIN;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS one_runtime_setup_choice TEXT;

ALTER TABLE vault_keys
  DROP CONSTRAINT IF EXISTS vault_keys_one_runtime_setup_choice_check;

ALTER TABLE vault_keys
  ADD CONSTRAINT vault_keys_one_runtime_setup_choice_check
  CHECK (
    one_runtime_setup_choice IS NULL
    OR one_runtime_setup_choice IN ('hushh_managed_vertex', 'byok_pending_vault')
  );

COMMENT ON COLUMN vault_keys.one_runtime_setup_choice IS
  'Strict non-secret Connections setup preference; never a credential or vault reference.';

COMMIT;
