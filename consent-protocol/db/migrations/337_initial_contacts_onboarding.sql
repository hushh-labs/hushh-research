-- Sparse lifecycle metadata only. No provider credentials or address book.
BEGIN;
ALTER TABLE public.vault_keys ADD COLUMN IF NOT EXISTS initial_contacts_source TEXT;
ALTER TABLE public.vault_keys ADD COLUMN IF NOT EXISTS initial_contacts_welcome_acknowledged BOOLEAN;
ALTER TABLE public.vault_keys ADD COLUMN IF NOT EXISTS initial_contacts_circle_id UUID;
COMMENT ON COLUMN public.vault_keys.initial_contacts_source IS
  'Explicit initial signup source: google, device, or none; NULL leaves legacy accounts outside enrollment.';
COMMENT ON COLUMN public.vault_keys.initial_contacts_welcome_acknowledged IS
  'NULL unenrolled, false welcome pending, true acknowledged; never rearmed by bootstrap or account reset.';
COMMENT ON COLUMN public.vault_keys.initial_contacts_circle_id IS
  'Server-owned initial shared Contacts circle reference; retained after circle deletion to prevent recreation.';
COMMIT;
