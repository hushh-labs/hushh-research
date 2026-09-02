-- Protect opt-out from stale monitor writes and bound Gmail History fan-out.
-- Both values are opaque monitor coordination metadata and never browser-visible.

BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  ADD COLUMN IF NOT EXISTS monitoring_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monitor_message_offset INTEGER NOT NULL DEFAULT 0;

-- Existing opt-ins predate the generation guard. Give each one a non-zero
-- active epoch so the rollout does not disable an already-consented monitor.
UPDATE gmail_personal_information_request_preferences
SET monitoring_generation = 1
WHERE monitoring_enabled = TRUE
  AND monitoring_generation = 0;

ALTER TABLE gmail_personal_information_request_preferences
  ADD CONSTRAINT gmail_personal_information_request_preferences_generation_nonnegative
    CHECK (monitoring_generation >= 0),
  ADD CONSTRAINT gmail_personal_information_request_preferences_message_offset_nonnegative
    CHECK (monitor_message_offset >= 0);

COMMENT ON COLUMN gmail_personal_information_request_preferences.monitoring_generation IS
  'Monotonic opt-in generation. Stale scans cannot persist after monitoring is disabled or re-enabled.';
COMMENT ON COLUMN gmail_personal_information_request_preferences.monitor_message_offset IS
  'Server-only offset within the current Gmail History page. Bounds message hydration without losing page fan-out.';

COMMIT;
