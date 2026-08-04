-- Guarded operational rollback for migration 132.
-- This file is intentionally excluded from the release migration manifest.

BEGIN;

-- Dropping the table destroys every owner's share-token digest, which cannot
-- be reconstructed: only the digest is stored, never the plaintext token. Any
-- printed or installed QR code would break permanently and every pass would
-- resolve to nothing. Rolling back with live cards present is therefore
-- refused: disable ONE_WALLET_CARD_ENABLED and roll the application back
-- first, then retain this additive table until a separately reviewed contract
-- migration removes it.
DO $$
BEGIN
  IF to_regclass('public.one_wallet_cards') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM one_wallet_cards LIMIT 1) THEN
      RAISE EXCEPTION
        'migration_132_contains_live_wallet_cards_disable_feature_flag_and_retain_table';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS one_wallet_cards;

COMMIT;
