-- Behavioral rollback; retain additive schema and every earned award/claim.
-- Deploy the previous application revision with this rollback. Do not drop
-- loyalty ledgers or referral membership: they are recoverable audit history.
BEGIN;
DROP TRIGGER IF EXISTS one_referral_completed_reply ON agent_chat_messages;
DROP TRIGGER IF EXISTS one_referral_pkm_daily ON pkm_data;
DROP TRIGGER IF EXISTS one_referral_new_connection ON connections;
DROP TRIGGER IF EXISTS one_referral_bind_network ON one_referral_relationships;
DROP TRIGGER IF EXISTS one_referral_network_account_delete ON actor_profiles;
DROP TRIGGER IF EXISTS one_referral_notify_score ON one_referral_score_events;
DROP TRIGGER IF EXISTS one_referral_notify_streak ON one_referral_streak_state;
DROP TRIGGER IF EXISTS one_referral_notify_reward_claim ON one_referral_milestone_entitlements;
DROP TRIGGER IF EXISTS one_referral_notify_leaderboard ON one_referral_leaderboard_snapshots;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM one_referral_program_settings WHERE version=4 AND retired_at IS NULL) THEN
  UPDATE one_referral_program_settings SET retired_at=NOW() WHERE version=4;
  UPDATE one_referral_program_settings SET retired_at=NULL WHERE version=3;
 END IF;
 IF EXISTS(SELECT 1 FROM one_referral_policies WHERE version=2 AND retired_at IS NULL) THEN
  UPDATE one_referral_policies SET retired_at=NOW() WHERE version=2;
  UPDATE one_referral_policies SET retired_at=NULL WHERE version=1;
 END IF;
END $$;
COMMIT;
