-- Migration 239: retire server-held Plaid custody and the Alpaca funding path.
--
-- Plaid access tokens now live sealed in each person's vault and reach Plaid
-- through the stateless pass-through (api/routes/kai/plaid_vault.py). The
-- server no longer stores Plaid Items, refresh runs, link sessions, portfolio
-- source preferences, or any funding state.
--
-- Run scripts/ops/plaid_server_custody_retire.py --execute first so every
-- stored Item is disconnected at Plaid before its row disappears. Every deploy
-- lane applies release migrations automatically, so that order is enforced
-- here, not in prose: the guard below aborts the migration (and the deploy)
-- while any server-held Item is still live, or while regulated funding
-- records exist that need an explicit retention decision. Replay re-creates
-- these tables empty before this file runs, so the guard converges once the
-- script has run.
--
-- Drop order is FK-safe (children before parents), so no CASCADE is needed.
-- Each drop removes its own indexes, constraints, and triggers, including the
-- kai_funding_transfer_events_feed_fanout trigger from migration 179.

BEGIN;

DO $$
DECLARE
  live_items bigint := 0;
  regulated_rows bigint := 0;
  n bigint;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kai_plaid_items', 'kai_funding_plaid_items'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I WHERE status <> %L', t, 'removed') INTO n;
      live_items := live_items + n;
    END IF;
  END LOOP;
  IF live_items > 0 THEN
    RAISE EXCEPTION
      'migration 239: % server-held Plaid Item(s) are still live. Run scripts/ops/plaid_server_custody_retire.py --execute in this environment first.',
      live_items;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'kai_funding_transfers',
    'kai_funding_trade_intents',
    'kai_funding_trade_events',
    'kai_funding_consent_records'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', t) INTO n;
      regulated_rows := regulated_rows + n;
    END IF;
  END LOOP;
  IF regulated_rows > 0 THEN
    RAISE EXCEPTION
      'migration 239: % regulated funding record(s) exist. Export them and record a retention decision before dropping the funding tables.',
      regulated_rows;
  END IF;
END
$$;

-- Funding (migrations 038, 044, 045)
DROP TABLE IF EXISTS kai_funding_trade_events;
DROP TABLE IF EXISTS kai_funding_trade_intents;
DROP TABLE IF EXISTS kai_funding_support_escalations;
DROP TABLE IF EXISTS kai_funding_transfer_events;
DROP TABLE IF EXISTS kai_funding_transfers;
DROP TABLE IF EXISTS kai_funding_ach_relationships;
DROP TABLE IF EXISTS kai_funding_consent_records;
DROP TABLE IF EXISTS kai_funding_plaid_accounts;
DROP TABLE IF EXISTS kai_funding_plaid_items;
DROP TABLE IF EXISTS kai_funding_brokerage_accounts;
DROP TABLE IF EXISTS kai_funding_alpaca_connect_sessions;
DROP TABLE IF EXISTS kai_funding_reconciliation_runs;
DROP TABLE IF EXISTS kai_funding_webhook_events;

-- The Feed projection function from migration 179 has no table left to watch.
DROP FUNCTION IF EXISTS feed_events_from_kai_funding_transfer_events();

-- Portfolio (migration 113; 023/024 were never release-manifested)
DROP TABLE IF EXISTS kai_plaid_refresh_runs;
DROP TABLE IF EXISTS kai_plaid_link_sessions;
DROP TABLE IF EXISTS kai_plaid_items;
DROP TABLE IF EXISTS kai_portfolio_source_preferences;

-- Never created by a governed migration; account erasure cleaned it when present.
DROP TABLE IF EXISTS kai_plaid_user_profile_cache;

COMMIT;
