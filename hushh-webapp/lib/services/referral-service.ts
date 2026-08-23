import { apiJson } from "./api-client";

/**
 * What the Referrals tab renders.
 *
 * Everything here is server-decided. The client never computes a count, never
 * decides whether a referral qualified, and never sees anything about the
 * people behind the numbers beyond a status word and the day they started.
 */
export type ReferralStatus =
  | "Qualified"
  | "In progress"
  | "Under review"
  | "Expired";

export type ReferralRow = {
  status: ReferralStatus;
  started_on: string;
};

export type ReferralSummary = {
  slug: string;
  link: string;
  qualified_count: number;
  in_progress_count: number;
  under_review_count: number;
  required_active_minutes: number;
  new_users_only: boolean;
  referrals: ReferralRow[];
};

export const ReferralService = {
  async getSummary(): Promise<ReferralSummary> {
    return apiJson<ReferralSummary>("/api/one/referrals/summary", {
      method: "GET",
    });
  },
};
