BEGIN;

-- Delivery intent is committed with the authoritative transition, never with
-- an HTTP response or a process-local executor. Only source references live
-- here: no coordinates, envelopes, messages, tokens or notification copy.
CREATE TABLE system_push_outbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 source_kind TEXT NOT NULL CHECK (source_kind IN ('share','location_request','circle_member','connection_request')),
 source_id UUID NOT NULL,
 source_revision TEXT NOT NULL DEFAULT '',
 recipient_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','sent','suppressed','failed')),
 attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 12),
 due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day',
 lease_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(source_kind, source_id, source_revision, recipient_user_id)
);
CREATE INDEX system_push_due ON system_push_outbox(due_at) WHERE status IN ('pending','leased');
CREATE INDEX system_push_expiry ON system_push_outbox(expires_at);
CREATE TABLE system_push_device_deliveries (
 event_id UUID NOT NULL REFERENCES system_push_outbox(id) ON DELETE CASCADE,
 device_id UUID NOT NULL,
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id, device_id)
);

CREATE FUNCTION queue_system_push() RETURNS trigger AS $$
DECLARE kind TEXT; recipient TEXT; source UUID; revision TEXT := ''; deadline TIMESTAMPTZ := now() + interval '1 day'; is_sms BOOLEAN;
BEGIN
 IF TG_TABLE_NAME = 'one_location_share_grants' THEN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  -- Approval owns a separate, richer alert. SMS must never announce a
  -- location before its first encrypted envelope has committed.
  IF NEW.metadata->>'reason' = 'request_approved' THEN RETURN NEW; END IF;
  is_sms := COALESCE(NULLIF(BTRIM(NEW.metadata->>'share_kind'),''),
    CASE WHEN NEW.metadata->>'reason'='sos_panic' THEN 'sos' ELSE 'share' END) = 'sos';
  -- Only a deferred SMS first envelope is a notification transition on UPDATE.
  -- In particular, the next point on a predeployment share must not ring again.
  IF TG_OP = 'UPDATE' THEN
   IF NOT is_sms OR OLD.latest_envelope_id IS NOT NULL OR NEW.latest_envelope_id IS NULL THEN RETURN NEW; END IF;
  END IF;
  IF is_sms AND NEW.latest_envelope_id IS NULL THEN RETURN NEW; END IF;
  kind := 'share'; source := NEW.id; recipient := NEW.recipient_user_id;
  deadline := LEAST(deadline, COALESCE(NEW.expires_at, deadline));
 ELSIF TG_TABLE_NAME = 'one_location_access_requests' THEN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  IF NEW.metadata->>'notify_owner' = 'false' THEN RETURN NEW; END IF;
  revision := COALESCE(NEW.request_revision,1)::TEXT;
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending'
    AND COALESCE(OLD.request_revision,1)::TEXT = revision THEN RETURN NEW; END IF;
  kind := 'location_request'; source := NEW.id; recipient := NEW.owner_user_id;
 ELSIF TG_TABLE_NAME = 'connection_requests' THEN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  kind := 'connection_request'; source := NEW.id; recipient := NEW.addressee_user_id;
 ELSIF TG_TABLE_NAME = 'one_location_circle_memberships' THEN
  IF NEW.status <> 'active' OR NEW.role = 'owner' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM one_location_circles WHERE id=NEW.circle_id AND system_kind='trusted') THEN RETURN NEW; END IF;
  kind := 'circle_member'; source := NEW.circle_id; recipient := NEW.user_id;
  revision := EXTRACT(EPOCH FROM NEW.joined_at)::TEXT;
 END IF;
 INSERT INTO system_push_outbox(source_kind,source_id,source_revision,recipient_user_id,expires_at)
 VALUES(kind,source,revision,recipient,deadline) ON CONFLICT DO NOTHING;
 -- A doorbell accelerates delivery; polling recovers every lost doorbell.
 PERFORM pg_notify('system_push_ready','');
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public,pg_temp;
CREATE TRIGGER system_push_share AFTER INSERT OR UPDATE OF latest_envelope_id ON one_location_share_grants FOR EACH ROW EXECUTE FUNCTION queue_system_push();
CREATE TRIGGER system_push_location_request AFTER INSERT OR UPDATE ON one_location_access_requests FOR EACH ROW EXECUTE FUNCTION queue_system_push();
CREATE TRIGGER system_push_connection_request AFTER INSERT ON connection_requests FOR EACH ROW EXECUTE FUNCTION queue_system_push();
CREATE TRIGGER system_push_circle_member AFTER INSERT OR UPDATE OF status ON one_location_circle_memberships FOR EACH ROW EXECUTE FUNCTION queue_system_push();

ALTER TABLE system_push_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_push_device_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON system_push_outbox,system_push_device_deliveries FROM PUBLIC;
REVOKE ALL ON FUNCTION queue_system_push() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT ALL ON system_push_outbox,system_push_device_deliveries TO service_role;
  GRANT EXECUTE ON FUNCTION queue_system_push() TO service_role;
 END IF;
END $$;
-- Recipient references must obey the existing deleted-account write barrier.
DO $$ BEGIN
 PERFORM public.install_account_deletion_write_guards();
END $$;
COMMIT;
