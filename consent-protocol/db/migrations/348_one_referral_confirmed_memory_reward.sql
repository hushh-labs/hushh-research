-- Current Memory saves commit encrypted blobs and provenance events atomically.
-- Reward only confirmed product content writes; upgrades, projections and blob
-- maintenance do not carry this authority. Retain the legacy hook and share its
-- owner/day key so compatibility writes cannot earn a second daily reward.
BEGIN;

CREATE OR REPLACE FUNCTION one_referral_record_confirmed_memory_reward()
RETURNS TRIGGER AS $$
DECLARE
  cfg one_referral_program_settings%ROWTYPE;
  award INTEGER;
  reward_key TEXT;
BEGIN
  IF NULLIF(BTRIM(NEW.metadata #>> '{provenance,mutation_plan_id}'), '') IS NULL
     OR NULLIF(BTRIM(NEW.metadata #>> '{provenance,confirmation_receipt_id}'), '') IS NULL
     OR NOT EXISTS (SELECT 1 FROM actor_profiles WHERE user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO cfg FROM one_referral_program_settings
    WHERE activated_at IS NOT NULL AND retired_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  award := (cfg.points->>'pkm_daily_points')::INTEGER;
  IF award > 0 THEN
    reward_key := 'pkm_daily:' || NEW.user_id || ':' ||
      (NOW() AT TIME ZONE COALESCE(cfg.weekly_schedule->>'timezone', 'UTC'))::DATE;
    INSERT INTO one_referral_score_events
      (user_id, event_type, points, coins, settings_version, idempotency_key)
    VALUES (NEW.user_id, 'pkm_daily', award, 0, cfg.version, reward_key)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_referral_confirmed_memory_reward ON pkm_events;
CREATE TRIGGER one_referral_confirmed_memory_reward AFTER INSERT ON pkm_events
  FOR EACH ROW WHEN (NEW.operation_type = 'content_write')
  EXECUTE FUNCTION one_referral_record_confirmed_memory_reward();

COMMIT;
