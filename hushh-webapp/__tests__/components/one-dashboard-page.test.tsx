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
    // 2a redesign groups capabilities into Workflows / Memory / Access sections
    // (the RIA standalone agent tile mirrors the top-bar switcher roster and
    // sits in the Workflows group next to Finance).
    expect(screen.getByTestId("one-workflows-section")).toBeTruthy();
    expect(screen.getByTestId("one-memory-section")).toBeTruthy();
    expect(screen.getByTestId("one-access-section")).toBeTruthy();

    // Dashboard tiles tag their destination with `?from=/one` (or `&from=/one`
    // when the href already has a query) so the surface's top-bar back button
    // returns to the dashboard, not Profile. See resolveTopShellBreadcrumb.
    const fromOne = `from=${ROUTES.ONE_HOME}`;
    // The finance tile is publicly named "Finance"; Kai stays internal.
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(`${ROUTES.KAI_HOME}?${fromOne}`);
    expect(financeLink.className).not.toContain("translate");
    // 2a pastel-block model: no per-tone outline border on outer chrome — the
    // tone lives in the card's flat pastel FILL (inline background), not a
    // colored border.
    expect(financeLink.className).not.toContain("border-emerald-500");
    expect(financeLink.getAttribute("style") ?? "").toContain("background");
    // The /one grid mirrors the top-bar agent switcher roster: RIA sits
    // directly after Finance as a standalone top-level agent (also a pastel
    // workflow card).
    const riaLink = screen.getByRole("link", { name: "Open RIA" });
    expect(riaLink.getAttribute("href")).toBe(`${ROUTES.RIA_HOME}?${fromOne}`);
    expect(riaLink.getAttribute("style") ?? "").toContain("background");
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
        .getByRole("link", { name: "Open Memory" })
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
    expect(screen.getByText("Unlock to view")).toBeTruthy(); // pkm vault-gated
    expect(screen.getByText("2 to review")).toBeTruthy(); // consent attention
    expect(screen.getByText("2 consents pending")).toBeTruthy(); // header badge
    // Gmail is a Memory list row whose description renders inline (no `title`
    // attribute in the 2a card/row markup).
    expect(
      screen.getByText("Receipt sync and purchase-memory review."),
    ).toBeTruthy();
    // All 8 catalog capabilities plus the standalone RIA agent tile render as
    // tappable links (2a redesign uses plain links, not morphy ripple hosts;
    // the grid mirrors the top-bar switcher roster).
    expect(
      container.querySelectorAll('a[aria-label^="Open "]').length,
    ).toBe(9);
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
    expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
  });
});
