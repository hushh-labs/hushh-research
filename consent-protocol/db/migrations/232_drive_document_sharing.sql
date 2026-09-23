-- Original-file Google Viewer sharing is independent of the removable index.
-- No provider identifier, filename, purpose or recipient address is plaintext.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_share_requests (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL CHECK (recipient_user_id <> user_id),
  client_request_id UUID NOT NULL,
  request_envelope JSONB NOT NULL CHECK (jsonb_typeof(request_envelope)='object'),
  recipient_binding TEXT NOT NULL CHECK (recipient_binding ~ '^[0-9a-f]{64}$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','preparing','review_ready','approved','declined','cancelled','expired','completed','partial'
  )),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision>=0),
  revocation_revision BIGINT NOT NULL DEFAULT 0 CHECK (revocation_revision>=0),
  approval_invalidated_at TIMESTAMPTZ,
  preparation_lease_id UUID,
  preparation_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp()+INTERVAL '30 days'),
  UNIQUE(recipient_user_id,client_request_id),
  UNIQUE(request_id,user_id),
  CHECK ((preparation_lease_id IS NULL)=(preparation_lease_expires_at IS NULL)),
  CHECK (expires_at>created_at AND expires_at<=created_at+INTERVAL '31 days')
);
CREATE INDEX IF NOT EXISTS drive_share_incoming ON drive_share_requests(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drive_share_outgoing ON drive_share_requests(recipient_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drive_share_preparation ON drive_share_requests(status,created_at)
  WHERE status IN ('pending','preparing');

CREATE TABLE IF NOT EXISTS drive_share_reviews (
  request_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision>0),
  user_id TEXT NOT NULL,
  connection_generation BIGINT NOT NULL CHECK (connection_generation>0),
  review_envelope JSONB NOT NULL CHECK (jsonb_typeof(review_envelope)='object'),
  review_digest TEXT NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  directive_id TEXT UNIQUE,
  decision TEXT CHECK (decision IN ('approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  PRIMARY KEY(request_id,revision),
  FOREIGN KEY(request_id,user_id) REFERENCES drive_share_requests(request_id,user_id),
  CHECK ((decision IS NULL)=(decided_at IS NULL))
);

CREATE TABLE IF NOT EXISTS drive_share_permission_operations (
  operation_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  review_revision BIGINT NOT NULL,
  batch_id TEXT NOT NULL,
  document_id UUID NOT NULL,
  connection_generation BIGINT NOT NULL CHECK (connection_generation>0),
  file_lock_hmac TEXT NOT NULL CHECK (file_lock_hmac ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('grant','revoke')),
  parent_operation_id UUID REFERENCES drive_share_permission_operations(operation_id),
  plan_envelope JSONB NOT NULL CHECK (jsonb_typeof(plan_envelope)='object'),
  receipt_envelope JSONB CHECK (jsonb_typeof(receipt_envelope)='object'),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued','dispatching','unknown','succeeded','preexisting','rejected',
    'not_dispatched','present_unattributed','absent','needs_review'
  )),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  safe_error_code TEXT CHECK (safe_error_code ~ '^[a-z_]{1,80}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  dispatched_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  FOREIGN KEY(request_id,review_revision) REFERENCES drive_share_reviews(request_id,revision),
  FOREIGN KEY(request_id,user_id) REFERENCES drive_share_requests(request_id,user_id),
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((kind='grant' AND parent_operation_id IS NULL) OR (kind='revoke' AND parent_operation_id IS NOT NULL)),
  CHECK (state<>'succeeded' OR receipt_envelope IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_share_grant_once
  ON drive_share_permission_operations(request_id,review_revision,document_id) WHERE kind='grant';
CREATE UNIQUE INDEX IF NOT EXISTS drive_share_revoke_batch_once
  ON drive_share_permission_operations(parent_operation_id,batch_id) WHERE kind='revoke';
CREATE UNIQUE INDEX IF NOT EXISTS drive_share_revoke_active_once
  ON drive_share_permission_operations(parent_operation_id)
  WHERE kind='revoke' AND state IN ('queued','dispatching','unknown');
CREATE INDEX IF NOT EXISTS drive_share_operations_owner ON drive_share_permission_operations(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drive_share_operations_pending ON drive_share_permission_operations(state,created_at)
  WHERE state IN ('queued','dispatching','unknown');

-- An uncertain provider outcome retains this claim until reconciliation.
-- Lease expiry alone must never authorize another mutation of the same file.
CREATE TABLE IF NOT EXISTS drive_share_file_claims (
  file_lock_hmac TEXT PRIMARY KEY CHECK (file_lock_hmac ~ '^[0-9a-f]{64}$'),
  operation_id UUID NOT NULL UNIQUE REFERENCES drive_share_permission_operations(operation_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Transactional notification/Feed outbox. Generic body is authored at delivery.
CREATE TABLE IF NOT EXISTS drive_share_events (
  event_id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES drive_share_requests(request_id),
  user_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision>=0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'document_share_request','document_share_review_ready','document_share_decided',
    'document_share_outcome','document_share_revoked','document_share_revocation_outcome'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  UNIQUE(request_id,user_id,revision,event_type)
);
CREATE INDEX IF NOT EXISTS drive_share_event_delivery ON drive_share_events(created_at)
  WHERE delivered_at IS NULL;

COMMENT ON TABLE drive_share_permission_operations IS
  'Encrypted provider plans and receipts survive connector disconnect, catalog removal and chat deletion. Google permissions remain until separately revoked. No cascade from index/credentials.';
ALTER TABLE drive_share_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_share_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_share_permission_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_share_file_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_share_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_share_requests,drive_share_reviews,drive_share_permission_operations,drive_share_file_claims,drive_share_events FROM PUBLIC;
DO $$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['drive_share_requests','drive_share_reviews','drive_share_permission_operations','drive_share_file_claims','drive_share_events'] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',table_name,role_name);
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',table_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
