BEGIN;
ALTER TABLE vault_keys DROP COLUMN IF EXISTS one_chat_onboarding;
COMMIT;
