import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
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

const expectedOrder = [
  "location",
  "email",
  "finance",
  "ria",
  "gmail",
  "calendar",
  "pkm",
  "consent",
  "connected-systems",
] as const;

const expectedLabels = [
  "Location",
  "KYC",
  "Finance",
  "RIA",
  "Gmail",
  "Calendar",
  "Memory",
  "Consent",
  "CRM",
] as const;

describe("OneDashboardPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    CacheService.getInstance().clear();
  });

  it("keeps unfinished Finance actionable after root onboarding is dismissed", () => {
    const userId = "dashboard-dismissed-user";
    OneSetupCompletionHintService.markResolved(userId);

    render(
      <OneDashboardPage
        displayName="Dismissed User"
        userId={userId}
        capabilityStatusById={buildStatusMap({
          finance: { state: "not-started", requiresUnlock: true },
        })}
      />,
    );

    const financeLink = screen.getByRole("link", {
      name: "Finance, setup required",
    });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
  });

  it("renders a direct 3 by 3 app-icon launcher instead of the old agent directory", () => {
    const userId = "dashboard-launcher-user";
    CacheService.getInstance().set(CACHE_KEYS.ONE_LOCATION_STATE(userId), {
      ownerGrants: [{ status: "active" }],
      receivedGrants: [{ status: "approved" }],
    });
    CacheService.getInstance().set(
      CACHE_KEYS.PENDING_CONSENTS(userId),
      [{ id: "pending-1" }, { id: "pending-2" }],
    );

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
          ria: { state: "completed" },
          "connected-systems": { state: "blocked", prerequisite: "oauth" },
        })}
      />,
    );

    expect(screen.getByRole("heading", { name: "One", hidden: true })).toBeTruthy();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.queryByText(/Agents \(\d+\)/)).toBeNull();
    expect(screen.queryByRole("searchbox", { name: /search agents/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agent launcher options" })).toBeNull();
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
    expect(screen.queryByTestId("one-agents-search")).toBeNull();
    expect(container.textContent).not.toMatch(
      /action due|approvals waiting|requests to review|saved details|live shares|connected systems|Finish setup|View as list|View as grid/i,
    );

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

    const gridScope = within(screen.getByTestId("one-agents-grid"));
    for (const label of expectedLabels) {
      expect(gridScope.getByText(label)).toBeTruthy();
    }

    expect(screen.getAllByTestId("one-agent-notification-badge")).toHaveLength(2);
    expect(screen.getByTestId("one-agent-live-dot")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-live-label")).toBeNull();
    expect(screen.queryByTestId("one-agents-empty-state")).toBeNull();
  });

  it("preserves tile destinations and setup routing", () => {
    render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          email: { state: "completed" },
          finance: { state: "not-started", requiresUnlock: true },
          gmail: { state: "blocked", prerequisite: "oauth" },
          calendar: { state: "blocked", prerequisite: "oauth" },
          location: { state: "completed" },
          "connected-systems": { state: "blocked", prerequisite: "oauth" },
        })}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Location" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_LOCATION);
    expect(
      screen.getByRole("link", { name: "KYC" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_KYC);
    expect(
      screen
        .getByRole("link", { name: "Finance, setup required" })
        .getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("finance"));
    expect(
      screen
        .getByRole("link", { name: "Gmail, setup required" })
        .getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("gmail"));
    expect(
      screen
        .getByRole("link", { name: "Calendar, setup required" })
        .getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("calendar"));
    expect(
      screen
        .getByRole("link", { name: "CRM, setup required" })
        .getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));
    expect(
      screen.getByRole("link", { name: "Memory" }).getAttribute("href"),
    ).toBe(ROUTES.PKM);
    expect(
      screen.getByRole("link", { name: "Consent" }).getAttribute("href"),
    ).toContain(ROUTES.CONSENTS);
  });

  it("ignores the removed saved list-view preference", () => {
    window.localStorage.setItem("hushh:one-agent-roster-view", "list");

    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
    expect(screen.queryByTestId("one-agents-view-content")).toBeNull();
  });

  it("renders only meaningful adornments and caps action counts", () => {
    const { rerender } = render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          calendar: { state: "in-progress", pendingCount: 112 },
        })}
      />,
    );

    expect(screen.getByText("99+")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Calendar, 99+ reviews" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();

    rerender(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          calendar: { state: "completed", pendingCount: 0 },
        })}
      />,
    );

    expect(screen.queryByTestId("one-agent-notification-badge")).toBeNull();
    expect(screen.queryByTestId("one-agent-setup-badge")).toBeNull();
  });
});
