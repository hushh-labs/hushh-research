BEGIN;

-- PKM events are metadata-only audit records. Older decision projections could
-- retain model prose, votes and raw-card content in cleartext JSONB. Keep only
-- bounded decision facts; encrypted owner history remains untouched.
UPDATE pkm_events AS event
SET metadata = jsonb_build_object(
  'decisions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', item.ordinality,
      'ticker', LEFT(UPPER(REGEXP_REPLACE(COALESCE(item.value ->> 'ticker', ''), '[^A-Z0-9._-]', '', 'g')), 32),
      'decision_type', LEFT(UPPER(REGEXP_REPLACE(COALESCE(item.value ->> 'decision_type', item.value ->> 'decision', 'HOLD'), '[^A-Z _-]', '', 'g')), 32),
      'confidence', CASE
        WHEN COALESCE(item.value ->> 'confidence', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN LEAST(1::numeric, GREATEST(0::numeric, (item.value ->> 'confidence')::numeric))
        ELSE 0
      END,
      'created_at', LEFT(COALESCE(item.value ->> 'created_at', item.value ->> 'timestamp', ''), 64),
      'metadata', jsonb_build_object('source', 'legacy_redacted', 'consensus_reached', false)
    ))
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(event.metadata -> 'decisions') = 'array'
          THEN event.metadata -> 'decisions'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS item(value, ordinality)
  ), '[]'::jsonb),
  'projection_mode', CASE
    WHEN event.metadata ->> 'projection_mode' IN ('replace_all', 'append')
      THEN event.metadata ->> 'projection_mode'
    ELSE 'legacy_redacted'
  END,
  'projection_type', 'decision_history_v1'
)
WHERE event.domain = 'financial'
  AND event.operation_type = 'decision_projection';

-- Durable analyze checkpoints are operational recovery cache, not an archive
-- for owner information. Purge legacy terminal payloads so old raw cards,
-- model content and PKM context cannot be replayed from Postgres.
DELETE FROM kai_analyze_runs;

COMMIT;
