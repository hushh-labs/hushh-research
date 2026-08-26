-- Referral program invariants, asserted against a real Postgres.
--
-- The static contract test (tests/test_one_referral_program_migration.py) proves
-- the constraints are WRITTEN. This proves they BITE. Run it against a database
-- that has migration 165 applied:
--
--   psql "$DATABASE_URL" -f db/verify/verify_one_referral_invariants.sql
--
-- Every line of output starts PASS or *** FAIL ***. It creates three synthetic
-- identities prefixed test_ and leaves them behind; run it against a throwaway
-- database, never against UAT with real accounts in it.

\set ON_ERROR_STOP on
\pset tuples_only on

-- Re-runnable: clear anything a previous run of THIS file left behind, in
-- dependency order. Scoped to the test_ identities only -- it must never be
-- able to touch a real referral, even if someone runs it somewhere it does not
-- belong.
DELETE FROM one_referral_risk_reviews WHERE relationship_id IN
  (SELECT id FROM one_referral_relationships WHERE starts_with(referrer_user_id, 'test_'));
DELETE FROM one_referral_events WHERE starts_with(user_id, 'test_');
DELETE FROM one_agent_engagement_sessions WHERE starts_with(user_id, 'test_');
DELETE FROM one_referral_relationships WHERE starts_with(referrer_user_id, 'test_');
DELETE FROM one_referral_attributions WHERE starts_with(referrer_user_id, 'test_');
DELETE FROM one_referral_codes WHERE starts_with(owner_user_id, 'test_');
DELETE FROM one_referral_policies WHERE version > 1;

-- Synthetic test identities. Marked as test data by the uid prefix.
INSERT INTO vault_keys (user_id, primary_method, created_at, updated_at, vault_status)
VALUES ('test_referrer_a','passphrase',0,0,'placeholder'), ('test_referred_b','passphrase',0,0,'placeholder'), ('test_other_c','passphrase',0,0,'placeholder')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO actor_profiles (user_id) VALUES ('test_referrer_a'),('test_referred_b'),('test_other_c')
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION assert_rejects(stmt TEXT, label TEXT) RETURNS TEXT AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    RETURN 'PASS  ' || label;
  END;
  RETURN '*** FAIL *** ' || label || ' -- statement was ACCEPTED';
END;
$$ LANGUAGE plpgsql;

SELECT 'PASS  policy v1 seeded at 900s / 3 events'
  FROM one_referral_policies
 WHERE version=1 AND required_active_seconds=900 AND minimum_meaningful_events=3
   AND activated_at IS NOT NULL AND retired_at IS NULL;

SELECT assert_rejects(
  $$INSERT INTO one_referral_policies (version,attribution_window_days,qualification_window_days,required_active_seconds,minimum_meaningful_events,activated_at)
    VALUES (2,30,7,1200,3,NOW())$$,
  'second ACTIVE policy rejected (single-active index)');

SELECT assert_rejects(
  $$INSERT INTO one_referral_policies (version,attribution_window_days,qualification_window_days,required_active_seconds,minimum_meaningful_events,heartbeat_interval_seconds,max_credit_per_heartbeat_secs)
    VALUES (3,30,7,900,3,30,60)$$,
  'per-heartbeat credit above the beat interval rejected');

INSERT INTO one_referral_codes (owner_user_id,slug,normalized_slug,policy_version)
VALUES ('test_referrer_a','Ankit-7k4m','ankit-7k4m',1);

SELECT assert_rejects(
  $$INSERT INTO one_referral_codes (owner_user_id,slug,normalized_slug,policy_version)
    VALUES ('test_referrer_a','Ankit-9z9z','ankit-9z9z',1)$$,
  'second ACTIVE slug for one owner rejected');

SELECT assert_rejects(
  $$INSERT INTO one_referral_codes (owner_user_id,slug,normalized_slug,policy_version)
    VALUES ('test_other_c','Ankit-7K4M','ankit-7k4m',1)$$,
  'duplicate normalized slug rejected (case-insensitive collision)');

SELECT assert_rejects(
  $$INSERT INTO one_referral_codes (owner_user_id,slug,normalized_slug,policy_version)
    VALUES ('test_other_c','Bad Slug','Bad Slug',1)$$,
  'unnormalized slug shape rejected');

INSERT INTO one_referral_attributions (id,referral_code_id,referrer_user_id,policy_version,expires_at)
SELECT '11111111-1111-1111-1111-111111111111', id,'test_referrer_a',1,NOW()+INTERVAL '30 days'
  FROM one_referral_codes WHERE normalized_slug='ankit-7k4m';

SELECT assert_rejects(
  $$UPDATE one_referral_attributions SET bound_user_id='test_referrer_a', bound_at=NOW(), status='bound'
     WHERE id='11111111-1111-1111-1111-111111111111'$$,
  'self-attribution rejected at bind time');

UPDATE one_referral_attributions SET bound_user_id='test_referred_b', bound_at=NOW(), status='bound'
 WHERE id='11111111-1111-1111-1111-111111111111';

INSERT INTO one_referral_relationships (id,attribution_id,referrer_user_id,referred_user_id,policy_version)
VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','test_referrer_a','test_referred_b',1);

SELECT assert_rejects(
  $$INSERT INTO one_referral_relationships (attribution_id,referrer_user_id,referred_user_id,policy_version)
    VALUES ('11111111-1111-1111-1111-111111111111','test_other_c','test_referred_b',1)$$,
  'second referrer for one referred user rejected');

SELECT assert_rejects(
  $$INSERT INTO one_referral_relationships (attribution_id,referrer_user_id,referred_user_id,policy_version)
    VALUES ('11111111-1111-1111-1111-111111111111','test_other_c','test_other_c',1)$$,
  'self-referral relationship rejected');

-- State machine
SELECT assert_rejects(
  $$UPDATE one_referral_relationships SET status='qualified', qualified_at=NOW()
     WHERE id='22222222-2222-2222-2222-222222222222'$$,
  'attributed -> qualified rejected (skipping the whole funnel)');

UPDATE one_referral_relationships SET status='signed_up' WHERE id='22222222-2222-2222-2222-222222222222';
UPDATE one_referral_relationships SET status='phone_verified' WHERE id='22222222-2222-2222-2222-222222222222';
UPDATE one_referral_relationships SET status='onboarded' WHERE id='22222222-2222-2222-2222-222222222222';
UPDATE one_referral_relationships SET status='engaging' WHERE id='22222222-2222-2222-2222-222222222222';
SELECT 'PASS  legal funnel walk attributed -> engaging accepted';

SELECT assert_rejects(
  $$UPDATE one_referral_relationships SET status='qualified'
     WHERE id='22222222-2222-2222-2222-222222222222'$$,
  'qualified without qualified_at rejected');

UPDATE one_referral_relationships SET status='qualified', qualified_at=NOW() WHERE id='22222222-2222-2222-2222-222222222222';
UPDATE one_referral_relationships SET status='revoked', revoked_at=NOW() WHERE id='22222222-2222-2222-2222-222222222222';

SELECT assert_rejects(
  $$UPDATE one_referral_relationships SET status='qualified'
     WHERE id='22222222-2222-2222-2222-222222222222'$$,
  'revoked -> qualified rejected (terminal state is terminal)');

-- Engagement accounting
INSERT INTO one_agent_engagement_sessions (id,user_id,agent_key,started_at,last_heartbeat_at,credited_active_seconds)
VALUES ('33333333-3333-3333-3333-333333333333','test_referred_b','one_location',NOW()-INTERVAL '10 minutes',NOW(),300);

SELECT assert_rejects(
  $$UPDATE one_agent_engagement_sessions SET credited_active_seconds=-1
     WHERE id='33333333-3333-3333-3333-333333333333'$$,
  'negative credited time rejected');

SELECT assert_rejects(
  $$UPDATE one_agent_engagement_sessions SET credited_active_seconds=3600
     WHERE id='33333333-3333-3333-3333-333333333333'$$,
  'credited time exceeding session wall-clock span rejected (replay defence)');

-- Event replay
INSERT INTO one_referral_events (user_id,event_type,idempotency_key)
VALUES ('test_referred_b','engagement_heartbeat','beat-0001');

SELECT assert_rejects(
  $$INSERT INTO one_referral_events (user_id,event_type,idempotency_key)
    VALUES ('test_referred_b','engagement_heartbeat','beat-0001')$$,
  'replayed heartbeat idempotency key rejected');

-- Risk review audit
SELECT assert_rejects(
  $$INSERT INTO one_referral_risk_reviews (relationship_id,risk_level,decision)
    VALUES ('22222222-2222-2222-2222-222222222222','medium','approved')$$,
  'approval with no decided_by / decided_at rejected (unattributed decision)');
