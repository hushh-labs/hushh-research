-- Owner's optional Drive-request price. A new paid request locks its effective
-- price and version; profile edits never reprice an in-flight request.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_request_owner_pricing (
  user_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  amount_cents INTEGER NOT NULL DEFAULT 1000
    CHECK (amount_cents BETWEEN 100 AND 50000 AND amount_cents % 100 = 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='quoted_amount_cents' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests ADD COLUMN quoted_amount_cents INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='quote_version' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests ADD COLUMN quote_version INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_requests'::regclass
      AND conname='drive_share_requests_locked_quote_check') THEN
    ALTER TABLE drive_share_requests
      ADD CONSTRAINT drive_share_requests_locked_quote_check CHECK (
        (quoted_amount_cents IS NULL AND quote_version IS NULL)
        OR (payment_required=TRUE AND quoted_amount_cents BETWEEN 100 AND 50000
          AND quoted_amount_cents % 100 = 0 AND quote_version >= 0)
      ) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
    WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
    WHERE oid='drive_request_owner_pricing'::regclass AND relrowsecurity) THEN
    ALTER TABLE drive_request_owner_pricing ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
REVOKE ALL ON drive_request_owner_pricing FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_request_owner_pricing FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_request_owner_pricing TO service_role;
  END IF;
END $$;

COMMENT ON TABLE drive_request_owner_pricing IS
  'Owner profile price per successful Drive request; false uses the platform default.';
COMMENT ON COLUMN drive_share_requests.quoted_amount_cents IS
  'Immutable effective price quoted at request creation; NULL for legacy/free requests.';
COMMIT;
