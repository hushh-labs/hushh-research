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
      "data-agent-roster-layout",
      "3-to-9",
    );
    const bodyText = container.textContent ?? "";
    expect(bodyText.indexOf("Finish setup")).toBeGreaterThanOrEqual(0);
    expect(bodyText.indexOf("Agents")).toBeGreaterThan(
      bodyText.indexOf("Finish setup"),
    );
    expect(
      screen.getByRole("heading", { name: "Agents (9)" }),
    ).toBeTruthy();

    // Every dashboard tile enters the same static setup workspace as the hub.
    // A resolved journey is redirected by that workspace to the normal product
    // destination, so direct product routes never bypass first-run setup.
    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(
      buildOneSetupCapabilityRoute("finance"),
    );
    expect(financeLink.className).not.toContain("translate");
    expect(screen.getByTestId("one-agent-tile-finance").style.width).toBe(
      "5.75rem",
    );
    // The compact grid uses 3×3; wide screens place all nine fixed-width cells
    // in one row. Every tile fixes its icon and copy tracks so the icon wells
    // share the same centerline at either density.
    expect(screen.getByTestId("one-agent-tile-finance").className).toContain(
      "grid-rows-[4rem_2.5rem]",
    );
    expect(screen.getByTestId("one-agent-tile-finance").className).toContain(
      "justify-items-center",
    );
    // Each tile's icon chip carries its own brand tone (bug fix: the icon
    // component previously ignored the tone prop entirely and rendered every
    // tile with the same neutral chip).
    const financeIcon = financeLink.querySelector("span[aria-hidden]");
    expect(financeIcon?.className).toContain("justify-self-center");
    expect(financeIcon?.className).toContain("bg-[#B85CF6]");
    const financeGlyph = financeIcon?.querySelector("svg");
    expect(financeGlyph?.className.baseVal).toContain("!text-[#1d1d1f]");
    expect(financeGlyph?.className.baseVal).toContain("dark:!text-white");
    expect(financeIcon?.className).toContain("text-[#1d1d1f]");
    expect(financeIcon?.className).toContain("dark:text-white");
    expect(financeLink.querySelector("[class*='bg-[#34c759]']")).toBeNull();
    const riaLink = screen.getByRole("link", { name: "Open RIA" });
    expect(riaLink.getAttribute("href")).toBe(buildOneSetupCapabilityRoute("ria"));
    // Agents model: the route link is a normal app-icon tile, not a large
    // colored workflow card.
    expect(financeLink.className).not.toContain("border-emerald-500");
    expect(financeLink.getAttribute("style") ?? "").not.toContain("background");
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("gmail"));
    expect(
      screen.getByRole("link", { name: "Open Email" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("email"));
    expect(
      screen.getByRole("link", { name: "Open Onepoint" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("location"));
    expect(
      screen
        .getByRole("link", { name: "Open Connected Systems" })
        .getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));

    // Resolver-driven setup labels come from the shared setup copy. A vault
    // prerequisite never turns a setup launcher into a locked control.
    expect(screen.getByText("Set up Finance")).toBeTruthy();
    expect(screen.getByText("Connect Gmail")).toBeTruthy();
    expect(screen.getByText("Finish RIA")).toBeTruthy();
    // email + location are real vault-gated workflows (not explore-only), so a
    // completed status reads "Ready", not "Explored".
    expect(screen.getAllByText("Ready")).toHaveLength(2); // email + location completed
    expect(screen.queryByText("Set up vault")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("title"),
    ).toBe("Receipt sync and purchase-memory review.");
    // The dashboard is the complete user-facing roster. Only six agents are
    // setup capabilities; Memory, Consent/Nav, and Marketplace are direct
    // workspaces and never inflate setup progress.
    expect(container.querySelectorAll('a[aria-label^="Open "]').length).toBe(9);
    expect(screen.getByRole("link", { name: "Open Memory" }).getAttribute("href")).toBe(
      ROUTES.PKM,
    );
    expect(screen.getByRole("link", { name: "Open Consent" }).getAttribute("href")).toContain(
      "/consents",
    );
    expect(
      screen
        .getByRole("link", { name: "Open Information Marketplace" })
        .getAttribute("href"),
    ).toBe(ROUTES.ONE_MARKETPLACE);
    expect(screen.getByTestId("one-finish-setup")).toHaveTextContent(
      "2 of 6 setup steps ready",
    );
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

    // The exact six setup capabilities read Ready when completed.
    expect(screen.getAllByText("Ready")).toHaveLength(6);
    expect(
      screen.getByRole("heading", { name: "Agents (9)" }),
    ).toBeTruthy();
    expect(screen.queryByText("Finish setup")).toBeNull();
  });

  it("renders authored setup actions instead of transient checking states", () => {
    render(<OneDashboardPage displayName="Kushal Trivedi" />);
    expect(screen.queryAllByText("Checking...")).toHaveLength(0);
    expect(screen.getByText("Connect Gmail")).toBeTruthy();
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
      screen.getByRole("link", { name: "Open Connected Systems" }).getAttribute("href"),
    ).toBe(buildOneSetupCapabilityRoute("connected-systems"));
  });
});
