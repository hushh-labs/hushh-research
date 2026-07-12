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

    expect(screen.queryByText("Good to see you, Kushal.")).toBeNull();
    expect(screen.queryByText("One")).toBeNull();
    expect(
      screen.queryByText(
        "Your apps, memory, access, and specialist agents in one place.",
      ),
    ).toBeNull();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-grid").style.display).toBe("grid");
    expect(
      screen.getByTestId("one-agents-grid").style.gridTemplateColumns,
    ).toBe("repeat(3, minmax(0, 1fr))");
    expect(screen.getByTestId("one-agents-grid").style.justifyItems).toBe(
      "center",
    );
    const bodyText = container.textContent ?? "";
    expect(bodyText.indexOf("Finish setup")).toBeGreaterThanOrEqual(0);
    expect(bodyText.indexOf("Agents")).toBeGreaterThan(
      bodyText.indexOf("Finish setup"),
    );
    expect(screen.getByText("Agents")).toBeTruthy();

    // Dashboard tiles tag their destination with `?from=/one` (or `&from=/one`
    // when the href already has a query) so the surface's top-bar back button
    // returns to the dashboard, not Profile. See resolveTopShellBreadcrumb.
    const fromOne = `from=${ROUTES.ONE_HOME}`;
    // The finance tile is publicly named "Finance"; Kai stays internal.
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(`${ROUTES.KAI_HOME}?${fromOne}`);
    expect(financeLink.className).not.toContain("translate");
    expect(
      screen.getByTestId("one-agent-tile-finance").style.width,
    ).toBe("5.75rem");
    // Each tile's icon chip carries its own brand tone (bug fix: the icon
    // component previously ignored the tone prop entirely and rendered every
    // tile with the same neutral chip).
    const financeIcon = financeLink.querySelector("span[aria-hidden]");
    expect(financeIcon?.className).toContain("bg-[#B85CF6]");
    expect(financeIcon?.className).toContain("text-white");
    expect(financeIcon?.className).toContain("dark:text-[#1d1d1f]");
    // The /one grid mirrors the top-bar agent switcher roster: RIA sits
    // directly after Finance as a standalone top-level agent.
    const riaLink = screen.getByRole("link", { name: "Open RIA" });
    expect(riaLink.getAttribute("href")).toBe(`${ROUTES.RIA_HOME}?${fromOne}`);
    // Agents model: the route link is a normal app-icon tile, not a large
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
      screen.getByRole("link", { name: "Open Onepoint" }).getAttribute("href"),
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
    expect(screen.queryByText("2 consents pending")).toBeNull(); // top shield owns count
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("title"),
    ).toBe("Receipt sync and purchase-memory review.");
    // All 8 capabilities plus the standalone RIA agent tile render as
    // tappable launcher links (grid mirrors the top-bar switcher roster).
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
    expect(screen.queryByText("No pending consents")).toBeNull();
    expect(screen.queryByText("Finish setup")).toBeNull();
  });

  it("renders an honest fallback when status is not yet resolved", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    // No fabricated "Ready"/"Setup needed" — everything reads as checking.
    expect(screen.getAllByText("Checking...").length).toBeGreaterThan(0);
  });
});
