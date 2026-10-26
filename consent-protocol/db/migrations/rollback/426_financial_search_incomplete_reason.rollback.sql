-- Application rollback is independent of this compatible diagnostic expansion.
-- Never erase a saved failure reason just to force schema contraction.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM drive_owner_search_jobs WHERE error_code='search_incomplete') THEN
  RAISE EXCEPTION 'Retained incomplete search reasons require the expanded constraint';
 END IF;
END $$;
ALTER TABLE drive_owner_search_jobs DROP CONSTRAINT drive_owner_search_jobs_error_code_check;
ALTER TABLE drive_owner_search_jobs ADD CONSTRAINT drive_owner_search_jobs_error_code_check
 CHECK (error_code IN ('provider_unavailable','connection_changed','connector_unavailable',
 'provider_response_invalid','search_limit','search_expired'));
COMMIT;
