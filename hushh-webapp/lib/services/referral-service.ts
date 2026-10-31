import { apiJson } from "./api-client";

/**
 * What the Referrals tab renders.
 *
 * Everything here is server-decided. The client never computes a count, never
 * decides whether a referral qualified, and never sees anything about the
 * people beyond the direct member display name, status and aggregate progress.
 */
export type ReferralStatus =
  | "Qualified"
  | "In progress"
  | "Under review"
  | "Expired";

export type ReferralRow = {
  id?: string;
  display_name?: string;
  status: ReferralStatus;
  /** Where this person has reached, as a privacy-safe step. */
  step: string;
  started_on: string;
  /** Credited active minutes so far, capped at the bar. */
  active_minutes: number;
  required_minutes: number;
  meaningful_events: number;
  required_events: number;
};

export type ReferralSummary = {
  joined_count: number;
  total_count?: number;
  next_offset?: number | null;
  slug: string;
  link: string;
  /** Accepted referral-link opens, including QR navigation; not unique visitors. */
  link_open_count?: number;
  last_opened_at?: string | null;
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

export type ReferralPolicy = {
  flash_bonus_enabled?: boolean;
  version: number;
  points: { qualified_referral_points: number; flash_window_total_points: number; streak_three_day_bonus_points: number; referral_in_progress_points?: number; referral_qualified_activity_total_points?: number; agent_usage_points?: number; pkm_daily_points?: number; connection_created_points?: number };
  streak_rules: { run_length_days: number; bonus_points: number };
  challenge_duration_days: number | null;
  weekly_prizes_enabled: boolean;
};

export type WeeklyChallenge = {
  calendar_active?: boolean;
  campaign_active?: boolean;
  received_at_monotonic?: number;
  /** Server work is excluded when estimating the response's one-way transit. */
  server_processing_ms?: number;
  estimated_transit_ms?: number;
  server_now?: string;
  round_id?: string;
  status?: string;
  weekly_prizes_enabled?: boolean;
  active: boolean;
  week_started_at: string | null;
  cutoff_at: string | null;
  timezone: string | null;
};

/** A ranking row: `handle` remains a chosen alias or anonymous placeholder;
 * `display_name` is a separate viewer-permitted account-profile projection. */
export type LeaderboardEntry = {
  rank: number;
  handle: string;
  /** Profile name visible to this viewer, when no public alias was chosen. */
  display_name?: string | null;
  /** Portrait returned through the same viewer-permitted profile projection. */
  photo_url?: string | null;
  points: number;
  is_viewer: boolean;
};

export type LeaderboardPage = {
  snapshot_id?: string;
  next_after_rank?: number | null;
  snapshot_generated_at: string | null;
  entries: LeaderboardEntry[];
  viewer: LeaderboardEntry | null;
  stale: boolean;
};

export type CircleLeaderboardEntry = {
  rank: number;
  member_count?: number;
  qualified_member_count?: number;
  circle_id: string;
  circle_name: string;
  contribution_count: number;
};

export type EarnedMilestone = {
  claimed_at?: string | null;
  fulfillment_status?: string | null;
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
  joined_referral_count: number;
  progress_basis?: "joined_referrals";
  available_milestones?: Omit<NextMilestone, "progress">[];
  lifetime_qualified_count: number;
  earned: EarnedMilestone[];
  next_milestone: NextMilestone | null;
};

export type EngagementStatus = {
  streak: { current_run_days: number; run_length_days: number; longest_run_days?: number; last_activity_date?: string | null };
  flash: { active: boolean; ends_at: string | null };
};

export type CircleSelection = {
  status?: "preview" | "available";
  competition_active?: boolean;
  circle_name?: string;
  rank?: number;
  member_count?: number;
  qualified_member_count?: number;
  contribution_count?: number;
  circle_id: string | null;
  selected_at?: string;
};

export const ReferralService = {
  async recordAppOpen(opts: { idToken: string }): Promise<{ activity_date: string; timezone: string; server_now: string; next_day_at: string }> {
    return apiJson("/api/one/referrals/app-open", { method: "POST", headers: { Authorization: `Bearer ${opts.idToken}`, "Content-Type": "application/json" }, body: JSON.stringify({surface:"referral_dashboard"}) });
  },

  async claimReward(opts: { idToken: string; milestoneKey: string }): Promise<{ status: string }> {
    return apiJson("/api/one/referrals/rewards/claim", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.idToken}` },
      body: JSON.stringify({ milestone_key: opts.milestoneKey }) });
  },
  /**
   * `apiJson` does not attach credentials -- every authenticated /api/one call
   * in this app passes the Firebase ID token explicitly, and the proxy forwards
   * the Authorization header it is given. Omitting it is a silent 401 that
   * surfaces as "Unable to load".
   */
  async getSummary(opts: { idToken: string }): Promise<ReferralSummary> {
    const result = await apiJson<ReferralSummary>("/api/one/referrals/summary", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
    if (!Number.isSafeInteger(result.joined_count) || result.joined_count < 0) {
      throw new Error("Joined referral totals are unavailable");
    }
    return result;
  },

  /** Revoke the presented referral QR; preserve earned referrals and progress. */
  async rotateShareLink(opts: { idToken: string; slug: string }): Promise<ReferralSummary> {
    return apiJson<ReferralSummary>("/api/one/referrals/rotate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
      body: JSON.stringify({ slug: opts.slug }),
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

  /** This person's own recorded earned Coins, summed live from the ledger --
   * independent of the published leaderboard snapshot. Correct for an
   * unranked account or one whose points posted after the latest snapshot. */
  async getPoints(opts: { idToken: string }): Promise<{ points: number; coins: number }> {
    const result = await apiJson<{ points: number; coins: number }>("/api/one/referrals/points", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
    if (!Number.isSafeInteger(result.coins) || result.coins !== result.points) {
      throw new Error("Lifetime Coins are unavailable");
    }
    return result;
  },

  /** One page of the published cumulative leaderboard. The caller's own row
   * is included even when it falls outside this page. */
  async getLeaderboard(opts: {
    idToken: string;
    afterRank?: number;
    limit?: number;
    snapshotId?: string;
  }): Promise<LeaderboardPage> {
    const params = new URLSearchParams();
    if (opts.afterRank) params.set("after_rank", String(opts.afterRank));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.snapshotId) params.set("snapshot_id", opts.snapshotId);
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
    const result = await apiJson<{ teams: CircleLeaderboardEntry[]; status: string; competition_active: boolean }>(
      "/api/one/referrals/circles/leaderboard",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.idToken}`,
        },
      },
    );
    if (result.status !== "preview" || result.competition_active !== false || result.teams.length !== 0) {
      throw new Error("Referral team standings are unavailable");
    }
    return result;
  },

  /** This person's lifetime milestone progress and earned merchandise. */
  async getPolicy(opts: { idToken: string }): Promise<ReferralPolicy> {
    return apiJson<ReferralPolicy>("/api/one/referrals/policy", {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.idToken}` },
    });
  },

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

  /** The persisted weekly-prize round. Calendar existence never enables prizes. */
  async getChallenge(opts: { idToken: string }): Promise<WeeklyChallenge> {
    const requestedAt = performance.now();
    const result = await apiJson<WeeklyChallenge>("/api/one/referrals/challenge", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
    const receivedAt = performance.now();
    const processing = result.server_processing_ms;
    const transit = typeof processing === "number" && Number.isFinite(processing) && processing >= 0
      ? Math.max(0, receivedAt - requestedAt - processing) / 2
      : 0;
    return { ...result, received_at_monotonic: receivedAt, estimated_transit_ms: transit };
  },

  /** This person's current referral-contest team, if any. */
  async getCircleSelection(opts: { idToken: string }): Promise<CircleSelection> {
    const result = await apiJson<CircleSelection>("/api/one/referrals/circle", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.idToken}`,
      },
    });
    if (result.status !== "preview" || result.competition_active !== false || result.circle_id !== null) {
      throw new Error("Referral team membership is unavailable");
    }
    return result;
  },

  /** Preview gate: team selection remains unavailable until opt-in policy approval. */
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
