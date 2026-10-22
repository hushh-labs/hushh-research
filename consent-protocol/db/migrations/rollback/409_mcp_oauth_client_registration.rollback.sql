-- Retire dynamic credentials before reverting serving code. Preserve additive columns and audit history;
-- deleting apps would cascade into credentials and potentially consent metadata.
BEGIN;
UPDATE developer_oauth_tokens SET revoked_at = (extract(epoch FROM now()) * 1000)::bigint
WHERE revoked_at IS NULL AND app_id IN (
  SELECT app_id FROM developer_apps WHERE kind = 'oauth_dynamic'
);
UPDATE developer_oauth_clients SET revoked_at = (extract(epoch FROM now()) * 1000)::bigint
WHERE registration_method IN ('dcr', 'cimd') AND revoked_at IS NULL;
UPDATE developer_apps SET status = 'suspended' WHERE kind = 'oauth_dynamic';
COMMIT;
