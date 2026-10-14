-- Removing custody inventory while any resource remains is unsafe.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.shared_files_storage) THEN
    RAISE EXCEPTION 'Shared Files storage inventory must be reconciled before rollback';
  END IF;
END $$;
DROP TABLE public.shared_files_storage;
COMMIT;
