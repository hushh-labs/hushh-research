-- Keep owner evidence; a no-op rollback cannot remove live capability obligations.
BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry WHERE
  jsonb_path_exists(backend_metadata,'$.**.azureFilesInventory'))
 OR EXISTS (SELECT 1 FROM public.personal_agent_standby_placements WHERE
  jsonb_path_exists(backend_metadata,'$.**.azureFilesInventory')) THEN
  RAISE EXCEPTION 'Azure Files obligations require reconciliation before schema rollback';
 END IF;
END $$;
DROP FUNCTION IF EXISTS public.azure_files_upgrade_admission_ready();
DROP FUNCTION IF EXISTS public.effective_erasure_azure_files_inventory(jsonb);
DROP FUNCTION IF EXISTS public.valid_erasure_files_upgrade_observation(jsonb,jsonb);
ALTER FUNCTION public.valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)
 RENAME TO valid_erasure_files_upgrade_observation;
DROP FUNCTION IF EXISTS public.valid_erasure_azure_files_upgrade_observation(jsonb,jsonb);
COMMIT;
