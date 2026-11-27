-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
-- Rollback for 467_one_location_chat_e2e.sql

DROP TABLE IF EXISTS public.one_location_request_blocks;
DROP TABLE IF EXISTS public.one_location_geofence_rules;

ALTER TABLE public.one_location_account_settings
  DROP COLUMN IF EXISTS paused_until;

ALTER TABLE public.one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_precision_check,
  DROP CONSTRAINT IF EXISTS one_location_share_grants_share_mode_check,
  DROP COLUMN IF EXISTS calendar_event_id,
  DROP COLUMN IF EXISTS task_label,
  DROP COLUMN IF EXISTS starts_at,
  DROP COLUMN IF EXISTS precision,
  DROP COLUMN IF EXISTS share_mode;

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
      'location_place_rating_withdrawn'
    )
  ) NOT VALID;
