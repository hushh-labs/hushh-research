import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
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

describe("OneDashboardPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
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

    const financeLink = screen.getByRole("link", { name: /Open Finance/i });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
  });

  it("renders the One launcher as a clean app grid with stable route targets", () => {
    const { container } = render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          finance: { state: "not-started", requiresUnlock: true },
          gmail: { state: "blocked", prerequisite: "oauth" },
          calendar: { state: "blocked", prerequisite: "oauth" },
          email: { state: "completed" },
          location: { state: "completed" },
          ria: { state: "in-progress" },
        })}
      />,
    );

    expect(screen.queryByText("Good to see you, Kushal.")).toBeNull();
    expect(screen.queryByText("Your private agent")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Agents/i })).toBeNull();
    expect(screen.getByRole("heading", { name: "One" })).toBeTruthy();
    expect(
      container.querySelector("[data-one-launcher-root='true']"),
    ).toHaveClass("bg-[color:var(--one-launcher-background)]");
    expect(screen.getByTestId("one-launcher-avatar")).toHaveTextContent("K");
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
    expect(screen.queryByTestId("one-agents-search")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More One options" }),
    ).toBeNull();
    expect(screen.getByTestId("one-launcher-avatar-link")).toHaveAttribute(
      "href",
      ROUTES.PROFILE,
    );

    const expectedCanonicalToneIcons = [
      "finance",
      "location",
      "ria",
      "gmail",
      "calendar",
      "email",
      "pkm",
      "consent",
    ] as const;
    for (const id of expectedCanonicalToneIcons) {
      const icon = screen.getByTestId(`one-agent-icon-${id}`);
      expect(icon).toBeTruthy();
      expect(icon).toHaveAttribute("data-agent-icon-kind", "lucide");
      expect(icon).not.toHaveAttribute("data-agent-icon-palette-index");
      expect(icon.querySelector("svg")).toBeTruthy();
    }
    expect(screen.getByTestId("one-agent-icon-location")).toHaveStyle({
      backgroundColor: "var(--app-accent)",
    });

    const grid = screen.getByTestId("one-agents-grid");
    expect(grid).toHaveAttribute("data-agent-roster-layout", "app-icon-grid");
    expect(grid.className).toContain("one-agent-launcher-grid");
    expect(grid.querySelectorAll("li.one-agent-launcher-tile").length).toBe(8);
    expect(container.textContent).not.toContain("actions");
    expect(container.textContent).not.toContain("checking");
    expect(container.textContent).not.toContain("status not loaded");
    expect(container.textContent).not.toContain("winner");
    expect(container.textContent).not.toContain(
      "Connect your everyday systems",
    );

    expect(
      screen.getByRole("link", { name: /Open Finance/i }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("finance"));
    expect(
      screen.getByRole("link", { name: /Open Gmail/i }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("gmail"));
    expect(
      screen.getByRole("link", { name: /Open Calendar/i }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("calendar"));
    expect(
      screen.getByRole("link", { name: /Open KYC/i }).getAttribute("href"),
    ).toBe(ROUTES.ONE_KYC);
    expect(
      screen.getByRole("link", { name: /Open Location/i }).getAttribute("href"),
    ).toBe(ROUTES.ONE_LOCATION);
    expect(
      screen.getByRole("link", { name: /Open Memory/i }).getAttribute("href"),
    ).toBe(ROUTES.PKM);
    expect(
      screen.getByRole("link", { name: /Open Consent/i }).getAttribute("href"),
    ).toContain(ROUTES.CONSENTS);
    expect(screen.queryByRole("link", { name: /Open CRM/i })).toBeNull();
    expect(screen.queryByTestId("one-agent-icon-connected-systems")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Open Information Marketplace/i }),
    ).toBeNull();
    expect(
      container.querySelectorAll(
        'a[aria-label^="Open "]:not([href="/one/profile"])',
      ).length,
    ).toBe(8);
  });

  it("uses only actionable and live indicators instead of visible KPI captions", () => {
    render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        capabilityStatusById={buildStatusMap({
          consent: { state: "needs-attention", pendingCount: 102 },
          ria: { state: "in-progress" },
          finance: { state: "completed" },
        })}
      />,
    );

    expect(screen.getByText("99+")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-indicator-setup")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Explore")).toBeNull();
    expect(screen.queryByText("Set up")).toBeNull();
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("ignores stale root list preferences and always renders the launcher grid", () => {
    window.localStorage.setItem("hushh:one-agent-roster-view", "list");
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
    expect(screen.queryByTestId("one-agents-view-content")).toBeNull();
  });

  it("removes root-local discovery controls", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    expect(screen.queryByTestId("one-agents-search")).toBeNull();
    expect(screen.queryByTestId("one-agents-search-shell")).toBeNull();
    expect(screen.queryByTestId("one-agents-more")).toBeNull();
    expect(screen.queryByText("Search agents")).toBeNull();
    expect(screen.queryByText(/Show as/i)).toBeNull();
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
  });
});
