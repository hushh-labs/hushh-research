-- Roll the application back before dropping its additive retry receipt.
-- Appended immutable versions and all request/listing bindings remain intact.
BEGIN;
ALTER TABLE drive_packet_heads DROP COLUMN IF EXISTS sale_finalization_revision;
COMMIT;
