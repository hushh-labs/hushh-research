-- Expand the existing operational reason enum; no file or authority changes.
BEGIN;
ALTER TABLE drive_owner_search_jobs DROP CONSTRAINT IF EXISTS drive_owner_search_jobs_error_code_check;
ALTER TABLE drive_owner_search_jobs ADD CONSTRAINT drive_owner_search_jobs_error_code_check
 CHECK (error_code IN ('provider_unavailable','connection_changed','connector_unavailable',
 'provider_response_invalid','search_limit','search_expired','search_incomplete')) NOT VALID;
ALTER TABLE drive_owner_search_jobs VALIDATE CONSTRAINT drive_owner_search_jobs_error_code_check;
COMMIT;
