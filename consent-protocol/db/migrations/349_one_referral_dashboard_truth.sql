-- Additive dashboard reconciliation. No ledger replay or entitlement rewrite.
BEGIN;
ALTER TABLE one_referral_activity_days
 ADD COLUMN IF NOT EXISTS dashboard_visited_at TIMESTAMPTZ;
ALTER TABLE one_referral_streak_state
 ADD COLUMN IF NOT EXISTS dashboard_last_activity_date DATE,
 ADD COLUMN IF NOT EXISTS dashboard_current_streak INTEGER NOT NULL DEFAULT 0
   CHECK (dashboard_current_streak >= 0),
 ADD COLUMN IF NOT EXISTS dashboard_longest_streak INTEGER NOT NULL DEFAULT 0
   CHECK (dashboard_longest_streak >= dashboard_current_streak);

LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE prior one_referral_program_settings%ROWTYPE;
        current_row one_referral_program_settings%ROWTYPE;
        rewards JSONB;
        expected JSONB;
BEGIN
 SELECT * INTO STRICT prior FROM one_referral_program_settings WHERE version=4;
 SELECT jsonb_agg(CASE WHEN item->>'milestone_key'='airpods_500'
   THEN item || '{"reward":"Apple AirPods"}'::JSONB ELSE item END ORDER BY position)
 INTO rewards FROM jsonb_array_elements(prior.milestones) WITH ORDINALITY AS m(item,position);
 IF (SELECT jsonb_agg((item->>'threshold')::INTEGER ORDER BY (item->>'threshold')::INTEGER)
     FROM jsonb_array_elements(rewards) item) <> '[10,100,500,10000]'::JSONB THEN
   RAISE EXCEPTION 'migration 349: unexpected milestone ladder';
 END IF;
 expected := (to_jsonb(prior) - ARRAY['version','created_at','activated_at','retired_at'])
   || jsonb_build_object('milestones',rewards,
     'streak_rules',prior.streak_rules || '{"activity_source":"referral_dashboard_visit"}'::JSONB,
     'weekly_schedule',prior.weekly_schedule || '{"timezone":"Asia/Kolkata","cutoff_day_of_week":1,"cutoff_time":"00:00:00"}'::JSONB);
 SELECT * INTO current_row FROM one_referral_program_settings WHERE version=5;
 IF FOUND THEN
   IF current_row.activated_at IS NULL OR current_row.retired_at IS NOT NULL
     OR (to_jsonb(current_row) - ARRAY['version','created_at','activated_at','retired_at']) IS DISTINCT FROM expected THEN
     RAISE EXCEPTION 'migration 349: conflicting or inactive settings 5';
   END IF;
 ELSE
   IF prior.activated_at IS NULL OR prior.retired_at IS NOT NULL THEN
     RAISE EXCEPTION 'migration 349: active settings 4 required';
   END IF;
   UPDATE one_referral_program_settings SET retired_at=NOW() WHERE version=4;
   INSERT INTO one_referral_program_settings(version,qualification_policy_version,points,milestones,
     streak_rules,flash_windows,weekly_schedule,prize_catalogue,tie_break_rules,
     fulfillment_config,feature_active,activated_at)
   VALUES(5,prior.qualification_policy_version,prior.points,rewards,
     expected->'streak_rules',prior.flash_windows,expected->'weekly_schedule',
     prior.prize_catalogue,prior.tie_break_rules,prior.fulfillment_config,prior.feature_active,NOW());
 END IF;
END $$;
COMMIT;
