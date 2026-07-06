import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { ROUTES } from "@/lib/navigation/routes";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";

function status(
  id: string,
  overrides: Partial<CapabilityStatus> = {},
): CapabilityStatus {
  return {
    id,
    state: "completed",
    pendingCount: 0,
    prerequisite: null,
    requiresUnlock: false,
    ...overrides,
  };
}

function buildStatusMap(
  entries: Record<string, Partial<CapabilityStatus>>,
): Record<string, CapabilityStatus> {
  const map: Record<string, CapabilityStatus> = {};
  for (const [id, overrides] of Object.entries(entries)) {
    map[id] = status(id, overrides);
  }
  return map;
}

describe("OneDashboardPage", () => {
  it("renders the primary One agent modes with route targets", () => {
    const { container } = render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          finance: { state: "not-started" },
          gmail: { state: "blocked", prerequisite: "oauth" },
          email: { state: "completed" },
          location: { state: "completed" },
          pkm: { state: "unknown", requiresUnlock: true },
          consent: { state: "needs-attention", pendingCount: 2 },
          "connected-systems": { state: "blocked", prerequisite: "oauth" },
        })}
      />,
    );

    expect(screen.getByTestId("page-header")).toBeTruthy();
    expect(screen.getByText("Good to see you, Kushal.")).toBeTruthy();
    expect(screen.getByTestId("one-launcher-section")).toBeTruthy();
    expect(screen.getByText("Launcher")).toBeTruthy();

    // Dashboard tiles tag their destination with `?from=/one` (or `&from=/one`
    // when the href already has a query) so the surface's top-bar back button
    // returns to the dashboard, not Profile. See resolveTopShellBreadcrumb.
    const fromOne = `from=${ROUTES.ONE_HOME}`;
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(`${ROUTES.KAI_HOME}?${fromOne}`);
    expect(financeLink.className).not.toContain("translate");
    // Launcher model: the route link is a normal app-icon tile, not a large
    // colored workflow card.
    expect(financeLink.className).not.toContain("border-emerald-500");
    expect(financeLink.getAttribute("style") ?? "").not.toContain("background");
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("href"),
    ).toBe(`${ROUTES.GMAIL}?${fromOne}`);
    expect(
      screen.getByRole("link", { name: "Open Email" }).getAttribute("href"),
    ).toBe(`${ROUTES.ONE_KYC}?${fromOne}`);
    expect(
      screen.getByRole("link", { name: "Open Location" }).getAttribute("href"),
    ).toBe(`${ROUTES.ONE_LOCATION}?${fromOne}`);
    expect(
      screen
        .getByRole("link", { name: "Open Personal Data" })
        .getAttribute("href"),
    ).toBe(`${ROUTES.PKM}?${fromOne}`);
    expect(
      screen
        .getByRole("link", { name: "Open Consent" })
        .getAttribute("href"),
    ).toBe(`/consents?tab=pending&${fromOne}`);
    expect(
      screen
        .getByRole("link", { name: "Open Connected Systems" })
        .getAttribute("href"),
    ).toBe(`${ROUTES.CONNECTED_SYSTEMS}?${fromOne}`);

    // Resolver-driven consumer labels (plain language, no system nouns).
    expect(screen.getByText("Set up")).toBeTruthy(); // finance not-started
    expect(screen.getAllByText("Connect to set up")).toHaveLength(2); // gmail + connected
    // email + location are real vault-gated workflows (not explore-only), so a
    // completed status reads "Ready", not "Explored".
    expect(screen.getAllByText("Ready")).toHaveLength(2); // email + location completed
    expect(screen.getByText("Unlock to see")).toBeTruthy(); // pkm vault-gated
    expect(screen.getByText("2 to review")).toBeTruthy(); // consent attention
    expect(screen.getByText("2 consents pending")).toBeTruthy(); // header badge
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("title"),
    ).toBe("Receipt sync and purchase-memory review.");
    // All 8 capabilities render as tappable launcher links.
    expect(
      container.querySelectorAll('a[aria-label^="Open "]').length,
    ).toBe(8);
    expect(screen.queryByRole("link", { name: "Open One Agent" })).toBeNull();
  });

  it("reflects completed setup across all capabilities", () => {
    render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          finance: { state: "completed" },
          gmail: { state: "completed" },
          email: { state: "completed" },
          location: { state: "completed" },
          pkm: { state: "completed" },
          consent: { state: "completed" },
          "connected-systems": { state: "completed" },
        })}
      />,
    );

    // finance + gmail + email + location + pkm + connected-systems are real
    // workflows and read "Ready" when completed; only consent is explore-only
    // and reads "Explored".
    expect(screen.getAllByText("Ready")).toHaveLength(6);
    expect(screen.getByText("Explored")).toBeTruthy();
    expect(screen.getByText("No pending consents")).toBeTruthy();
  });

  it("renders an honest fallback when status is not yet resolved", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    // No fabricated "Ready"/"Setup needed" — everything reads as checking.
    expect(screen.getAllByText("Checking...").length).toBeGreaterThan(0);
  });
});
