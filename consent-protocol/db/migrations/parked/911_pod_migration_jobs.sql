-- 911: moving a private agent from one cloud to another becomes an observable job.
--
-- A person who started on the hosted tier must be able to move their agent into
-- their own project without losing anything it has learned. That move is a chain
-- of eleven steps across two clouds -- freeze, provision the destination, export,
-- ferry, import and re-seal, verify, switch the row, reap the old host -- and any
-- of them can take minutes. Running it inside one HTTP request would repeat the
-- mistake 909 exists to correct, with a much worse failure mode: a timeout there
-- costs a retry, a timeout here could leave a person's memory in flight between
-- two pods with nothing recording where it got to.
--
-- One row per person, superseded in place by each new attempt, exactly as
-- `byoc_setup_jobs` does. History is not the point; the CURRENT truth is, and it
-- is what lets a person leave the screen and come back to a finished move.
--
-- WHAT THIS TABLE MAY NEVER HOLD, stated because the temptation is real:
-- no key material, no bundle contents, no decrypted anything. The re-seal happens
-- INSIDE the destination pod, because hushh structurally cannot perform it -- the
-- bootstrap identity deliberately holds no KMS encrypt or decrypt. What is
-- recorded here is coordinates and progress: which stage, when, and the two chain
-- heads whose equality is the proof that nothing was lost.
--
-- `source_head_sha` / `target_head_sha` are the whole verification story. The
-- commit log's chain hash is computed over PLAINTEXT fields ({seq, kind, payload,
-- prev_sha}), so a re-seal that preserves them verifies identically under the
-- destination's own key. Byte-equal heads is therefore a cryptographic statement
-- that every record arrived intact and in order, not a sample of them. The switch
-- happens only when they match; a mismatch fails the job with the source still
-- frozen and whole, so the worst outcome is a move that did not happen.
CREATE TABLE IF NOT EXISTS pod_migration_jobs (
    user_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    hushh_id TEXT NOT NULL,
    -- Where it is going. The source is whatever the registry row says today, so
    -- it is deliberately not duplicated here -- one writer of that truth.
    target_project TEXT NOT NULL,
    target_region TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    stage TEXT NOT NULL DEFAULT 'starting',
    stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- The zero-loss oracle. Both are NULL until their side reports; the switch
    -- refuses unless they are equal and non-empty.
    source_head_sha TEXT,
    source_record_count INTEGER,
    target_head_sha TEXT,
    target_record_count INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The status route reads by user; the sweep reads by staleness.
CREATE INDEX IF NOT EXISTS idx_pod_migration_jobs_status_updated
    ON pod_migration_jobs (status, updated_at DESC);
