BEGIN;

-- A failed/interrupted concurrent build can leave an INVALID index behind.
-- IF NOT EXISTS alone must never let a retry declare this release ready.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public.idx_one_location_events_recipient_type')
      AND indrelid = 'public.one_location_events'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Feed recipient index is missing or invalid; rebuild migration 203 before retrying 204';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_feed_counterpart_user_id(
  p_user_id TEXT, p_source_domain TEXT, p_event_type TEXT, p_source_row_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  counterpart_id TEXT;
  source_uuid UUID;
  source_event_id BIGINT;
  use_grant_lookup BOOLEAN;
BEGIN
  -- Parse presentation source keys, never cast an indexed primary-key column.
  -- Malformed legacy keys must not abort insertion of the underlying event.
  BEGIN
    source_uuid := CASE WHEN p_event_type IN ('connection_accepted', 'connection_rejected')
      THEN p_source_row_id::UUID ELSE split_part(p_source_row_id, ':', 1)::UUID END;
  EXCEPTION WHEN invalid_text_representation THEN source_uuid := NULL;
  END;
  IF p_source_domain = 'location' AND p_event_type IN (
    'location_share_created', 'location_share_revoked', 'location_share_expired',
    'location_share_shortened', 'location_share_duration_changed', 'location_share_viewed',
    'location_access_request', 'location_access_approved', 'location_access_denied',
    'location_access_request_withdrawn', 'location_referral_invite',
    'location_sms_contact_added', 'location_sms_contact_removed', 'circle_member_added'
  ) THEN
    BEGIN
      source_event_id := split_part(p_source_row_id, ':', 1)::BIGINT;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      source_event_id := NULL;
    END;
  END IF;
  use_grant_lookup := source_uuid IS NOT NULL AND p_event_type IN (
    'location_share_created', 'location_share_revoked', 'location_share_expired',
    'location_share_shortened', 'location_share_duration_changed', 'location_share_viewed'
  );
  IF p_source_domain = 'connections' THEN
    IF p_event_type IN ('connection_accepted', 'connection_rejected') THEN
      SELECT CASE WHEN r.requester_user_id = p_user_id THEN r.addressee_user_id
                  ELSE r.requester_user_id END INTO counterpart_id
      FROM public.connection_requests r
      WHERE r.id = source_uuid
        AND p_user_id IN (r.requester_user_id, r.addressee_user_id);
    ELSIF p_event_type = 'connection_revoked' THEN
      SELECT CASE WHEN c.user_a_id = p_user_id THEN c.user_b_id ELSE c.user_a_id END
        INTO counterpart_id
      FROM public.connections c
      WHERE c.id = source_uuid
        AND p_user_id IN (c.user_a_id, c.user_b_id);
    END IF;
  ELSIF p_source_domain = 'location' THEN
    IF p_event_type = 'circle_member_invited' THEN
      SELECT i.inviter_user_id INTO counterpart_id
      FROM public.one_location_circle_member_invites i
      WHERE i.id = source_uuid
        AND i.invitee_user_id = p_user_id;
    ELSE
      SELECT CASE
        WHEN e.event_type IN ('location_share_viewed', 'location_circle_code_joined',
          'location_circle_member_invite_accepted', 'circle_member_added',
          'location_referral_invite', 'location_public_invite_submitted') THEN e.actor_user_id
        WHEN e.owner_user_id = p_user_id THEN e.recipient_user_id
        ELSE e.owner_user_id END INTO counterpart_id
      FROM (
        -- Separate branches preserve a primary-key lookup for numeric audit
        -- sources even after PostgreSQL switches to a generic cached plan.
        SELECT a.* FROM public.one_location_events a
          WHERE source_event_id IS NOT NULL AND a.id = source_event_id
        UNION ALL
        -- Grant IDs use the leading column of the existing retention index.
        SELECT a.* FROM public.one_location_events a
          WHERE source_event_id IS NULL AND use_grant_lookup
            AND a.grant_id = source_uuid
        UNION ALL
        -- Legacy request/referral/metadata keys still need exact source matching
        -- below, but only inspect this audience's events, never all users' audit.
        SELECT a.* FROM public.one_location_events a
          WHERE source_event_id IS NULL AND NOT use_grant_lookup
            AND a.owner_user_id = p_user_id
        UNION ALL
        SELECT a.* FROM public.one_location_events a
          WHERE source_event_id IS NULL AND NOT use_grant_lookup
            AND a.recipient_user_id = p_user_id
            AND a.owner_user_id IS DISTINCT FROM p_user_id
      ) e
      WHERE e.event_type = p_event_type
        AND CASE
          WHEN p_event_type = 'location_referral_invite' THEN e.recipient_user_id = p_user_id
          WHEN p_event_type IN ('location_share_viewed', 'location_circle_code_joined',
            'location_circle_member_invite_accepted', 'circle_member_added',
            'location_public_invite_submitted', 'location_access_approved')
            THEN e.owner_user_id = p_user_id
          WHEN p_event_type IN ('location_share_created', 'location_share_revoked',
            'location_share_shortened', 'location_share_duration_changed', 'location_share_expired',
            'location_access_request', 'location_access_denied', 'location_access_request_withdrawn',
            'location_one_network_joined', 'location_sms_contact_added', 'location_sms_contact_removed')
            THEN p_user_id IN (e.owner_user_id, e.recipient_user_id)
          ELSE FALSE END
        AND (e.id::TEXT = p_source_row_id OR p_source_row_id = CASE
          WHEN p_event_type IN ('location_share_created', 'location_share_revoked', 'location_share_expired')
            THEN COALESCE(e.grant_id::TEXT, e.id::TEXT)
          WHEN p_event_type IN ('location_share_shortened', 'location_share_duration_changed') THEN
            CASE WHEN NULLIF(BTRIM(e.metadata->>'client_operation_id'), '') IS NOT NULL
              THEN CONCAT(COALESCE(e.grant_id::TEXT, 'unknown-grant'), ':operation:',
                LEFT(BTRIM(e.metadata->>'client_operation_id'), 160))
              ELSE e.id::TEXT END
          WHEN p_event_type = 'location_access_request' THEN
            CONCAT(COALESCE(e.request_id::TEXT, e.id::TEXT), ':revision:',
              COALESCE(LEFT(NULLIF(BTRIM(e.metadata->>'request_revision'), ''), 32), '1'))
          WHEN p_event_type IN ('location_access_approved', 'location_access_denied', 'location_access_request_withdrawn')
            THEN COALESCE(e.request_id::TEXT, e.id::TEXT)
          WHEN p_event_type = 'location_referral_invite' THEN COALESCE(e.referral_id::TEXT, e.id::TEXT)
          WHEN p_event_type = 'location_public_invite_submitted' THEN
            COALESCE(CASE WHEN jsonb_typeof(e.metadata->'submission_id') = 'string'
              THEN LEFT(NULLIF(BTRIM(e.metadata->>'submission_id'), ''), 256) END, e.id::TEXT)
          WHEN p_event_type = 'location_one_network_joined' THEN
            COALESCE(LEFT(NULLIF(BTRIM(e.metadata->>'invite_id'), ''), 160),
              LEFT(NULLIF(BTRIM(e.metadata->>'connection_id'), ''), 160), e.id::TEXT)
          WHEN p_event_type IN ('location_circle_code_joined', 'location_circle_member_invite_accepted') THEN
            CONCAT(COALESCE(NULLIF(BTRIM(e.metadata->>'invite_id'), ''), e.id::TEXT),
              ':member:', COALESCE(e.actor_user_id, e.id::TEXT))
          WHEN p_event_type = 'location_share_viewed' THEN
            CONCAT(COALESCE(e.grant_id::TEXT, e.id::TEXT), ':viewer:', e.actor_user_id,
              ':', TO_CHAR(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
          WHEN p_event_type IN ('location_sms_contact_added', 'location_sms_contact_removed') THEN
            CASE WHEN e.owner_user_id = p_user_id THEN e.id::TEXT ELSE CONCAT(e.id::TEXT, ':recipient') END
          ELSE e.id::TEXT END)
      ORDER BY e.id DESC LIMIT 1;
    END IF;
  END IF;
  RETURN (SELECT p.user_id FROM public.actor_profiles p WHERE p.user_id = counterpart_id);
END;
$$;

COMMIT;
