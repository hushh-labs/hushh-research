-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh

-- Server-only review and settlement metadata. Canonical grants, encrypted
-- envelopes, requests, and Location events keep their existing custody.
CREATE TABLE IF NOT EXISTS public.one_location_chat_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  person_user_id TEXT NOT NULL CHECK (person_user_id <> user_id),
  origin_id UUID,
  intent_hash TEXT NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  action TEXT NOT NULL CHECK (action IN (
    'share_live', 'share_pin', 'ask', 'view', 'stop', 'set_duration', 'extend',
    'ask_extension', 'approve', 'decline'
  )),
  terms JSONB NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  receipt JSONB CHECK (jsonb_typeof(receipt) = 'object'),
  CHECK ((executed_at IS NULL) = (receipt IS NULL))
);

ALTER TABLE public.one_location_chat_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.one_location_chat_plans FROM PUBLIC;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.one_location_chat_plans FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.one_location_chat_plans FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.one_location_chat_plans TO service_role;
  END IF;
END
$roles$;

CREATE INDEX IF NOT EXISTS idx_one_location_chat_plans_origin
  ON public.one_location_chat_plans (user_id, origin_id, created_at DESC, id DESC)
  WHERE origin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_one_location_chat_plans_pending_expiry
  ON public.one_location_chat_plans (expires_at) WHERE receipt IS NULL;

CREATE INDEX IF NOT EXISTS idx_one_location_chat_plans_party
  ON public.one_location_chat_plans (person_user_id);
CREATE INDEX IF NOT EXISTS idx_one_location_chat_plans_owner
  ON public.one_location_chat_plans (user_id);

SELECT public.install_account_deletion_write_guards();
