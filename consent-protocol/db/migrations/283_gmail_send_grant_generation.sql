-- A send review survives token refresh, but never reconnection or a changed
-- sending grant. No credentials or message contents are added to the ledger.
BEGIN;
ALTER TABLE kai_gmail_connections
  ADD COLUMN IF NOT EXISTS send_grant_generation BIGINT NOT NULL DEFAULT 0
  CHECK (send_grant_generation >= 0);

CREATE OR REPLACE FUNCTION bump_gmail_send_grant_generation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.google_sub, NEW.scope_csv, NEW.status, NEW.revoked, NEW.send_enabled)
     IS DISTINCT FROM
     ROW(OLD.google_sub, OLD.scope_csv, OLD.status, OLD.revoked, OLD.send_enabled) THEN
    NEW.send_grant_generation := GREATEST(NEW.send_grant_generation, OLD.send_grant_generation + 1);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gmail_send_grant_generation ON kai_gmail_connections;
CREATE TRIGGER gmail_send_grant_generation BEFORE UPDATE ON kai_gmail_connections
FOR EACH ROW EXECUTE FUNCTION bump_gmail_send_grant_generation();
COMMIT;
