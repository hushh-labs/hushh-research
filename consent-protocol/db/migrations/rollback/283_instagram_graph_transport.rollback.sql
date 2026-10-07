-- Do not narrow the transport constraint while an Instagram definition exists.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM external_mcp_connectors
    WHERE transport_kind = 'instagram_graph_rest'
  ) THEN
    RAISE EXCEPTION 'remove Instagram connector definitions before rollback';
  END IF;
END $$;

ALTER TABLE external_mcp_connectors
  DROP CONSTRAINT IF EXISTS external_connector_transport_check;
ALTER TABLE external_mcp_connectors
  ADD CONSTRAINT external_connector_transport_check
  CHECK (transport_kind IN ('mcp', 'google_drive_rest'));

COMMIT;
