-- Roll back the application first. Retain security fences and unresolved remote
-- receipts: dropping them could restore a retired phone's access.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.account_phone_transfers WHERE state <> 'completed') THEN
  RAISE EXCEPTION 'phone transfer reconciliation required before rollback';
 END IF;
END $$;
DROP TRIGGER IF EXISTS pending_phone_transfer_erasure ON public.actor_profiles;
DROP FUNCTION IF EXISTS public.guard_pending_phone_transfer_erasure();
DROP TABLE public.account_phone_transfers;
-- phone admission fences and binding revisions deliberately survive rollback.
