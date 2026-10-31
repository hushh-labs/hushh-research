-- Per-person commitments for a single reviewed Location audience. The existing
-- directive owns the plan and its atomic domain receipts; no plaintext audience.
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS audience_plan JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS audience_receipts JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='one_command_audience_receipts_valid') THEN
    ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_command_audience_receipts_valid CHECK (
      jsonb_typeof(audience_plan)='object' AND octet_length(audience_plan::text)<=1000000
      AND jsonb_typeof(audience_receipts)='object' AND octet_length(audience_receipts::text)<=1000000
      AND ((audience_plan='{}'::jsonb AND audience_receipts='{}'::jsonb) OR
        (channel='command' AND action_id IN ('location.share_selected','location.send_request','location.send_check_in')))
    );
  END IF;
END $$;
