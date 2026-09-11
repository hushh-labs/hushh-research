BEGIN;

-- Migration 172 introduced a local send gate, but OAuth completion did not
-- persist it. Enable only connected, non-revoked accounts that already hold
-- Google's gmail.send grant; this creates no new provider authority.
UPDATE kai_gmail_connections
SET send_enabled = TRUE,
    updated_at = NOW()
WHERE status = 'connected'
  AND revoked = FALSE
  AND send_enabled = FALSE
  AND scope_csv ~ '(^|[[:space:],])https://www.googleapis.com/auth/gmail\\.send([[:space:],]|$)';

COMMIT;
