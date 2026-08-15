-- One Location: make an access request carry HOW MUCH time was asked for.
--
-- Until now an access request was a bare "let me see your location" with no
-- duration on it. The requester's picker was collected in the UI and thrown
-- away at the API boundary, so the owner approved a number they had never been
-- told and the requester was never told which number they got. The same gap
-- swallowed the "ask for more time" path: extending an existing share fell back
-- to a plain request whose only trace of the ask was the literal English string
-- "Requesting more time."
--
-- Three columns close it:
--   requested_duration_hours / requested_duration_mode -- the amount asked for,
--     so the owner's notification, the feed, and the approve control can all
--     name it and approval can default to it.
--   extends_grant_id -- the live grant this ask is asking to lengthen, so
--     "3 more hours on top of the 45 minutes left" is a fact the server knows
--     rather than something a surface has to infer.
--   request_revision -- bumped whenever a still-pending ask changes. A person
--     who asked for 1 hour and then asks for 4 is making a NEW ask on the same
--     row; without a revision the notification de-dup on the client (keyed by
--     request id) silently swallows the second one and the owner is left
--     approving the stale number.
--
-- The requested duration is a REQUEST, never an authorization: nothing here
-- widens access on its own. The grant is still written only by approve_request,
-- and its bounds are still the grant table's own duration contract.

BEGIN;

ALTER TABLE one_location_access_requests
  ADD COLUMN IF NOT EXISTS requested_duration_hours DOUBLE PRECISION;

ALTER TABLE one_location_access_requests
  ADD COLUMN IF NOT EXISTS requested_duration_mode TEXT;

ALTER TABLE one_location_access_requests
  ADD COLUMN IF NOT EXISTS extends_grant_id UUID
    REFERENCES one_location_share_grants(id) ON DELETE SET NULL;

ALTER TABLE one_location_access_requests
  ADD COLUMN IF NOT EXISTS request_revision INTEGER NOT NULL DEFAULT 1;

-- NULL mode = the requester expressed no preference (every row written before
-- this migration, plus any client that still omits it). That stays legal so the
-- owner keeps their own default; what is not legal is a mode/hours pair that
-- contradicts itself, or an hours value outside what a grant could ever honour.
ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS one_location_access_requests_requested_duration_contract;

ALTER TABLE one_location_access_requests
  ADD CONSTRAINT one_location_access_requests_requested_duration_contract
    CHECK (
      (
        requested_duration_mode IS NULL
        AND requested_duration_hours IS NULL
      )
      OR (
        requested_duration_mode = 'timed'
        AND requested_duration_hours IS NOT NULL
        AND requested_duration_hours >= 0.25
        AND requested_duration_hours <= 24
      )
      OR (
        requested_duration_mode = 'until_stopped'
        AND requested_duration_hours IS NULL
      )
    ) NOT VALID;

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS one_location_access_requests_revision_positive;

ALTER TABLE one_location_access_requests
  ADD CONSTRAINT one_location_access_requests_revision_positive
    CHECK (request_revision >= 1);

-- Answering "is this person already asking for more time on this share?" is a
-- read on every render of the owner's approvals list and the requester's people
-- list, and only pending rows can answer it.
CREATE INDEX IF NOT EXISTS idx_one_location_access_requests_extends_grant_pending
  ON one_location_access_requests (extends_grant_id, requested_at DESC)
  WHERE extends_grant_id IS NOT NULL AND status = 'pending';

COMMENT ON COLUMN one_location_access_requests.requested_duration_hours IS
  'How many hours the requester asked for. A request, never an authorization -- only approve_request writes a grant.';
COMMENT ON COLUMN one_location_access_requests.requested_duration_mode IS
  'timed | until_stopped, or NULL when the requester expressed no preference and the owner picks.';
COMMENT ON COLUMN one_location_access_requests.extends_grant_id IS
  'The live grant this ask wants lengthened, so extra-time asks read as extra time rather than as a fresh share.';
COMMENT ON COLUMN one_location_access_requests.request_revision IS
  'Bumped when a still-pending ask changes (e.g. 1 hour re-asked as 4). Keeps client notification de-dup from swallowing the new ask.';

-- location_share_shortened has been inserted by shorten_grant since that
-- feature landed, but was never added to this CHECK -- so every one of those
-- inserts violated the constraint, and _insert_event swallowed the error as a
-- warning. The audit trail simply had no record that anyone ever shortened a
-- share. Extending is the mirror of shortening and lands in the same feed, so
-- the row that records it has to be insertable before that feed can be trusted.
ALTER TABLE one_location_events
  DROP CONSTRAINT IF EXISTS one_location_events_event_type_check;

ALTER TABLE one_location_events
  ADD CONSTRAINT one_location_events_event_type_check CHECK (
    event_type IN (
      'location_recipient_key_registered',
      'location_share_created',
      'location_envelope_updated',
      'location_share_viewed',
      'location_share_revoked',
      'location_share_shortened',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_access_denied',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined'
    )
  ) NOT VALID;

-- The feed fan-out was owner-scoped: only the person whose location it is ever
-- got a feed row. So the person who ASKED for three more hours could read the
-- whole exchange nowhere -- not the ask, not the answer -- and had only a
-- transient toast, which is gone the moment it is dismissed. Both parties are
-- in this conversation, so both get the row.
--
-- Fan-out to the counterparty is limited to the request lifecycle (ask,
-- approve, decline). The share lifecycle already reaches the recipient as its
-- own notification, and widening every event here would double up rows for
-- things they were told about twice.
--
-- viewer_role is what keeps the copy honest: the same row renders "You approved
-- 3 hours more" for the owner and "Gave you 3 hours more" for the requester,
-- and counterpart_label is swapped to the OTHER person for the counterparty's
-- copy so neither side reads their own name back as the actor.
CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  counterparty_metadata JSONB;
BEGIN
  IF NEW.event_type IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_shortened',
    'location_share_expired',
    'location_access_request',
    'location_access_approved',
    'location_access_denied'
  ) THEN
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      NEW.metadata || jsonb_build_object('viewer_role', 'owner'),
      NEW.id::TEXT
    );
  END IF;

  IF NEW.event_type IN (
    'location_access_request',
    'location_access_approved',
    'location_access_denied'
  )
    AND NEW.recipient_user_id IS NOT NULL
    AND NEW.recipient_user_id <> NEW.owner_user_id
  THEN
    counterparty_metadata := NEW.metadata || jsonb_build_object('viewer_role', 'counterparty');
    IF NEW.metadata ? 'owner_label' THEN
      counterparty_metadata := counterparty_metadata
        || jsonb_build_object('counterpart_label', NEW.metadata -> 'owner_label');
    END IF;
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.recipient_user_id,
      'location',
      NEW.event_type,
      counterparty_metadata,
      NEW.id::TEXT
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_from_one_location_events() IS
  'Fans out feed-worthy one_location_events into feed_events. Request-lifecycle rows reach BOTH parties, tagged with viewer_role so each side reads its own side of the exchange.';

COMMIT;
