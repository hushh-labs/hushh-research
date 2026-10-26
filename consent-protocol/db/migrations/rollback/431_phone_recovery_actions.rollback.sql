-- Do not contract away consumed proofs or unknown effects to force rollback.
DO $$ BEGIN
 IF to_regclass('public.account_device_actions') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.account_device_actions) THEN
   RAISE EXCEPTION 'PHONE_RECOVERY_RECEIPTS_RETAINED: use compatible application rollback';
  END IF;
 END IF;
 IF to_regclass('public.account_phone_recovery_continuations') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.account_phone_recovery_continuations) THEN
   RAISE EXCEPTION 'PHONE_RECOVERY_RECEIPTS_RETAINED: use compatible application rollback';
  END IF;
 END IF;
END $$;
DROP TABLE IF EXISTS public.account_device_actions;
DROP TABLE IF EXISTS public.account_phone_recovery_continuations;
