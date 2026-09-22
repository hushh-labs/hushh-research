-- Server-side progress for the voice-first Location setup.
--
-- The step order is a hard rule, enforced by the service: consent is recorded
-- strictly before the OS permission prompt, and the recipient key must be
-- verified server-side (one_location_recipient_keys) before setup completes.
-- Refresh-safe by construction: the client reads its step from this row.

BEGIN;

CREATE TABLE IF NOT EXISTS one_location_setup_progress (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  step TEXT NOT NULL DEFAULT 'intro'
    CHECK (step IN ('intro', 'consent', 'os_permission', 'precision', 'recipient_key', 'done')),
  consent_version TEXT,
  consent_accepted_at TIMESTAMPTZ,
  os_permission_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (os_permission_state IN ('unknown', 'prompt', 'granted', 'denied')),
  precision TEXT
    CHECK (precision IS NULL OR precision IN ('precise', 'approximate')),
  recipient_key_registered_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT one_location_setup_consent_before_permission CHECK (
    step IN ('intro', 'consent') OR consent_accepted_at IS NOT NULL
  )
);

COMMENT ON TABLE one_location_setup_progress IS
  'Voice-first Location setup progress. Consent precedes OS permission by constraint.';

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
