import { fireEvent, render, screen } from "@testing-library/react";
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

function countRosterMetrics(
  container: HTMLElement,
  value: string,
  label: string,
): number {
  return Array.from(
    container.querySelectorAll('span[data-ui-role="body-strong"]'),
  ).filter(
    (node) =>
      node.textContent === value &&
      node.nextElementSibling?.textContent === label,
  ).length;
}

describe("OneDashboardPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("routes home tiles to the product surface once onboarding is dismissed", () => {
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

    // Profile-only: a not-configured tile opens the capability's own screen,
    // never /one/setup/* (which the guard would eject a dismissed user from).
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    const href = financeLink.getAttribute("href") ?? "";
    expect(href).not.toBe(buildOneSetupCapabilityRoute("finance"));
    expect(href.startsWith("/one/setup")).toBe(false);
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
    expect(screen.queryByText("Your private agent")).toBeNull();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(container.textContent).not.toContain("Finish setup");
    expect(screen.getByRole("heading", { name: "Agents (7)" })).toBeTruthy();

    // Every dashboard tile enters the same static setup workspace as the hub.
    // A resolved journey is redirected by that workspace to the normal product
    // destination, so direct product routes never bypass first-run setup.
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
    const expectedProfileFormatIcons = [
      "finance",
      "ria",
      "email",
      "pkm",
      "consent",
      "connected-systems",
      "location",
    ] as const;
    for (const id of expectedProfileFormatIcons) {
      const icon = screen.getAllByTestId(`one-agent-icon-${id}`)[0];
      expect(icon).toBeTruthy();
      expect(icon).toHaveAttribute("data-agent-icon-kind", "lucide");
      expect(icon.querySelector("svg")).toBeTruthy();
    }
    const financeIcon = screen.getAllByTestId("one-agent-icon-finance")[0];
    expect(financeIcon).toHaveStyle({
      "--agent-icon-profile-bg": "#F4D9FF",
      "--agent-icon-profile-fg": "#7A1FA2",
    });
    const rosterPaletteOrder = [
      "finance",
      "ria",
      "email",
      "location",
      "pkm",
      "consent",
      "connected-systems",
    ] as const;
    const rosterPaletteSlots = rosterPaletteOrder.map((id) =>
      screen
        .getAllByTestId(`one-agent-icon-${id}`)[0]
        .getAttribute("data-agent-icon-palette-index"),
    );
    expect(rosterPaletteSlots).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(
      new Set(
        rosterPaletteOrder.map((id) =>
          screen
            .getAllByTestId(`one-agent-icon-${id}`)[0]
            .style.getPropertyValue("--agent-icon-profile-bg"),
        ),
      ).size,
    ).toBe(rosterPaletteOrder.length);
    expect(financeIcon.className).toContain(
      "dark:bg-[var(--agent-icon-profile-bg-dark)]",
    );
    expect(financeIcon.querySelector("svg")?.className.baseVal).toContain(
      "text-current",
    );
    expect(financeIcon.querySelector("svg")?.className.baseVal).not.toContain(
      "dark:!text-[#1d1d1f]",
    );
    expect(financeIcon.querySelector(".backdrop-blur-\\[8px\\]")).toBeNull();
    const riaLink = screen.getByRole("link", { name: "Open RIA" });
    expect(riaLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("ria"),
    );
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
      screen.getByRole("link", { name: "Open CRM" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));

    // The roster shows a concise, numeric action KPI rather than generic
    // progress words such as Ready, Open, or Explore.
    expect(countRosterMetrics(container, "0", "actions due")).toBe(2);
    expect(
      countRosterMetrics(container, "—", "checking requests"),
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Explore")).toBeNull();
    // Gmail is intentionally paused in the One surface while its runtime and
    // Profile recovery controls remain available. Five agents are currently
    // setup capabilities; Memory, Consent/Nav, and Marketplace are direct
    // workspaces and never inflate setup progress.
    expect(container.querySelectorAll('a[aria-label^="Open "]').length).toBe(7);
    expect(
      screen.getByRole("link", { name: "Open Memory" }).getAttribute("href"),
    ).toBe(ROUTES.PKM);
    expect(
      screen.getByRole("link", { name: "Open Consent" }).getAttribute("href"),
    ).toContain(ROUTES.CONSENTS);
    expect(
      screen.queryByRole("link", { name: "Open Information Marketplace" }),
    ).toBeNull();
    expect(screen.queryByTestId("one-finish-setup")).toBeNull();
    expect(screen.queryByText(/9 agents.*setup steps ready/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open One Agent" })).toBeNull();
  });

  it("reflects completed setup across all capabilities", () => {
    const { container } = render(
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

    // Completed workspace setup is represented as an operational KPI rather
    // than the generic Ready label.
    expect(countRosterMetrics(container, "0", "actions due")).toBe(5);
    expect(screen.getByRole("heading", { name: "Agents (7)" })).toBeTruthy();
    expect(screen.queryByText("Finish setup")).toBeNull();
  });

  it("renders authored setup actions instead of transient checking states", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    expect(screen.queryAllByText("Checking...")).toHaveLength(0);
    expect(screen.queryByText("Connect Gmail")).toBeNull();
    expect(
      countRosterMetrics(document.body, "—", "checking requests"),
    ).toBeGreaterThan(0);
  });

  it("renders the complete roster as a list first and keeps the grid available", () => {
    const { container } = render(
      <OneDashboardPage displayName="Kushal Trivedi" />,
    );

    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(screen.getByTestId("one-agent-list-row-finance")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Finance" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("finance"));
    expect(screen.getByLabelText("Show agent grid view")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByLabelText("Show agent grid view"));
    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.getByTestId("one-agent-tile-finance")).toBeTruthy();
    const grid = container.querySelector(
      '[data-agent-roster-layout="grouped-icon-grid"]',
    );
    expect(grid?.className).toContain("grid-cols-3");
    expect(grid?.className).toContain("sm:grid-cols-4");
  });

  it("restores a saved list view without replaying a view-change animation", () => {
    window.localStorage.setItem("hushh:one-agent-roster-view", "list");
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(screen.getByTestId("one-agents-view-content")).not.toHaveClass(
      "motion-step-enter",
    );

    fireEvent.click(screen.getByLabelText("Show agent grid view"));
    expect(screen.getByTestId("one-agents-view-content")).toHaveClass(
      "motion-step-enter",
    );
  });

  it("filters the local agent roster without opening a second global search surface", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "location" },
    });

    expect(screen.getByTestId("one-agent-list-row-location")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-list-row-finance")).toBeNull();
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
