-- ============================================================================
-- Migration 011: NOTIFY on consent_audit INSERT for event-driven SSE/push
-- ============================================================================
-- When a row is inserted into consent_audit, notify listeners so the
-- notification worker can send FCM/push and/or push to in-app SSE queues.
-- Payload is small JSON (user_id, request_id, action) to stay under 8KB limit.
-- ============================================================================

CREATE OR REPLACE FUNCTION consent_audit_notify()
RETURNS TRIGGER AS $$
DECLARE
  payload TEXT;
BEGIN
  -- Build small JSON payload (NOTIFY limit 8000 bytes)
  payload := json_build_object(
    'user_id', NEW.user_id,
    'request_id', COALESCE(NEW.request_id, ''),
    'action', NEW.action,
    'scope', COALESCE(NEW.scope, ''),
    'agent_id', COALESCE(NEW.agent_id, ''),
    'scope_description', COALESCE(NEW.scope_description, ''),
    'issued_at', NEW.issued_at,
    'bundle_id', COALESCE(NEW.metadata->>'bundle_id', ''),
    'bundle_label', COALESCE(NEW.metadata->>'bundle_label', ''),
    'bundle_scope_count', COALESCE(NEW.metadata->>'bundle_scope_count', '1')
  )::TEXT;
  PERFORM pg_notify('consent_audit_new', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS consent_audit_after_insert ON consent_audit;
CREATE TRIGGER consent_audit_after_insert
  AFTER INSERT ON consent_audit
  FOR EACH ROW
  EXECUTE FUNCTION consent_audit_notify();

COMMENT ON FUNCTION consent_audit_notify() IS 'Sends NOTIFY consent_audit_new on each consent_audit INSERT for event-driven SSE and push notifications';
