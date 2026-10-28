-- Existing reconciled history and owner resources are deliberately retained.
DROP FUNCTION IF EXISTS public.reconcile_hosted_bucket_absence(text,text,jsonb,jsonb);
