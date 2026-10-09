BEGIN;
ALTER TABLE one_wallet_cards DROP COLUMN IF EXISTS share_token_envelope;
COMMIT;
