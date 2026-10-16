-- Extend canonical referral selections and contributions; never backfill consent.
BEGIN;
ALTER TABLE one_referral_circle_selections ADD COLUMN IF NOT EXISTS round_id UUID
 REFERENCES one_referral_reward_rounds(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_circle_selection_per_round
 ON one_referral_circle_selections(round_id,user_id) WHERE round_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS one_referral_circle_teams (
 round_id UUID NOT NULL REFERENCES one_referral_reward_rounds(id) ON DELETE CASCADE,
 circle_id UUID NOT NULL REFERENCES one_location_circles(id) ON DELETE CASCADE,
 team_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 PRIMARY KEY(round_id,circle_id)
);
ALTER TABLE one_referral_circle_contributions ADD COLUMN IF NOT EXISTS round_id UUID
 REFERENCES one_referral_reward_rounds(id) ON DELETE CASCADE;
ALTER TABLE one_referral_circle_contributions ADD COLUMN IF NOT EXISTS selection_id UUID
 REFERENCES one_referral_circle_selections(id) ON DELETE CASCADE;
ALTER TABLE one_referral_scoring_jobs ADD COLUMN IF NOT EXISTS circle_selection_id UUID
 REFERENCES one_referral_circle_selections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS one_referral_circle_contributions_round
 ON one_referral_circle_contributions(round_id,circle_id);

-- Capture eligibility when qualification enqueues its durable job. The worker
-- settles that snapshot, even after a member leaves or the week rolls over.
CREATE OR REPLACE FUNCTION one_referral_circle_job_snapshot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('one-circle-wars:' || NEW.user_id,0));
 SELECT s.id INTO NEW.circle_selection_id
 FROM one_referral_relationships r
 JOIN one_referral_attributions a ON a.id=r.attribution_id
 JOIN one_referral_circle_selections s ON s.user_id=r.referrer_user_id
 JOIN one_referral_reward_rounds w ON w.id=s.round_id
 JOIN one_location_circles c ON c.id=s.circle_id
 JOIN one_location_circle_memberships m ON m.circle_id=c.id AND m.user_id=s.user_id
 WHERE r.id=NEW.relationship_id AND r.referrer_user_id=NEW.user_id
  AND r.status='qualified' AND a.status='bound'
  AND a.referrer_user_id=s.user_id AND a.bound_user_id=r.referred_user_id
  AND a.first_seen_at>=s.selected_at AND r.created_at>=s.selected_at
  AND r.qualified_at>=s.selected_at AND r.qualified_at<s.ended_at
  AND r.qualified_at>=w.started_at AND r.qualified_at<w.cutoff_at
  AND c.status='active' AND m.status='active'
  AND (c.system_kind IS DISTINCT FROM 'trusted' OR c.owner_user_id=s.user_id)
 ORDER BY s.selected_at DESC LIMIT 1;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_referral_circle_job_snapshot ON one_referral_scoring_jobs;
CREATE TRIGGER one_referral_circle_job_snapshot BEFORE INSERT ON one_referral_scoring_jobs
 FOR EACH ROW EXECUTE FUNCTION one_referral_circle_job_snapshot();

CREATE OR REPLACE FUNCTION one_referral_circle_weekly_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.round_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'weekly circle history is immutable' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_referral_circle_weekly_immutable ON one_referral_circle_selections;
CREATE TRIGGER one_referral_circle_weekly_immutable BEFORE UPDATE ON one_referral_circle_selections
 FOR EACH ROW EXECUTE FUNCTION one_referral_circle_weekly_immutable();
DROP TRIGGER IF EXISTS one_referral_circle_credit_immutable ON one_referral_circle_contributions;
CREATE TRIGGER one_referral_circle_credit_immutable BEFORE UPDATE ON one_referral_circle_contributions
 FOR EACH ROW EXECUTE FUNCTION one_referral_circle_weekly_immutable();

CREATE OR REPLACE FUNCTION one_referral_circle_wars_notify() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('one_referral_changed','{"reason":"circle_wars_changed"}');
 RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS one_referral_circle_join_notify ON one_referral_circle_selections;
CREATE TRIGGER one_referral_circle_join_notify AFTER INSERT OR DELETE ON one_referral_circle_selections
 FOR EACH STATEMENT EXECUTE FUNCTION one_referral_circle_wars_notify();
DROP TRIGGER IF EXISTS one_referral_circle_score_notify ON one_referral_circle_contributions;
CREATE TRIGGER one_referral_circle_score_notify AFTER INSERT OR DELETE ON one_referral_circle_contributions
 FOR EACH STATEMENT EXECUTE FUNCTION one_referral_circle_wars_notify();
DROP TRIGGER IF EXISTS one_referral_circle_revoke_notify ON one_referral_relationships;
CREATE TRIGGER one_referral_circle_revoke_notify AFTER UPDATE OF status ON one_referral_relationships
 FOR EACH ROW WHEN (OLD.status='qualified' AND NEW.status<>'qualified')
 EXECUTE FUNCTION one_referral_circle_wars_notify();
ALTER TABLE one_referral_circle_teams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_referral_circle_teams FROM PUBLIC;
COMMENT ON TABLE one_referral_circle_teams IS 'Random weekly public aliases; private Circle names and IDs remain membership-gated. No new membership or score authority.';
DO $$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON one_referral_circle_teams FROM %I',role_name);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON one_referral_circle_teams TO service_role;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
  PERFORM public.install_account_deletion_write_guards();
 END IF;
END $$;
COMMIT;
