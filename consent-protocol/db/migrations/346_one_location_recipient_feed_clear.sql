-- The recipient's Feed clear for an ended location share (the Save My Soul
-- card). Presentation-only state on the recipient's own received grant, so a
-- clear holds on every device and after sign-in. The service writes it only
-- for the recipient and only once the share has ended; the owner's view never
-- includes it and updated_at is left unchanged. A nullable column adds no
-- table rewrite, and account deletion already removes the grant row.
BEGIN;
ALTER TABLE public.one_location_share_grants
  ADD COLUMN IF NOT EXISTS recipient_cleared_at TIMESTAMPTZ;
COMMENT ON COLUMN public.one_location_share_grants.recipient_cleared_at IS
  'When the recipient cleared this ended share from their Feed. Never shown to the owner.';
COMMIT;
