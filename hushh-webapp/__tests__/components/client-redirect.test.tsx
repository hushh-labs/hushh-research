import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientRedirect } from "@/components/navigation/client-redirect";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mocks.trackEvent,
}));

describe("ClientRedirect", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("retains provider continuation only on the Plaid compatibility callback without recording it", () => {
    window.history.replaceState({}, "", "/kai/plaid/oauth/return?oauth_state_id=synthetic-state#continuation");
    const { unmount } = render(<ClientRedirect to="/one/kai/plaid/oauth/return" preserveCallbackParameters />);
    expect(mocks.replace).toHaveBeenLastCalledWith("/one/kai/plaid/oauth/return?oauth_state_id=synthetic-state#continuation", { scroll: false });
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    unmount();
    render(<ClientRedirect to="/one" />);
    expect(mocks.replace).toHaveBeenLastCalledWith("/one", { scroll: false });
  });

  it("emits a sanitized compatibility redirect event before replacing the route", () => {
    render(
      <ClientRedirect
        to="/one/kai?tab=portfolio"
        redirectRouteId="kai_dashboard_legacy_redirect"
      />,
    );

    expect(mocks.trackEvent).toHaveBeenCalledWith(
      "page_view",
      {
        route_id: "kai_dashboard_legacy_redirect",
        nav_type: "redirect",
      },
      {
        dedupeKey: "deprecated_redirect:kai_dashboard_legacy_redirect",
        dedupeWindowMs: 5_000,
      },
    );
    expect(mocks.replace).toHaveBeenCalledWith("/one/kai?tab=portfolio", {
      scroll: false,
    });
  });
});
