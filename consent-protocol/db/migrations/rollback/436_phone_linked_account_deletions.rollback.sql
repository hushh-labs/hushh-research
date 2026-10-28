-- Do not contract away consumed proofs or admitted deletions to force rollback.
DO $$ BEGIN
 IF to_regclass('public.account_phone_linked_deletions') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.account_phone_linked_deletions) THEN
   RAISE EXCEPTION 'PHONE_LINKED_DELETION_RECEIPTS_RETAINED: use compatible application rollback';
  END IF;
 END IF;
END $$;
DROP TABLE IF EXISTS public.account_phone_linked_deletions;
