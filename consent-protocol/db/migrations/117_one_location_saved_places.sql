BEGIN;

-- Saved Places are the owner's personal knowledge (PKM) tags for locations that
-- matter to them (Home / Work / Other), captured with consent during Location
-- onboarding. Coordinates are low-precision, owner-scoped metadata: they grant
-- no sharing or access by themselves and are never exposed to any other user.
CREATE TABLE IF NOT EXISTS one_location_saved_places (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL
    CHECK (category IN ('home', 'work', 'other')),
  label TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL
    CHECK (latitude >= -90 AND latitude <= 90),
  longitude DOUBLE PRECISION NOT NULL
    CHECK (longitude >= -180 AND longitude <= 180),
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_one_location_saved_places_owner
  ON one_location_saved_places (owner_user_id, created_at);

-- Home and Work are singletons per owner: at most one of each. Multiple "other"
-- places are allowed, so the partial unique index only covers the fixed
-- categories.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_location_saved_places_singleton
  ON one_location_saved_places (owner_user_id, category)
  WHERE category IN ('home', 'work');

COMMENT ON TABLE one_location_saved_places IS
  'Owner-scoped saved places (Home/Work/Other) for personalisation. Grants no location access by itself.';

COMMIT;
