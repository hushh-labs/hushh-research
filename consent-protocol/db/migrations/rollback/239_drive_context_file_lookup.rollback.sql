-- Data-preserving code rollback. The index is harmless without the preview
-- endpoint and keeping it avoids a blocking rebuild on a later rollout.
BEGIN;
SELECT 1;
COMMIT;
