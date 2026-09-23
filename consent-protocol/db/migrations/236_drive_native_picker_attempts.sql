-- Expand only. Google's One Picker callback stages encrypted candidates; it
-- never itself inserts a selected Drive source or changes the Drive grant.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_native_picker_attempts (
  attempt_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'google_drive'
    CHECK (connector_id = 'google_drive'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  credential_version BIGINT NOT NULL CHECK (credential_version > 0),
  selection_session_id UUID NOT NULL UNIQUE
    REFERENCES drive_picker_sessions(session_id) ON DELETE CASCADE,
  proof_ciphertext TEXT NOT NULL,
  proof_iv TEXT NOT NULL,
  candidates_ciphertext TEXT,
  candidates_iv TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count BETWEEN 0 AND 25),
  callback_claimed_at TIMESTAMPTZ,
  staged_at TIMESTAMPTZ,
  confirmation_lease_id UUID,
  confirmation_lease_expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '10 minutes'),
  FOREIGN KEY (user_id, connector_id)
    REFERENCES user_external_connector_connections(user_id, connector_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((candidates_ciphertext IS NULL) = (candidates_iv IS NULL)),
  CHECK ((confirmation_lease_id IS NULL) = (confirmation_lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS drive_native_picker_attempts_owner_idx
  ON drive_native_picker_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drive_native_picker_attempts_expiry_idx
  ON drive_native_picker_attempts(expires_at);

COMMENT ON TABLE drive_native_picker_attempts IS
  'Ten-minute owner/generation/version-bound Google One Picker attempts. PKCE proof and staged metadata are AES-GCM encrypted; no token, Google subject, file ID or filename is stored in plaintext.';

-- A credential rotation may preserve ordinary selected sources, but it must
-- invalidate an in-flight native redirect whose callback and confirmation are
-- pinned to that exact credential version. Delete its linked session first so
-- a late callback cannot claim a surviving catalog admission session.
CREATE OR REPLACE FUNCTION invalidate_selected_drive_documents()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.connector_id = 'google_drive' AND (
    NEW.credential_version <> OLD.credential_version
    OR NEW.status NOT IN ('connected', 'verifying')
  ) THEN
    DELETE FROM drive_picker_sessions
      WHERE session_id IN (
        SELECT selection_session_id FROM drive_native_picker_attempts
        WHERE user_id = NEW.user_id AND connector_id = NEW.connector_id
      );
  END IF;
  IF NEW.connector_id = 'google_drive' AND (
    NEW.connection_generation <> OLD.connection_generation OR NEW.status = 'revoked'
  ) THEN
    DELETE FROM connected_documents WHERE user_id = NEW.user_id AND connector_id = NEW.connector_id;
    DELETE FROM drive_picker_sessions WHERE user_id = NEW.user_id AND connector_id = NEW.connector_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS selected_drive_connection_invalidation ON user_external_connector_connections;
CREATE TRIGGER selected_drive_connection_invalidation
  AFTER UPDATE OF connection_generation, credential_version, status ON user_external_connector_connections
  FOR EACH ROW EXECUTE FUNCTION invalidate_selected_drive_documents();

ALTER TABLE drive_native_picker_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_native_picker_attempts FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON drive_native_picker_attempts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON drive_native_picker_attempts FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON drive_native_picker_attempts FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON drive_native_picker_attempts TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
