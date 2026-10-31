-- Delivery is recipient acknowledgment, never send acceptance or a push hint.
-- Additive metadata in the existing message authority; no second receipt store.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.messages'::regclass
                 AND attname='delivered_at' AND NOT attisdropped) THEN
    ALTER TABLE public.messages ADD COLUMN delivered_at TIMESTAMPTZ;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.messages'::regclass
                   AND attname='delivered_at' AND atttypid='timestamptz'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'messages.delivered_at has an unexpected type';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_direct_message_delivery_write()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
     AND (OLD.delivered_at IS NOT NULL OR NEW.delivered_at IS NULL OR NEW.delivered_at<OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='DIRECT_MESSAGE_DELIVERY_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE v_function_oid OID; BEGIN
  SELECT tgfoid INTO v_function_oid FROM pg_trigger
    WHERE tgrelid='public.messages'::regclass AND tgname='trg_direct_message_delivery_guard' AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER trg_direct_message_delivery_guard BEFORE UPDATE OF delivered_at ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_delivery_write();
  ELSIF v_function_oid<>'public.guard_direct_message_delivery_write()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message delivery guard has an unexpected function';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.guard_direct_message_delivery_write() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.guard_direct_message_delivery_write() TO service_role;
  END IF;
END $$;
COMMENT ON COLUMN public.messages.delivered_at IS
  'Monotonic server timestamp after a participant recipient acknowledges receiving this message. Read implies delivery; legacy read timestamps remain authoritative.';
COMMIT;
