import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { ROUTES } from "@/lib/navigation/routes";

describe("OneDashboardPage", () => {
  it("renders the primary One agent modes with route targets", () => {
    const { container } = render(
      <OneDashboardPage displayName="Kushal Trivedi" pendingConsents={2} />,
    );

    expect(screen.getByTestId("page-header")).toBeTruthy();
    expect(screen.getByText("Good to see you, Kushal.")).toBeTruthy();
    expect(screen.getByTestId("one-workflows-section")).toBeTruthy();
    expect(screen.getByTestId("one-memory-section")).toBeTruthy();
    expect(screen.getByTestId("one-access-section")).toBeTruthy();

    const financeLink = screen.getByRole("link", { name: "Open Finance" });
    expect(financeLink.getAttribute("href")).toBe(ROUTES.KAI_HOME);
    expect(financeLink.className).not.toContain("translate");
    expect(financeLink.className).toContain("border-emerald-500");
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
    expect(screen.getAllByText("Setup needed")).toHaveLength(3);
    expect(screen.getAllByText("Ready")).toHaveLength(3);
    expect(screen.getByText("2 pending")).toBeTruthy();
    expect(screen.getByText("Gmail receipts and saved knowledge.")).toBeTruthy();
    expect(container.querySelectorAll(".morphy-ripple-host").length).toBe(7);
    expect(screen.queryByRole("link", { name: "Open One Agent" })).toBeNull();
  });

  it("shows completed One setup when the pre-vault setup is resolved", () => {
    render(
      <OneDashboardPage
        displayName="Kushal Trivedi"
        pendingConsents={0}
        oneSetupResolved
      />,
    );

    expect(screen.getByText("Setup done")).toBeTruthy();
    expect(screen.getAllByText("Setup needed")).toHaveLength(2);
    expect(screen.getAllByText("Ready")).toHaveLength(4);
  });
});
