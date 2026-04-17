-- CLI-first GA4 growth reporting queries for Kai.
-- Usage:
--   bq query --use_legacy_sql=false < consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql
--
-- Before running, replace:
--   {{PROJECT_ID}} with hushh-pda or hushh-pda-uat
--   {{DATASET}} with analytics_prod or analytics_staging
--
-- These queries intentionally use the raw GA4 export as the source of truth.
-- The Growth Dashboard should be built from modeled results like these rather
-- than from implicit GA4 UI conversions.

-- 1. Investor funnel progression
WITH growth_events AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS event_date,
    user_pseudo_id,
    platform,
    event_name,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') AS journey,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'entry_surface') AS entry_surface,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'portfolio_source') AS portfolio_source,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'workspace_source') AS workspace_source,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'app_version') AS app_version
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name IN (
    'growth_funnel_step_completed',
    'investor_activation_completed',
    'ria_activation_completed'
  )
)
SELECT
  event_date,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'entered', user_pseudo_id, NULL)) AS investor_entered_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'auth_completed', user_pseudo_id, NULL)) AS investor_authed_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'vault_ready', user_pseudo_id, NULL)) AS investor_vault_ready_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'onboarding_completed', user_pseudo_id, NULL)) AS investor_onboarded_users,
  COUNT(DISTINCT IF(journey = 'investor' AND step = 'portfolio_ready', user_pseudo_id, NULL)) AS investor_portfolio_ready_users,
  COUNT(DISTINCT IF(event_name = 'investor_activation_completed', user_pseudo_id, NULL)) AS investor_activated_users
FROM growth_events
GROUP BY event_date
ORDER BY event_date DESC;

-- 2. RIA funnel progression
WITH growth_events AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS event_date,
    user_pseudo_id,
    event_name,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') AS journey,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'workspace_source') AS workspace_source
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name IN (
    'growth_funnel_step_completed',
    'ria_activation_completed'
  )
)
SELECT
  event_date,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'entered', user_pseudo_id, NULL)) AS ria_entered_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'auth_completed', user_pseudo_id, NULL)) AS ria_authed_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'profile_submitted', user_pseudo_id, NULL)) AS ria_profile_submitted_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'request_created', user_pseudo_id, NULL)) AS ria_request_created_users,
  COUNT(DISTINCT IF(journey = 'ria' AND step = 'workspace_ready', user_pseudo_id, NULL)) AS ria_workspace_ready_users,
  COUNT(DISTINCT IF(event_name = 'ria_activation_completed', user_pseudo_id, NULL)) AS ria_activated_users
FROM growth_events
GROUP BY event_date
ORDER BY event_date DESC;

-- 3. Attribution quality
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS event_date,
  COALESCE(traffic_source.source, '(not set)') AS source,
  COALESCE(traffic_source.medium, '(not set)') AS medium,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
WHERE event_name = 'growth_funnel_step_completed'
GROUP BY event_date, source, medium
ORDER BY event_date DESC, users DESC;

-- 4. Platform mix quality
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS event_date,
  platform,
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
WHERE event_name IN (
  'growth_funnel_step_completed',
  'investor_activation_completed',
  'ria_activation_completed'
)
GROUP BY event_date, platform
ORDER BY event_date DESC, users DESC;

-- 5. Missing-step drift
WITH investor_steps AS (
  SELECT
    user_pseudo_id,
    ARRAY_AGG(DISTINCT (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') IGNORE NULLS) AS steps
  FROM `{{PROJECT_ID}}.{{DATASET}}.events_*`
  WHERE event_name = 'growth_funnel_step_completed'
    AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'journey') = 'investor'
  GROUP BY user_pseudo_id
)
SELECT
  COUNT(*) AS investor_users_seen,
  COUNTIF('entered' IN UNNEST(steps)) AS with_entered,
  COUNTIF('auth_completed' IN UNNEST(steps)) AS with_auth_completed,
  COUNTIF('vault_ready' IN UNNEST(steps)) AS with_vault_ready,
  COUNTIF('onboarding_completed' IN UNNEST(steps)) AS with_onboarding_completed,
  COUNTIF('portfolio_ready' IN UNNEST(steps)) AS with_portfolio_ready,
  COUNTIF('activated' IN UNNEST(steps)) AS with_activated
FROM investor_steps;
