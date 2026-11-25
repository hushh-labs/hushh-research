BEGIN;
LOCK TABLE public.pkm_answer_requests IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.pkm_answer_requests'::regclass
              AND attname='composer_runtime' AND NOT attisdropped) THEN
    IF EXISTS (SELECT 1 FROM public.pkm_answer_requests WHERE composer_runtime IS NOT NULL) THEN
      RAISE EXCEPTION 'processing-runtime approvals exist; incompatible rollback refused';
    END IF;
  END IF;
END $$;
ALTER TABLE public.pkm_answer_requests DROP CONSTRAINT IF EXISTS pkm_answer_processing_runtime_shape;
ALTER TABLE public.pkm_answer_requests DROP COLUMN IF EXISTS composer_runtime;
COMMIT;
