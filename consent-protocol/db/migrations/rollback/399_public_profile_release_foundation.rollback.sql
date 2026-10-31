-- Forward-only additive foundation: preserve public evidence and owner handoff
-- receipts. Discovery and its drain remain disabled by their existing gates;
-- rolling application code back never deletes records or restores old checks.
BEGIN;
SELECT 1;
COMMIT;
