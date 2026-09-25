BEGIN;

-- Put Drive sharing and Drive questions in the Feed.
--
-- Both lanes notify only through an opaque outbox (drive_share_events,
-- drive_query_events) whose one delivery path is a push. A person with no
-- registered device -- every web browser that never granted notification
-- permission -- learned nothing: a share, a question or an answer arrived in
-- complete silence. The Feed, the one place every other relationship change is
-- written down, never showed a Drive event at all.
--
-- One projection writes a Feed row to the person each Drive event is addressed
-- to, the same way location and circle events are projected. Feed is
-- plaintext: only the closed event type, the opaque request id, the request's
-- status word and the other person's display label cross over -- never a file
-- name, question, purpose, answer or Drive identifier. The source domain is
-- `connected_systems` (Google Drive is a connected system), so the feed_events
-- source_domain CHECK is unchanged.
--
-- The projection must never be able to fail a share: any error is swallowed
-- inside its own block and the Drive transaction continues without a Feed row.

CREATE OR REPLACE FUNCTION project_drive_event_to_feed(
  p_lane TEXT,
  p_event_id UUID,
  p_request_id UUID,
  p_user_id TEXT,
  p_event_type TEXT,
  p_created_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  owner_id TEXT;
  other_id TEXT;
  counterpart_id TEXT;
  request_status TEXT;
  label TEXT;
  handle TEXT;
  feed_id BIGINT;
BEGIN
  IF p_event_type NOT IN (
    'document_share_request',
    'document_share_review_ready',
    'document_share_decided',
    'document_share_outcome',
    'document_share_revoked',
    'document_share_revocation_outcome',
    'document_share_question',
    'document_share_answered',
    'document_share_declined'
  ) THEN
    RETURN;
  END IF;

  BEGIN
    IF p_lane = 'share' THEN
      SELECT r.user_id, r.recipient_user_id, r.status
        INTO owner_id, other_id, request_status
        FROM drive_share_requests r WHERE r.request_id = p_request_id;
    ELSIF p_lane = 'query' THEN
      SELECT r.user_id, r.requester_user_id, r.status
        INTO owner_id, other_id, request_status
        FROM drive_live_query_requests r WHERE r.request_id = p_request_id;
    ELSE
      RETURN;
    END IF;
    IF owner_id IS NULL THEN
      RETURN;
    END IF;
    -- The other person, from the addressee's side of the request.
    counterpart_id := CASE WHEN p_user_id = owner_id THEN other_id ELSE owner_id END;

    SELECT NULLIF(BTRIM(COALESCE(a.display_name, '')), ''),
           NULLIF(BTRIM(split_part(COALESCE(a.email, ''), '@', 1)), '')
      INTO label, handle
      FROM actor_identity_cache a WHERE a.user_id = counterpart_id;
    -- Same rule as requester_identity.looks_technical_label: a raw uid, a
    -- UUID or an opaque token is an identifier, not a name. A full email is
    -- narrowed to its handle; the Feed never shows an address.
    IF label IS NOT NULL AND (
      strpos(label, '@') > 0
      OR label = counterpart_id
      OR lower(label) LIKE 'ria:%'
      OR label ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (strpos(label, '@') = 0 AND strpos(label, ' ') = 0 AND length(label) >= 20)
    ) THEN
      label := NULL;
    END IF;
    IF label IS NULL AND handle IS NOT NULL
       AND NOT (strpos(handle, ' ') = 0 AND length(handle) >= 20) THEN
      label := handle;
    END IF;
    label := LEFT(label, 160);

    INSERT INTO feed_events (
      user_id, source_domain, event_type, actor_label, metadata, source_row_id, created_at
    )
    VALUES (
      p_user_id,
      'connected_systems',
      p_event_type,
      label,
      jsonb_strip_nulls(jsonb_build_object(
        'request_id', p_request_id::TEXT,
        'counterpart_label', label,
        -- Only the non-owner side carries the marker, as in migration 152.
        'feed_audience', CASE WHEN p_user_id = other_id THEN 'recipient' END,
        'user_facing_status', LEFT(request_status, 40)
      )),
      p_event_id::TEXT,
      COALESCE(p_created_at, now())
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO feed_id;

    -- Server-only link to the other person so the Feed shows their current
    -- photo (migration 202); never enters the browser payload.
    IF feed_id IS NOT NULL AND counterpart_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM actor_profiles p WHERE p.user_id = counterpart_id) THEN
      INSERT INTO feed_event_counterparts (feed_event_id, counterpart_user_id)
      VALUES (feed_id, counterpart_id)
      ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'drive_feed_projection_failed sqlstate=%', SQLSTATE;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION feed_events_from_drive_events()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM project_drive_event_to_feed(
    CASE TG_TABLE_NAME WHEN 'drive_query_events' THEN 'query' ELSE 'share' END,
    NEW.event_id,
    NEW.request_id,
    NEW.user_id,
    NEW.event_type,
    NEW.created_at
  );
  RETURN NEW;
END;
$$;

-- Create each trigger only once. Replay runs on every deploy, and dropping a
-- trigger takes ACCESS EXCLUSIVE on its table; CREATE OR REPLACE FUNCTION
-- above already updates the body in place.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'drive_share_events_feed_projection'
      AND tgrelid = 'drive_share_events'::regclass
  ) THEN
    CREATE TRIGGER drive_share_events_feed_projection
      AFTER INSERT ON drive_share_events
      FOR EACH ROW EXECUTE FUNCTION feed_events_from_drive_events();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'drive_query_events_feed_projection'
      AND tgrelid = 'drive_query_events'::regclass
  ) THEN
    CREATE TRIGGER drive_query_events_feed_projection
      AFTER INSERT ON drive_query_events
      FOR EACH ROW EXECUTE FUNCTION feed_events_from_drive_events();
  END IF;
END
$$;

-- Recent history, so events from before this migration are not silent either.
-- Idempotent on replay: each event is one Feed row keyed by its event id.
SELECT project_drive_event_to_feed(
  'share', e.event_id, e.request_id, e.user_id, e.event_type, e.created_at
)
FROM drive_share_events e
WHERE e.created_at > now() - INTERVAL '3 days';

SELECT project_drive_event_to_feed(
  'query', e.event_id, e.request_id, e.user_id, e.event_type, e.created_at
)
FROM drive_query_events e
WHERE e.created_at > now() - INTERVAL '3 days';

COMMENT ON FUNCTION project_drive_event_to_feed(TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) IS
  'Projects one Drive sharing/question event into Feed for its addressee: closed type, request id, status word and the other person''s label only.';

COMMIT;
