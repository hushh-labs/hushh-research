-- Application rollback only: deploy the preceding application revision.
-- v5 has the same wire/schema shape and award amounts as v4. Retain its
-- approved catalogue and immutable policy lineage, all attendance and awards.
-- Retiring v5/reactivating v4 would create overlapping historical intervals
-- and prevent exact replay. Forward replay remains a verified no-op.
BEGIN;
SELECT 1;
COMMIT;
