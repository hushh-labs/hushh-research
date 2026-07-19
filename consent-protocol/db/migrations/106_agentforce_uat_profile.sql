-- 106_agentforce_uat_profile.sql
--
-- The Agentforce UAT catalog uses Salesforce-compatible tool aliases and is
-- intentionally separate from the generic flat profile. It is not a bypass
-- for Salesforce's current prohibition on personalized MCP responses.

BEGIN;

ALTER TABLE developer_apps
    DROP CONSTRAINT IF EXISTS developer_apps_schema_profile_check;
ALTER TABLE developer_apps
    ADD CONSTRAINT developer_apps_schema_profile_check
    CHECK (schema_profile IN ('standard', 'flat', 'agentforce'));

COMMENT ON COLUMN developer_apps.schema_profile IS
  'Authenticated MCP catalog projection. standard preserves v0.3; flat serves constrained generic hosts; agentforce is schema-registration UAT only and rejects personalized tool execution.';

COMMIT;
