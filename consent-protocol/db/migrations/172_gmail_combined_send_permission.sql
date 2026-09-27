BEGIN;

-- The single Gmail OAuth connection grants read and send together. This is a
-- local owner safety toggle, not a second provider grant or token store.
-- Replay guard: ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE before it
-- finds the column. Skip it only when the column is already there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('kai_gmail_connections')
      AND attname = 'send_enabled'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    ALTER TABLE kai_gmail_connections
      ADD COLUMN IF NOT EXISTS send_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END
$$;

COMMENT ON COLUMN kai_gmail_connections.send_enabled IS
  'Owner-controlled local delivery toggle. Gmail send scope is granted during the single Gmail OAuth connection.';

COMMIT;
