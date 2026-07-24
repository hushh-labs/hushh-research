BEGIN;

-- Save My Soul recipients are an explicit owner-scoped subset of the existing
-- connections graph. No rows are backfilled: an empty list must fail closed.
CREATE TABLE IF NOT EXISTS one_location_sms_contacts (
  owner_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  contact_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, contact_user_id),
  CONSTRAINT one_location_sms_contacts_not_self
    CHECK (owner_user_id <> contact_user_id)
);

CREATE INDEX IF NOT EXISTS idx_one_location_sms_contacts_contact
  ON one_location_sms_contacts (contact_user_id, owner_user_id);

COMMENT ON TABLE one_location_sms_contacts IS
  'Owner-selected Save My Soul recipients. Membership grants no location access by itself.';

COMMIT;
