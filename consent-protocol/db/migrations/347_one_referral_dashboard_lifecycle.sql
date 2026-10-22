-- Referral dashboard lifecycle. Historic awards and settled qualifications stay intact.
BEGIN;
ALTER TABLE one_referral_events ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS one_referral_relationships_pending_deadline
 ON one_referral_relationships(created_at) WHERE status IN ('signed_up','phone_verified','onboarded','engaging');
-- SET NULL violated the existing bound-user/bound-time pair constraint on deletion.
ALTER TABLE one_referral_attributions DROP CONSTRAINT IF EXISTS one_referral_attributions_bound_user_id_fkey;
ALTER TABLE one_referral_attributions ADD CONSTRAINT one_referral_attributions_bound_user_id_fkey
 FOREIGN KEY(bound_user_id) REFERENCES actor_profiles(user_id) ON DELETE CASCADE;

ALTER TABLE one_referral_policies ADD COLUMN IF NOT EXISTS required_product_event TEXT NOT NULL DEFAULT 'completed_agent_reply';
DO $$
DECLARE prior one_referral_policies%ROWTYPE;
BEGIN
 LOCK TABLE one_referral_policies IN SHARE ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM one_referral_policies WHERE version=2) THEN
  SELECT * INTO STRICT prior FROM one_referral_policies WHERE activated_at IS NOT NULL AND retired_at IS NULL;
  UPDATE one_referral_policies SET retired_at=NOW() WHERE version=prior.version;
  INSERT INTO one_referral_policies(version,program_enabled,new_users_only,attribution_window_days,
    qualification_window_days,required_active_seconds,minimum_meaningful_events,eligible_agent_keys,
    heartbeat_interval_seconds,max_credit_per_heartbeat_secs,recent_interaction_window_secs,
    max_reporting_gap_seconds,required_product_event,activated_at)
  VALUES(2,prior.program_enabled,prior.new_users_only,prior.attribution_window_days,
    prior.qualification_window_days,prior.required_active_seconds,1,prior.eligible_agent_keys,
    prior.heartbeat_interval_seconds,prior.max_credit_per_heartbeat_secs,prior.recent_interaction_window_secs,
    prior.max_reporting_gap_seconds,'completed_agent_reply',NOW());
  UPDATE one_referral_relationships SET policy_version=2
   WHERE status IN ('attributed','signed_up','phone_verified','onboarded','engaging','under_review');
 ELSE
  SELECT * INTO STRICT prior FROM one_referral_policies WHERE version=2;
  IF prior.activated_at IS NULL OR prior.retired_at IS NOT NULL OR prior.required_product_event<>'completed_agent_reply'
    OR prior.minimum_meaningful_events<>1 THEN
   RAISE EXCEPTION 'migration 347: conflicting or inactive qualification policy 2';
  END IF;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
   AND table_name='one_referral_score_events' AND column_name='coins') THEN
  ALTER TABLE one_referral_score_events ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;
  UPDATE one_referral_score_events SET coins=points;
 END IF;
END $$;
ALTER TABLE one_referral_score_events DROP CONSTRAINT IF EXISTS one_referral_score_events_type_values;
ALTER TABLE one_referral_score_events ADD CONSTRAINT one_referral_score_events_type_values
 CHECK (event_type IN ('base_qualification','flash_qualification','streak_bonus','reversal',
 'in_progress_activity','qualified_activity','app_streak_bonus','agent_usage','pkm_daily','connection_created'));
ALTER TABLE one_referral_score_events DROP CONSTRAINT IF EXISTS one_referral_score_events_coin_shape;
ALTER TABLE one_referral_score_events ADD CONSTRAINT one_referral_score_events_coin_shape
 CHECK ((event_type='reversal' AND coins<=0) OR (event_type<>'reversal' AND coins>=0));

ALTER TABLE one_referral_streak_state ADD COLUMN IF NOT EXISTS last_activity_date DATE;
ALTER TABLE one_referral_streak_state ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0);
ALTER TABLE one_referral_streak_state ADD COLUMN IF NOT EXISTS longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= current_streak);
CREATE TABLE IF NOT EXISTS one_referral_activity_days (
 user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 activity_date DATE NOT NULL, timezone TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (user_id, activity_date)
);
ALTER TABLE one_referral_milestone_entitlements ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE one_referral_reward_rounds ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE one_referral_leaderboard_snapshots ADD COLUMN IF NOT EXISTS source_event_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE one_referral_reward_rounds DROP CONSTRAINT IF EXISTS one_referral_reward_rounds_status_values;
ALTER TABLE one_referral_reward_rounds ADD CONSTRAINT one_referral_reward_rounds_status_values
 CHECK (status IN ('scheduled','ended','reconciling','finalized','cancelled'));

-- Activate a versioned policy rather than rewriting earned history.
DO $$
DECLARE prior one_referral_program_settings%ROWTYPE;
BEGIN
 LOCK TABLE one_referral_program_settings IN SHARE ROW EXCLUSIVE MODE;
 IF NOT EXISTS (SELECT 1 FROM one_referral_program_settings WHERE version = 4) THEN
  SELECT * INTO STRICT prior FROM one_referral_program_settings
   WHERE activated_at IS NOT NULL AND retired_at IS NULL;
  UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = prior.version;
  INSERT INTO one_referral_program_settings
   (version, qualification_policy_version, points, milestones, streak_rules, flash_windows,
    weekly_schedule, prize_catalogue, tie_break_rules, fulfillment_config, feature_active, activated_at)
  VALUES (4, 2,
   prior.points || '{"referral_in_progress_points":5,"referral_qualified_activity_total_points":15,"agent_usage_points":10,"pkm_daily_points":15,"connection_created_points":5,"referral_activity_policy":"upgrade"}'::JSONB,
   prior.milestones, prior.streak_rules || '{"activity_source":"app_open"}'::JSONB,
   prior.flash_windows, prior.weekly_schedule, prior.prize_catalogue,
   prior.tie_break_rules || '{"individual":"coins_desc_first_earned_asc_user_id_asc","circle":"qualified_referrals_desc_created_at_asc_id_asc"}'::JSONB,
   prior.fulfillment_config, prior.feature_active, NOW());
 ELSE
  SELECT * INTO STRICT prior FROM one_referral_program_settings WHERE version=3;
  IF NOT EXISTS(SELECT 1 FROM one_referral_program_settings s WHERE s.version=4
    AND s.activated_at IS NOT NULL AND s.retired_at IS NULL AND s.qualification_policy_version=2
    AND s.points=prior.points || '{"referral_in_progress_points":5,"referral_qualified_activity_total_points":15,"agent_usage_points":10,"pkm_daily_points":15,"connection_created_points":5,"referral_activity_policy":"upgrade"}'::JSONB
    AND s.milestones=prior.milestones AND s.streak_rules=prior.streak_rules || '{"activity_source":"app_open"}'::JSONB
    AND s.flash_windows=prior.flash_windows AND s.weekly_schedule=prior.weekly_schedule
    AND s.prize_catalogue=prior.prize_catalogue AND s.fulfillment_config=prior.fulfillment_config
    AND s.feature_active=prior.feature_active
    AND s.tie_break_rules=prior.tie_break_rules || '{"individual":"coins_desc_first_earned_asc_user_id_asc","circle":"qualified_referrals_desc_created_at_asc_id_asc"}'::JSONB) THEN
   RAISE EXCEPTION 'migration 347: conflicting or inactive program settings 4';
  END IF;
 END IF;
END $$;

-- The persisted reply, not a client heartbeat, proves product usage. No content is copied.
CREATE OR REPLACE FUNCTION one_referral_record_completed_reply() RETURNS TRIGGER AS $$
BEGIN
 IF NEW.role = 'assistant' AND NEW.status = 'complete' AND NEW.error_code IS NULL
    AND NEW.completed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM agent_chat_messages u
      WHERE u.conversation_id = NEW.conversation_id AND u.user_id = NEW.user_id
        AND u.role = 'user' AND u.status = 'complete' AND u.created_at <= NEW.created_at)
    AND EXISTS (SELECT 1 FROM actor_profiles WHERE user_id = NEW.user_id) THEN
  INSERT INTO one_referral_events (user_id,event_type,idempotency_key,server_timestamp,metadata)
   VALUES (NEW.user_id,'product_usage','agent_reply:' || NEW.id,NEW.completed_at,
           jsonb_build_object('message_id',NEW.id,'occurred_at',NEW.completed_at))
   ON CONFLICT (idempotency_key) DO NOTHING;
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS one_referral_completed_reply ON agent_chat_messages;
CREATE TRIGGER one_referral_completed_reply AFTER INSERT ON agent_chat_messages
 FOR EACH ROW EXECUTE FUNCTION one_referral_record_completed_reply();
CREATE INDEX IF NOT EXISTS one_referral_events_product_usage
 ON one_referral_events(user_id,server_timestamp) WHERE event_type = 'product_usage';
CREATE INDEX IF NOT EXISTS one_referral_events_unscored_usage
 ON one_referral_events(id) WHERE event_type='product_usage' AND scored_at IS NULL;

-- Extend the existing How It Works product rewards at their trusted write owners.
CREATE OR REPLACE FUNCTION one_referral_record_product_reward() RETURNS TRIGGER AS $$
DECLARE cfg one_referral_program_settings%ROWTYPE; uid TEXT; award INTEGER; kind TEXT; reward_key TEXT;
BEGIN
 SELECT * INTO cfg FROM one_referral_program_settings WHERE activated_at IS NOT NULL AND retired_at IS NULL;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='pkm_data' THEN
  IF TG_OP='UPDATE' AND NEW.encrypted_data_ciphertext IS NOT DISTINCT FROM OLD.encrypted_data_ciphertext THEN RETURN NEW; END IF;
  kind := 'pkm_daily'; award := (cfg.points->>'pkm_daily_points')::INTEGER;
  uid := NEW.user_id;
  reward_key := 'pkm_daily:' || uid || ':' || (NOW() AT TIME ZONE COALESCE(cfg.weekly_schedule->>'timezone','UTC'))::DATE;
  IF award>0 AND EXISTS(SELECT 1 FROM actor_profiles WHERE user_id=uid) THEN
   INSERT INTO one_referral_score_events(user_id,event_type,points,coins,settings_version,idempotency_key)
    VALUES(uid,kind,award,0,cfg.version,reward_key) ON CONFLICT DO NOTHING;
  END IF;
 ELSE
  IF NEW.status<>'active' OR (TG_OP='UPDATE' AND OLD.status='active') THEN RETURN NEW; END IF;
  kind := 'connection_created'; award := (cfg.points->>'connection_created_points')::INTEGER;
  FOREACH uid IN ARRAY ARRAY[NEW.user_a_id,NEW.user_b_id] LOOP
   reward_key := 'connection:' || uid || ':' || NEW.user_a_id || ':' || NEW.user_b_id;
   IF award>0 AND EXISTS(SELECT 1 FROM actor_profiles WHERE user_id=uid) THEN
    INSERT INTO one_referral_score_events(user_id,event_type,points,coins,settings_version,idempotency_key)
     VALUES(uid,kind,award,0,cfg.version,reward_key) ON CONFLICT DO NOTHING;
   END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS one_referral_pkm_daily ON pkm_data;
CREATE TRIGGER one_referral_pkm_daily AFTER INSERT OR UPDATE ON pkm_data
 FOR EACH ROW EXECUTE FUNCTION one_referral_record_product_reward();
DROP TRIGGER IF EXISTS one_referral_new_connection ON connections;
CREATE TRIGGER one_referral_new_connection AFTER INSERT OR UPDATE ON connections
 FOR EACH ROW EXECUTE FUNCTION one_referral_record_product_reward();

CREATE OR REPLACE FUNCTION one_referral_notify_score() RETURNS TRIGGER AS $$
BEGIN
 PERFORM pg_notify('one_referral_changed',json_build_object('referrer_user_id',NEW.user_id,'reason','score_changed')::TEXT);
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS one_referral_notify_score ON one_referral_score_events;
CREATE TRIGGER one_referral_notify_score AFTER INSERT ON one_referral_score_events
 FOR EACH ROW EXECUTE FUNCTION one_referral_notify_score();
DROP TRIGGER IF EXISTS one_referral_notify_streak ON one_referral_streak_state;
CREATE TRIGGER one_referral_notify_streak AFTER INSERT OR UPDATE ON one_referral_streak_state
 FOR EACH ROW EXECUTE FUNCTION one_referral_notify_score();
DROP TRIGGER IF EXISTS one_referral_notify_reward_claim ON one_referral_milestone_entitlements;
CREATE TRIGGER one_referral_notify_reward_claim AFTER UPDATE ON one_referral_milestone_entitlements
 FOR EACH ROW EXECUTE FUNCTION one_referral_notify_score();
CREATE OR REPLACE FUNCTION one_referral_notify_leaderboard() RETURNS TRIGGER AS $$
BEGIN
 PERFORM pg_notify('one_referral_changed','{"reason":"leaderboard_published"}');
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS one_referral_notify_leaderboard ON one_referral_leaderboard_snapshots;
CREATE TRIGGER one_referral_notify_leaderboard AFTER INSERT ON one_referral_leaderboard_snapshots
 FOR EACH ROW EXECUTE FUNCTION one_referral_notify_leaderboard();

-- Referral genealogy never grants Location Circle access or capacity.
CREATE TABLE IF NOT EXISTS one_referral_network_circles (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 leader_user_id TEXT NOT NULL UNIQUE REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS one_referral_network_members (
 user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 circle_id UUID NOT NULL REFERENCES one_referral_network_circles(id) ON DELETE CASCADE,
 parent_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 relationship_id UUID UNIQUE REFERENCES one_referral_relationships(id) ON DELETE CASCADE,
 joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (parent_user_id IS DISTINCT FROM user_id),
 CHECK ((parent_user_id IS NULL) = (relationship_id IS NULL))
);
CREATE INDEX IF NOT EXISTS one_referral_network_members_circle ON one_referral_network_members(circle_id);

CREATE OR REPLACE FUNCTION one_referral_bind_network() RETURNS TRIGGER AS $$
DECLARE parent_circle UUID; previous_circle UUID;
BEGIN
 -- A single graph mutation lock prevents cycles and competing first memberships.
 PERFORM pg_advisory_xact_lock(332,1);
 IF EXISTS (
  WITH RECURSIVE ancestors(uid,path) AS (
   SELECT NEW.referrer_user_id, ARRAY[NEW.referrer_user_id]
   UNION ALL SELECT r.referrer_user_id, a.path || r.referrer_user_id
     FROM ancestors a JOIN one_referral_relationships r ON r.referred_user_id = a.uid
    WHERE NOT r.referrer_user_id = ANY(a.path)
  ) SELECT 1 FROM ancestors WHERE uid = NEW.referred_user_id
 ) THEN RAISE EXCEPTION 'referral cycle' USING ERRCODE = 'check_violation'; END IF;
 SELECT circle_id INTO parent_circle FROM one_referral_network_members WHERE user_id = NEW.referrer_user_id;
 IF parent_circle IS NULL THEN
  INSERT INTO one_referral_network_circles(leader_user_id) VALUES(NEW.referrer_user_id)
   ON CONFLICT (leader_user_id) DO NOTHING;
  SELECT id INTO parent_circle FROM one_referral_network_circles WHERE leader_user_id = NEW.referrer_user_id;
  INSERT INTO one_referral_network_members(user_id,circle_id) VALUES(NEW.referrer_user_id,parent_circle);
 END IF;
 SELECT circle_id INTO previous_circle FROM one_referral_network_members
  WHERE user_id=NEW.referred_user_id AND parent_user_id IS NULL FOR UPDATE;
 IF previous_circle IS NOT NULL THEN
  -- A pending attribution can bind after its owner has already invited others.
  UPDATE one_referral_network_members SET circle_id=parent_circle WHERE circle_id=previous_circle;
  UPDATE one_referral_network_members SET parent_user_id=NEW.referrer_user_id,relationship_id=NEW.id
   WHERE user_id=NEW.referred_user_id;
  DELETE FROM one_referral_network_circles WHERE id=previous_circle;
 ELSE
  INSERT INTO one_referral_network_members(user_id,circle_id,parent_user_id,relationship_id)
   VALUES(NEW.referred_user_id,parent_circle,NEW.referrer_user_id,NEW.id);
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS one_referral_bind_network ON one_referral_relationships;
CREATE TRIGGER one_referral_bind_network AFTER INSERT ON one_referral_relationships
 FOR EACH ROW EXECUTE FUNCTION one_referral_bind_network();

-- Backfill existing rooted trees; refuse unresolved/cyclic graphs instead of guessing.
INSERT INTO one_referral_network_circles(leader_user_id)
 SELECT DISTINCT r.referrer_user_id FROM one_referral_relationships r
 WHERE NOT EXISTS (SELECT 1 FROM one_referral_relationships p WHERE p.referred_user_id = r.referrer_user_id)
 ON CONFLICT DO NOTHING;
INSERT INTO one_referral_network_members(user_id,circle_id)
 SELECT leader_user_id,id FROM one_referral_network_circles ON CONFLICT DO NOTHING;
WITH RECURSIVE network(uid,circle_id,parent,rid,path) AS (
 SELECT c.leader_user_id,c.id,NULL::TEXT,NULL::UUID,ARRAY[c.leader_user_id] FROM one_referral_network_circles c
 UNION ALL SELECT r.referred_user_id,n.circle_id,r.referrer_user_id,r.id,n.path || r.referred_user_id
  FROM network n JOIN one_referral_relationships r ON r.referrer_user_id = n.uid
 WHERE NOT r.referred_user_id = ANY(n.path)
)
INSERT INTO one_referral_network_members(user_id,circle_id,parent_user_id,relationship_id)
 SELECT uid,circle_id,parent,rid FROM network WHERE rid IS NOT NULL ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM one_referral_relationships r LEFT JOIN one_referral_network_members m
 ON m.user_id = r.referred_user_id WHERE m.user_id IS NULL) THEN
  RAISE EXCEPTION 'migration 347: unresolved referral genealogy requires audited repair';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION one_referral_rebuild_network() RETURNS VOID AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(332,1);
 INSERT INTO one_referral_network_circles(leader_user_id)
  SELECT DISTINCT r.referrer_user_id FROM one_referral_relationships r
   WHERE NOT EXISTS(SELECT 1 FROM one_referral_relationships p WHERE p.referred_user_id=r.referrer_user_id)
  ON CONFLICT DO NOTHING;
 WITH RECURSIVE network(uid,circle_id,parent,rid,path) AS (
  SELECT c.leader_user_id,c.id,NULL::TEXT,NULL::UUID,ARRAY[c.leader_user_id] FROM one_referral_network_circles c
   WHERE NOT EXISTS(SELECT 1 FROM one_referral_relationships r WHERE r.referred_user_id=c.leader_user_id)
  UNION ALL SELECT r.referred_user_id,n.circle_id,r.referrer_user_id,r.id,n.path || r.referred_user_id
   FROM network n JOIN one_referral_relationships r ON r.referrer_user_id=n.uid
   WHERE NOT r.referred_user_id=ANY(n.path)
 ) INSERT INTO one_referral_network_members(user_id,circle_id,parent_user_id,relationship_id)
   SELECT uid,circle_id,parent,rid FROM network
   ON CONFLICT(user_id) DO UPDATE SET circle_id=EXCLUDED.circle_id,
     parent_user_id=EXCLUDED.parent_user_id,relationship_id=EXCLUDED.relationship_id;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION one_referral_network_after_account_delete() RETURNS TRIGGER AS $$
BEGIN
 PERFORM one_referral_rebuild_network();
 RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS one_referral_network_account_delete ON actor_profiles;
CREATE TRIGGER one_referral_network_account_delete AFTER DELETE ON actor_profiles
 FOR EACH ROW EXECUTE FUNCTION one_referral_network_after_account_delete();

ALTER TABLE one_referral_network_circles ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_referral_network_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_referral_activity_days ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
  PERFORM public.install_account_deletion_write_guards();
 END IF;
END $$;
COMMIT;
