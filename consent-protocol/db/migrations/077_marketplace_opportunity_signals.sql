BEGIN;

-- Durable, proactive "opportunity signals" for the Information Marketplace.
--
-- Until now every nudge/flashcard in the app (Gmail, Location) was derived fresh
-- on load and lived only in the browser — no dismiss, no snooze, nothing survived
-- a reload, let alone the next day. This table makes an opportunity a real record:
-- "your insurance expires soon — publish this so buyers can reach you", or an
-- offer-worthy unpublished slice worth listing. The card can be published (via the
-- existing consent-first posture flow), snoozed ("remind me later" → reappears the
-- next day), or dismissed, and that state persists.
--
-- Consent-first: a signal NEVER publishes anything on its own. It only surfaces the
-- suggestion; publishing runs the normal owner-driven, server-side posture change,
-- and this row merely records that the signal was acted on.
--
-- Two producers converge on this one store:
--   * server-side derivation of dateless "intent" signals (offer-worthy unpublished
--     slices), which needs no vault key; and
--   * client-side derivation of dated "expiry" signals (insurance renewal, trip
--     date), which are only decryptable with the owner's vault key and are written
--     through the author endpoint.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS marketplace_opportunity_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  -- 'expiry' carries an event_date (dated, client-derived); 'intent' is dateless
  -- (server-derived from offer-worthy unpublished slices).
  kind TEXT NOT NULL
    CHECK (kind IN ('expiry', 'intent')),
  domain TEXT NOT NULL,
  -- The PKM slice this maps to, so the publish CTA can target the right section.
  scope_handle TEXT,
  title TEXT NOT NULL,
  body TEXT,
  event_date DATE,
  suggested_price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL
    CHECK (source IN ('derived', 'authored')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'snoozed', 'published', 'dismissed', 'expired')),
  -- "Remind me later" sets snoozed_until to the start of the next day; list_due
  -- surfaces the card again once now() passes it.
  snoozed_until TIMESTAMPTZ,
  -- Stable identity so re-derivation on every open is idempotent (no duplicates).
  dedupe_key TEXT NOT NULL,
  show_count INTEGER NOT NULL DEFAULT 0,
  -- Carries topLevelScopePath/label/domainTitle/sensitivityTier so the publish CTA
  -- can call the consent-first posture flow without a second lookup.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_opportunity_signals_dedupe UNIQUE (user_id, dedupe_key)
);

-- The "due now" query: active signals, or snoozed ones whose snooze has elapsed,
-- for a given owner. event_date included so dated cards can order/expire cheaply.
CREATE INDEX IF NOT EXISTS idx_marketplace_opportunity_signals_due
  ON marketplace_opportunity_signals (user_id, status, snoozed_until, event_date);

COMMIT;
