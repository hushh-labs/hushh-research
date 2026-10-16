-- Roll back code first. Retain weekly selections/contributions for audit;
-- removing the feature must never turn weekly opt-ins into lifetime consent.
BEGIN;
DROP TRIGGER IF EXISTS one_referral_circle_job_snapshot ON one_referral_scoring_jobs;
DROP FUNCTION IF EXISTS one_referral_circle_job_snapshot();
DROP TRIGGER IF EXISTS one_referral_circle_join_notify ON one_referral_circle_selections;
DROP TRIGGER IF EXISTS one_referral_circle_score_notify ON one_referral_circle_contributions;
DROP TRIGGER IF EXISTS one_referral_circle_revoke_notify ON one_referral_relationships;
DROP FUNCTION IF EXISTS one_referral_circle_wars_notify();
COMMIT;
