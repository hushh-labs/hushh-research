-- Expand-only rollback: disable answer admission and return to the previous
-- application image. Retain mode bindings, dispatch timestamps and trigger.
-- Dropping them could make an unknown provider call eligible for recreation.
-- Reapply is idempotent. Reconcile all obligations before any schema removal.
BEGIN;
COMMIT;
