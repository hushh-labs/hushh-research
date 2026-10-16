-- Expand only: original IDs, sequence, recipient envelopes and epochs stay authoritative.
BEGIN;
ALTER TABLE circle_chat_messages
  -- Keep the authenticated reference after source erasure; resolution still
  -- requires the viewer's original recipient epoch. No copied quote is stored.
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID,
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_for_everyone_at TIMESTAMPTZ;
ALTER TABLE circle_chat_recipients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
COMMIT;
