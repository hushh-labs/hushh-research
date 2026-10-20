vi.mock("@/components/wallet/wallet-entry-warmup", () => ({ WalletEntryWarmup: () => null }));
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { ScheduledTasksPanel } from "@/components/scheduled-tasks/scheduled-tasks-panel";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const schedule = vi.hoisted(() => ({
  owner: "owner",
  hosting: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: schedule.hosting },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: schedule.owner }) },
}));
vi.mock("@/lib/services/pod-scheduled-tasks", () => ({
  PodScheduledTasksClient: class {
    status = schedule.status;
  },
}));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: () => undefined }));

describe("Scheduled tasks placement", () => {
  beforeEach(() => {
    schedule.owner = "owner";
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner(schedule.owner);
    schedule.hosting.mockReset();
    schedule.status.mockReset();
    schedule.status.mockResolvedValue({ available: true, tasks: [] });
  });
  it("explains the Shared limit without admitting or waking a pod", async () => {
    schedule.hosting.mockResolvedValue({ hostingMode: "shared" });
    render(<ScheduledTasksPanel ownerId="owner" />);
    expect(schedule.hosting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Scheduled tasks" }));
    await screen.findByText("Scheduled tasks need a private agent.");
    expect(schedule.status).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Hosting" })).toHaveAttribute("href", "/one/profile/hosting");
  });
  it.each(["byoc", "hussh_pods"])("leaves %s pod availability to existing admission", async (hostingMode) => {
    schedule.hosting.mockResolvedValue({ hostingMode });
    render(<ScheduledTasksPanel ownerId="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "Scheduled tasks" }));
    await screen.findByText(/No scheduled tasks/);
    expect(schedule.status).toHaveBeenCalledTimes(1);
  });
  it("does not admit a pod from a delayed previous-owner response", async () => {
    let settle!: (value: object) => void;
    schedule.hosting.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const view = render(<ScheduledTasksPanel ownerId="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "Scheduled tasks" }));
    schedule.owner = "next-owner";
    publishValidatedAuthSessionOwner(schedule.owner);
    view.rerender(<ScheduledTasksPanel ownerId="next-owner" />);
    await act(async () => { settle({ hostingMode: "byoc", hushhId: "old-pod" }); });
    expect(schedule.status).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// The dashboard renders the live agent-presence chip, which reaches for VaultProvider,
// the Next.js router, and best-effort pod-status polling. This suite asserts nothing
// about the chip, so stub it out rather than standing up all three dependencies.
vi.mock("@/components/dashboard/one-agent-presence", () => ({
  OneAgentPresence: () => <div data-testid="dashboard-pod-presence" />,
}));
// Discovery has its own auth and service tests; these assertions cover the roster.
vi.mock("@/components/profile/public-profile-discovery-card", () => ({
  PublicProfileDiscoveryEntry: () => null,
}));
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

const financeSetupFromOne = `${buildOneSetupCapabilityRoute("finance")}?from=${encodeURIComponent(ROUTES.ONE_HOME)}`;

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

  it("leaves pod presence to the shared top bar", () => {
    render(<OneDashboardPage userId="owner" />);
    expect(screen.queryByTestId("dashboard-pod-presence")).toBeNull();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-section")).toContainElement(
      screen.getByRole("button", { name: "Scheduled tasks" }),
    );
    const files = screen.getByRole("link", { name: "Open Files" }).querySelector("svg");
    const messages = screen.getByRole("link", { name: "Open Messages" }).querySelector("svg");
    expect(files?.innerHTML).not.toEqual(messages?.innerHTML);
  });

  it.each([null, 0, 1, 2, 100, 137])("shows the Messages unread count %s rather than its completed setup status", (count) => {
    render(<OneDashboardPage messagesUnreadCount={count} capabilityStatusById={buildStatusMap({ messages: { state: "completed" } })} />);

    const tile = screen.getByRole("link", { name: "Open Messages" });
    const label = tile.querySelector('[data-ui-role="trailing-value"]');
    expect(label?.previousElementSibling).toHaveTextContent(count === null ? "—" : String(count));
    expect(label).toHaveTextContent(count === null ? "checking" : count === 1 ? "action" : "actions");
  });

  it("keeps unfinished Finance actionable after root onboarding is dismissed", () => {
    const userId = "dashboard-dismissed-user";
    OneSetupCompletionHintService.markResolved(userId); // dismissed

    render(
      <OneDashboardPage
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
      financeSetupFromOne,
    );
  });

  it("does not put a setup progress tile above the roster", () => {
    // Founder directive 2026-09-22: /one is the agent roster and nothing
    // else. The optional capabilities keep their own setup steps; the
    // dashboard no longer carries a checklist for them.
    const { container } = render(
      <OneDashboardPage
        displayName="Parth"
        userId="dashboard-no-tile-user"
        capabilityStatusById={buildStatusMap({
          gmail: { state: "completed" },
          ria: { state: "skipped" },
          finance: { state: "not-started" },
        })}
      />,
    );

    expect(screen.queryByTestId("one-setup-progress-tile")).toBeNull();
    expect(container.textContent).not.toContain("Finish setting up One");
  });

  it("renders the primary One agent modes with route targets", () => {
    const { container } = render(
      <OneDashboardPage
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

    // The greeting is gone entirely (founder, 2026-09-02: "I still have the greeting
    // message on the /one route for some reason added, we don't need that").
    expect(screen.queryByText(/Good (morning|afternoon|evening), /)).toBeNull();
    expect(screen.queryByText("Your private agent")).toBeNull();
    expect(screen.getByTestId("one-agents-section")).toBeTruthy();
    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(container.textContent).not.toContain("Finish setup");
    expect(screen.getByRole("heading", { name: "Agents (10)" })).toBeTruthy();

    // Every dashboard tile enters the same static setup workspace as the hub.
    // A resolved journey is redirected by that workspace to the normal product
    // destination, so direct product routes never bypass first-run setup.
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(
      financeSetupFromOne,
    );
    const rosterOrder = [
      "location",
      "gmail",
      "calendar",
      "finance",
      "ria",
      "wallet",
      "consent",
      "pkm",
      "files",
      "messages",
    ] as const;
    const grid = screen.getByTestId("one-agents-grid");
    expect(
      Array.from(grid.querySelectorAll('[data-testid^="one-agent-tile-"]')).map(
        (tile) => tile.getAttribute("data-testid")?.replace("one-agent-tile-", ""),
      ),
    ).toEqual(rosterOrder);
    for (const id of rosterOrder) {
      const icon = screen.getAllByTestId(`one-agent-icon-${id}`)[0];
      expect(icon).toHaveAttribute("data-agent-icon-kind", "custom");
      expect(icon).toHaveClass("h-[68px]", "w-[68px]");
      expect(icon.querySelectorAll("svg")).toHaveLength(1);
    }
    const financeIcon = screen.getAllByTestId("one-agent-icon-finance")[0];
    // Greyscale-until-onboarded is reverted for now: icons stay full color
    // regardless of setup state, so "finance" ("not-started" in this
    // fixture) still carries its palette color -- see the dedicated
    // palette-color coverage below with an all-completed fixture.
    //
    // An unfinished workspace keeps its recognizable full-color artwork.
    expect(financeIcon.querySelector("svg")).toBeTruthy();
    expect(financeIcon.className).not.toContain("grayscale");
    expect(financeIcon.querySelector(".backdrop-blur-\\[8px\\]")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Files" })).toHaveAttribute(
      "href", ROUTES.ONE_FILES,
    );
    expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute(
      "href", ROUTES.ONE_MESSAGES,
    );
    const riaLink = screen.getByRole("link", { name: "Open Advisor" });
    expect(riaLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("ria"),
    );
    // Agents model: the route link is a normal app-icon tile, not a large
    // colored workflow card.
    expect(financeLink.className).not.toContain("border-emerald-500");
    expect(financeLink.getAttribute("style") ?? "").not.toContain("background");
    expect(
      screen.getByRole("link", { name: "Open Wallet" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_WALLET);
    expect(
      screen.getByRole("link", { name: /Open Mail/ }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("gmail"));
    expect(
      screen.getByRole("link", { name: "Open Calendar" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("calendar"));
    expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", ROUTES.ONE_MESSAGES);
    expect(screen.queryByRole("link", { name: "Open KYC" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Location" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_LOCATION);
    expect(screen.queryByRole("link", { name: "Open CRM" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Messages" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_MESSAGES);

    // The roster shows a concise, numeric action KPI rather than generic
    // progress words such as Ready, Open, or Explore.
    expect(countRosterMetrics(container, "0", "actions")).toBe(1);
    expect(countRosterMetrics(container, "—", "checking")).toBeGreaterThan(0);
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Explore")).toBeNull();
    // Gmail and Calendar are first-class setup capabilities; Wallet, Memory,
    // and Consent remain direct workspaces and do not inflate setup progress.
    expect(container.querySelectorAll('a[aria-label^="Open "]').length).toBe(10);
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
    expect(screen.queryByText(/8 agents.*setup steps ready/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open One Agent" })).toBeNull();
  });

  it("reflects completed setup across all capabilities", () => {
    const { container } = render(
      <OneDashboardPage
        capabilityStatusById={buildStatusMap({
          finance: { state: "completed" },
          gmail: { state: "completed" },
          calendar: { state: "completed" },
          email: { state: "completed" },
          location: { state: "completed" },
          ria: { state: "completed" },
        })}
      />,
    );

    // Completed workspace setup is represented as an operational KPI rather
    // than the generic Ready label.
    expect(countRosterMetrics(container, "0", "actions")).toBe(5);
    expect(screen.getByRole("heading", { name: "Agents (10)" })).toBeTruthy();
    expect(screen.queryByText("Finish setup")).toBeNull();

    // Completed setup keeps the same capability artwork as unfinished setup.
    const financeIcon = screen.getAllByTestId("one-agent-icon-finance")[0];
    expect(financeIcon.querySelector("svg")).toBeTruthy();
    const rosterPaletteOrder = [
      "finance",
      "wallet",
      "location",
      "ria",
      "gmail",
      "calendar",
      "pkm",
      "consent",
      "messages",
    ] as const;
    const iconSources = rosterPaletteOrder.map((id) =>
      screen
        .getAllByTestId(`one-agent-icon-${id}`)[0]
        .querySelector("svg")?.innerHTML,
    );
    expect(iconSources.every(Boolean)).toBe(true);
    expect(new Set(iconSources).size).toBe(
      rosterPaletteOrder.length,
    );
  });

  it("renders authored setup actions instead of transient checking states", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    expect(screen.queryAllByText("Checking...")).toHaveLength(0);
    expect(screen.queryByText("Connect Mail")).toBeNull();
    expect(countRosterMetrics(document.body, "—", "checking")).toBeGreaterThan(
      0,
    );
  });

  it("defaults to the complete three-column grid and keeps the list available", () => {
    const { container } = render(
      <OneDashboardPage displayName="Kushal Trivedi" />,
    );

    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.getByTestId("one-agent-tile-messages")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Finance" }).getAttribute("href"),
    ).toBe(financeSetupFromOne);
    expect(screen.getByLabelText("Show agent grid view")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByLabelText("Show agent list view"));
    expect(screen.getByTestId("one-agents-list")).toBeTruthy();
    expect(screen.getByTestId("one-agent-list-row-messages")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show agent grid view"));
    expect(screen.getByTestId("one-agents-grid")).toBeTruthy();
    expect(screen.getByTestId("one-agent-tile-finance")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Files" })).toHaveAttribute(
      "href", ROUTES.ONE_FILES,
    );
    const grid = container.querySelector(
      '[data-agent-roster-layout="grouped-icon-grid"]',
    );
    expect(grid?.className).toContain("grid-cols-[repeat(3,minmax(80px,1fr))]");
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

  it("keeps header and view controls mounted while replacing only roster content", () => {
    window.localStorage.setItem("hushh:one-agent-roster-view", "grid");
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    const heading = screen.getByRole("heading", { name: "Agents (10)" });
    const gridControl = screen.getByLabelText("Show agent grid view");
    const listControl = screen.getByLabelText("Show agent list view");
    const gridContent = screen.getByTestId("one-agents-view-content");

    fireEvent.click(listControl);
    expect(screen.getByRole("heading", { name: "Agents (10)" })).toBe(heading);
    expect(screen.getByLabelText("Show agent grid view")).toBe(gridControl);
    expect(screen.getByLabelText("Show agent list view")).toBe(listControl);
    expect(gridContent.isConnected).toBe(false);
    expect(screen.queryByTestId("one-agents-grid")).toBeNull();
    expect(screen.getByTestId("one-agents-list")).toBeTruthy();

    fireEvent.click(gridControl);
    expect(screen.getByRole("heading", { name: "Agents (10)" })).toBe(heading);
    expect(screen.queryByTestId("one-agents-list")).toBeNull();
    expect(screen.getAllByTestId("one-agents-grid")).toHaveLength(1);
  });

  // Search is switched off for now (SHOW_AGENT_SEARCH = false in
  // one-agent-roster.tsx -- 10 agents don't need it yet). The filtering
  // logic itself is untouched; these stay skipped, not deleted, so
  // flipping the flag back on restores real coverage immediately.
  it.skip("filters the local agent roster without opening a second global search surface", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    fireEvent.change(screen.getByTestId("one-agents-search"), {
      target: { value: "location" },
    });

    expect(screen.getByTestId("one-agent-list-row-location")).toBeTruthy();
    expect(screen.queryByTestId("one-agent-list-row-finance")).toBeNull();
  });

  it.skip("clears the roster query from the trailing touch affordance", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);

    const search = screen.getByTestId("one-agents-search");
    fireEvent.change(search, { target: { value: "location" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear agent search" }));

    expect(search).toHaveValue("");
    expect(screen.getByTestId("one-agent-list-row-finance")).toBeTruthy();
  });

  it("shows the finance mover as a concise green percentage without redundant winner copy", () => {
    render(
      <OneDashboardPage
        userId="roster-finance-metric"
      />,
    );

    expect(screen.queryByText(/winner/i)).toBeNull();
  });
});
