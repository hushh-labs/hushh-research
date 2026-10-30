-- Extend the existing registry, not a second connector catalog.
-- is_active retains its legacy meaning: published in the curated catalog.
-- Private definitions MUST keep it false so older binaries cannot expose them.
BEGIN;

ALTER TABLE external_mcp_connectors
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS owner_enabled BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_mcp_private_visibility_check'
      AND conrelid = 'external_mcp_connectors'::regclass
  ) THEN
    ALTER TABLE external_mcp_connectors
      ADD CONSTRAINT external_mcp_private_visibility_check CHECK (
        (user_id IS NULL AND owner_enabled = FALSE)
        OR (user_id IS NOT NULL AND length(btrim(user_id)) > 0 AND is_active = FALSE)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS external_mcp_private_owner_idx
  ON external_mcp_connectors (user_id, connector_id)
  WHERE user_id IS NOT NULL;

COMMENT ON COLUMN external_mcp_connectors.user_id IS
  'NULL for operator-curated definitions; authenticated owner for private registrations. No bearer, file content, or private result belongs in registry metadata.';
COMMENT ON COLUMN external_mcp_connectors.owner_enabled IS
  'Private-registration availability only. Never publish a private definition via is_active; legacy readers filter on that column.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
