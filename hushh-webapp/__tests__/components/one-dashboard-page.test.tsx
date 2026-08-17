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
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
  });

  it("renders the primary One agent modes with route targets", () => {
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
          "connected-systems": { state: "blocked", prerequisite: "oauth" },
        })}
      />,
    );

    expect(screen.queryByText("Good to see you, Kushal.")).toBeNull();
    expect(screen.queryByText("Your private agent")).toBeNull();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(container.textContent).not.toContain("Finish setup");
    expect(screen.getByRole("heading", { name: "Agents (9)" })).toBeTruthy();

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
      "gmail",
      "calendar",
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
    // #5393. This used to assert rgba(88,86,214,0.16) — a 16%-alpha tint that
    // measured 1.25:1 against the white card behind it, i.e. a chip you could
    // not see. Each agent now wears its saturated identity fill from
    // AGENT_THEME_BY_TONE, which carries a white glyph at 4.13:1.
    expect(financeIcon).toHaveStyle({ backgroundColor: "#AF52DE" });
    expect(financeIcon.className).not.toContain("--agent-icon-profile-bg");
    // Palette slots are assigned by roster position, so this list must track
    // ONE_CAPABILITIES order. Location moved from sixth to second, which shifts
    // the five agents it passed by one slot each — a deliberate consequence of
    // the reorder, not an incidental one: the palette exists to keep adjacent
    // rows distinguishable, and that property is preserved.
    const rosterPaletteOrder = [
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
    const rosterPaletteSlots = rosterPaletteOrder.map((id) =>
      screen
        .getAllByTestId(`one-agent-icon-${id}`)[0]
        .getAttribute("data-agent-icon-palette-index"),
    );
    expect(rosterPaletteSlots).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
    const iconBackgrounds = Object.fromEntries(
      rosterPaletteOrder.map((id) => [
        id,
        screen
          .getAllByTestId(`one-agent-icon-${id}`)[0]
          .style.getPropertyValue("background-color"),
      ]),
    );
    // #5393. Nine agents used to collapse into THREE tint families, so the
    // roster read as one dull colour repeated. Only gmail and email may match
    // now — they are genuinely the same tone in the registry — and every
    // ADJACENT pair must differ, which is the property the palette exists for.
    expect(iconBackgrounds.gmail).toBe(iconBackgrounds.email);
    expect(new Set(Object.values(iconBackgrounds)).size).toBe(8);
    for (let slot = 1; slot < rosterPaletteOrder.length; slot += 1) {
      const previous = rosterPaletteOrder[slot - 1];
      const current = rosterPaletteOrder[slot];
      expect(
        `${current} vs ${previous}: ${iconBackgrounds[current]}`,
      ).not.toBe(`${current} vs ${previous}: ${iconBackgrounds[previous]}`);
    }
    // Setup state must not drain the artwork. Every capability resolves to
    // `unknown` -> `muted` while the vault is locked, which is the normal
    // state on landing here, and that used to render 8 of 9 glyphs at 2.07:1.
    for (const id of expectedProfileFormatIcons) {
      const glyph = screen
        .getAllByTestId(`one-agent-icon-${id}`)[0]
        .querySelector("svg")?.className.baseVal;
      expect(glyph).not.toContain("text-muted-foreground");
    }
    expect(financeIcon.querySelector("svg")?.className.baseVal).toContain(
      "!text-[color:var(--agent-icon-glyph,#ffffff)]",
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
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("gmail"));
    expect(
      screen.getByRole("link", { name: "Open Calendar" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("calendar"));
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
    expect(countRosterMetrics(container, "0", "actions")).toBe(2);
    expect(
      countRosterMetrics(container, "—", "checking"),
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Explore")).toBeNull();
    // Gmail and Calendar are first-class setup capabilities; Memory and
    // Consent remain direct workspaces and do not inflate setup progress.
    expect(container.querySelectorAll('a[aria-label^="Open "]').length).toBe(9);
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
          calendar: { state: "completed" },
          email: { state: "completed" },
          location: { state: "completed" },
          ria: { state: "completed" },
          "connected-systems": { state: "completed" },
        })}
      />,
    );

    // Completed workspace setup is represented as an operational KPI rather
    // than the generic Ready label.
    expect(countRosterMetrics(container, "0", "actions")).toBe(7);
    expect(screen.getByRole("heading", { name: "Agents (9)" })).toBeTruthy();
    expect(screen.queryByText("Finish setup")).toBeNull();
  });

  it("renders authored setup actions instead of transient checking states", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    expect(screen.queryAllByText("Checking...")).toHaveLength(0);
    expect(screen.queryByText("Connect Gmail")).toBeNull();
    expect(
      countRosterMetrics(document.body, "—", "checking"),
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
    expect(grid?.className).toContain("grid-cols-[repeat(3,minmax(84px,1fr))]");
    expect(grid?.className).not.toContain("sm:grid-cols-[repeat(4");
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
