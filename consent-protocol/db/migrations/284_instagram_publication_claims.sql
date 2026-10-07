-- Claim each Instagram creation container once before calling media_publish.
-- A failed or timed-out provider call keeps its claim: the outcome is unknown
-- and a retry could publish the same content twice.
BEGIN;

CREATE TABLE IF NOT EXISTS public.instagram_publication_claims (
  owner_user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'instagram'
    CHECK (connector_id = 'instagram'),
  instagram_account_id TEXT NOT NULL
    CHECK (instagram_account_id ~ '^[0-9]{1,32}$'),
  connection_generation BIGINT NOT NULL
    CHECK (connection_generation >= 0),
  container_id TEXT NOT NULL
    CHECK (container_id ~ '^[0-9]{1,32}$'),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, instagram_account_id, connection_generation, container_id),
  FOREIGN KEY (owner_user_id, connector_id)
    REFERENCES public.user_external_connector_connections(user_id, connector_id)
    ON DELETE CASCADE
);

COMMENT ON TABLE public.instagram_publication_claims IS
  'Durable one-use Instagram media_publish fence. Keep claims after uncertain provider outcomes; no media, caption, token, or message body is stored.';

ALTER TABLE public.instagram_publication_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instagram_publication_claims FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.instagram_publication_claims FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON TABLE public.instagram_publication_claims TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
