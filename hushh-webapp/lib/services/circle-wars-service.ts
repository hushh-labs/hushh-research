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
  getState(vaultOwnerToken: string): Promise<CircleWarsState> {
    return apiJson(BASE, { headers: headers(vaultOwnerToken), cache: "no-store" });
  },
  optIn(vaultOwnerToken: string, circleId: string): Promise<CircleWarsState> {
    return apiJson(`${BASE}/participation`, {
      method: "POST",
      headers: headers(vaultOwnerToken),
      body: JSON.stringify({ circle_id: circleId, consent: true }),
      cache: "no-store",
    });
  },
  getLeaderboard(vaultOwnerToken: string, offset = 0): Promise<CircleWarsLeaderboard> {
    return apiJson(`${BASE}/leaderboard?limit=25&offset=${offset}`, {
      headers: headers(vaultOwnerToken), cache: "no-store",
    });
  },
};
