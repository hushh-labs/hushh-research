-- Freeze the processor the owner actually approved; NULL preserves legacy Google-only consent.
ALTER TABLE public.pkm_answer_requests ADD COLUMN IF NOT EXISTS composer_runtime jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.pkm_answer_requests'::regclass
                 AND conname='pkm_answer_processing_runtime_shape') THEN
    ALTER TABLE public.pkm_answer_requests ADD CONSTRAINT pkm_answer_processing_runtime_shape CHECK (
      composer_runtime IS NULL OR ((
        jsonb_typeof(composer_runtime)='object'
        AND composer_runtime ?& ARRAY['version','provider','model','mode','fingerprint']
        AND composer_runtime - ARRAY['version','provider','model','mode','fingerprint'] = '{}'::jsonb
        AND composer_runtime->'version' = '1'::jsonb
        AND composer_runtime->>'provider' IN ('gemini','azure_openai','openai')
        AND composer_runtime->>'mode' IN ('private','shared')
        AND jsonb_typeof(composer_runtime->'model')='string'
        AND composer_runtime->>'model' ~ '^[A-Za-z0-9._:/-]{1,128}$'
        AND jsonb_typeof(composer_runtime->'fingerprint')='string'
        AND composer_runtime->>'fingerprint' ~ '^[a-f0-9]{64}$'
      ) IS TRUE)
    );
  END IF;
END $$;
