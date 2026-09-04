BEGIN;

-- ============================================================================
-- Migration 117: feed_events (cross-domain activity feed)
-- ============================================================================
-- A dedicated, presentation-focused append-only log for the One "Feed" route.
-- This is deliberately separate from each domain's own audit/compliance
-- ledger (consent_audit, one_location_events, connected_system_audit_events):
-- those remain the authority for their domain, this table exists only to
-- give the feed one uniform shape to read and paginate. Never stores
-- ciphertext or vault-protected content, only bounded, non-sensitive
-- metadata a human-readable line can be rendered from client-side.
-- ============================================================================

CREATE TABLE IF NOT EXISTS feed_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_domain TEXT NOT NULL CHECK (source_domain IN (
    'consent', 'location', 'kai', 'kyc', 'connected_systems', 'connections'
  )),
  event_type TEXT NOT NULL,
  actor_label TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_row_id TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_events_user_created
  ON feed_events (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_events_user_unread
  ON feed_events (user_id)
  WHERE read_at IS NULL;

COMMENT ON TABLE feed_events IS
  'Presentation-only cross-domain activity log for the One Feed route. Not a domain audit authority; metadata is always bounded and non-sensitive.';

-- ----------------------------------------------------------------------------
-- Trigger fan-out from existing durable per-domain event/audit tables.
-- Mirrors the established pattern in 011_consent_audit_notify_trigger.sql:
-- one small trigger function per source table, filtered to feed-worthy rows.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION feed_events_from_consent_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action IN ('REQUESTED', 'CONSENT_GRANTED', 'REVOKED') THEN
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.user_id,
      'consent',
      CASE NEW.action
        WHEN 'REQUESTED' THEN 'consent_requested'
        WHEN 'CONSENT_GRANTED' THEN 'consent_granted'
        WHEN 'REVOKED' THEN 'consent_revoked'
      END,
      jsonb_build_object(
        'scope', NEW.scope,
        'agent_id', NEW.agent_id,
        'scope_description', COALESCE(NEW.scope_description, '')
      ),
      NEW.id::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS consent_audit_feed_fanout ON consent_audit;
CREATE TRIGGER consent_audit_feed_fanout
  AFTER INSERT ON consent_audit
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_consent_audit();

COMMENT ON FUNCTION feed_events_from_consent_audit() IS
  'Fans out feed-worthy consent_audit inserts (REQUESTED/CONSENT_GRANTED/REVOKED) into feed_events.';

CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_expired',
    'location_access_request',
    'location_access_approved',
    'location_access_denied'
  ) THEN
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      NEW.metadata,
      NEW.id::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_events_feed_fanout ON one_location_events;
CREATE TRIGGER one_location_events_feed_fanout
  AFTER INSERT ON one_location_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_one_location_events();

COMMENT ON FUNCTION feed_events_from_one_location_events() IS
  'Fans out feed-worthy one_location_events inserts into feed_events, owner-scoped.';

CREATE OR REPLACE FUNCTION feed_events_from_connected_system_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('approved', 'connected', 'rejected', 'failed') THEN
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.user_id,
      'connected_systems',
      'connected_systems_' || NEW.status,
      jsonb_build_object(
        'system_id', NEW.system_id,
        'target', NEW.target,
        'object_type', NEW.object_type,
        'action', NEW.action
      ),
      NEW.event_id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connected_system_audit_feed_fanout ON connected_system_audit_events;
CREATE TRIGGER connected_system_audit_feed_fanout
  AFTER INSERT ON connected_system_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_connected_system_audit();

COMMENT ON FUNCTION feed_events_from_connected_system_audit() IS
  'Fans out feed-worthy connected_system_audit_events inserts into feed_events.';

COMMIT;
