import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ObservabilityRouteObserver } from "@/components/observability/route-observer";

const mocks = vi.hoisted(() => ({
  pathname: "/",
  trackPageView: vi.fn(),
  captureGrowthAttribution: vi.fn(),
  setLastKaiPath: vi.fn(),
  setLastRiaPath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/lib/observability/client", () => ({
  trackPageView: mocks.trackPageView,
}));

vi.mock("@/lib/observability/growth", () => ({
  captureGrowthAttribution: mocks.captureGrowthAttribution,
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
    },
  );

  it("does not persist a share token into session state", () => {
    // The session-path writes are inside the same effect, so bailing has to
    // happen before them or the token lands in client-side storage.
    renderAt("/c/tok_abc123");

    expect(mocks.setLastKaiPath).not.toHaveBeenCalled();
    expect(mocks.setLastRiaPath).not.toHaveBeenCalled();
  });

  it("still instruments the owner's own Wallet Profile surface", () => {
    // The exemption must stay scoped to the public token namespace: the owner
    // is a signed-in user on a first-party screen.
    renderAt("/one/wallet-card");

    expect(mocks.trackPageView).toHaveBeenCalledWith(
      "/one/wallet-card",
      "initial_load",
    );
    expect(mocks.captureGrowthAttribution).toHaveBeenCalledWith(
      "/one/wallet-card",
    );
  });

  it("still instruments ordinary product routes and records their scope", () => {
    renderAt("/ria/clients");

    expect(mocks.trackPageView).toHaveBeenCalledWith(
      "/ria/clients",
      "initial_load",
    );
    expect(mocks.setLastRiaPath).toHaveBeenCalledWith("/ria/clients");
  });
});
