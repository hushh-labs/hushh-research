-- Pending MCP connector reviews, shared by every backend instance.
--
-- A review is issued by one request and decided by later ones, and the backend
-- runs as several instances. The reviewed call's arguments were held in the
-- issuing instance's memory, so an approval served by another instance found
-- nothing and failed as "expired". They are now sealed with the owner's chat
-- key (AES-GCM, bound to owner, conversation and handle) and kept only until
-- the review expires. This is not approval: the action ledger still authorizes
-- every dispatch.
--
-- Replay-safe: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS one_mcp_pending_calls (
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_tag TEXT NOT NULL,
  payload_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, handle)
);

CREATE INDEX IF NOT EXISTS idx_one_mcp_pending_calls_owner_expiry
  ON one_mcp_pending_calls(user_id, expires_at);

-- Private to the backend: no public or app-user role reads sealed review records.
REVOKE ALL ON one_mcp_pending_calls FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON one_mcp_pending_calls FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON one_mcp_pending_calls TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE one_mcp_pending_calls IS
  'Sealed (owner chat key) arguments of connector calls awaiting review. Short-lived; removed on expiry and on account deletion.';

COMMIT;
