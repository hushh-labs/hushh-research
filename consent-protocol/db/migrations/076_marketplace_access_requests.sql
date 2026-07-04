BEGIN;

-- Product-grade persistence for Information Marketplace access requests.
--
-- Until now a buyer's request to access a published data slice lived only in the
-- owner's browser (in-session React state that cleared on refresh). This table
-- makes a request a real, durable record — the owner has a real inbox, requests
-- survive refresh, and approve/deny can be driven server-side (including through
-- Agent One over A2A, the way Location approves a grant). Consent-first: a request
-- NEVER grants access on its own; the owner must approve, and only the safe
-- summary of the slice is ever involved.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS marketplace_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  -- The buyer. buyer_user_id is nullable because a buyer may not be a Hushh user
  -- (or, in early phases, may be a labeled brand/agent rather than an account).
  buyer_user_id TEXT,
  buyer_label TEXT,
  -- The published slice being requested (safe-summary projection only).
  domain TEXT NOT NULL,
  scope_handle TEXT,
  slice_label TEXT NOT NULL,
  -- Price the owner set / was suggested for this 30-day scoped access.
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  duration_days INTEGER NOT NULL DEFAULT 30
    CHECK (duration_days > 0 AND duration_days <= 3650),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_access_requests_not_self
    CHECK (buyer_user_id IS NULL OR owner_user_id <> buyer_user_id)
);

-- The owner's inbox query: pending/other requests for a given owner, newest first.
CREATE INDEX IF NOT EXISTS idx_marketplace_access_requests_owner
  ON marketplace_access_requests (owner_user_id, status, created_at DESC);

COMMIT;
