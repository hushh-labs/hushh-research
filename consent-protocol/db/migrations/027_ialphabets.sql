-- Migration 027: iAlphabets stock trading game
-- A-Z team-draft paper trading game with leagues, scoring, and virality

BEGIN;

-- Seasons: global fixed 4-week windows
CREATE TABLE ialphabets_seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('upcoming', 'active', 'closed')),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_ialphabets_seasons_status ON ialphabets_seasons(status, starts_at);

-- Leagues
CREATE TABLE ialphabets_leagues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES ialphabets_seasons(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'private',
  invite_code TEXT UNIQUE NOT NULL,
  max_members INTEGER NOT NULL DEFAULT 50,
  starting_cash NUMERIC(14,2) NOT NULL DEFAULT 100000,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (privacy IN ('private', 'public')),
  CHECK (status IN ('open', 'drafting', 'active', 'closed')),
  CHECK (max_members >= 2 AND max_members <= 50)
);
CREATE INDEX idx_ialphabets_leagues_season_privacy ON ialphabets_leagues(season_id, privacy, status);
CREATE INDEX idx_ialphabets_leagues_owner ON ialphabets_leagues(owner_user_id);
CREATE INDEX idx_ialphabets_leagues_invite_code ON ialphabets_leagues(invite_code);

-- League members
CREATE TABLE ialphabets_league_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES ialphabets_leagues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_via_invite_id UUID,
  UNIQUE (league_id, user_id)
);
CREATE INDEX idx_ialphabets_members_user ON ialphabets_league_members(user_id);
CREATE INDEX idx_ialphabets_members_league ON ialphabets_league_members(league_id);

-- One alphabet per member per league (portfolio container)
CREATE TABLE ialphabets_alphabets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES ialphabets_leagues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'drafting',
  finalized_at TIMESTAMPTZ,
  swaps_used_this_week INTEGER NOT NULL DEFAULT 0,
  swaps_week_key TEXT,
  starting_value NUMERIC(14,2) NOT NULL DEFAULT 100000,
  current_value NUMERIC(14,2) NOT NULL DEFAULT 100000,
  total_return_pct NUMERIC(8,4) NOT NULL DEFAULT 0,
  rank_in_league INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, user_id),
  CHECK (status IN ('drafting', 'locked', 'closed'))
);
CREATE INDEX idx_ialphabets_alphabets_league_rank ON ialphabets_alphabets(league_id, rank_in_league);
CREATE INDEX idx_ialphabets_alphabets_user ON ialphabets_alphabets(user_id);

-- 26 picks per alphabet (one row per letter)
CREATE TABLE ialphabets_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alphabet_id UUID NOT NULL REFERENCES ialphabets_alphabets(id) ON DELETE CASCADE,
  letter CHAR(1) NOT NULL,
  ticker TEXT NOT NULL,
  company_name TEXT,
  cost_basis NUMERIC(14,4) NOT NULL,
  shares NUMERIC(14,6) NOT NULL,
  allocated_cash NUMERIC(14,2) NOT NULL,
  locked_at TIMESTAMPTZ,
  last_swapped_at TIMESTAMPTZ,
  UNIQUE (alphabet_id, letter),
  CHECK (letter ~ '^[A-Z]$')
);
CREATE INDEX idx_ialphabets_picks_alphabet ON ialphabets_picks(alphabet_id);
CREATE INDEX idx_ialphabets_picks_ticker ON ialphabets_picks(ticker);

-- Daily EOD snapshots (for history chart + leaderboard trend)
CREATE TABLE ialphabets_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alphabet_id UUID NOT NULL REFERENCES ialphabets_alphabets(id) ON DELETE CASCADE,
  league_id UUID NOT NULL,
  as_of_date DATE NOT NULL,
  total_value NUMERIC(14,2) NOT NULL,
  return_pct NUMERIC(8,4) NOT NULL,
  rank_in_league INTEGER,
  price_breakdown JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alphabet_id, as_of_date)
);
CREATE INDEX idx_ialphabets_snap_league_date ON ialphabets_snapshots(league_id, as_of_date DESC);
CREATE INDEX idx_ialphabets_snap_alphabet ON ialphabets_snapshots(alphabet_id, as_of_date DESC);

-- Invite codes + referral attribution
CREATE TABLE ialphabets_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID REFERENCES ialphabets_leagues(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'league',
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('league', 'referral'))
);
CREATE INDEX idx_ialphabets_invites_code ON ialphabets_invites(code);
CREATE INDEX idx_ialphabets_invites_inviter ON ialphabets_invites(inviter_user_id);

-- Add FK from league_members to invites (after both exist)
ALTER TABLE ialphabets_league_members
  ADD CONSTRAINT fk_ialphabets_members_invite
  FOREIGN KEY (joined_via_invite_id) REFERENCES ialphabets_invites(id) ON DELETE SET NULL;

-- Referral credit ledger
CREATE TABLE ialphabets_referral_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id UUID NOT NULL REFERENCES ialphabets_invites(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL,
  invitee_user_id TEXT NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invite_id, invitee_user_id)
);
CREATE INDEX idx_ialphabets_credits_inviter ON ialphabets_referral_credits(inviter_user_id);

COMMIT;
