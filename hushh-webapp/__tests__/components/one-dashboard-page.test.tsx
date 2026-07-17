import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
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
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the primary One agent modes with route targets", () => {
    const { container } = render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          finance: { state: "not-started", requiresUnlock: true },
          gmail: { state: "blocked", prerequisite: "oauth" },
          email: { state: "completed" },
          location: { state: "completed" },
          ria: { state: "in-progress" },
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
    expect(screen.getByTestId("one-agents-grid")).toHaveAttribute(
      "data-testid",
      "one-agents-grid",
    );
    expect(
      screen.getByTestId("one-agents-grid").querySelector(
        '[data-agent-roster-layout="grouped-icon-grid"]',
      ),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Finish setup");
    expect(
      screen.getByRole("heading", { name: "Agents (7)" }),
    ).toBeTruthy();

    // Every dashboard tile enters the same static setup workspace as the hub.
    // A resolved journey is redirected by that workspace to the normal product
    // destination, so direct product routes never bypass first-run setup.
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
    expect(financeLink.className).not.toContain("translate");
    expect(screen.getByTestId("one-agent-tile-finance").style.width).toBe("");
    expect(screen.getByTestId("one-agent-tile-finance").className).toContain(
      "flex-col",
    );
    expect(screen.getByTestId("one-agent-tile-finance").className).not.toContain(
      "border-[color:var(--app-card-border-standard)]",
    );
    const expectedLauncherIcons = [
      "finance",
      "ria",
      "email",
      "pkm",
      "consent",
      "connected-systems",
      "location",
    ] as const;
    for (const id of expectedLauncherIcons) {
      const icon = screen.getAllByTestId(`one-agent-icon-${id}`)[0];
      expect(icon).toBeTruthy();
      expect(icon.querySelector("svg")).toBeTruthy();
    }
    const riaLink = screen.getByRole("link", { name: "Open RIA" });
    expect(riaLink.getAttribute("href")).toBe(buildOneSetupCapabilityRoute("ria"));
    // Agents model: the route link is a normal app-icon tile, not a large
    // colored workflow card.
    expect(financeLink.className).not.toContain("border-emerald-500");
    expect(financeLink.getAttribute("style") ?? "").not.toContain("background");
    expect(screen.queryByRole("link", { name: "Open Gmail" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open KYC" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_KYC);
    expect(
      screen.getByRole("link", { name: "Open Location" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_LOCATION);
    expect(
      screen
        .getByRole("link", { name: "Open CRM" })
        .getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));

    // Resolver-driven setup labels come from the shared setup copy. A vault
    // prerequisite never turns a setup launcher into a locked control.
    expect(screen.getByText("Set up Finance")).toBeTruthy();
    expect(screen.queryByText("Connect Gmail")).toBeNull();
    expect(screen.getByText("Finish RIA")).toBeTruthy();
    // email + location are real vault-gated workflows (not explore-only), so a
    // completed status reads "Ready", not "Explored".
    expect(screen.getAllByText("Ready")).toHaveLength(2); // email + location completed
    expect(screen.queryByText("Set up vault")).toBeNull();
    // Gmail is intentionally paused in the One surface while its runtime and
    // Profile recovery controls remain available. Five agents are currently
    // setup capabilities; Memory, Consent/Nav, and Marketplace are direct
    // workspaces and never inflate setup progress.
    expect(container.querySelectorAll('a[aria-label^="Open "]').length).toBe(7);
    expect(screen.getByRole("link", { name: "Open Memory" }).getAttribute("href")).toBe(
      ROUTES.PKM,
    );
    expect(screen.getByRole("link", { name: "Open Consent" }).getAttribute("href")).toContain(
      "/consents",
    );
    expect(
      screen.queryByRole("link", { name: "Open Information Marketplace" }),
    ).toBeNull();
    expect(screen.queryByTestId("one-finish-setup")).toBeNull();
    expect(screen.queryByText(/9 agents.*setup steps ready/i)).toBeNull();
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
          ria: { state: "completed" },
          "connected-systems": { state: "completed" },
        })}
      />,
    );

    // The five enabled setup capabilities read Ready when completed.
    expect(screen.getAllByText("Ready")).toHaveLength(5);
    expect(
      screen.getByRole("heading", { name: "Agents (7)" }),
    ).toBeTruthy();
    expect(screen.queryByText("Finish setup")).toBeNull();
  });

  it("renders authored setup actions instead of transient checking states", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    expect(screen.queryAllByText("Checking...")).toHaveLength(0);
    expect(screen.queryByText("Connect Gmail")).toBeNull();
    expect(screen.getByText("Choose location")).toBeTruthy();
  });

  it("switches the complete roster into a compact persisted list", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    fireEvent.click(screen.getByTestId("one-agents-view-list"));

    expect(screen.queryByTestId("one-agents-grid")).toBeNull();
    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(screen.getByTestId("one-agent-list-row-finance")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Finance" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("finance"));
    expect(window.localStorage.getItem("hushh:one-agent-roster-view")).toBe(
      "list",
    );
    expect(screen.getByTestId("one-agents-view-list")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("restores the saved roster view without changing any agent route", async () => {
    window.localStorage.setItem("hushh:one-agent-roster-view", "list");
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    await waitFor(() => {
      expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    });
    expect(
      screen.getByRole("link", { name: "Open CRM" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));
  });
});
