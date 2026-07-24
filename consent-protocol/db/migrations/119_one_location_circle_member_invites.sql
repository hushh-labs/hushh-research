BEGIN;

-- A targeted Circle invitation is a membership-consent workflow for an
-- existing direct connection. Creating it grants no Circle membership,
-- connection origin, trusted edge, SMS selection, location grant, envelope,
-- or capability. Those effects remain gated on the invitee accepting.
CREATE TABLE IF NOT EXISTS one_location_circle_member_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL
    REFERENCES one_location_circles(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  invitee_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_circle_member_invites_no_self
    CHECK (inviter_user_id <> invitee_user_id),
  CONSTRAINT one_location_circle_member_invites_valid_expiry
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_member_invites_pending
  ON one_location_circle_member_invites (circle_id, invitee_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_one_location_circle_member_invites_invitee
  ON one_location_circle_member_invites
    (invitee_user_id, status, expires_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_circle_member_invites_circle
  ON one_location_circle_member_invites
    (circle_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_circle_member_invites_expiry
  ON one_location_circle_member_invites (status, expires_at)
  WHERE status = 'pending';

COMMENT ON TABLE one_location_circle_member_invites IS
  'Targeted, expiring Circle membership invitations for existing direct connections; acceptance is required and invitation creation grants no access.';

COMMIT;
