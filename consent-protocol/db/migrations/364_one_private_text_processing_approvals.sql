BEGIN;

-- Private processor permission is independent of model choice, public PWM
-- research, legal sign-in receipts, and information-access grants. No owner is
-- enrolled by this migration. A revoked row remains as the last approval record.
CREATE TABLE IF NOT EXISTS one_private_text_processing_approvals (
    user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    disclosure_version TEXT,
    generation UUID NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (disclosure_version IS NULL OR char_length(disclosure_version) BETWEEN 1 AND 64),
    CHECK (NOT enabled OR (disclosure_version IS NOT NULL AND accepted_at IS NOT NULL
        AND revoked_at IS NULL))
);

ALTER TABLE one_private_text_processing_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_private_text_processing_approvals FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('REVOKE ALL ON one_private_text_processing_approvals FROM %I', role_name);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON one_private_text_processing_approvals TO service_role;
    END IF;
    IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
        PERFORM public.install_account_deletion_write_guards();
    END IF;
END $$;

COMMENT ON TABLE one_private_text_processing_approvals IS
    'Explicit revocable owner permission for private Azure text in UAT only. Generation fences in-flight work. No private text, keys, model choice or public research consent. Deleted with the actor.';

COMMIT;
