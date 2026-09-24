BEGIN;
DROP TABLE IF EXISTS drive_document_rules;
DROP TABLE IF EXISTS drive_share_live_sources;
DROP TABLE IF EXISTS drive_live_preferences;
UPDATE external_mcp_connectors
SET oauth_scopes = 'openid email https://www.googleapis.com/auth/drive.file',
    capability_policy = '{"version":1,"access":"selected_files","mutations":false,"requireGenAiEligibility":true,"maxSelection":25}'::jsonb,
    description = 'Select Google Drive files you allow One to inspect. Connecting does not share files.',
    updated_at = clock_timestamp()
WHERE connector_id = 'google_drive'
  AND oauth_scopes = 'openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive'
  AND capability_policy = '{"version":2,"profiles":{"selected":{"version":1,"access":"selected_files","mutations":false,"requireGenAiEligibility":true,"maxSelection":25},"live":{"version":1,"access":"live_drive","readTransport":"google_drive_mcp","share":"exact_file_viewer","backgroundPreparation":"separate_owner_consent"}}}'::jsonb;
COMMIT;
