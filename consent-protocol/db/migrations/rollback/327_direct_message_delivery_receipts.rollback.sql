-- Roll back application readers first. Run only under a write freeze; testing
-- uses a disposable database. Existing message envelopes/read states survive.
BEGIN;
DO $$ DECLARE v_has_tombstone BOOLEAN; BEGIN
  IF to_regclass('public.account_deletion_tombstones') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.account_deletion_tombstones)' INTO v_has_tombstone;
    IF v_has_tombstone THEN RAISE EXCEPTION 'Schema rollback is forbidden after an account tombstone'; END IF;
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_direct_message_delivery_guard ON public.messages;
DROP FUNCTION IF EXISTS public.guard_direct_message_delivery_write();
ALTER TABLE public.messages DROP COLUMN IF EXISTS delivered_at;
COMMIT;
