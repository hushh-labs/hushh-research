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
  /** Where this person has reached, as a step -- never who they are. */
  step: string;
  started_on: string;
  /** Credited active minutes so far, capped at the bar. */
  active_minutes: number;
  required_minutes: number;
  meaningful_events: number;
  required_events: number;
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

export type ResolveResult = {
  status: "created" | "unavailable";
  attribution_id?: string;
};

export type BindResult = {
  status:
    | "bound"
    | "unavailable"
    | "already_used"
    | "expired"
    | "self_referral"
    | "already_referred"
    | "existing_user";
};

export const ReferralService = {
  /**
   * `apiJson` does not attach credentials -- every authenticated /api/one call
   * in this app passes the Firebase ID token explicitly, and the proxy forwards
   * the Authorization header it is given. Omitting it is a silent 401 that
   * surfaces as "Unable to load".
   */
  async getSummary(opts: { idToken: string }): Promise<ReferralSummary> {
    return apiJson<ReferralSummary>("/api/one/referrals/summary", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
  },

  /**
   * Opening a referral link. Deliberately unauthenticated -- there is no
   * session yet, which is the whole point: the attribution is recorded on the
   * server BEFORE the person is sent into sign-in, so nothing downstream has to
   * trust a slug the client hands back afterwards.
   */
  async resolve(slug: string, landingRoute?: string): Promise<ResolveResult> {
    return apiJson<ResolveResult>("/api/one/referrals/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, landing_route: landingRoute }),
    });
  },

  /** Attach a pending attribution to the person who just signed in. */
  async bind(opts: { idToken: string; attributionId: string }): Promise<BindResult> {
    return apiJson<BindResult>("/api/one/referrals/bind", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
      body: JSON.stringify({ attribution_id: opts.attributionId }),
    });
  },
};
