BEGIN;
ALTER TABLE drive_packet_heads
  ADD COLUMN IF NOT EXISTS packet_kind TEXT NOT NULL DEFAULT 'content_facts',
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS period_start DATE,
  ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS period_timezone TEXT;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='drive_packet_heads'::regclass
  AND conname='drive_packet_period_kind') THEN
ALTER TABLE drive_packet_heads ADD CONSTRAINT drive_packet_period_kind CHECK (
  (packet_kind='content_facts' AND category IS NULL AND period_start IS NULL
    AND period_end IS NULL AND period_timezone IS NULL)
  OR (packet_kind='provider_discovery' AND category IS NOT NULL AND category IN ('financial','bank','brokerage','insurance')
    AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_end>=period_start
    AND period_timezone IS NOT NULL));
END IF;
END $$;
ALTER TABLE drive_owner_search_jobs ADD COLUMN IF NOT EXISTS period_packet_id UUID
  REFERENCES drive_packet_heads(packet_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS drive_period_packet_search ON drive_owner_search_jobs(period_packet_id)
  WHERE period_packet_id IS NOT NULL;
COMMENT ON COLUMN drive_packet_heads.packet_kind IS
  'Provider-discovery packets freeze encrypted metadata and Google query provenance; no content facts or citations are implied.';
COMMIT;
