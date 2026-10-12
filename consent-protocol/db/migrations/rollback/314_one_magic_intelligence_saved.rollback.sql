-- Retains all confirmed PKM facts; only removes the UI completion metadata.
BEGIN;
ALTER TABLE vault_keys DROP COLUMN IF EXISTS one_magic_intelligence_saved;
COMMIT;
