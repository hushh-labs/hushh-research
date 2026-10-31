-- Roll back code first. These short-lived search results are not source-file authority.
BEGIN;
DROP TABLE IF EXISTS drive_owner_search_results;
DROP TABLE IF EXISTS drive_owner_search_jobs;
COMMIT;
