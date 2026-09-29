-- Durable progress for One's conversational onboarding (after setup).
--
-- The chat asks three questions (what to call you, what to help with first,
-- how One should talk). This column records only WHICH questions were
-- answered or skipped, whether the flow finished, and two calendar dates
-- (finished on, daily tip last dismissed on), so the flow never repeats and
-- resumes across reloads and devices. It never holds an answer: the preferred
-- name and reply style are written to the person's encrypted memory,
-- client-side, only after they confirm.
--
-- Additive and nullable: NULL means "never started", which is also the state
-- of every existing account, so no backfill and no live-row guard is needed.

BEGIN;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS one_chat_onboarding TEXT;

COMMENT ON COLUMN vault_keys.one_chat_onboarding IS
  'JSON {version:1, status:in_progress|completed, answered:[name|focus|tone], skipped:[...], completedOn:YYYY-MM-DD|null, tipDismissedOn:YYYY-MM-DD|null}. Normalized server-side to this bounded shape; never contains an answer value.';

COMMIT;
