-- Roll application code back and disable enrollment before this down migration.
-- Existing user-managed Contacts circles and their memberships are preserved.
BEGIN;
ALTER TABLE public.vault_keys DROP COLUMN IF EXISTS initial_contacts_circle_id;
ALTER TABLE public.vault_keys DROP COLUMN IF EXISTS initial_contacts_welcome_acknowledged;
ALTER TABLE public.vault_keys DROP COLUMN IF EXISTS initial_contacts_source;
COMMIT;
