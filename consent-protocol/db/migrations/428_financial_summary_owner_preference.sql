-- Scalar summaries default ON by product policy, independently from private
-- preparation and exact-file purchase authority. Never fabricate acceptance.
BEGIN;

ALTER TABLE drive_live_preferences
  ADD COLUMN IF NOT EXISTS financial_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS financial_summary_revision BIGINT NOT NULL DEFAULT 0
    CHECK (financial_summary_revision>=0);

-- A legacy revision proves a personal decision; FALSE at revision zero was
-- merely the old default. Preserve any explicit hide as one owner-level OFF.
-- This is a bounded preference transfer (one row per owner), not a file backfill.
INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled,
  financial_summary_enabled,financial_summary_revision)
SELECT user_id,max(connection_generation),TRUE,FALSE,1
FROM drive_packet_heads
WHERE packet_kind='provider_discovery' AND category='financial'
  AND public_summary_revision>0 AND NOT public_summary_enabled
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET
  financial_summary_enabled=FALSE,financial_summary_revision=1
WHERE drive_live_preferences.financial_summary_revision=0;

-- During a rolling deploy an older API can still record a per-period hide.
-- Transfer that explicit revision increment into the one canonical owner OFF.
-- A legacy period ON cannot widen a saved owner OFF to every period or make
-- its legacy read surface visible. The BEFORE trigger returns the real FALSE.
CREATE OR REPLACE FUNCTION preserve_drive_financial_summary_hide()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.packet_kind='provider_discovery' AND NEW.category='financial'
    AND NEW.public_summary_revision>OLD.public_summary_revision
    AND NOT NEW.public_summary_enabled THEN
    INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled,
      financial_summary_enabled,financial_summary_revision)
    VALUES(NEW.user_id,NEW.connection_generation,TRUE,FALSE,1)
    ON CONFLICT(user_id) DO UPDATE SET financial_summary_enabled=FALSE,
      financial_summary_revision=drive_live_preferences.financial_summary_revision+1,
      updated_at=clock_timestamp()
    WHERE drive_live_preferences.financial_summary_enabled;
    UPDATE drive_packet_heads SET public_summary_enabled=FALSE
    WHERE user_id=NEW.user_id AND packet_id<>NEW.packet_id
      AND packet_kind='provider_discovery' AND category='financial'
      AND public_summary_enabled;
  END IF;
  IF NEW.packet_kind='provider_discovery' AND NEW.category='financial'
    AND NEW.public_summary_enabled AND EXISTS (
    SELECT 1 FROM drive_live_preferences WHERE user_id=NEW.user_id
      AND NOT financial_summary_enabled
  ) THEN
    NEW.public_summary_enabled=FALSE;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_drive_financial_summary_hide ON drive_packet_heads;
CREATE TRIGGER preserve_drive_financial_summary_hide
BEFORE UPDATE OF public_summary_enabled,public_summary_revision ON drive_packet_heads
FOR EACH ROW EXECUTE FUNCTION preserve_drive_financial_summary_hide();

-- Old readers must also observe a migrated owner OFF immediately. Preserve all
-- existing receipt history/version/generation bytes and every private manifest.
UPDATE drive_packet_heads h SET public_summary_enabled=FALSE
FROM drive_live_preferences p
WHERE h.user_id=p.user_id AND NOT p.financial_summary_enabled
  AND h.packet_kind='provider_discovery' AND h.category='financial'
  AND h.public_summary_enabled;

COMMENT ON COLUMN drive_live_preferences.financial_summary_enabled IS
  'Canonical owner-level scalar financial summary visibility. Product default true; recorded false survives reconnect, preparation and new periods. Grants no private file access. Legacy explicit per-period hides migrate to owner OFF.';
COMMENT ON COLUMN drive_live_preferences.financial_summary_revision IS
  'Owner summary visibility CAS revision, independent from background revision and immutable sale manifests. Zero means product default; no fabricated personal acceptance.';
COMMENT ON COLUMN drive_packet_heads.public_summary_enabled IS
  'Legacy per-period publication receipt retained for compatibility and rollback only. Current scalar visibility is owned by drive_live_preferences.financial_summary_enabled.';

COMMIT;
