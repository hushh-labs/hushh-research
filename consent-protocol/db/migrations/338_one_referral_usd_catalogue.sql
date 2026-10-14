-- Publication reconciliation: activated in UAT in replay mode under unpublished
-- 322_one_referral_usd_catalogue.sql. Replay creates no ledger entry.
-- Upstream assigned 322 to wallet sharing and 337 to initial Contacts onboarding;
-- this publication uses 338.
-- Original normalized SQL SHA-256: e65bda802ef10df1798bbd7c1dd49012f5b5640de54ed6f097bf9f423ac22fb9
-- The original transition and exact-match guards below are retained.
-- Referral catalogue v3: $25 voucher and approved Apple Watch reward.
-- The legacy airpods_500 key preserves once-only milestone identity.
-- Hardware keeps its product name; no unverified dollar valuation is implied.
-- Preserve all other v2 settings and all historical rewards/entitlements.
BEGIN;
LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;
DO $migration_322$
DECLARE
  prior one_referral_program_settings%ROWTYPE;
  current_row one_referral_program_settings%ROWTYPE;
  rewards JSONB := '[
    {"milestone_key":"voucher_10","threshold":10,"reward":"$25 Amazon voucher"},
    {"milestone_key":"earbuds_100","threshold":100,"reward":"Wireless earbuds"},
    {"milestone_key":"airpods_500","threshold":500,"reward":"Apple Watch"},
    {"milestone_key":"iphone_10000","threshold":10000,"reward":"iPhone"}
  ]'::JSONB;
  expected JSONB;
BEGIN
  SELECT * INTO prior FROM one_referral_program_settings WHERE version = 2;
  IF NOT FOUND OR prior.activated_at IS NULL THEN
    RAISE EXCEPTION 'migration 322: activated settings v2 required';
  END IF;
  IF (SELECT jsonb_agg(item - 'reward' ORDER BY position)
      FROM jsonb_array_elements(prior.milestones) WITH ORDINALITY AS m(item, position))
     IS DISTINCT FROM
     (SELECT jsonb_agg(item - 'reward' ORDER BY position)
      FROM jsonb_array_elements(rewards) WITH ORDINALITY AS m(item, position)) THEN
    RAISE EXCEPTION 'migration 322: unexpected milestone keys or thresholds';
  END IF;
  expected := (to_jsonb(prior) - ARRAY['version','created_at','activated_at','retired_at','milestones'])
              || jsonb_build_object('milestones', rewards);
  SELECT * INTO current_row FROM one_referral_program_settings WHERE version = 3;
  IF FOUND THEN
    IF current_row.activated_at IS NULL OR current_row.retired_at IS NOT NULL
       OR (to_jsonb(current_row) - ARRAY['version','created_at','activated_at','retired_at']) IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'migration 322: existing v3 does not match the active USD catalogue';
    END IF;
  ELSE
    IF prior.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'migration 322: settings v2 must be active';
    END IF;
    UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = 2;
    INSERT INTO one_referral_program_settings (
      version, qualification_policy_version, points, milestones, streak_rules,
      flash_windows, weekly_schedule, prize_catalogue, tie_break_rules,
      fulfillment_config, feature_active, activated_at
    ) VALUES (
      3, prior.qualification_policy_version, prior.points, rewards, prior.streak_rules,
      prior.flash_windows, prior.weekly_schedule, prior.prize_catalogue, prior.tie_break_rules,
      prior.fulfillment_config, prior.feature_active, NOW()
    );
  END IF;
  IF (SELECT COUNT(*) FROM one_referral_program_settings
      WHERE activated_at IS NOT NULL AND retired_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'migration 322: expected exactly one active settings version';
  END IF;
END
$migration_322$;
COMMIT;
