-- Live Drive background work defaults ON for a verified connected owner.
-- A stored OFF preference is an account choice and is never overwritten here.
-- The verified live policy hash remains unchanged so existing OAuth connections
-- do not require a reconnect solely because the product default changed.
BEGIN;

ALTER TABLE drive_live_preferences
  ALTER COLUMN background_enabled SET DEFAULT TRUE;

UPDATE external_mcp_connectors
SET description='Choose selected-file or live Drive access. Live access can share matching files for Trusted Circle requests while background access is on.',
    updated_at=clock_timestamp()
WHERE connector_id='google_drive'
  AND description='Choose selected-file or live Drive access. Connecting does not share files.';

-- The automatic worker is the only writer of background_preparation_required.
-- Requeue only live, pending requests with a currently valid live connector;
-- the worker opens the encrypted trusted marker and rechecks the current
-- Trusted Circle and Google permission boundaries before any provider call.
WITH resumed AS (
  UPDATE drive_share_requests r
  SET preparation_error_code=CASE
        WHEN r.bulk_search_started_at IS NULL THEN 'trusted_auto_queued'
        ELSE 'trusted_auto_active' END,
      preparation_next_at=clock_timestamp(),
      updated_at=clock_timestamp()
  FROM user_external_connector_connections c
  JOIN external_mcp_connectors policy ON policy.connector_id=c.connector_id
  LEFT JOIN drive_live_preferences pref ON pref.user_id=c.user_id
  WHERE r.user_id=c.user_id
    AND r.status='pending' AND r.expires_at>clock_timestamp()
    AND r.preparation_error_code='background_preparation_required'
    AND c.connector_id='google_drive' AND c.status='connected'
    AND c.validation_state='verified' AND c.connection_generation>0
    AND c.verified_policy_hash='dbc4482ec7624a41fc1e798f515812577309fffac713393be2047f1f54445005'
    AND policy.is_active AND policy.transport_kind='google_drive_rest'
    AND policy.mcp_endpoint='https://www.googleapis.com/drive/v3'
    AND policy.capability_policy='{"version":2,"profiles":{"selected":{"version":1,"access":"selected_files","mutations":false,"requireGenAiEligibility":true,"maxSelection":25},"live":{"version":1,"access":"live_drive","readTransport":"google_drive_mcp","share":"exact_file_viewer","backgroundPreparation":"separate_owner_consent"}}}'::jsonb
    AND (pref.user_id IS NULL OR (pref.background_enabled=TRUE
      AND pref.disclosure_version='live-drive-background-v1'))
  RETURNING r.request_id,r.user_id
)
UPDATE drive_owner_search_jobs j
SET next_at=clock_timestamp(),updated_at=clock_timestamp()
FROM resumed r
WHERE j.user_id=r.user_id AND j.client_request_id=r.request_id
  AND j.status='queued' AND j.next_at=j.expires_at
  AND j.expires_at>clock_timestamp();

COMMIT;
