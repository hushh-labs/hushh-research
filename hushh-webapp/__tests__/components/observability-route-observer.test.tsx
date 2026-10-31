import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ObservabilityRouteObserver } from "@/components/observability/route-observer";
import { recordCurrentSectionVisit } from "@/components/observability/live-activity-section-subject";

const mocks = vi.hoisted(() => ({
  pathname: "/",
  trackPageView: vi.fn(),
  refreshWebGtmPageContext: vi.fn(),
  captureGrowthAttribution: vi.fn(),
  setLastKaiPath: vi.fn(),
  setLastRiaPath: vi.fn(),
  setObservabilityUserId: vi.fn().mockResolvedValue(true),
  recordLiveActivity: vi.fn(),
  user: null as { uid: string } | null,
  userId: null as string | null,
  loading: false,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/lib/observability/client", () => ({
  trackPageView: mocks.trackPageView,
}));
vi.mock("@/lib/observability/adapters/web-gtm", () => ({
  refreshWebGtmPageContext: mocks.refreshWebGtmPageContext,
}));

vi.mock("@/lib/observability/growth", () => ({
  captureGrowthAttribution: mocks.captureGrowthAttribution,
}));
vi.mock("@/lib/pkm/live-activity/live-activity-journal", () => ({
  recordLiveActivity: mocks.recordLiveActivity,
}));
// The CRM section is local-only; enable it so its hyphenated id is exercised.
vi.mock("@/lib/connected-systems/crm-product-availability", () => ({
  isLocalCrmBuildEnabled: () => true,
}));
vi.mock("@/lib/observability/identity", () => ({
  setObservabilityUserId: mocks.setObservabilityUserId,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, userId: mocks.userId, loading: mocks.loading }),
}));

vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (selector: (state: unknown) => unknown) =>
    selector({
      setLastKaiPath: mocks.setLastKaiPath,
      setLastRiaPath: mocks.setLastRiaPath,
    }),
}));

function renderAt(pathname: string) {
  mocks.pathname = pathname;
  render(<ObservabilityRouteObserver />);
}

describe("ObservabilityRouteObserver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setObservabilityUserId.mockReset().mockResolvedValue(true);
    mocks.user = null;
    mocks.userId = null;
    mocks.loading = false;
  });

  // Wallet Profile contract §7: the public page must emit no analytics. The
  // visitor is a stranger holding someone else's printed QR — not a user, no
  // account, no consent with us — and the path itself carries the share token,
  // so a single page_view would ship both the token and the visitor.
  it.each(["/c/tok_abc123", "/c/tok_abc123/", "/c/tok_abc123/index.html"])(
    "captures nothing for a scanned Wallet Profile at %s",
    (pathname) => {
      renderAt(pathname);

      expect(mocks.trackPageView).not.toHaveBeenCalled();
      expect(mocks.captureGrowthAttribution).not.toHaveBeenCalled();
      expect(mocks.refreshWebGtmPageContext).not.toHaveBeenCalled();
    },
  );

  it("does not persist a share token into session state", () => {
    // The session-path writes are inside the same effect, so bailing has to
    // happen before them or the token lands in client-side storage.
    renderAt("/c/tok_abc123");

    expect(mocks.setLastKaiPath).not.toHaveBeenCalled();
    expect(mocks.setLastRiaPath).not.toHaveBeenCalled();
  });

  it("still instruments the owner's own Wallet Profile surface", async () => {
    // The exemption must stay scoped to the public token namespace: the owner
    // is a signed-in user on a first-party screen.
    renderAt("/one/wallet-card");

    await waitFor(() => expect(mocks.trackPageView).toHaveBeenCalledWith(
      "/one/wallet-card",
      "initial_load",
    ));
    expect(mocks.captureGrowthAttribution).toHaveBeenCalledWith(
      "/one/wallet-card",
    );
  });

  it("still instruments ordinary product routes and records their scope", async () => {
    renderAt("/ria/clients");

    await waitFor(() => expect(mocks.trackPageView).toHaveBeenCalledWith(
      "/ria/clients",
      "initial_load",
    ));
    expect(mocks.setLastRiaPath).toHaveBeenCalledWith("/ria/clients");
  });
  it("waits for restored auth and binds its ID before recording a product view", async () => {
    mocks.user = { uid: "validated-account" };
    mocks.userId = "validated-account";
    let releaseBinding: (() => void) | undefined;
    mocks.setObservabilityUserId.mockImplementationOnce(() => new Promise<boolean>((resolve) => { releaseBinding = () => resolve(true); }));
    renderAt("/one");
    expect(mocks.refreshWebGtmPageContext).toHaveBeenCalledOnce();
    expect(mocks.setObservabilityUserId).toHaveBeenCalledWith("validated-account");
    expect(mocks.trackPageView).not.toHaveBeenCalled();
    releaseBinding?.();
    await waitFor(() => expect(mocks.trackPageView).toHaveBeenCalledWith("/one", "initial_load"));
  });

  it("does not emit a signed-in page view until a delayed gtag identity bind succeeds", async () => {
    vi.useFakeTimers();
    try {
      mocks.user = { uid: "validated-account" };
      mocks.userId = "validated-account";
      mocks.setObservabilityUserId
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      renderAt("/one");
      await act(async () => { await Promise.resolve(); });
      expect(mocks.trackPageView).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(mocks.setObservabilityUserId).toHaveBeenCalledTimes(2);
      expect(mocks.trackPageView).toHaveBeenCalledTimes(1);
      expect(mocks.trackPageView).toHaveBeenCalledWith("/one", "initial_load");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a start-fresh account by its owner, never the deleted account's Firebase UID", async () => {
    // After start fresh the Firebase UID is the retired owner, so the view waits for the owner.
    mocks.pathname = "/one";
    mocks.user = { uid: "firebase-uid-of-deleted-account" };
    const view = render(<ObservabilityRouteObserver />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.setObservabilityUserId).not.toHaveBeenCalled();
    expect(mocks.trackPageView).not.toHaveBeenCalled();

    mocks.userId = `acct_${"b".repeat(32)}`;
    view.rerender(<ObservabilityRouteObserver />);
    await waitFor(() => expect(mocks.trackPageView).toHaveBeenCalledWith("/one", "initial_load"));
    expect(mocks.setObservabilityUserId).toHaveBeenCalledWith(`acct_${"b".repeat(32)}`);
    expect(mocks.setObservabilityUserId).not.toHaveBeenCalledWith("firebase-uid-of-deleted-account");
  });

  describe("live activity section visits", () => {
    const owner = `acct_${"c".repeat(32)}`;
    const visit = (pathname: string, view: ReturnType<typeof render>) => {
      mocks.pathname = pathname;
      view.rerender(<ObservabilityRouteObserver />);
    };

    beforeEach(() => {
      mocks.user = { uid: owner };
      mocks.userId = owner;
      mocks.recordLiveActivity.mockReset();
    });

    it("counts a revisit through the One home, and the unlock catch-up never repeats a stored visit", () => {
      mocks.recordLiveActivity.mockReturnValue(true);
      mocks.pathname = "/one/location";
      const view = render(<ObservabilityRouteObserver />);
      visit("/one", view);
      visit("/one/location", view);
      recordCurrentSectionVisit(owner, "location");

      expect(mocks.recordLiveActivity.mock.calls).toEqual([
        [{ kind: "section_opened", subject: "location" }],
        [{ kind: "section_opened", subject: "location" }],
      ]);
    });

    it("records one entry per section visit, never for a sub-screen of the same section", () => {
      mocks.pathname = "/one/location";
      const view = render(<ObservabilityRouteObserver />);
      visit("/one/location/onboarding", view);
      visit("/one/connect", view);
      visit("/one/connect/settings", view);
      visit("/one/location", view);

      expect(mocks.recordLiveActivity.mock.calls).toEqual([
        [{ kind: "section_opened", subject: "location" }],
        [{ kind: "section_opened", subject: "connect" }],
        [{ kind: "section_opened", subject: "location" }],
      ]);
    });

    it("names an allowlisted section id, never the raw path", () => {
      mocks.pathname = "/one/profile/world-model";
      const view = render(<ObservabilityRouteObserver />);
      visit("/one/connected-systems", view);

      expect(mocks.recordLiveActivity.mock.calls).toEqual([
        [{ kind: "section_opened", subject: "profile_world_model" }],
        [{ kind: "section_opened", subject: "connected_systems" }],
      ]);
      for (const [input] of mocks.recordLiveActivity.mock.calls) {
        expect(JSON.stringify(input)).not.toContain("/");
      }
    });

    it("never journals the One home between sections", () => {
      mocks.pathname = "/one/location";
      const view = render(<ObservabilityRouteObserver />);
      visit("/one", view);
      visit("/one/connect", view);
      visit("/one/", view);

      expect(mocks.recordLiveActivity.mock.calls).toEqual([
        [{ kind: "section_opened", subject: "location" }],
        [{ kind: "section_opened", subject: "connect" }],
      ]);
    });

    it.each(["/c/tok_abc123", "/one/no-such-screen", "/people/person_ref_123"])(
      "records nothing for a share, unknown or non-section route at %s",
      (pathname) => {
        renderAt(pathname);

        expect(mocks.recordLiveActivity).not.toHaveBeenCalled();
      },
    );

    it("records nothing without a validated owner", () => {
      mocks.user = null;
      mocks.userId = null;
      renderAt("/one/location");

      mocks.user = { uid: "firebase-uid-of-deleted-account" };
      renderAt("/one/location");

      expect(mocks.recordLiveActivity).not.toHaveBeenCalled();
    });

    it("records before the analytics identity binds", () => {
      mocks.setObservabilityUserId.mockReturnValue(new Promise<boolean>(() => {}));
      renderAt("/one/location");

      expect(mocks.trackPageView).not.toHaveBeenCalled();
      expect(mocks.recordLiveActivity).toHaveBeenCalledWith({
        kind: "section_opened",
        subject: "location",
      });
    });
  });
});
