-- Migration 013: JSONB Merge RPC for atomic domain_summaries updates
-- ===================================================================
-- This function atomically merges a domain summary into the existing
-- domain_summaries JSONB column without overwriting other domains.
-- Analogous to MongoDB's $set operator on nested paths.

CREATE OR REPLACE FUNCTION merge_domain_summary(
  p_user_id TEXT,
  p_domain TEXT,
  p_summary JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Upsert: if the row exists, merge the domain summary atomically
  INSERT INTO world_model_index_v2 (user_id, domain_summaries, available_domains, updated_at)
  VALUES (
    p_user_id,
    jsonb_build_object(p_domain, p_summary),
    ARRAY[p_domain],
    NOW()
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    domain_summaries = COALESCE(world_model_index_v2.domain_summaries, '{}'::jsonb)
                       || jsonb_build_object(p_domain, p_summary),
    available_domains = (
      SELECT array_agg(DISTINCT d) FROM unnest(
        array_cat(
          COALESCE(world_model_index_v2.available_domains, ARRAY[]::TEXT[]),
          ARRAY[p_domain]
        )
      ) AS d
    ),
    updated_at = NOW();
END;
$$;

-- Helper: Remove a specific key from a domain's summary (e.g., strip sensitive fields)
CREATE OR REPLACE FUNCTION remove_domain_summary_key(
  p_user_id TEXT,
  p_domain TEXT,
  p_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE world_model_index_v2
  SET domain_summaries = domain_summaries #- ARRAY[p_domain, p_key],
      updated_at = NOW()
  WHERE user_id = p_user_id
    AND domain_summaries ? p_domain;
END;
$$;
