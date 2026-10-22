-- Durable, mode-scoped polling cursor recovers Connect bank deposits and
-- status transitions when a webhook is delayed or missed. The started time
-- doubles as a bounded lease; provider I/O happens after its transaction.
BEGIN;

ALTER TABLE stripe_owner_payout_accounts
  ADD COLUMN IF NOT EXISTS bank_payout_scan_started_at TIMESTAMPTZ;
ALTER TABLE stripe_owner_payout_accounts
  ADD COLUMN IF NOT EXISTS bank_payout_scan_cursor TEXT;
ALTER TABLE stripe_owner_payout_accounts
  DROP CONSTRAINT IF EXISTS stripe_owner_payout_bank_scan_cursor_check;
ALTER TABLE stripe_owner_payout_accounts
  ADD CONSTRAINT stripe_owner_payout_bank_scan_cursor_check
  CHECK (bank_payout_scan_cursor IS NULL OR
    bank_payout_scan_cursor ~ '^po_[A-Za-z0-9_]{1,252}$');

CREATE INDEX IF NOT EXISTS stripe_owner_payout_accounts_bank_scan_due
  ON stripe_owner_payout_accounts
  (stripe_mode, bank_payout_scan_started_at ASC NULLS FIRST, stripe_account_id);

-- Cancellation has its own signed event; keep the immediate path as well as
-- the periodic scan for events that Stripe cannot deliver.
ALTER TABLE stripe_connect_bank_payout_events
  DROP CONSTRAINT IF EXISTS stripe_connect_bank_payout_events_event_type_check;
ALTER TABLE stripe_connect_bank_payout_events
  ADD CONSTRAINT stripe_connect_bank_payout_events_event_type_check CHECK (event_type IN
    ('account.updated','account.external_account.created','account.external_account.updated',
     'account.external_account.deleted','payout.created','payout.updated','payout.paid',
     'payout.failed','payout.canceled'));

COMMENT ON COLUMN stripe_owner_payout_accounts.bank_payout_scan_started_at IS
  'Last bounded Connect payout page claim; also leases this owner for five minutes.';
COMMENT ON COLUMN stripe_owner_payout_accounts.bank_payout_scan_cursor IS
  'Last Stripe payout ID of an incomplete historical page scan; NULL starts at newest.';

COMMIT;
