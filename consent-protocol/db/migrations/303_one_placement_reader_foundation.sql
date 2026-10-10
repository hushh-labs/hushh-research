-- Additive placement readers for rollout continuity; no BYOC activation.
-- Existing richer dev tables, authority constraints and assignments remain intact.
-- These stores contain placement/setup metadata, never private content or tokens.
BEGIN;
CREATE TABLE IF NOT EXISTS personal_agent_registry (
    user_id TEXT PRIMARY KEY,
    hushh_id TEXT,
    phone_e164_hash TEXT,
    space_id TEXT,
    backend TEXT,
    external_agent_id TEXT,
    a2a_route TEXT,
    backend_metadata JSONB,
    attestation_ref TEXT,
    pod_pubkey TEXT,
    pod_key_id TEXT,
    pod_key_wrapping_alg TEXT,
    runtime_version TEXT,
    prompt_version TEXT,
    status TEXT NOT NULL DEFAULT 'unprovisioned',
    region TEXT,
    provisioned_at TIMESTAMPTZ,
    deployment_target TEXT,
    model_credential_mode TEXT,
    user_cloud_project TEXT,
    user_cloud_region TEXT,
    user_cloud_bootstrap_sa TEXT,
    user_cloud_authorized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS hushh_id TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS phone_e164_hash TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS space_id TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS backend TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS external_agent_id TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS a2a_route TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS backend_metadata JSONB;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS attestation_ref TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS pod_pubkey TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS pod_key_id TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS pod_key_wrapping_alg TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS runtime_version TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS deployment_target TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS model_credential_mode TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS user_cloud_project TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS user_cloud_region TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS user_cloud_bootstrap_sa TEXT;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS user_cloud_authorized_at TIMESTAMPTZ;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE public.personal_agent_registry ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS byoc_setup_jobs (
    user_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    stage TEXT NOT NULL DEFAULT 'starting',
    stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    authorization_attempts JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS stages JSONB;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS authorization_attempts JSONB;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
SELECT public.install_account_deletion_write_guards();
COMMIT;
