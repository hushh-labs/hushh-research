-- Existing command ledger owns client-domain operation claims and receipts.
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS effect_request_hmac TEXT;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS effect_receipt JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='one_command_effect_receipt_shape') THEN
    ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_command_effect_receipt_shape CHECK (
      (effect_request_hmac IS NULL AND effect_receipt IS NULL) OR
      (channel='command' AND effect_request_hmac IS NOT NULL AND effect_request_hmac ~ '^[a-f0-9]{64}$' AND
       (effect_receipt IS NULL OR (jsonb_typeof(effect_receipt)='object' AND octet_length(effect_receipt::text)<=4096)))
    );
  END IF;
END $$;
