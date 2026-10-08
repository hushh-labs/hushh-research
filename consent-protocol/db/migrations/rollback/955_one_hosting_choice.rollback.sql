-- Roll back 955: forget recorded Shared choices.
-- Fails closed: every person with no placement reads as `unplaced` again and is
-- shown the tier chooser; nobody is moved onto the shared runtime by the rollback.
-- Pair with a hub that no longer reads one_hosting_choice.
BEGIN;

ALTER TABLE vault_keys
  DROP CONSTRAINT IF EXISTS vault_keys_one_hosting_choice_check;
ALTER TABLE vault_keys
  DROP COLUMN IF EXISTS one_hosting_choice_at;
ALTER TABLE vault_keys
  DROP COLUMN IF EXISTS one_hosting_choice;

COMMIT;
