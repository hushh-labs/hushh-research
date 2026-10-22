BEGIN;

-- Domain outcome observations only. No content, provider IDs or action authority.
CREATE TABLE IF NOT EXISTS one_product_value_receipts (
  effect_id CHAR(64) NOT NULL,
  user_id TEXT NOT NULL REFERENCES one_product_activity_epochs(user_id) ON DELETE CASCADE,
  generation UUID NOT NULL,
  agent_id TEXT NOT NULL,
  proof TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
  PRIMARY KEY(user_id,generation,agent_id,effect_id),
  CHECK ((agent_id='agent_calendar' AND proof='calendar.provider_effect.v1')
      OR (agent_id='agent_location' AND proof='location.domain_effect.v1')
      OR (agent_id='agent_nav' AND proof='nav.owner_decision.v1'))
);
CREATE INDEX IF NOT EXISTS one_product_value_owner_time ON one_product_value_receipts(user_id,occurred_at);
CREATE INDEX IF NOT EXISTS one_product_value_expiry ON one_product_value_receipts(expires_at);
ALTER TABLE one_product_value_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_product_value_receipts FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON one_product_value_receipts FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON one_product_value_receipts TO service_role;
  END IF;
  PERFORM public.install_account_deletion_write_guards();
END $$;

-- Link an information-request reply to the canonical, provider-confirmed send.
ALTER TABLE gmail_personal_information_requests ADD COLUMN IF NOT EXISTS reply_send_action_id TEXT
  REFERENCES gmail_owner_send_actions(action_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS gmail_personal_information_reply_send_action
  ON gmail_personal_information_requests(reply_send_action_id)
  WHERE reply_send_action_id IS NOT NULL;
COMMENT ON TABLE one_product_value_receipts IS
 'Private best-effort provider-effect observations: opaque references, 500 per owner/UTC day, seven-day TTL. Never an action, consent, reward, delivery or business settlement authority.';
COMMIT;
