-- A bounded retry receipt on existing packet work, never a new queue or consent.
BEGIN;
ALTER TABLE drive_packet_heads
  ADD COLUMN IF NOT EXISTS sale_finalization_revision BIGINT NOT NULL DEFAULT 0
    CHECK (sale_finalization_revision>=0);
COMMENT ON COLUMN drive_packet_heads.sale_finalization_revision IS
  'Latest owner discovery revision evaluated by immutable period sale finalization. Scalar retry receipt; no filenames, source identifiers, content, listing authority or permission grants. Existing owner/generation and packet worker leases own access; deleted with the packet head.';
COMMIT;
