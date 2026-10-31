-- Owner-level Location sharing posture. Coordinate-free.
--
-- Until now "location on/off" had no single row: device pause is client-local,
-- Ghost Mode is a map-presence preference, and every share is a per-recipient
-- grant. The voice-first Location surface needs one persisted answer to
-- "is sharing on?" that the app can enforce. `unset` keeps every existing tap
-- flow behaving exactly as before; only an explicit `off` is enforced.
--
-- `precision` is a preference. Location points are recipient-encrypted on the
-- device, so the server can store the choice and reject a mismatched envelope
-- tag, but the coarsening itself happens client-side before encryption.

BEGIN;

CREATE TABLE IF NOT EXISTS one_location_account_settings (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  sharing_state TEXT NOT NULL DEFAULT 'unset'
    CHECK (sharing_state IN ('unset', 'on', 'off')),
  precision TEXT NOT NULL DEFAULT 'precise'
    CHECK (precision IN ('precise', 'approximate')),
  sharing_consent_version TEXT,
  sharing_consent_accepted_at TIMESTAMPTZ,
  sharing_enabled_at TIMESTAMPTZ,
  sharing_disabled_at TIMESTAMPTZ,
  os_permission_reported TEXT NOT NULL DEFAULT 'unknown'
    CHECK (os_permission_reported IN ('unknown', 'prompt', 'granted', 'denied')),
  os_permission_reported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE one_location_account_settings IS
  'Owner-level app sharing posture. unset = never chosen (legacy behaviour); off = enforced; no coordinates.';
COMMENT ON COLUMN one_location_account_settings.precision IS
  'Preference only. Points are client-encrypted; coarsening happens on the device before encryption.';
COMMENT ON COLUMN one_location_account_settings.os_permission_reported IS
  'Last OS permission state the device reported. Never implies app-level sharing is on.';

-- Refresh migration 201's tombstone write guards for the new account-keyed
-- tables. Guarded so partial test schemas without 201 still apply cleanly;
-- every release lane runs 201 before this migration (manifest order).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
