-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
--
-- Migration 467: End-to-end main-chat Location capabilities (US-001..US-040):
-- 1. Grant share modes (live / static_pin / task_bound), per-grant precision
--    (precise / approximate / city), scheduled multi-day starts_at, task_label,
--    and calendar_event_id.
-- 2. Auto-resuming timed pause (`paused_until`) on one_location_account_settings.
-- 3. Durable Postgres geofence rules (`one_location_geofence_rules`) enforcing
--    the privacy invariant that `saved_home` NEVER stores coordinates on server.
-- 4. Per-peer location request blocks (`one_location_request_blocks`) so removing
--    a peer from a Trusted Location Circle blocks future location requests while
--    preserving non-location Hussh connections.
-- 5. Extended audit event types on `one_location_events`.

ALTER TABLE public.one_location_share_grants
  ADD COLUMN IF NOT EXISTS share_mode TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS precision TEXT,
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS task_label TEXT,
  ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;

ALTER TABLE public.one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_share_mode_check;
ALTER TABLE public.one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_share_mode_check
  CHECK (share_mode IN ('live', 'static_pin', 'task_bound')) NOT VALID;
ALTER TABLE public.one_location_share_grants
  VALIDATE CONSTRAINT one_location_share_grants_share_mode_check;

ALTER TABLE public.one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_precision_check;
ALTER TABLE public.one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_precision_check
  CHECK (precision IS NULL OR precision IN ('precise', 'approximate', 'city')) NOT VALID;
ALTER TABLE public.one_location_share_grants
  VALIDATE CONSTRAINT one_location_share_grants_precision_check;

ALTER TABLE public.one_location_account_settings
  ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.one_location_geofence_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('share_on_arrival', 'stop_on_arrival')),
  place_kind TEXT NOT NULL CHECK (place_kind IN ('public_place', 'saved_home')),
  place_label TEXT NOT NULL,
  public_place_id TEXT,
  public_lat DOUBLE PRECISION,
  public_lng DOUBLE PRECISION,
  radius_meters INTEGER NOT NULL DEFAULT 250 CHECK (radius_meters >= 50 AND radius_meters <= 5000),
  recipient_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  share_duration_hours DOUBLE PRECISION,
  precision TEXT CHECK (precision IS NULL OR precision IN ('precise', 'approximate', 'city')),
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'triggered', 'cancelled', 'expired')),
  triggered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT one_location_geofence_home_no_coords CHECK (
    place_kind <> 'saved_home' OR (public_lat IS NULL AND public_lng IS NULL)
  )
);

ALTER TABLE public.one_location_geofence_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.one_location_geofence_rules FROM PUBLIC;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.one_location_geofence_rules FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.one_location_geofence_rules FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.one_location_geofence_rules TO service_role;
  END IF;
END
$roles$;

CREATE INDEX IF NOT EXISTS idx_one_location_geofence_rules_owner_status
  ON public.one_location_geofence_rules (owner_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.one_location_request_blocks (
  owner_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL CHECK (blocked_user_id <> owner_user_id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, blocked_user_id)
);

ALTER TABLE public.one_location_request_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.one_location_request_blocks FROM PUBLIC;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.one_location_request_blocks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.one_location_request_blocks FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.one_location_request_blocks TO service_role;
  END IF;
END
$roles$;

CREATE INDEX IF NOT EXISTS idx_one_location_request_blocks_blocked
  ON public.one_location_request_blocks (blocked_user_id);

ALTER TABLE public.one_location_events
  DROP CONSTRAINT IF EXISTS one_location_events_event_type_check;

ALTER TABLE public.one_location_events
  ADD CONSTRAINT one_location_events_event_type_check CHECK (
    event_type IN (
      'location_recipient_key_registered',
      'location_share_created',
      'location_envelope_updated',
      'location_share_viewed',
      'location_share_revoked',
      'location_share_shortened',
      'location_share_duration_changed',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_auto_approve_rule_changed',
      'location_access_denied',
      'location_access_request_withdrawn',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined',
      'location_circle_code_joined',
      'location_circle_member_invite_accepted',
      'circle_member_added',
      'location_sms_contact_added',
      'location_sms_contact_removed',
      'location_place_rating_saved',
      'location_place_rating_updated',
      'location_place_rating_withdrawn',
      'location_emergency_override',
      'location_pause_timed',
      'location_geofence_created',
      'location_geofence_triggered',
      'location_geofence_cancelled',
      'location_peer_blocked',
      'location_peer_unblocked'
    )
  ) NOT VALID;

SELECT public.install_account_deletion_write_guards();
