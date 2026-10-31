-- Forward-only retained consent history. Disable publication without deleting evidence.
BEGIN;
UPDATE drive_packet_heads SET public_summary_enabled=FALSE WHERE public_summary_enabled;
COMMIT;
