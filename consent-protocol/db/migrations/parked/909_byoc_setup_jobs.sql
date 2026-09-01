-- 909: the one-click cloud setup becomes an observable background job.
--
-- The six-stage chain (create project, link billing, enable APIs, apply IAM,
-- settle the grant, prove and record) ran inside ONE synchronous HTTP request
-- bounded by three stacked timeouts (backend settle 45s, proxy 55s, browser
-- 60s). A fresh project legitimately needs longer -- measured live 2026-08-21:
-- the founder's hussh-one-6pf68p spent 24s creating and enabling, leaving the
-- settle window 15s against Google's minutes-scale IAM propagation -- so the
-- person was told to "press Continue again", which is a machine's job.
--
-- One row per person, superseded in place by each new attempt: history is not
-- the point, the CURRENT truth is. The row is written by the background task
-- after each stage and read by the status route, which is what lets a person
-- leave the screen, keep onboarding, and come back to a finished cloud.
--
-- The person's OAuth token NEVER touches this table: it lives in the task's
-- memory for the job's lifetime, exactly as it lived in the request coroutine
-- before. Stage names, timestamps, a typed refusal, and coordinates only.
CREATE TABLE IF NOT EXISTS byoc_setup_jobs (
    user_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    stage TEXT NOT NULL DEFAULT 'starting',
    stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
