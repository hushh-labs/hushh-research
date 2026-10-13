-- Migration 014: Full Supabase Cleanup -- DROP all deprecated tables
-- ===================================================================
-- PRECONDITION: All code paths redirected in Phase 3-4. Zero live references
-- to any table being dropped. Verified by grepping entire codebase.
--
-- Tables being dropped:
--   vault_kai, vault_kai_preferences, vault_food, vault_professional,
--   vault_portfolios, user_investor_profiles, chat_conversations,
--   chat_messages, world_model_attributes, world_model_index (v1)
--
-- NEVER TOUCHED: vault_keys, investor_profiles (SEC public data)

-- ===================================================================
-- Step 1: Drop triggers and functions that reference world_model_attributes
-- ===================================================================

DROP TRIGGER IF EXISTS trg_update_user_index ON world_model_attributes;
DROP TRIGGER IF EXISTS trg_update_domain_counts ON world_model_attributes;
DROP FUNCTION IF EXISTS update_user_index_on_attribute_change();
DROP FUNCTION IF EXISTS update_domain_registry_counts();

-- ===================================================================
-- Step 2: Replace stale get_user_world_model_metadata() RPC
-- Old version queried world_model_attributes. New reads from world_model_index_v2.
-- ===================================================================

CREATE OR REPLACE FUNCTION get_user_world_model_metadata(p_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'user_id', p_user_id,
    'available_domains', COALESCE(wmi.available_domains, ARRAY[]::TEXT[]),
    'domain_summaries', COALESCE(wmi.domain_summaries, '{}'::jsonb),
    'total_attributes', COALESCE(wmi.total_attributes, 0),
    'last_updated', wmi.updated_at,
    'model_version', wmi.model_version
  ) INTO v_result
  FROM world_model_index_v2 wmi WHERE wmi.user_id = p_user_id;
  RETURN COALESCE(v_result, jsonb_build_object(
    'user_id', p_user_id, 'available_domains', '[]'::jsonb,
    'domain_summaries', '{}'::jsonb, 'total_attributes', 0
  ));
END; $$;

-- ===================================================================
-- Step 3: Sanitize existing domain_summaries data
-- Remove any sensitive fields that were accidentally stored
-- ===================================================================

UPDATE world_model_index_v2 SET
  domain_summaries = domain_summaries #- '{financial,holdings}' #- '{financial,total_value}'
WHERE domain_summaries->'financial'->'holdings' IS NOT NULL
   OR domain_summaries->'financial'->'total_value' IS NOT NULL;

-- Recalculate total_attributes from domain_summaries
UPDATE world_model_index_v2 SET total_attributes = (
  SELECT COALESCE(SUM(
    CASE WHEN (v.value->>'holdings_count') IS NOT NULL
         THEN (v.value->>'holdings_count')::int ELSE 1 END
  ), 0) FROM jsonb_each(domain_summaries) v
);

-- ===================================================================
-- Step 4: Force-DROP all deprecated tables (CASCADE for FK safety)
-- ===================================================================

-- Leaf tables (no dependents)
DROP TABLE IF EXISTS vault_kai CASCADE;
DROP TABLE IF EXISTS vault_kai_preferences CASCADE;
DROP TABLE IF EXISTS vault_food CASCADE;
DROP TABLE IF EXISTS vault_professional CASCADE;
DROP TABLE IF EXISTS vault_portfolios CASCADE;
DROP TABLE IF EXISTS user_investor_profiles CASCADE;

-- Chat tables (chat_messages references chat_conversations)
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS chat_conversations CASCADE;

-- world_model_attributes (triggers already dropped in Step 1)
DROP TABLE IF EXISTS world_model_attributes CASCADE;

-- world_model_index v1 (replaced by world_model_index_v2)
DROP TABLE IF EXISTS world_model_index CASCADE;

-- ===================================================================
-- Step 5: Clean up domain_registry counters
-- ===================================================================

UPDATE domain_registry dr SET
  user_count = (
    SELECT COUNT(*) FROM world_model_index_v2
    WHERE dr.domain_key = ANY(available_domains)
  ),
  attribute_count = 0
WHERE TRUE;
