-- Additive queue/checkpoint columns are retained on code rollback.
-- Disable DRIVE_PERIOD_PACKETS_ENABLED and drain owned leases before reverting code.
-- No saved originals, tags or migration provenance is destroyed.
SELECT 1;
