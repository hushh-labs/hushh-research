-- Retained membership and mutation receipts are an authority boundary. Drain
-- WorkOS consumers and reconcile all outstanding operations before rollback.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.account_workos_memberships)
 OR EXISTS(SELECT 1 FROM public.account_firebase_mutations WHERE purpose IN ('sso_claims','sso_create','sso_offboarding')) THEN
  RAISE EXCEPTION 'WorkOS generation evidence must be preserved' USING ERRCODE='42501';
 END IF;
END; $$;
DROP TABLE public.account_workos_memberships;
DROP FUNCTION public.guard_workos_generation_membership();
ALTER TABLE public.account_firebase_mutations DROP CONSTRAINT account_firebase_mutations_purpose_check;
ALTER TABLE public.account_firebase_mutations ADD CONSTRAINT account_firebase_mutations_purpose_check
 CHECK(purpose IN ('display_name','welcome_marker','phone_unlink'));
