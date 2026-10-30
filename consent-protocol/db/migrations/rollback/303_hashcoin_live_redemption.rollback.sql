-- Financial reservations may already exist in either mode. Disable
-- DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED to stop new live withdrawals; retain
-- existing rows and the mode-binding trigger so reconciliation stays safe.
BEGIN;
COMMENT ON TABLE hashcoin_redemptions IS
  'Live redemption disabled by runtime flag; mode-bound financial reservations retained.';
COMMIT;
