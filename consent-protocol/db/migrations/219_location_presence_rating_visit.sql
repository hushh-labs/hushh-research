BEGIN;

-- Internal correlation only. Visit retention is independent of presence
-- retention, so this deliberately has no foreign key or public projection.
ALTER TABLE one_location_nearby_presences ADD COLUMN IF NOT EXISTS rating_visit_id UUID;

CREATE OR REPLACE FUNCTION clear_location_presence_rating_visit() RETURNS TRIGGER AS $$
BEGIN
  -- Older binaries rotate the alias on check-in but do not know this column.
  -- They must never carry a prior venue's visit into the new presence.
  IF NEW.participant_alias IS DISTINCT FROM OLD.participant_alias OR NEW.status <> 'active' THEN
    NEW.rating_visit_id := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clear_location_presence_rating_visit ON one_location_nearby_presences;
CREATE TRIGGER clear_location_presence_rating_visit BEFORE UPDATE ON one_location_nearby_presences
  FOR EACH ROW EXECUTE FUNCTION clear_location_presence_rating_visit();

-- An older binary can finish its broad visit closure after its checkout has
-- committed and a newer check-in has begun. Never let that late closure end
-- the new active presence's visit. New checkout clears its exact pointer in
-- the same transaction before closing that visit. This read takes no presence
-- lock: writers already lock presence before visit, so reversing that order
-- here would introduce a deadlock during mixed-version deployment.
CREATE OR REPLACE FUNCTION preserve_active_location_rating_visit() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM one_location_nearby_presences p
    WHERE p.owner_user_id = OLD.owner_user_id AND p.rating_visit_id = OLD.id
      AND p.status = 'active' AND p.expires_at > clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS preserve_active_location_rating_visit ON one_location_nearby_visits;
CREATE TRIGGER preserve_active_location_rating_visit BEFORE UPDATE OF ended_at ON one_location_nearby_visits
  FOR EACH ROW EXECUTE FUNCTION preserve_active_location_rating_visit();

COMMIT;
