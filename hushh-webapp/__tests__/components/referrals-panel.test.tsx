import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

import { ReferralsPanel } from "@/components/profile/referrals-panel";
import { ApiError } from "@/lib/services/api-client";
import { ReferralService, type ReferralSummary } from "@/lib/services/referral-service";

// The panel reads the signed-in user to mint an ID token. Stubbing the hook
// rather than the whole auth provider keeps the token in the assertions --
// the first version of this suite mocked only the service, which is exactly
// why it passed while the deployed screen returned 401 on every load.
// The identity must be STABLE across renders. `user` is a dependency of the
// panel's loader, so a mock that returns a fresh object each call re-runs the
// effect on every render and quietly eats the queued mock responses.
vi.mock("@/lib/firebase/auth-context", () => {
  const value = {
    user: { uid: "test_user", getIdToken: () => Promise.resolve("test-id-token") },
  };
  return { useAuth: () => value };
});

/**
 * What the Referrals tab is allowed to show, and what it must never show.
 *
 * The privacy assertions here are the load-bearing ones. A referrer is shown a
 * count and a status word; a referred person's identity, and the reason a
 * referral was held, both stay on the server. Those are not rendering details
 * -- telling a referrer their friend was refused also tells them what our
 * fraud checks look at.
 */

const summary: ReferralSummary = {
  slug: "ankit-7k4m",
  link: "https://uat.one.hushh.ai/r/ankit-7k4m",
  qualified_count: 3,
  in_progress_count: 2,
  under_review_count: 0,
  required_active_minutes: 15,
  new_users_only: true,
  referrals: [
    {
      status: "Qualified" as const,
      step: "Qualified",
      started_on: "2026-08-20",
      active_minutes: 15,
      required_minutes: 15,
      meaningful_events: 4,
      required_events: 3,
    },
    {
      status: "In progress" as const,
      step: "Using an agent",
      started_on: "2026-08-22",
      active_minutes: 4,
      required_minutes: 15,
      meaningful_events: 1,
      required_events: 3,
    },
  ],
};

function mockSummary(value: Partial<ReferralSummary> = {}) {
  return vi
    .spyOn(ReferralService, "getSummary")
    .mockResolvedValue({ ...summary, ...value });
}

/**
 * Every gamification read defaults to a safe, empty-but-present shape so a
 * test that only cares about ONE section does not have to mock all six.
 */
function mockGamificationDefaults() {
  vi.spyOn(ReferralService, "getLeaderboard").mockResolvedValue({
    snapshot_generated_at: null,
    entries: [],
    viewer: null,
    stale: true,
  });
  vi.spyOn(ReferralService, "getCircleLeaderboard").mockResolvedValue({ teams: [] });
  vi.spyOn(ReferralService, "getMilestones").mockResolvedValue({
    lifetime_qualified_count: 0,
    earned: [],
    next_milestone: null,
  });
  vi.spyOn(ReferralService, "getEngagement").mockResolvedValue({
    streak: { current_run_days: 0, run_length_days: 3 },
    flash: { active: false, ends_at: null },
  });
  vi.spyOn(ReferralService, "getCircleSelection").mockResolvedValue({ circle_id: null });
  vi.spyOn(ReferralService, "getHandle").mockResolvedValue({ handle: "already-set" });
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  mockGamificationDefaults();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReferralsPanel", () => {
  it("shows the server's counts, never a number it worked out itself", async () => {
    mockSummary();
    render(<ReferralsPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("referral-qualified-count").textContent).toBe("3");
    });
    expect(screen.getByTestId("referral-in-progress-count").textContent).toBe("2");
    // The two rows must not be mistaken for the counts: the panel renders what
    // the server said (3), not the length of the list it was handed (2).
    expect(summary.referrals.length).not.toBe(summary.qualified_count);
  });

  it("sends the Firebase ID token, because the endpoint answers 401 without it", async () => {
    const spy = mockSummary();
    render(<ReferralsPanel />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({ idToken: "test-id-token" });
  });

  it("shows the referral link and copies exactly that link", async () => {
    mockSummary();
    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText(summary.link)).toBeTruthy());
    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(summary.link),
    );
  });

  it("never renders anything identifying about a referred person", async () => {
    mockSummary();
    const { container } = render(<ReferralsPanel />);
    await waitFor(() => expect(screen.getByText(summary.link)).toBeTruthy());

    const rendered = container.textContent || "";
    for (const leak of [
      "@",
      "+91",
      "user_",
      "uid",
      "risk",
      "fraud",
      "device",
      "duplicate",
      "rejected",
    ]) {
      expect(rendered.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("offers a retry when the summary fails, and does not crash Profile", async () => {
    const spy = vi
      .spyOn(ReferralService, "getSummary")
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce(summary);

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Unable to load")).toBeTruthy());
    fireEvent.click(screen.getByText("Try again"));

    await waitFor(() => expect(screen.getByText(summary.link)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("shows a zero state rather than an empty screen", async () => {
    mockSummary({ qualified_count: 0, in_progress_count: 0, referrals: [] });
    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("No referrals yet")).toBeTruthy());
    expect(screen.getByTestId("referral-qualified-count").textContent).toBe("0");
  });

  it("hides the review row until there is something under review", async () => {
    mockSummary({ under_review_count: 0 });
    render(<ReferralsPanel />);
    // "Qualified" appears both as a count row and as a referral status.
    await waitFor(() => expect(screen.getAllByText("Qualified").length).toBeGreaterThan(0));
    expect(screen.queryByText("Under review")).toBeNull();
  });

  it("shows the review row when the server reports one", async () => {
    mockSummary({
      under_review_count: 1,
      referrals: [
        {
          status: "Under review" as const,
          step: "Under review",
          started_on: "2026-08-21",
          active_minutes: 15,
          required_minutes: 15,
          meaningful_events: 3,
          required_events: 3,
        },
      ],
    });
    render(<ReferralsPanel />);
    await waitFor(() => expect(screen.getAllByText("Under review").length).toBeGreaterThan(0));
  });

  it("states the qualification bar from the server, not from a hardcoded 15", async () => {
    mockSummary({ required_active_minutes: 20 });
    render(<ReferralsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/20 active minutes/)).toBeTruthy(),
    );
  });

  it("opens the in-progress detail on tap, showing the step and the minutes", async () => {
    mockSummary();
    render(<ReferralsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("referral-in-progress-count")).toBeTruthy(),
    );
    // Collapsed by default: the counts are the summary, the detail is a choice.
    expect(screen.queryByTestId("referral-progress-minutes")).toBeNull();

    // SettingsRow splits into an outer shell (which carries the test id) and an
    // inner button when it has a trailing element, so the click has to land on
    // the button, not the shell.
    fireEvent.click(
      within(screen.getByTestId("referral-in-progress-row")).getByRole("button"),
    );

    await waitFor(() =>
      expect(screen.getByTestId("referral-progress-minutes").textContent).toBe(
        "4/15",
      ),
    );
    expect(screen.getByText("Using an agent")).toBeTruthy();
  });

  it("names nobody in the in-progress detail", async () => {
    mockSummary();
    const { container } = render(<ReferralsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("referral-in-progress-count")).toBeTruthy(),
    );
    // SettingsRow splits into an outer shell (which carries the test id) and an
    // inner button when it has a trailing element, so the click has to land on
    // the button, not the shell.
    fireEvent.click(
      within(screen.getByTestId("referral-in-progress-row")).getByRole("button"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("referral-progress-minutes")).toBeTruthy(),
    );

    // The detail is the most tempting place to leak an identity, because it is
    // the one screen that is genuinely about one other person.
    const rendered = (container.textContent || "").toLowerCase();
    for (const leak of ["@", "+91", "user_", "uid", "device", "risk"]) {
      expect(rendered).not.toContain(leak);
    }
  });

  it("does not offer the detail when there is nothing in progress", async () => {
    mockSummary({ in_progress_count: 0, referrals: [] });
    render(<ReferralsPanel />);
    await waitFor(() => expect(screen.getByText("No referrals yet")).toBeTruthy());

    // Not merely empty when opened -- not openable at all. A row that looks
    // tappable and does nothing is worse than a row that does not invite the tap.
    const row = screen.getByTestId("referral-in-progress-row");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("referral-progress-minutes")).toBeNull();
  });

  it("refetches when the tab comes back to the foreground", async () => {
    // A referral changes state because of what the OTHER person did, so a count
    // that only moves on a manual reload is wrong the moment it is drawn.
    const spy = mockSummary();
    render(<ReferralsPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });

  it("does not let a slow first response overwrite a newer one", async () => {
    let releaseFirst: (value: ReferralSummary) => void = () => {};
    const slow = new Promise<ReferralSummary>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(ReferralService, "getSummary")
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ ...summary, qualified_count: 99 });

    render(<ReferralsPanel />);
    // The first request is still in flight; nothing has rendered yet.
    releaseFirst({ ...summary, qualified_count: 1 });

    await waitFor(() =>
      expect(screen.getByTestId("referral-qualified-count").textContent).toBe("1"),
    );
  });

  it("still renders the core summary when every gamification read fails", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getLeaderboard").mockRejectedValue(new Error("down"));
    vi.spyOn(ReferralService, "getCircleLeaderboard").mockRejectedValue(new Error("down"));
    vi.spyOn(ReferralService, "getMilestones").mockRejectedValue(new Error("down"));
    vi.spyOn(ReferralService, "getEngagement").mockRejectedValue(new Error("down"));
    vi.spyOn(ReferralService, "getCircleSelection").mockRejectedValue(new Error("down"));
    vi.spyOn(ReferralService, "getHandle").mockRejectedValue(new Error("down"));

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText(summary.link)).toBeTruthy());
    expect(screen.getByTestId("referral-qualified-count").textContent).toBe("3");
  });
});

describe("ReferralsPanel gamification", () => {
  it("shows the viewer's rank and points from the leaderboard read", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getLeaderboard").mockResolvedValue({
      snapshot_generated_at: "2026-11-09T00:00:00Z",
      entries: [{ rank: 1, handle: "top-dog", points: 500, is_viewer: false }],
      viewer: { rank: 47, handle: "me-handle", points: 20, is_viewer: true },
      stale: false,
    });

    render(<ReferralsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("referral-overall-rank").textContent).toBe("#47"),
    );
    expect(screen.getByTestId("referral-cumulative-points").textContent).toBe("20");
  });

  it("shows 'Not yet ranked' rather than a fabricated rank with no snapshot", async () => {
    mockSummary();
    render(<ReferralsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("referral-overall-rank").textContent).toBe("Not yet ranked"),
    );
  });

  it("never renders a real name on the leaderboard -- only chosen handles", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getLeaderboard").mockResolvedValue({
      snapshot_generated_at: "2026-11-09T00:00:00Z",
      entries: [
        { rank: 1, handle: "top-dog", points: 500, is_viewer: false },
        { rank: 2, handle: "Anonymous referrer", points: 300, is_viewer: false },
      ],
      viewer: null,
      stale: false,
    });

    const { container } = render(<ReferralsPanel />);
    await waitFor(() => expect(screen.getByText(/top-dog/)).toBeTruthy());

    const rendered = container.textContent || "";
    for (const leak of ["@", "+91", "user_", "uid"]) {
      expect(rendered.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("shows progress toward the next milestone", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getMilestones").mockResolvedValue({
      lifetime_qualified_count: 3,
      earned: [],
      next_milestone: { milestone_key: "tee_5", threshold: 5, reward: "Hushh tee", progress: 3 },
    });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Hushh tee")).toBeTruthy());
    expect(screen.getByTestId("referral-milestone-progress").textContent).toBe("3/5");
  });

  it("lists earned merchandise", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getMilestones").mockResolvedValue({
      lifetime_qualified_count: 5,
      earned: [{ milestone_key: "tee_5", reward: "Hushh tee", earned_at: "2026-10-01T00:00:00Z" }],
      next_milestone: null,
    });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Hushh tee")).toBeTruthy());
    expect(screen.getByText("Every reward earned")).toBeTruthy();
  });

  it("shows streak progress only while a streak is live", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getEngagement").mockResolvedValue({
      streak: { current_run_days: 2, run_length_days: 3 },
      flash: { active: false, ends_at: null },
    });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Referral streak")).toBeTruthy());
    expect(screen.getByText("2 of 3 days")).toBeTruthy();
  });

  it("hides the engagement section with no live streak and no active flash", async () => {
    mockSummary();
    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText(summary.link)).toBeTruthy());
    expect(screen.queryByText("Keep it going")).toBeNull();
  });

  it("shows a flash banner while a flash window is active", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getEngagement").mockResolvedValue({
      streak: { current_run_days: 0, run_length_days: 3 },
      flash: { active: true, ends_at: "2026-11-09T18:00:00Z" },
    });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Flash bonus is live")).toBeTruthy());
  });

  it("prompts for a handle only when none is set yet", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getHandle").mockResolvedValue({ handle: null });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Appear on the leaderboard")).toBeTruthy());
  });

  it("hides the handle prompt once a handle is already set", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getHandle").mockResolvedValue({ handle: "my-handle" });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText(summary.link)).toBeTruthy());
    expect(screen.queryByText("Appear on the leaderboard")).toBeNull();
  });

  it("saves a chosen handle and clears the prompt", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getHandle").mockResolvedValue({ handle: null });
    const setHandleSpy = vi
      .spyOn(ReferralService, "setHandle")
      .mockResolvedValue({ handle: "my-new-handle" });

    render(<ReferralsPanel />);
    await waitFor(() => expect(screen.getByLabelText("Leaderboard handle")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Leaderboard handle"), {
      target: { value: "my-new-handle" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(setHandleSpy).toHaveBeenCalledWith({
      idToken: "test-id-token",
      handle: "my-new-handle",
    }));
  });

  it("surfaces a distinct message when the chosen handle is already taken", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getHandle").mockResolvedValue({ handle: null });
    vi.spyOn(ReferralService, "setHandle").mockRejectedValue(
      new ApiError("Handle taken", 409, { detail: { code: "REFERRAL_HANDLE_TAKEN" } }),
    );

    render(<ReferralsPanel />);
    await waitFor(() => expect(screen.getByLabelText("Leaderboard handle")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Leaderboard handle"), {
      target: { value: "popular-handle" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(screen.getByText("That handle is already taken.")).toBeTruthy(),
    );
  });

  it("shows the team leaderboard with raw contribution counts", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getCircleLeaderboard").mockResolvedValue({
      teams: [{ circle_id: "circle-1", circle_name: "The Avengers", contribution_count: 12 }],
    });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("The Avengers")).toBeTruthy());
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("shows the viewer's own team contribution when a circle is selected", async () => {
    mockSummary();
    vi.spyOn(ReferralService, "getCircleSelection").mockResolvedValue({ circle_id: "circle-1" });
    vi.spyOn(ReferralService, "getCircleLeaderboard").mockResolvedValue({
      teams: [{ circle_id: "circle-1", circle_name: "The Avengers", contribution_count: 9 }],
    });

    render(<ReferralsPanel />);

    await waitFor(() => expect(screen.getByText("Your team")).toBeTruthy());
  });
});
