-- Migration 068: covering index on consent_audit(user_id, issued_at DESC)
--
-- Target query: get_audit_log()
--   SELECT ... FROM consent_audit WHERE user_id = $1 ORDER BY issued_at DESC
--   LIMIT $2 OFFSET $3
--
-- The existing idx_consent_user(user_id) satisfies the WHERE predicate but
-- forces a separate filesort for ORDER BY issued_at DESC on every page fetch.
-- A composite (user_id, issued_at DESC) index lets Postgres satisfy both the
-- equality filter and the ORDER BY in a single index scan, eliminating the
-- sort step on the hot paginated audit-log read path.
--
-- Online/rollback posture: CREATE INDEX CONCURRENTLY does not take an
-- ACCESS EXCLUSIVE lock so it runs without blocking live reads or writes on
-- the consent_audit table. IF NOT EXISTS makes re-runs idempotent. Drop with:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_consent_audit_user_issued;
--
-- Note: CONCURRENTLY cannot run inside a BEGIN/COMMIT block; this file is
-- intentionally transaction-free. The migration runner must execute it outside
-- an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_consent_audit_user_issued
    ON consent_audit (user_id, issued_at DESC);

COMMENT ON INDEX idx_consent_audit_user_issued IS
    'Covering index for paginated audit-log reads: WHERE user_id = $1 ORDER BY issued_at DESC.';
