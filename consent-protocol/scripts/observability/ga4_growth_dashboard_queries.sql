-- Governed GA4 KPI model queries for Kai.
-- Usage:
--   bq query --use_legacy_sql=false < consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql
--
-- Before running, replace:
--   {{PROJECT_ID}} with hushh-pda or hushh-pda-uat
--   {{DATASET}} with the GA4 export dataset for the property, for example:
--     prod -> analytics_526603671
--     uat  -> analytics_533362555
--
-- Operating model:
--   GA4 collects metadata-only events.
--   BigQuery modeled results are the KPI source of truth.
--   Looker Studio visualizes these governed results, not raw GA4 UI cards.
--
-- Reporting policy:
--   prod dashboard -> analytics_526603671 only
--   uat validation -> analytics_533362555 only
--   do not mix UAT and production in the same modeled dashboard source
--
-- Prod note:
--   stream_id `13702689760` is the current HushhVoice iOS stream on the
--   production property. Exclude it from Kai growth reporting.

-- 1. Investor funnel progression.
WITH base_events AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS event_date,
    event_timestamp,
    user_pseudo_id,
    event_name,
    stream_id,
    COALESCE(
      NULLIF((SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'platform'), ''),
      LOWER(platform),
      '(not set)'
    ) AS platform,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'event_category') AS event_category,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') AS journey,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'entry_surface') AS entry_surface,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'portfolio_source') AS portfolio_source,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'app_version') AS app_version
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name IN ('growth_funnel_step_completed', 'investor_activation_completed')
    AND (stream_id IS NULL OR stream_id != '13702689760')
)
SELECT
  event_date,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'entered', user_pseudo_id, NULL)) AS investor_entered_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'auth_completed', user_pseudo_id, NULL)) AS investor_auth_completed_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'vault_ready', user_pseudo_id, NULL)) AS investor_vault_ready_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'onboarding_completed', user_pseudo_id, NULL)) AS investor_onboarding_completed_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'portfolio_ready', user_pseudo_id, NULL)) AS investor_portfolio_ready_users,
  COUNT(DISTINCT IF(event_name = 'investor_activation_completed', user_pseudo_id, NULL)) AS investor_activated_users
FROM base_events
GROUP BY event_date
ORDER BY event_date DESC;

-- 2. RIA funnel progression.
WITH base_events AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS event_date,
    user_pseudo_id,
    event_name,
    stream_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') AS journey,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'workspace_source') AS workspace_source
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name IN ('growth_funnel_step_completed', 'ria_activation_completed')
    AND (stream_id IS NULL OR stream_id != '13702689760')
)
SELECT
  event_date,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'entered', user_pseudo_id, NULL)) AS ria_entered_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'auth_completed', user_pseudo_id, NULL)) AS ria_auth_completed_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'profile_submitted', user_pseudo_id, NULL)) AS ria_profile_submitted_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'request_created', user_pseudo_id, NULL)) AS ria_request_created_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'workspace_ready', user_pseudo_id, NULL)) AS ria_workspace_ready_users,
  COUNT(DISTINCT IF(event_name = 'ria_activation_completed', user_pseudo_id, NULL)) AS ria_activated_users
FROM base_events
GROUP BY event_date
ORDER BY event_date DESC;

-- 3. Activation conversion rate.
WITH base_events AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS event_date,
    user_pseudo_id,
    event_name,
    stream_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') AS journey,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name IN (
    'growth_funnel_step_completed',
    'investor_activation_completed',
    'ria_activation_completed'
  )
    AND (stream_id IS NULL OR stream_id != '13702689760')
)
SELECT
  event_date,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'entered', user_pseudo_id, NULL)) AS investor_entered_users,
  COUNT(DISTINCT IF(event_name = 'investor_activation_completed', user_pseudo_id, NULL)) AS investor_activated_users,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(event_name = 'investor_activation_completed', user_pseudo_id, NULL)),
    COUNT(DISTINCT IF(journey = 'investor' AND step = 'entered', user_pseudo_id, NULL))
  ) AS investor_activation_rate,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'entered', user_pseudo_id, NULL)) AS ria_entered_users,
  COUNT(DISTINCT IF(event_name = 'ria_activation_completed', user_pseudo_id, NULL)) AS ria_activated_users,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(event_name = 'ria_activation_completed', user_pseudo_id, NULL)),
    COUNT(DISTINCT IF(journey = 'ria' AND step = 'entered', user_pseudo_id, NULL))
  ) AS ria_activation_rate
FROM base_events
GROUP BY event_date
ORDER BY event_date DESC;

-- 4. Attribution quality.
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS event_date,
  COALESCE(
    NULLIF(collected_traffic_source.manual_source, ''),
    NULLIF(session_traffic_source_last_click.manual_campaign.source, ''),
    NULLIF(traffic_source.source, ''),
    '(not set)'
  ) AS source,
  COALESCE(
    NULLIF(collected_traffic_source.manual_medium, ''),
    NULLIF(session_traffic_source_last_click.manual_campaign.medium, ''),
    NULLIF(traffic_source.medium, ''),
    '(not set)'
  ) AS medium,
  COALESCE(
    NULLIF(collected_traffic_source.manual_campaign_name, ''),
    NULLIF(session_traffic_source_last_click.manual_campaign.campaign_name, ''),
    NULLIF(traffic_source.name, ''),
    '(not set)'
  ) AS campaign,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
WHERE event_name IN (
  'growth_funnel_step_completed',
  'investor_activation_completed',
  'ria_activation_completed'
)
  AND (stream_id IS NULL OR stream_id != '13702689760')
GROUP BY event_date, source, medium, campaign
ORDER BY event_date DESC, users DESC;

-- 5. Platform mix.
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS event_date,
  COALESCE(
    NULLIF((SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'platform'), ''),
    LOWER(platform),
    '(not set)'
  ) AS platform,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
WHERE event_name IN (
  'growth_funnel_step_completed',
  'investor_activation_completed',
  'ria_activation_completed',
  'market_insights_loaded',
  'portfolio_viewed',
  'recommendation_viewed',
  'marketplace_profile_viewed',
  'import_parse_completed',
  'import_quality_gate_passed',
  'import_quality_gate_failed',
  'import_save_completed',
  'phone_verification_started',
  'phone_verification_completed',
  'persona_switched'
)
  AND (stream_id IS NULL OR stream_id != '13702689760')
GROUP BY event_date, platform
ORDER BY event_date DESC, users DESC;

-- 6. Feature engagement.
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS event_date,
  event_name,
  COALESCE(
    NULLIF((SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'portfolio_source'), ''),
    '(not set)'
  ) AS portfolio_source,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
WHERE event_name IN (
  'market_insights_loaded',
  'portfolio_viewed',
  'recommendation_viewed',
  'marketplace_profile_viewed'
)
  AND (stream_id IS NULL OR stream_id != '13702689760')
GROUP BY event_date, event_name, portfolio_source
ORDER BY event_date DESC, event_count DESC;

-- 7. Missing-param and instrumentation health.
WITH observed AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS event_date,
    event_name,
    stream_id,
    user_pseudo_id,
    COALESCE(
      NULLIF((SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'platform'), ''),
      LOWER(platform),
      '(not set)'
    ) AS resolved_platform,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'env') AS env,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'event_category') AS event_category,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') AS journey,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'entry_surface') AS entry_surface,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'app_version') AS app_version
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name IN (
    'growth_funnel_step_completed',
    'investor_activation_completed',
    'ria_activation_completed',
    'market_insights_loaded',
    'portfolio_viewed',
    'recommendation_viewed',
    'marketplace_profile_viewed',
    'import_parse_completed',
    'import_quality_gate_passed',
    'import_quality_gate_failed',
    'import_save_completed',
    'phone_verification_started',
    'phone_verification_completed',
    'persona_switched'
  )
    AND (stream_id IS NULL OR stream_id != '13702689760')
)
SELECT
  event_date,
  COUNT(*) AS governed_events,
  COUNTIF(event_category IS NULL OR event_category = '') AS missing_event_category_events,
  COUNTIF(env IS NULL OR env = '') AS missing_env_events,
  COUNTIF(resolved_platform = '(not set)') AS missing_platform_events,
  COUNTIF(app_version IS NULL OR app_version = '') AS missing_app_version_events,
  COUNTIF(event_name IN ('growth_funnel_step_completed', 'investor_activation_completed', 'ria_activation_completed') AND (journey IS NULL OR journey = '')) AS missing_journey_events,
  COUNTIF(event_name = 'growth_funnel_step_completed' AND (step IS NULL OR step = '')) AS missing_step_events,
  COUNTIF(event_name IN ('growth_funnel_step_completed', 'investor_activation_completed', 'ria_activation_completed') AND (entry_surface IS NULL OR entry_surface = '')) AS missing_entry_surface_events,
  COUNT(DISTINCT stream_id) AS streams_seen,
  COUNT(DISTINCT resolved_platform) AS platforms_seen,
  COUNT(DISTINCT user_pseudo_id) AS users_seen
FROM observed
GROUP BY event_date
ORDER BY event_date DESC;

-- 8. Data freshness.
SELECT
  MAX(TIMESTAMP_MICROS(event_timestamp)) AS latest_event_at,
  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(TIMESTAMP_MICROS(event_timestamp)), MINUTE) AS freshness_lag_minutes,
  COUNT(*) AS governed_events
FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
WHERE event_name IN (
  'growth_funnel_step_completed',
  'investor_activation_completed',
  'ria_activation_completed',
  'market_insights_loaded',
  'portfolio_viewed',
  'recommendation_viewed',
  'marketplace_profile_viewed',
  'import_parse_completed',
  'import_quality_gate_passed',
  'import_quality_gate_failed',
  'import_save_completed',
  'phone_verification_started',
  'phone_verification_completed',
  'persona_switched'
)
  AND (stream_id IS NULL OR stream_id != '13702689760');
