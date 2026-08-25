BEGIN;

-- The single Gmail OAuth connection grants read and send together. This is a
-- local owner safety toggle, not a second provider grant or token store.
ALTER TABLE kai_gmail_connections
  ADD COLUMN IF NOT EXISTS send_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN kai_gmail_connections.send_enabled IS
  'Owner-controlled local delivery toggle. Gmail send scope is granted during the single Gmail OAuth connection.';

COMMIT;
