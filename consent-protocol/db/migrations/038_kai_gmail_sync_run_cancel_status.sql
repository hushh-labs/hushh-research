ALTER TABLE IF EXISTS kai_gmail_sync_runs
    DROP CONSTRAINT IF EXISTS kai_gmail_sync_runs_status_check;

ALTER TABLE IF EXISTS kai_gmail_sync_runs
    ADD CONSTRAINT kai_gmail_sync_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled'));
