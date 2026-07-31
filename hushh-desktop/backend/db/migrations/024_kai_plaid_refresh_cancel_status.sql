ALTER TABLE IF EXISTS kai_plaid_refresh_runs
    DROP CONSTRAINT IF EXISTS kai_plaid_refresh_runs_status_check;

ALTER TABLE IF EXISTS kai_plaid_refresh_runs
    ADD CONSTRAINT kai_plaid_refresh_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled'));
