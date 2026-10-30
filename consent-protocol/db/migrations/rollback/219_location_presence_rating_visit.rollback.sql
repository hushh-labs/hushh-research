BEGIN;
-- Deploy the previous presence writer before removing the optional pointer.
-- Existing encrypted visits, ratings and presence records remain untouched.
DROP TRIGGER IF EXISTS preserve_active_location_rating_visit ON one_location_nearby_visits;
DROP FUNCTION IF EXISTS preserve_active_location_rating_visit();
DROP TRIGGER IF EXISTS clear_location_presence_rating_visit ON one_location_nearby_presences;
DROP FUNCTION IF EXISTS clear_location_presence_rating_visit();
ALTER TABLE one_location_nearby_presences DROP COLUMN IF EXISTS rating_visit_id;
COMMIT;
