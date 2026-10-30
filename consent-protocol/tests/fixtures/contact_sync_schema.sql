-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh

CREATE TABLE actor_profiles (
  user_id TEXT PRIMARY KEY,
  contact_discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  contact_sync_consent_enabled_at TIMESTAMPTZ,
  contact_sync_consent_rule_version BIGINT NOT NULL DEFAULT 0,
  contact_sync_consent_contract_version TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE marketplace_public_profiles (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  is_discoverable BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE actor_identity_cache (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  phone_number TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  photo_url TEXT,
  custom_photo_url TEXT
);
CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id TEXT NOT NULL,
  user_b_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  source TEXT NOT NULL DEFAULT 'request'
    CHECK (source IN ('request', 'circle_invite', 'import', 'named_circle')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT connections_pair_unique UNIQUE (user_a_id, user_b_id),
  CONSTRAINT connections_canonical_order CHECK (user_a_id < user_b_id)
);
CREATE TABLE connection_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id TEXT NOT NULL,
  addressee_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE connection_scope_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_request_id UUID NOT NULL REFERENCES connection_requests(id),
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE connection_scope_proposal_events (
  id BIGSERIAL PRIMARY KEY,
  connection_scope_proposal_id UUID NOT NULL
    REFERENCES connection_scope_proposals(id),
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  reason TEXT
);
CREATE TABLE connection_origins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  origin_kind TEXT NOT NULL,
  origin_key TEXT NOT NULL,
  source_circle_id UUID,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT connection_origins_key_unique UNIQUE (connection_id, origin_key)
);
CREATE TABLE trusted_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  trusted_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'agent_one',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT trusted_connections_edge_unique
    UNIQUE (owner_user_id, trusted_user_id)
);
