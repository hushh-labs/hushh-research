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

export type WeeklyChallenge = {
  active: boolean;
  week_started_at: string | null;
  cutoff_at: string | null;
  timezone: string | null;
};

/** One row on the individual leaderboard. Never a real name -- `handle` is
 * either the person's own chosen alias or the anonymous placeholder. */
export type LeaderboardEntry = {
  rank: number;
  handle: string;
  points: number;
  is_viewer: boolean;
};

export type LeaderboardPage = {
  snapshot_generated_at: string | null;
  entries: LeaderboardEntry[];
  viewer: LeaderboardEntry | null;
  stale: boolean;
};

export type CircleLeaderboardEntry = {
  circle_id: string;
  circle_name: string;
  contribution_count: number;
};

export type EarnedMilestone = {
  milestone_key: string;
  reward: string;
  earned_at: string;
};

export type NextMilestone = {
  milestone_key: string;
  threshold: number;
  reward: string;
  progress: number;
};

export type MilestoneProgress = {
  lifetime_qualified_count: number;
  earned: EarnedMilestone[];
  next_milestone: NextMilestone | null;
};

export type EngagementStatus = {
  streak: { current_run_days: number; run_length_days: number };
  flash: { active: boolean; ends_at: string | null };
};

export type CircleSelection = {
  circle_id: string | null;
  selected_at?: string;
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

  /** One page of the published cumulative leaderboard. The caller's own row
   * is included even when it falls outside this page. */
  async getLeaderboard(opts: {
    idToken: string;
    afterRank?: number;
    limit?: number;
  }): Promise<LeaderboardPage> {
    const params = new URLSearchParams();
    if (opts.afterRank) params.set("after_rank", String(opts.afterRank));
    if (opts.limit) params.set("limit", String(opts.limit));
    const query = params.toString();
    return apiJson<LeaderboardPage>(
      `/api/one/referrals/leaderboard${query ? `?${query}` : ""}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.idToken}`,
        },
      },
    );
  },

  /** Cumulative RAW qualified-referral count per contest team. */
  async getCircleLeaderboard(opts: {
    idToken: string;
  }): Promise<{ teams: CircleLeaderboardEntry[] }> {
    return apiJson<{ teams: CircleLeaderboardEntry[] }>(
      "/api/one/referrals/circles/leaderboard",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.idToken}`,
        },
      },
    );
  },

  /** This person's lifetime milestone progress and earned merchandise. */
  async getMilestones(opts: { idToken: string }): Promise<MilestoneProgress> {
    return apiJson<MilestoneProgress>("/api/one/referrals/milestones", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
  },

  /** Streak progress and whether a flash window is active right now. */
  async getEngagement(opts: { idToken: string }): Promise<EngagementStatus> {
    return apiJson<EngagementStatus>("/api/one/referrals/engagement", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
  },

  /** This person's own chosen public leaderboard handle, if any. */
  async getHandle(opts: { idToken: string }): Promise<{ handle: string | null }> {
    return apiJson<{ handle: string | null }>("/api/one/referrals/handle", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
  },

  /** Choose or change this person's own public leaderboard handle. */
  async setHandle(opts: {
    idToken: string;
    handle: string;
  }): Promise<{ handle: string }> {
    return apiJson<{ handle: string }>("/api/one/referrals/handle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
      body: JSON.stringify({ handle: opts.handle }),
    });
  },

  /** The current seven-day challenge round's start and close. `active` is
   * false when the program's weekly schedule is unset. */
  async getChallenge(opts: { idToken: string }): Promise<WeeklyChallenge> {
    return apiJson<WeeklyChallenge>("/api/one/referrals/challenge", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
  },

  /** This person's current referral-contest team, if any. */
  async getCircleSelection(opts: { idToken: string }): Promise<CircleSelection> {
    return apiJson<CircleSelection>("/api/one/referrals/circle", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
  },

  /** Select this person's one active referral-contest team. Requires
   * accepted membership in that Location Circle already. */
  async selectCircle(opts: {
    idToken: string;
    circleId: string;
  }): Promise<CircleSelection> {
    return apiJson<CircleSelection>("/api/one/referrals/circle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
      body: JSON.stringify({ circle_id: opts.circleId }),
    });
  },
};
