"""Exact, additive weekly-prize activation for the reviewed v5 policy."""

REFERRAL_POLICY_V5_SHA256 = "d374793348628ffc7a5155fcff42a51ae0a32c73238f434ee866d0caf8b5e0d1"


def policy_fingerprint_sql(version: int) -> str:
    return f"""SELECT encode(sha256(convert_to(jsonb_build_object(
        'qualification_policy_version', qualification_policy_version,
        'points', points, 'milestones', milestones, 'streak_rules', streak_rules,
        'flash_windows', flash_windows, 'weekly_schedule', weekly_schedule,
        'prize_catalogue', prize_catalogue, 'tie_break_rules', tie_break_rules,
        'fulfillment_config', fulfillment_config, 'feature_active', feature_active
      )::text, 'UTF8')), 'hex')
        FROM one_referral_program_settings WHERE version = {version}"""


def watch_milestones_sql(policy: str) -> str:
    return f"""(SELECT jsonb_agg(CASE WHEN item->>'milestone_key'='airpods_500'
      THEN item || '{{"reward":"Apple Watch"}}'::JSONB ELSE item END ORDER BY position)
      FROM jsonb_array_elements({policy}.milestones) WITH ORDINALITY AS m(item,position))"""


def reviewed_prize_successor_sql() -> str:
    """Accept only the reviewed Watch catalogue and weekly-prize activation."""
    return f"""EXISTS (
      SELECT 1 FROM one_referral_program_settings p5
      JOIN one_referral_program_settings p6 ON p6.version=6
      WHERE p5.version=5 AND p5.activated_at IS NOT NULL
        AND p6.activated_at=p5.retired_at AND p6.activated_at>p5.activated_at
        AND p6.retired_at IS NULL AND NOT p5.feature_active AND p6.feature_active
        AND (to_jsonb(p6)-ARRAY['version','created_at','activated_at','retired_at']) =
          ((to_jsonb(p5)-ARRAY['version','created_at','activated_at','retired_at'])
            || jsonb_build_object('feature_active',true,'milestones',{watch_milestones_sql("p5")}))
        AND NOT EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version>6)
    )"""


def activate_weekly_prizes_sql() -> str:
    """Called only by the fixed-target UAT operator after deployment proof."""
    return f"""
    LOCK TABLE one_referral_program_settings,one_referral_reward_rounds IN SHARE ROW EXCLUSIVE MODE;
    DO $$
    DECLARE prior one_referral_program_settings%ROWTYPE; at TIMESTAMPTZ;
    BEGIN
      at := clock_timestamp();
      IF ({policy_fingerprint_sql(5)}) IS DISTINCT FROM '{REFERRAL_POLICY_V5_SHA256}' THEN
        RAISE EXCEPTION 'Reviewed v5 configuration does not match';
      END IF;
      IF {reviewed_prize_successor_sql()} THEN RETURN; END IF;
      SELECT * INTO STRICT prior FROM one_referral_program_settings
        WHERE activated_at IS NOT NULL AND retired_at IS NULL;
      IF prior.version<>5 OR prior.feature_active OR
         EXISTS(SELECT 1 FROM one_referral_program_settings WHERE version>5) THEN
        RAISE EXCEPTION 'Expected the reviewed inactive v5 policy';
      END IF;
      -- No retroactive launch: preserve and refuse unresolved past rounds.
      IF EXISTS(SELECT 1 FROM one_referral_reward_rounds
        WHERE cutoff_at<=at AND status IN ('scheduled','ended','reconciling')) THEN
        RAISE EXCEPTION 'Resolve historical inactive rounds before activation';
      END IF;
      UPDATE one_referral_program_settings SET retired_at=at WHERE version=5;
      INSERT INTO one_referral_program_settings(version,qualification_policy_version,
        points,milestones,streak_rules,flash_windows,weekly_schedule,prize_catalogue,
        tie_break_rules,fulfillment_config,feature_active,activated_at)
      VALUES(6,prior.qualification_policy_version,prior.points,{watch_milestones_sql("prior")},
        prior.streak_rules,prior.flash_windows,prior.weekly_schedule,prior.prize_catalogue,
        prior.tie_break_rules,prior.fulfillment_config,TRUE,at);
      PERFORM pg_notify('one_referral_changed','{{"reason":"weekly_prizes_enabled"}}');
    END $$;
    """
