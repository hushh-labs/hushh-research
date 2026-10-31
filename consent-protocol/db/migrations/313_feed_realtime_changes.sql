-- One metadata-only invalidation for every committed Feed write, regardless of
-- producer. NOTIFY coalesces identical owner hints within a transaction. It is
-- lossy; reconnect/reset requires an authenticated snapshot, never event replay.
-- A future broker can replace delivery behind the same hint/snapshot contract.
BEGIN;

CREATE OR REPLACE FUNCTION public.notify_feed_changed()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_owners TEXT[];
  v_owner TEXT;
  v_payload TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_owners := ARRAY[OLD.user_id];
  ELSIF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    v_owners := ARRAY[OLD.user_id, NEW.user_id];
  ELSE
    v_owners := ARRAY[NEW.user_id];
  END IF;
  FOREACH v_owner IN ARRAY v_owners LOOP
    v_payload := json_build_object('type', 'feed_changed', 'user_id', v_owner)::TEXT;
    IF v_owner IS NOT NULL AND octet_length(v_payload) <= 7500 THEN
      PERFORM pg_notify('one_user_state_changed', v_payload);
    END IF;
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A best-effort hint cannot become authority for the Feed or its producer.
  RAISE WARNING 'feed_wake_failed sqlstate=%', SQLSTATE;
  RETURN NULL;
END;
$$;

-- Replays must not replace a trigger on the hot Feed table. Reject drift;
-- changing a live trigger's shape requires a separately reviewed migration.
DO $$
DECLARE v_trigger RECORD;
BEGIN
  SELECT * INTO v_trigger FROM pg_trigger
  WHERE tgname = 'feed_events_realtime_wake'
    AND tgrelid = 'public.feed_events'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER feed_events_realtime_wake
      AFTER INSERT OR UPDATE OR DELETE ON public.feed_events
      FOR EACH ROW EXECUTE FUNCTION public.notify_feed_changed();
  ELSIF v_trigger.tgfoid <> 'public.notify_feed_changed()'::regprocedure::OID
    OR v_trigger.tgtype <> 29 OR v_trigger.tgenabled <> 'O'
    OR v_trigger.tgqual IS NOT NULL OR v_trigger.tgnargs <> 0
    OR v_trigger.tgattr::TEXT <> '' OR v_trigger.tgconstraint <> 0
    OR v_trigger.tgoldtable IS NOT NULL OR v_trigger.tgnewtable IS NOT NULL THEN
    RAISE EXCEPTION 'Feed realtime wake trigger has unexpected definition';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.notify_feed_changed() FROM PUBLIC;
COMMENT ON FUNCTION public.notify_feed_changed() IS
  'Committed owner-scoped metadata-only Feed invalidation; authenticated snapshots recover gaps.';
COMMIT;
