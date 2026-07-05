-- 075_agent_chat_message_metadata.sql
--
-- Add an OPTIONAL, encrypted metadata blob to agent chat messages.
--
-- Selection turns in the One+Location delegated chat persist the raw LLM seed
-- as `content` (so later turns still receive exact recipient/key ids) but need a
-- separate human-readable display string ("Abdul Zalil · 8 hours") for the UI
-- chip. The display string is PII (recipient names), so it is encrypted at rest
-- with the same AES-256-GCM scheme as `content` — never stored plaintext.
--
-- Nullable and additive: existing rows and non-selection messages leave these
-- columns NULL. Idempotent.

BEGIN;

ALTER TABLE agent_chat_messages
  ADD COLUMN IF NOT EXISTS metadata_ciphertext text,
  ADD COLUMN IF NOT EXISTS metadata_iv         text,
  ADD COLUMN IF NOT EXISTS metadata_tag        text,
  ADD COLUMN IF NOT EXISTS metadata_algorithm  text;

COMMIT;
