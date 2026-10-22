import { apiJson } from "./api-client";

export type CircleWarsPeriod = {
  week_start: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  round_id: string;
  server_now: string;
  seconds_remaining: number;
};

export type CircleWarsTeam = {
  team_key: string;
  circle_id: string | null;
  name: string;
  anonymous: boolean;
  rank: number;
  participating_members: number;
  qualified_referrals: number;
  is_your_circle: boolean;
  next_rank: number | null;
  referrals_to_next_rank: number | null;
  relative_progress: number;
};

export type CircleWarsState = {
  /** Client-only receipt anchor, never sent to the backend or persisted. */
  received_at_monotonic?: number;
  period: CircleWarsPeriod;
  participation: {
    status: "active" | "withdrawn";
    opted_in_at: string;
    team: CircleWarsTeam | null;
  } | null;
};

export type CircleWarsLeaderboard = {
  period: CircleWarsPeriod;
  teams: CircleWarsTeam[];
  total_teams: number;
  offset: number;
  limit: number;
  has_more: boolean;
};

const BASE = "/api/one/referrals/circle-wars";
const headers = (vaultOwnerToken: string) => ({
  Authorization: `Bearer ${vaultOwnerToken}`,
  "Content-Type": "application/json",
});

/** Uses apiJson's existing native direct-HTTP / web catch-all proxy transport. */
export const CircleWarsService = {
  async getState(vaultOwnerToken: string): Promise<CircleWarsState> {
    const state = await apiJson<CircleWarsState>(BASE, { headers: headers(vaultOwnerToken), cache: "no-store" });
    return { ...state, received_at_monotonic: performance.now() };
  },
  async optIn(vaultOwnerToken: string, circleId: string): Promise<CircleWarsState> {
    const state = await apiJson<CircleWarsState>(`${BASE}/participation`, {
      method: "POST",
      headers: headers(vaultOwnerToken),
      body: JSON.stringify({ circle_id: circleId, consent: true }),
      cache: "no-store",
    });
    return { ...state, received_at_monotonic: performance.now() };
  },
  getLeaderboard(vaultOwnerToken: string, offset = 0): Promise<CircleWarsLeaderboard> {
    return apiJson(`${BASE}/leaderboard?limit=10&offset=${offset}`, {
      headers: headers(vaultOwnerToken), cache: "no-store",
    });
  },
};
