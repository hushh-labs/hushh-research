BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM one_attempt_email_preferences) OR EXISTS(SELECT 1 FROM one_attempt_email_outbox) THEN
    RAISE EXCEPTION 'rollback_refused_nonempty_attempt_email_state';
  END IF;
END $$;
DROP TRIGGER IF EXISTS one_attempt_email_observation ON one_product_activity_observations;
DROP TRIGGER IF EXISTS one_attempt_email_preference_fence ON one_attempt_email_preferences;
DROP TRIGGER IF EXISTS one_attempt_email_reset ON one_product_activity_epochs;
DROP TRIGGER IF EXISTS one_attempt_email_erasure ON account_deletion_tombstones;
DROP FUNCTION IF EXISTS public.enqueue_one_attempt_email();
DROP FUNCTION IF EXISTS public.fence_one_attempt_email_preference();
DROP FUNCTION IF EXISTS public.reset_one_attempt_email();
DROP FUNCTION IF EXISTS public.erase_one_attempt_email();
DROP TABLE IF EXISTS one_attempt_email_outbox;
DROP TABLE IF EXISTS one_attempt_email_preferences;
COMMIT;
