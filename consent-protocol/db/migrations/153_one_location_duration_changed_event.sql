-- One Location: the owner may change a live share's end time in either
-- direction, and that write needs an event type the CHECK constraint accepts.
--
-- Until now the only duration edit on a running share was `shorten_grant`, so
-- `location_share_shortened` was the only value the ledger ever needed. The
-- owner extending their own share is a different fact -- the audit trail must
-- not record "shortened" for time that was added -- and one value covering both
-- directions keeps a single row shape for the Feed and the notification lane.
--
-- 064 and 068 also carry this value now, for an environment built from scratch.
-- This migration exists because 064 and 068 are already applied everywhere that
-- matters: editing them alone changes nothing in UAT or production, where only
-- an unseen migration number runs.
--
-- Additive by construction: the list is 064's, plus one value. Nothing that was
-- accepted before is rejected now, so this cannot fail on existing rows.

BEGIN;

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
      -- Emitted when the owner sets a new end time on a share that is already
      -- running. Carries `direction` in its metadata, so "gave more time" and
      -- "took time back" stay distinguishable without two event types.
      'location_share_duration_changed',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_access_denied',
      -- Not this branch's value: it landed on main in parallel, added to 064
      -- and 068 only. Re-adding the constraint without it would drop it from
      -- every environment this migration reaches, which is the same outage in
      -- the other direction. Any new value has to appear here too.
      'location_access_request_withdrawn',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined'
    )
  );

COMMIT;
