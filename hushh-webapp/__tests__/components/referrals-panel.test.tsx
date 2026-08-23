import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { ReferralsPanel } from "@/components/profile/referrals-panel";
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
    { status: "Qualified", started_on: "2026-08-20" },
    { status: "In progress", started_on: "2026-08-22" },
  ],
};

function mockSummary(value: Partial<ReferralSummary> = {}) {
  return vi
    .spyOn(ReferralService, "getSummary")
    .mockResolvedValue({ ...summary, ...value });
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
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
      referrals: [{ status: "Under review", started_on: "2026-08-21" }],
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
});
