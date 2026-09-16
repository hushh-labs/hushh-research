-- Keep each client-dispatched membership batch with the existing directive.
-- Membership effects and their bounded receipt commit in the owning transaction.
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS membership_plan JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS membership_receipts JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='one_command_membership_receipts_valid') THEN
    ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_command_membership_receipts_valid
      CHECK (jsonb_typeof(membership_plan)='object' AND octet_length(membership_plan::text)<=50000
        AND (membership_plan='{}'::jsonb OR (channel='command' AND action_id='location.add_to_circle'))
        AND jsonb_typeof(membership_receipts)='object' AND octet_length(membership_receipts::text) <= 1000000
        AND (membership_receipts='{}'::jsonb OR (channel='command' AND action_id='location.add_to_circle')));
  END IF;
END $$;
