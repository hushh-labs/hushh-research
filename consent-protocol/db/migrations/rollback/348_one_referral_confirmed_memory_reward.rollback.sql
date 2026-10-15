-- Earned rewards and the legacy compatibility hook are preserved.
BEGIN;
DROP TRIGGER IF EXISTS one_referral_confirmed_memory_reward ON pkm_events;
DROP FUNCTION IF EXISTS one_referral_record_confirmed_memory_reward();
COMMIT;
