BEGIN;
-- Dev Browser uses the existing exact-action ledger. Private terms never enter
-- these rows; only their keyed commitments and owner/task bindings are stored.
-- Preserve MCP and every existing confirmation/session predicate.
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS pod_chat_action_identity;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT pod_chat_action_identity CHECK (
    channel <> 'pod_chat' OR (
      adk_app_name IS NULL
      AND action_id IN (
        'connector.mcp.invoke',
        'browser.model_process',
        'browser.disclose',
        'browser.session_remember',
                'browser.session_restore',
                'browser.provider_safety'
      )
      AND requires_confirmation
      AND trusted_activation_required
      AND resource_binding_hmac IS NOT NULL
    )
  );
COMMIT;
-- Application rollback disables Browser. Reinstalling 945's narrower CHECK
-- requires a separate ledger-retention decision; never delete review history
-- merely to make a SQL rollback pass.
