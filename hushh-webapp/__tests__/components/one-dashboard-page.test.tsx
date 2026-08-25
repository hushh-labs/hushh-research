import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import {
  CACHE_KEYS,
  CacheService,
} from "@/lib/services/cache-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

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

function openAgentListView() {
  fireEvent.click(screen.getByLabelText("Show agent list view"));
  return screen.getByTestId("one-agents-list");
}

describe("OneDashboardPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    CacheService.getInstance().clear();
  });

  it("keeps unfinished Finance actionable after root onboarding is dismissed", () => {
    const userId = "dashboard-dismissed-user";
    OneSetupCompletionHintService.markResolved(userId); // dismissed

    render(
      <OneDashboardPage
        displayName="Dismissed User"
        userId={userId}
        capabilityStatusById={buildStatusMap({
          finance: { state: "not-started", requiresUnlock: true },
        })}
      />,
    );

    // Root onboarding completion is not Finance completion. The resolver's
    // actionable state must still lead to the bounded Finance setup workspace.
    const financeLink = screen.getByRole("link", { name: /^Open Finance/ });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
  });

  it("renders the primary One agents as a direct premium app-icon launcher", () => {
    const userId = "dashboard-launcher-user";
    CacheService.getInstance().set(
      CACHE_KEYS.KAI_MARKET_HOME_BASELINE(userId, 7),
      {
        movers: {
          gainers: [{ symbol: "RFAI", change_pct: 355.6 }],
        },
      },
    );
    CacheService.getInstance().set(CACHE_KEYS.ONE_LOCATION_STATE(userId), {
      ownerGrants: [{ status: "active" }],
      receivedGrants: [{ status: "approved" }],
    });
    CacheService.getInstance().set(CACHE_KEYS.PKM_METADATA(userId), {
      totalAttributes: 31,
    });

    const { container } = render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        userId={userId}
        capabilityStatusById={buildStatusMap({
          finance: { state: "completed" },
          gmail: { state: "blocked", prerequisite: "oauth" },
          calendar: { state: "blocked", prerequisite: "oauth" },
          email: { state: "completed" },
          location: { state: "completed" },
          ria: { state: "in-progress" },
          "connected-systems": { state: "blocked", prerequisite: "oauth" },
        })}
      />,
    );

    expect(screen.queryByText("Good to see you, Kushal.")).toBeNull();
    expect(screen.queryByText("Your private agent")).toBeNull();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
    expect(container.textContent).not.toContain("Finish setup");

    const heading = screen.getByRole("heading", { name: "Agents (9)" });
    expect(heading.textContent).toBe("Agents (9)");
    expect(heading.querySelector(".sr-only")).toBeNull();

    const expectedOrder = [
      "finance",
      "location",
      "ria",
      "gmail",
      "calendar",
      "email",
      "pkm",
      "consent",
      "connected-systems",
    ] as const;
    const tiles = Array.from(
      container.querySelectorAll('[data-testid^="one-agent-tile-"]'),
    );
    expect(tiles.map((tile) => tile.getAttribute("data-testid"))).toEqual(
      expectedOrder.map((id) => `one-agent-tile-${id}`),
    );

    const grid = container.querySelector(
      '[data-agent-roster-layout="app-icon-launcher-grid"]',
    );
    expect(grid).toBeTruthy();
    expect(grid?.className).toContain("grid-cols-3");
    expect(grid?.className).not.toContain("sm:grid-cols-[repeat(4");
    expect(screen.getByTestId("one-agents-grid").className).not.toContain(
      "bg-white",
    );
    expect(screen.getByTestId("one-agents-grid").className).not.toContain(
      "rounded-[20px]",
    );

    const financeLink = screen.getByRole("link", {
      name: /Open Finance, RFAI up 355\.6 percent/,
    });
    expect(financeLink.getAttribute("href")).toBe(ROUTES.KAI_HOME);
    expect(
      screen.getByRole("link", {
        name: /Open Location, 2 live shares/,
      }).getAttribute("href"),
    ).toBe(ROUTES.ONE_LOCATION);
    expect(
      screen.getByRole("link", { name: /^Open Gmail/ }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("gmail"));
    expect(
      screen.getByRole("link", { name: /^Open Calendar/ }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("calendar"));
    expect(
      screen.getByRole("link", { name: /^Open KYC/ }).getAttribute("href"),
    ).toBe(ROUTES.ONE_KYC);
    expect(
      screen.getByRole("link", { name: /^Open CRM/ }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));
    expect(
      screen.getByRole("link", { name: /^Open Memory/ }).getAttribute("href"),
    ).toBe(ROUTES.PKM);
    expect(
      screen.getByRole("link", { name: /^Open Consent/ }).getAttribute("href"),
    ).toContain(ROUTES.CONSENTS);

    for (const id of expectedOrder) {
      const icon = screen.getAllByTestId(`one-agent-icon-${id}`)[0];
      expect(icon).toBeTruthy();
      expect(icon).toHaveAttribute("data-agent-icon-kind", "lucide");
      expect(icon.className).toContain("h-[68px]");
      expect(icon.className).toContain("w-[68px]");
      expect(icon.className).toContain("rounded-[18px]");
      expect(icon.querySelector("svg")?.className.baseVal).toContain(
        "!text-white",
      );
    }

    expect(screen.getByText("RFAI")).toBeTruthy();
    expect(screen.getByText("+355.6%")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("31")).toBeTruthy();
    expect(screen.getByText("saved")).toBeTruthy();
    expect(screen.queryByText("0 actions")).toBeNull();
    expect(screen.queryByText("0 approvals waiting")).toBeNull();
    expect(screen.queryByText("status not loaded")).toBeNull();
    expect(screen.queryByText("Checking...")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Explore")).toBeNull();
    expect(screen.getAllByTestId("one-agent-notification-badge").length).toBe(
      4,
    );
    expect(screen.getByTestId("one-agent-live-dot")).toBeTruthy();
    expect(container.querySelector(".material-ripple")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open One Agent" })).toBeNull();
  });

  it("defaults first-time visitors to grid and preserves a saved list view", () => {
    const { unmount } = render(
      <OneDashboardPage displayName="Kushal Trivedi" />,
    );

    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.getByLabelText("Show agent grid view")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Show agent list view")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    unmount();
    window.localStorage.setItem("hushh:one-agent-roster-view", "list");

    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(screen.getByTestId("one-agent-list-row-finance")).toBeTruthy();
    expect(screen.getByTestId("one-agents-view-content")).not.toHaveClass(
      "motion-step-enter",
    );

    fireEvent.click(screen.getByLabelText("Show agent grid view"));
    expect(screen.getByTestId("one-agents-view-content")).toHaveClass(
      "motion-step-enter",
    );
    expect(window.localStorage.getItem("hushh:one-agent-roster-view")).toBe(
      "grid",
    );
  });

  it("keeps list view available with the same routes and solid app identity", () => {
    render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          finance: { state: "not-started", requiresUnlock: true },
          ria: { state: "in-progress" },
        })}
      />,
    );

    const list = openAgentListView();
    expect(list).toBeTruthy();

    const financeRow = screen.getByRole("link", { name: /^Open Finance/ });
    expect(financeRow.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
    const financeIcon = screen.getAllByTestId("one-agent-icon-finance")[0];
    expect(financeIcon.className).toContain("h-10");
    expect(financeIcon.className).toContain("w-10");
    expect(financeIcon.querySelector("svg")?.className.baseVal).toContain(
      "!text-white",
    );
    expect(screen.getAllByTestId("one-agent-notification-badge").length).toBe(
      2,
    );
  });

  it("filters by title, description, metric value, and metric label without opening another search", () => {
    const userId = "dashboard-search-user";
    CacheService.getInstance().set(
      CACHE_KEYS.KAI_MARKET_HOME_BASELINE(userId, 7),
      {
        movers: {
          gainers: [{ symbol: "RFAI", change_pct: 12.25 }],
        },
      },
    );
    CacheService.getInstance().set(CACHE_KEYS.ONE_LOCATION_STATE(userId), {
      ownerGrants: [{ status: "active" }],
      receivedGrants: [],
    });

    render(
      <OneDashboardPage displayName="Kushal Trivedi" userId={userId} />,
    );

    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "location" },
    });
    expect(screen.getByTestId("one-agent-tile-location")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-tile-finance")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "receipt" },
    });
    expect(screen.getByTestId("one-agent-tile-gmail")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-tile-location")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "RFAI" },
    });
    expect(screen.getByTestId("one-agent-tile-finance")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-tile-location")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "live" },
    });
    expect(screen.getByTestId("one-agent-tile-location")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-tile-finance")).toBeNull();
  });

  it("shows a quiet empty state for unmatched search", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "not an agent" },
    });

    expect(screen.getByTestId("one-agents-empty-state")).toBeTruthy();
    expect(screen.getByText("No matching agents")).toBeTruthy();
    expect(screen.getByText("Try another search.")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-tile-finance")).toBeNull();
  });

  it("shows the finance mover as a concise green percentage without redundant winner copy", () => {
    render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        userId="roster-finance-metric"
      />,
    );

    expect(screen.queryByText(/winner/i)).toBeNull();
  });
});
