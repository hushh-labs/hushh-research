-- Wake the existing owner-scoped Feed stream when a displayed request state
-- changes without appending a history row. No private row fields cross NOTIFY.
BEGIN;

CREATE OR REPLACE FUNCTION public.notify_feed_request_projection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_owner TEXT;
  v_counterpart TEXT;
  v_recipient TEXT;
  v_reason TEXT := 'consent_mutated';
  v_payload TEXT;
BEGIN
  -- Do not wake for lease renewals, scanned pages, or a replayed write.
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'drive_request_payment_orders' THEN
      IF ROW(NEW.status, NEW.reconciliation_required,
             CASE WHEN NEW.stripe_checkout_session_id IS NOT NULL THEN NEW.stripe_checkout_expires_at END)
         IS NOT DISTINCT FROM ROW(OLD.status, OLD.reconciliation_required,
             CASE WHEN OLD.stripe_checkout_session_id IS NOT NULL THEN OLD.stripe_checkout_expires_at END) THEN
        RETURN NULL;
      END IF;
    ELSIF TG_TABLE_NAME = 'drive_owner_search_jobs' THEN
      IF ROW(NEW.status, NEW.evaluation_status)
         IS NOT DISTINCT FROM ROW(OLD.status, OLD.evaluation_status) THEN
        RETURN NULL;
      END IF;
    ELSIF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NULL;
    END IF;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'connection_requests' THEN
      v_owner := NEW.requester_user_id;
      v_counterpart := NEW.addressee_user_id;
      v_reason := 'connection_mutated';
    WHEN 'drive_request_payment_orders' THEN
      v_owner := NEW.user_id;
      v_counterpart := NEW.requester_user_id;
    WHEN 'drive_request_payment_refunds' THEN
      -- Refund obligations can outlive account deletion. Only a surviving,
      -- participant-bound payment order can authorize a recipient wake.
      SELECT o.user_id, o.requester_user_id INTO v_owner, v_counterpart
        FROM public.drive_request_payment_orders o WHERE o.request_id = NEW.request_id;
    WHEN 'drive_owner_search_jobs' THEN
      SELECT r.user_id, r.recipient_user_id INTO v_owner, v_counterpart
        FROM public.drive_share_requests r
        WHERE r.request_id = NEW.client_request_id AND r.user_id = NEW.user_id;
    WHEN 'drive_bulk_shares' THEN
      SELECT r.user_id, r.recipient_user_id INTO v_owner, v_counterpart
        FROM public.drive_share_requests r
        WHERE r.request_id = NEW.origin_request_id AND r.user_id = NEW.user_id;
    ELSE
      RETURN NULL;
  END CASE;

  FOREACH v_recipient IN ARRAY ARRAY[v_owner, v_counterpart] LOOP
    IF v_recipient IS NOT NULL THEN
      v_payload := json_build_object(
        'type', 'feed_changed', 'user_id', v_recipient, 'reason', v_reason
      )::TEXT;
      IF octet_length(v_payload) <= 7500 THEN
        PERFORM pg_notify('one_user_state_changed', v_payload);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'feed_request_wake_failed sqlstate=%', SQLSTATE;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_feed_request_projection() FROM PUBLIC;

-- Existing triggers are left in place on replay to avoid locking hot tables.
DO $$
DECLARE v_spec RECORD;
DECLARE v_trigger RECORD;
DECLARE v_columns TEXT;
BEGIN
  FOR v_spec IN SELECT * FROM (VALUES
    ('connection_requests', 'status'),
    ('drive_owner_search_jobs', 'status, evaluation_status'),
    ('drive_bulk_shares', 'status'),
    ('drive_request_payment_orders', 'status, reconciliation_required, stripe_checkout_session_id, stripe_checkout_expires_at'),
    ('drive_request_payment_refunds', 'status')
  ) AS definitions(table_name, update_columns) LOOP
    SELECT * INTO v_trigger FROM pg_trigger
      WHERE tgname = 'feed_request_projection_wake'
        AND tgrelid = format('public.%I', v_spec.table_name)::regclass
        AND NOT tgisinternal;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE TRIGGER feed_request_projection_wake AFTER INSERT OR UPDATE OF %s ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.notify_feed_request_projection()',
        v_spec.update_columns, v_spec.table_name
      );
    ELSE
      SELECT string_agg(a.attnum::TEXT, ' ' ORDER BY columns.ordinality) INTO v_columns
        FROM unnest(string_to_array(v_spec.update_columns, ', ')) WITH ORDINALITY AS columns(name, ordinality)
        JOIN pg_attribute a ON a.attrelid = v_trigger.tgrelid AND a.attname = columns.name;
      IF v_trigger.tgfoid <> 'public.notify_feed_request_projection()'::regprocedure::OID
         OR v_trigger.tgtype <> 21 OR v_trigger.tgenabled <> 'O'
         OR v_trigger.tgattr::TEXT IS DISTINCT FROM v_columns
         OR v_trigger.tgqual IS NOT NULL OR v_trigger.tgnargs <> 0
         OR v_trigger.tgoldtable IS NOT NULL OR v_trigger.tgnewtable IS NOT NULL
         OR v_trigger.tgconstraint <> 0 THEN
        RAISE EXCEPTION 'Unexpected Feed request wake trigger on %', v_spec.table_name;
      END IF;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
