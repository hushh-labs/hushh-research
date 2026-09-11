-- Consumer MCP workstream: additive OAuth audience binding, dev lane only.
-- Existing unbound developer credentials retain their original permissions.
-- A resource-bound connection must repeat the audience at exchange and refresh.
BEGIN;
ALTER TABLE developer_oauth_authorizations ADD COLUMN IF NOT EXISTS resource TEXT;
COMMIT;
