-- 085_developer_partner_apps.sql
--
-- Partner-class developer apps for CRM systems operating the Hussh MCP.
--
-- Architecture rule: every CRM system gets its OWN partner app + token so
-- revocation, audit, and last-used telemetry stay per-system. Partner apps
-- are ops-provisioned (scripts/ops/provision_partner_developer_app.py) and
-- have no owner_firebase_uid, so they never collide with the self-serve
-- one-app-per-Firebase-user portal contract and stay invisible to it.
--
-- kind:
--   self_serve  - portal-provisioned human developer app (default, existing rows)
--   partner_crm - ops-provisioned app representing a CRM system (MuleSoft lane)
--
-- crm_id is a soft reference to enterprise_crm_registry.crm_id. No hard FK:
-- registry rows are per-environment and re-seedable, and a partner token may
-- be provisioned before its CRM registry row exists.

BEGIN;

ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'self_serve';
ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS crm_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_schema = current_schema()
          AND table_name = 'developer_apps'
          AND constraint_name = 'developer_apps_kind_check'
    ) THEN
        EXECUTE 'ALTER TABLE developer_apps ADD CONSTRAINT developer_apps_kind_check '
            || 'CHECK (kind IN (''self_serve'', ''partner_crm''))';
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_developer_apps_kind ON developer_apps(kind);

COMMIT;
