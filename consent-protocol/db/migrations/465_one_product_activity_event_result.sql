-- Optional explicit client-reported result; historical observations stay unknown.
ALTER TABLE public.one_product_activity_observations
  ADD COLUMN IF NOT EXISTS event_result TEXT NULL
  CHECK (event_result IN ('success', 'error', 'expected_error'));
