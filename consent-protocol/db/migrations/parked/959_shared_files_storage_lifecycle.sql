-- Dev qualification only. Ciphertext remains in GCS; this row owns resource
-- inventory and fenced transport admission, never filenames or library keys.
BEGIN;
CREATE TABLE IF NOT EXISTS public.shared_files_storage (
  user_id TEXT PRIMARY KEY REFERENCES public.vault_keys(user_id) ON DELETE RESTRICT,
  library_id UUID NOT NULL DEFAULT gen_random_uuid(),
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL,
  bucket_admission JSONB CHECK (bucket_admission IS NULL OR jsonb_typeof(bucket_admission) = 'object'),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'erasing', 'erased')),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  writes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(writes) = 'object'),
  receipt JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.shared_files_storage ADD COLUMN IF NOT EXISTS bucket_admission JSONB;
ALTER TABLE public.shared_files_storage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shared_files_storage FROM PUBLIC;
COMMENT ON TABLE public.shared_files_storage IS 'Shared Files ciphertext resource inventory and write fencing. No plaintext content or keys.';
COMMIT;
