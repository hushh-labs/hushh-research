-- One fixed-price payment per eligible Trusted Circle document request.
-- Existing requests remain free. Provider references contain no document data.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='payment_required' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests
      ADD COLUMN payment_required BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS drive_request_payment_orders (
  request_id UUID PRIMARY KEY REFERENCES drive_share_requests(request_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL CHECK (requester_user_id <> user_id),
  amount_cents INTEGER NOT NULL DEFAULT 1000 CHECK (amount_cents = 1000),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment','checkout_open','paid','refunded','expired')),
  checkout_attempt_id UUID,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_checkout_url TEXT,
  stripe_checkout_expires_at TIMESTAMPTZ,
  stripe_payment_intent_id TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  reconciliation_reason TEXT CHECK (reconciliation_reason IS NULL OR
    reconciliation_reason IN ('request_closed','authority_changed','zero_delivery','account_erased')),
  reconciliation_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id,user_id) REFERENCES drive_share_requests(request_id,user_id) ON DELETE CASCADE,
  CHECK ((status IN ('paid','refunded')) = (paid_at IS NOT NULL)),
  CHECK (stripe_checkout_url IS NULL OR stripe_checkout_session_id IS NOT NULL),
  CHECK ((reconciliation_required AND reconciliation_reason IS NOT NULL
    AND reconciliation_at IS NOT NULL) OR (NOT reconciliation_required
    AND reconciliation_reason IS NULL AND reconciliation_at IS NULL))
);
CREATE INDEX IF NOT EXISTS drive_request_payment_orders_requester
  ON drive_request_payment_orders(requester_user_id,created_at DESC);

-- Survives account/request erasure without a user ID, email, filename, or
-- document content. The random request UUID and provider references are the
-- minimum binding needed to settle a late charge or an uncertain refund.
CREATE TABLE IF NOT EXISTS drive_request_payment_obligations (
  request_id UUID PRIMARY KEY,
  payer_ref TEXT NOT NULL CHECK (payer_ref ~ '^[0-9a-f]{64}$'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents = 1000),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  status TEXT NOT NULL CHECK (status IN
    ('awaiting_payment','checkout_open','paid','refunded','expired')),
  checkout_attempt_id UUID,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  erased_at TIMESTAMPTZ,
  delivery_confirmed_at_erasure BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_unsettled_at_erasure BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('paid','refunded')) = (paid_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION mirror_drive_request_payment_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO drive_request_payment_obligations
    (request_id,payer_ref,amount_cents,currency,status,checkout_attempt_id,
     stripe_checkout_session_id,stripe_payment_intent_id,paid_at,reconciliation_required)
  VALUES (NEW.request_id,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      NEW.request_id::text || ':' || NEW.requester_user_id,'UTF8')),'hex'),
    NEW.amount_cents,NEW.currency,NEW.status,NEW.checkout_attempt_id,
    NEW.stripe_checkout_session_id,NEW.stripe_payment_intent_id,NEW.paid_at,
    NEW.reconciliation_required)
  ON CONFLICT (request_id) DO UPDATE SET
    status=EXCLUDED.status,checkout_attempt_id=EXCLUDED.checkout_attempt_id,
    stripe_checkout_session_id=EXCLUDED.stripe_checkout_session_id,
    stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id,
    paid_at=EXCLUDED.paid_at,
    reconciliation_required=drive_request_payment_obligations.reconciliation_required
      OR EXCLUDED.reconciliation_required,
    updated_at=clock_timestamp();
  RETURN NEW;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='drive_request_payment_obligation_mirror'
      AND tgrelid='drive_request_payment_orders'::regclass) THEN
    CREATE TRIGGER drive_request_payment_obligation_mirror
      AFTER INSERT OR UPDATE ON drive_request_payment_orders FOR EACH ROW
      EXECUTE FUNCTION mirror_drive_request_payment_obligation();
  END IF;
END $$;

-- A direct request delete and the normal account erasure path must both remove
-- account IDs while retaining enough opaque payment state for reconciliation.
CREATE OR REPLACE FUNCTION erase_drive_request_payment_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivered BOOLEAN;
DECLARE unsettled BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM drive_request_payment_obligations WHERE request_id=OLD.request_id) THEN
    SELECT EXISTS(SELECT 1 FROM drive_bulk_share_effects e
      JOIN drive_bulk_shares b ON b.share_id=e.share_id
      WHERE b.origin_request_id=OLD.request_id AND e.state IN ('succeeded','preexisting'))
      OR EXISTS(SELECT 1 FROM drive_share_permission_operations p
        WHERE p.request_id=OLD.request_id AND p.kind='grant'
          AND p.state IN ('succeeded','preexisting'))
      INTO delivered;
    SELECT EXISTS(SELECT 1 FROM drive_bulk_share_effects e
      JOIN drive_bulk_shares b ON b.share_id=e.share_id
      WHERE b.origin_request_id=OLD.request_id AND
        (e.state IN ('dispatching','unknown','present_unattributed') OR
         (e.state='failed' AND e.safe_error_code='permission_outcome_unknown')))
      OR EXISTS(SELECT 1 FROM drive_share_permission_operations p
        WHERE p.request_id=OLD.request_id AND p.kind='grant'
          AND p.state IN ('dispatching','unknown','present_unattributed'))
      INTO unsettled;
    UPDATE drive_request_payment_obligations o SET
      erased_at=clock_timestamp(),
      delivery_confirmed_at_erasure=o.delivery_confirmed_at_erasure OR delivered,
      delivery_unsettled_at_erasure=o.delivery_unsettled_at_erasure OR unsettled,
      reconciliation_required=CASE WHEN o.status='refunded' THEN FALSE
        ELSE o.reconciliation_required OR NOT (o.delivery_confirmed_at_erasure OR delivered)
          OR o.status NOT IN ('paid','refunded') END,
      updated_at=clock_timestamp()
    WHERE o.request_id=OLD.request_id;
  END IF;
  RETURN OLD;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='drive_request_payment_erasure'
      AND tgrelid='drive_share_requests'::regclass) THEN
    CREATE TRIGGER drive_request_payment_erasure
      BEFORE DELETE ON drive_share_requests FOR EACH ROW
      EXECUTE FUNCTION erase_drive_request_payment_identity();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS drive_request_payment_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT NOT NULL,
  request_id UUID NOT NULL REFERENCES drive_request_payment_obligations(request_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS drive_request_payment_refunds (
  request_id UUID PRIMARY KEY REFERENCES drive_request_payment_obligations(request_id),
  attempt_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN
    ('queued','dispatching','unknown','pending','manual_review','succeeded','failed')),
  stripe_refund_id TEXT UNIQUE,
  first_dispatch_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  safe_error_code TEXT CHECK (safe_error_code IS NULL OR safe_error_code IN
    ('provider_unavailable','provider_rejected','provider_mismatch',
     'idempotency_window_elapsed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (status='queued' OR first_dispatch_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS drive_request_payment_refunds_due
  ON drive_request_payment_refunds(next_check_at,status)
  WHERE status IN ('queued','dispatching','unknown','pending','manual_review');

-- Replay-all deployments should not take an ACCESS EXCLUSIVE lock once the
-- event allowlist is installed. Compare the catalog's allowed event literals.
DO $$
DECLARE installed TEXT[];
BEGIN
  SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(
    pg_get_constraintdef(c.oid), '''(document_share_[^'']+)''', 'g') AS hit
    ORDER BY hit[1]) INTO installed
  FROM pg_constraint c
  WHERE c.conrelid='drive_share_events'::regclass
    AND c.conname='drive_share_events_event_type_check';
  IF installed IS DISTINCT FROM ARRAY[
    'document_share_decided','document_share_outcome',
    'document_share_payment_confirmed','document_share_payment_ready',
    'document_share_payment_refunded','document_share_request',
    'document_share_review_ready','document_share_revocation_outcome',
    'document_share_revoked']::TEXT[] THEN
    ALTER TABLE drive_share_events DROP CONSTRAINT IF EXISTS drive_share_events_event_type_check;
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check
      CHECK (event_type IN (
        'document_share_request','document_share_review_ready','document_share_decided',
        'document_share_outcome','document_share_revoked','document_share_revocation_outcome',
        'document_share_payment_ready','document_share_payment_confirmed',
        'document_share_payment_refunded'
      ));
  END IF;
END $$;

-- Migration 246's Feed trigger has its own closed event allowlist. Rebuild the
-- installed function in place so both fresh and already-upgraded databases
-- project these opaque payment updates into the requester's Feed.
DO $$
DECLARE source_sql TEXT;
DECLARE old_fragment TEXT := '''document_share_revocation_outcome'',';
BEGIN
  IF to_regprocedure('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)'::regprocedure)
    INTO source_sql;
  IF strpos(source_sql, '''document_share_payment_ready''') > 0 THEN
    IF strpos(source_sql, '''document_share_payment_refunded''') = 0 THEN
      EXECUTE replace(source_sql, '''document_share_payment_confirmed'',',
        '''document_share_payment_confirmed'',' || E'\n    ''document_share_payment_refunded'',');
    END IF;
    RETURN;
  END IF;
  IF strpos(source_sql, old_fragment) = 0 THEN
    RAISE EXCEPTION 'Drive Feed projection allowlist was not found';
  END IF;
  EXECUTE replace(source_sql, old_fragment,
    old_fragment || E'\n    ''document_share_payment_ready'',\n    ''document_share_payment_confirmed'',\n    ''document_share_payment_refunded'',');
END $$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'drive_request_payment_orders','drive_request_payment_obligations',
    'drive_request_payment_webhook_events','drive_request_payment_refunds'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=table_name::regclass) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON drive_request_payment_orders,drive_request_payment_obligations,
  drive_request_payment_webhook_events,
  drive_request_payment_refunds FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_request_payment_orders,drive_request_payment_obligations,drive_request_payment_webhook_events,drive_request_payment_refunds FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_request_payment_orders,
      drive_request_payment_obligations,
      drive_request_payment_webhook_events,drive_request_payment_refunds TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
