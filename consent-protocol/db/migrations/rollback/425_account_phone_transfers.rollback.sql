-- Roll back the application first. Retain security fences and unresolved receipts:
-- neither provider uncertainty nor a pending security notice permits erasure.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.account_phone_transfers
           WHERE state <> 'completed' OR notice_status <> 'settled') THEN
  RAISE EXCEPTION 'phone transfer reconciliation required before rollback';
 END IF;
END $$;
DROP TRIGGER IF EXISTS pending_phone_transfer_erasure ON public.actor_profiles;
DROP FUNCTION IF EXISTS public.guard_pending_phone_transfer_erasure();
DROP TABLE public.account_phone_transfers;
-- phone admission fences and binding revisions deliberately survive rollback.
