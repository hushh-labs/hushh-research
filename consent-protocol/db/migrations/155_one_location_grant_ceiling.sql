-- One Location: remember how far the owner actually authorized a grant to
-- run, separately from where its expiry currently sits.
--
-- `expires_at` is mutated in place by every duration edit -- `shorten_grant`
-- moves it earlier, `set_grant_duration` moves it either way. Once the
-- recipient shortens a 1-hour grant to 15 minutes, the fact that the owner
-- once agreed to a full hour is gone: nothing on the row remembers it. So
-- asking to go back up to 30 minutes -- still well inside what was already
-- approved -- reads as a brand new ask for more time, and gets sent to the
-- owner exactly like a request for 4 hours would. Shrink-then-regrow inside
-- an already-approved window and shrink-then-request-beyond-it become the
-- same code path, which is the bug: growing back toward what was already
-- granted should need nobody's permission a second time.
--
-- `ceiling_expires_at` is that missing memory: the furthest-out expiry the
-- owner has ever explicitly authorized for this grant. It moves only on an
-- owner-authorized write (grant creation, an approved request, the owner's
-- own duration edit) and never on the self-serve shrink/regrow a recipient
-- (or either party, via `shorten_grant`) can do without asking. A duration
-- edit that stays at or under the ceiling applies immediately, whichever
-- direction it moves the live expiry; only a candidate past the ceiling
-- still needs a fresh request_access the owner approves -- and approving it
-- is itself an owner-authorized write, so it becomes the new ceiling.
--
-- NULL means "no ceiling known": an until_stopped grant (no expiry to bound
-- in the first place) and any row written before this migration. Both fall
-- back to comparing against the live `expires_at`, which is exactly today's
-- behavior -- this column can only ever unlock a self-serve regrow that
-- was previously blocked, never permit something that was allowed before.

BEGIN;

ALTER TABLE one_location_share_grants
  ADD COLUMN IF NOT EXISTS ceiling_expires_at TIMESTAMPTZ;

-- Backfill only what is still live. An expired or revoked grant's ceiling
-- can never be read again by a duration edit, so there is nothing to gain by
-- filling it in for rows that are already inert.
UPDATE one_location_share_grants
SET ceiling_expires_at = expires_at
WHERE status = 'active'
  AND ceiling_expires_at IS NULL;

-- Documents the invariant rather than enforcing anything new: every writer
-- of expires_at that also knows about ceiling_expires_at already keeps this
-- true by construction (see one_location_agent_service.py). NOT VALID, like
-- 154's own additions, so this does not pay for a full-table scan today.
ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_ceiling_bounds;

ALTER TABLE one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_ceiling_bounds
    CHECK (
      ceiling_expires_at IS NULL
      OR expires_at IS NULL
      OR expires_at <= ceiling_expires_at
    ) NOT VALID;

COMMENT ON COLUMN one_location_share_grants.ceiling_expires_at IS
  'Furthest-out expiry the owner has explicitly authorized for this grant. Set on owner-authorized writes (create_grant, set_grant_duration); never moved by the self-serve shorten/regrow path. NULL = no known ceiling (until_stopped grants, or rows predating this column) -- duration edits then fall back to comparing against the live expires_at.';

COMMIT;
