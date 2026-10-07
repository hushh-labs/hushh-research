-- Admit the first-party Instagram Graph adapter as a distinct connector transport.
BEGIN;

ALTER TABLE external_mcp_connectors
  DROP CONSTRAINT IF EXISTS external_connector_transport_check;
ALTER TABLE external_mcp_connectors
  ADD CONSTRAINT external_connector_transport_check
  CHECK (transport_kind IN ('mcp', 'google_drive_rest', 'instagram_graph_rest'));

COMMIT;
