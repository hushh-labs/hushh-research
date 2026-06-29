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
    expect(screen.getByTestId("one-workflows-section")).toBeTruthy();
    expect(screen.getByTestId("one-memory-section")).toBeTruthy();
    expect(screen.getByTestId("one-access-section")).toBeTruthy();

    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(ROUTES.KAI_HOME);
    expect(financeLink.className).not.toContain("translate");
    // Premium card model: no per-tone outline borders on outer chrome.
    expect(financeLink.className).not.toContain("border-emerald-500");
    expect(financeLink.className).toContain("border-transparent");
    expect(
      screen.getByRole("link", { name: "Open Gmail" }).getAttribute("href"),
    ).toBe(ROUTES.GMAIL);
    expect(
      screen.getByRole("link", { name: "Open Email" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_KYC);
    expect(
      screen.getByRole("link", { name: "Open Location" }).getAttribute("href"),
    ).toBe(ROUTES.ONE_LOCATION);
    expect(
      screen
        .getByRole("link", { name: "Open Personal Data" })
        .getAttribute("href"),
    ).toBe(ROUTES.PKM);
    expect(
      screen
        .getByRole("link", { name: "Open Consent Guardian" })
        .getAttribute("href"),
    ).toBe("/consents?tab=pending");
    expect(
      screen
        .getByRole("link", { name: "Open Connected Systems" })
        .getAttribute("href"),
    ).toBe(ROUTES.CONNECTED_SYSTEMS);

    // Resolver-driven consumer labels (plain language, no system nouns).
    expect(screen.getByText("Set up")).toBeTruthy(); // finance not-started
    expect(screen.getAllByText("Connect to set up")).toHaveLength(2); // gmail + connected
    // email + location are real vault-gated workflows (not explore-only), so a
    // completed status reads "Ready", not "Explored".
    expect(screen.getAllByText("Ready")).toHaveLength(2); // email + location completed
    expect(screen.getByText("Unlock to see")).toBeTruthy(); // pkm vault-gated
    expect(screen.getByText("2 to review")).toBeTruthy(); // consent attention
    expect(screen.getByText("2 consents pending")).toBeTruthy(); // header badge
    expect(screen.getByText("Gmail receipts and saved knowledge.")).toBeTruthy();
    expect(container.querySelectorAll(".morphy-ripple-host").length).toBe(7);
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
