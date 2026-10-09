BEGIN;

ALTER TABLE one_wallet_cards
  ADD COLUMN IF NOT EXISTS share_token_envelope JSONB;

COMMENT ON COLUMN one_wallet_cards.share_token_hash IS
  'SHA-256 lookup digest. Plaintext is never stored or logged. Legacy rows without an encrypted envelope retain explicit owner rotation recovery.';
COMMENT ON COLUMN one_wallet_cards.share_token_envelope IS
  'Optional AES-GCM envelope for authenticated owner link recovery. AAD binds the owner and token digest. Never part of the public card projection.';
COMMENT ON COLUMN one_wallet_cards.card_payload IS
  'Server-validated allowlisted profile fields. Automatic creation uses available account basics; later edits are owner-controlled and are never overwritten by provisioning. No PKM material or credentials.';

COMMIT;
