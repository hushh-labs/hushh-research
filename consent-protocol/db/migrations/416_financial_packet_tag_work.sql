-- Packet-private organizing work; no file access, sale or sharing authority.
BEGIN;
ALTER TABLE drive_packet_heads
  ADD COLUMN IF NOT EXISTS tagging_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tagging_next_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS predefined_query_version TEXT;
ALTER TABLE drive_owner_search_jobs ADD COLUMN IF NOT EXISTS retention_checked_at TIMESTAMPTZ;
ALTER TABLE user_external_connector_connections ADD COLUMN IF NOT EXISTS drive_packet_inspected_at TIMESTAMPTZ;
COMMENT ON COLUMN user_external_connector_connections.drive_packet_inspected_at IS
  'Opaque-owner enrollment scan housekeeping only; never OAuth freshness, processing approval or connection use. Refused placements rotate without reading content.';
COMMENT ON COLUMN drive_owner_search_jobs.retention_checked_at IS
  'Housekeeping inspection time only; never search progress or freshness. Advances bounded retained-period cleanup.';
CREATE INDEX IF NOT EXISTS drive_packet_tagging_due ON drive_packet_heads(tagging_next_at)
  WHERE tagging_pending AND packet_kind='provider_discovery' AND category='financial';
COMMENT ON COLUMN drive_packet_heads.tagging_pending IS
  'Owner/generation-fenced candidate-only local organizing queue. Placements are sealed in existing period search result metadata; cursor and policy are sealed in the packet build. No new whole-Drive index or user acceptance.';
COMMIT;
