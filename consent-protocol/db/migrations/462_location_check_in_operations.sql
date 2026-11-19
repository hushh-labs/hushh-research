BEGIN;
-- Explicit private Check-In intent and saved ciphertext receipts. No point,
-- precise place, note, map or message body belongs in these workflow records.
CREATE TABLE one_location_check_in_operations (
 id UUID PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 client_operation_id TEXT NOT NULL CHECK(length(client_operation_id) BETWEEN 1 AND 160),
 duration_hours NUMERIC NOT NULL CHECK(duration_hours>0 AND duration_hours<=24),
 source_circle_id UUID, confirmed_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','partial','completed','failed','ended')),
 confirmed_count INT NOT NULL DEFAULT 0 CHECK(confirmed_count>=0), revision INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), settled_at TIMESTAMPTZ,
 UNIQUE(owner_user_id,client_operation_id)
);
CREATE TABLE one_location_check_in_targets (
 operation_id UUID NOT NULL REFERENCES one_location_check_in_operations(id) ON DELETE CASCADE,
 target_id UUID NOT NULL DEFAULT gen_random_uuid(),
 recipient_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL, confirmed_grant_id UUID, confirmed_envelope_id UUID,
 confirmed_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
 PRIMARY KEY(operation_id,target_id),
 UNIQUE(operation_id,recipient_user_id),
 CHECK((confirmed_grant_id IS NULL AND confirmed_envelope_id IS NULL AND confirmed_at IS NULL)
    OR (confirmed_grant_id IS NOT NULL AND confirmed_envelope_id IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX one_location_check_in_grant ON one_location_check_in_targets(confirmed_grant_id) WHERE confirmed_grant_id IS NOT NULL;
CREATE INDEX one_location_check_in_retention ON one_location_check_in_operations(settled_at) WHERE settled_at IS NOT NULL;
COMMENT ON TABLE one_location_check_in_operations IS 'Owner-only private Check-In plan; 12-hour terminal workflow retention. Saved Feed receipts retain bounded counts, never points or private notes.';
COMMENT ON TABLE one_location_check_in_targets IS 'Exact intended audience and atomic grant/envelope receipt; no location ciphertext or private note duplicated. Cascade with owner operation.';
-- A grant ending updates the same Check-In operation, with dated outcome steps.
CREATE FUNCTION one_location_check_in_grant_ended() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='active' OR OLD.status=NEW.status THEN RETURN NEW; END IF;
 -- Do not lock another operation while a new share replaces this grant.
 -- Count/state reconciliation runs after the grant transaction, under its own
 -- operation lock. This trigger touches only this exact saved target.
 UPDATE one_location_check_in_targets SET ended_at=COALESCE(ended_at,clock_timestamp())
 WHERE confirmed_grant_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER one_location_check_in_grant_ended AFTER UPDATE OF status ON one_location_share_grants
FOR EACH ROW EXECUTE FUNCTION one_location_check_in_grant_ended();

-- Attach only closed, scalar transition facts after the existing projections.
CREATE FUNCTION one_location_feed_transition_facts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_key TEXT; operation UUID; origin_request UUID;
BEGIN
 source_key := CASE
  WHEN NEW.event_type IN('location_share_created','location_share_revoked','location_share_expired') THEN NEW.grant_id::text
  WHEN NEW.event_type IN('location_share_shortened','location_share_duration_changed') AND NULLIF(NEW.metadata->>'client_operation_id','') IS NOT NULL
    THEN NEW.grant_id::text||':operation:'||left(NEW.metadata->>'client_operation_id',160)
  WHEN NEW.event_type='location_access_request' THEN NEW.request_id::text||':revision:'||COALESCE(NEW.metadata->>'request_revision','1')
  WHEN NEW.event_type IN('location_access_approved','location_access_denied') THEN NEW.request_id::text
  END;
 SELECT o.id INTO operation FROM one_location_check_in_operations o JOIN one_location_share_grants g
 ON g.owner_user_id=o.owner_user_id AND g.metadata->>'client_operation_id'=o.client_operation_id
 WHERE g.id=NEW.grant_id AND g.metadata->>'share_kind'='check_in';
SELECT CASE WHEN count(*)=1 THEN min(id::text)::uuid END INTO origin_request
 FROM one_location_access_requests WHERE approved_grant_id=NEW.grant_id
   AND owner_user_id=NEW.owner_user_id AND requester_user_id=NEW.recipient_user_id;
 UPDATE feed_events f SET metadata=f.metadata || jsonb_strip_nulls(jsonb_build_object(
   'grant_id',NEW.grant_id::text,'recorded_grant_id',NEW.grant_id::text,'request_id',NEW.request_id::text,'recorded_request_id',COALESCE(NEW.request_id,origin_request)::text,
   'actor_is_self',CASE WHEN NEW.actor_user_id IS NOT NULL THEN NEW.actor_user_id=f.user_id END,
   'action_actor_label',(SELECT left(btrim(a.display_name),160) FROM actor_identity_cache a WHERE a.user_id=NEW.actor_user_id
     AND NULLIF(btrim(a.display_name),'') IS NOT NULL AND a.display_name<>a.user_id AND strpos(a.display_name,'@')=0
     AND a.display_name !~* '^ria:' AND a.display_name !~* '^[0-9a-f-]{36}$'
     AND a.display_name !~ '^[+0-9 ()-]+$' AND (a.display_name ~ '[[:space:]]' OR length(a.display_name)<20)),
   'reason',CASE WHEN NEW.metadata->>'reason' IN('owner_revoke','recipient_revoke','owner_shorten','recipient_shorten','expired','request_approved','check_in','sos_panic','circle_membership_ended','circle_deleted','connection_disconnected') THEN NEW.metadata->>'reason' END,
   'added_duration_hours',CASE WHEN jsonb_typeof(NEW.metadata->'added_duration_hours') IN('number','string') THEN left(NEW.metadata->>'added_duration_hours',32) END,
   'approval_mode',CASE WHEN NEW.metadata->>'approval_mode' IN('automatic','manual') THEN NEW.metadata->>'approval_mode' END,
   'check_in_operation_id',CASE WHEN f.user_id=NEW.owner_user_id THEN operation::text END,
   'circle_id',CASE WHEN NEW.metadata->>'circle_id' ~* '^[0-9a-f-]{36}$' THEN NEW.metadata->>'circle_id' END,
   'membership_key',CASE WHEN jsonb_typeof(NEW.metadata->'membership_key')='string' THEN left(NEW.metadata->>'membership_key',256) END
 )) WHERE f.source_domain='location' AND f.event_type=NEW.event_type
 AND f.user_id IN(NEW.owner_user_id,NEW.recipient_user_id)
 AND f.source_row_id IN(NEW.id::text,NEW.id::text||':recipient',source_key);
 RETURN NEW;
END $$;
CREATE TRIGGER zz_one_location_feed_transition_facts AFTER INSERT ON one_location_events
FOR EACH ROW EXECUTE FUNCTION one_location_feed_transition_facts();
 -- Capture the old incarnation before a future rejoin can overwrite joined_at.
CREATE FUNCTION one_location_feed_membership_facts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE key TEXT;
BEGIN
 IF OLD.status<>'active' OR NEW.status NOT IN('left','removed') THEN RETURN NEW; END IF;
 key:=encode(sha256(convert_to('one.circle.membership:'||NEW.circle_id::text||':'||NEW.user_id||':'||
   (extract(epoch FROM NEW.joined_at)*1000000)::bigint::text,'UTF8')),'hex');
 UPDATE feed_events SET metadata=metadata||jsonb_build_object('membership_key',key)
 WHERE source_domain='location' AND event_type IN('circle_member_left','circle_membership_ended')
 AND source_row_id=NEW.circle_id::text||':'||NEW.user_id||':'||NEW.joined_at::text;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_one_location_feed_membership_facts AFTER UPDATE OF status ON one_location_circle_memberships
FOR EACH ROW EXECUTE FUNCTION one_location_feed_membership_facts();


UPDATE feed_events f SET metadata=f.metadata||jsonb_strip_nulls(jsonb_build_object('recorded_grant_id',e.grant_id::text,'recorded_request_id',e.request_id::text))
FROM one_location_events e WHERE f.source_domain='location' AND f.event_type=e.event_type
 AND f.user_id IN(e.owner_user_id,e.recipient_user_id) AND e.grant_id IS NOT NULL
 AND f.source_row_id IN(e.id::text,e.id::text||':recipient')
 AND NOT EXISTS(SELECT 1 FROM one_location_events other WHERE other.id<>e.id AND other.event_type=e.event_type
   AND other.grant_id<>e.grant_id AND f.source_row_id IN(other.id::text,other.id::text||':recipient'));
UPDATE feed_events f SET metadata=f.metadata||jsonb_build_object('recorded_request_id',r.id::text)
FROM one_location_access_requests r WHERE r.approved_grant_id IS NOT NULL
 AND f.source_domain='location' AND f.user_id IN(r.owner_user_id,r.requester_user_id)
 AND COALESCE(f.metadata->>'recorded_grant_id',f.source_row_id)=r.approved_grant_id::text
 AND NOT EXISTS(SELECT 1 FROM one_location_access_requests other WHERE other.id<>r.id
   AND other.approved_grant_id=r.approved_grant_id AND other.owner_user_id=r.owner_user_id AND other.requester_user_id=r.requester_user_id);
COMMIT;
