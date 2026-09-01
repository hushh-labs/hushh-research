import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PortfolioSourceSwitcher } from "@/components/kai/portfolio-source-switcher";

const statementSnapshots = [
  { id: "statement-july", label: "Demo Brokerage · Jul 17" },
  { id: "statement-june", label: "Demo Brokerage · Jun 17" },
];

describe("PortfolioSourceSwitcher", () => {
  it("shows only viable source choices and delegates a confirmed source change", () => {
    const onSourceChange = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <PortfolioSourceSwitcher
        activeSource="statement"
        availableSources={["statement", "plaid"]}
        onSourceChange={onSourceChange}
        statementSnapshots={statementSnapshots}
        activeStatementSnapshotId="statement-july"
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Brokerage" }));
    expect(onSourceChange).toHaveBeenCalledWith("plaid");

    rerender(
      <PortfolioSourceSwitcher
        activeSource="statement"
        availableSources={["statement", "plaid"]}
        onSourceChange={onSourceChange}
        statementSnapshots={statementSnapshots}
        activeStatementSnapshotId="statement-july"
        isChangingSource
      />,
    );

    expect(screen.getByTestId("portfolio-source-switcher")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Statement" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Brokerage" })).toBeDisabled();

    rerender(
      <PortfolioSourceSwitcher
        activeSource="statement"
        availableSources={["statement"]}
        onSourceChange={onSourceChange}
        statementSnapshots={statementSnapshots}
        activeStatementSnapshotId="statement-july"
      />,
    );

    expect(screen.queryByRole("button", { name: "Brokerage" })).toBeNull();
    expect(screen.getAllByText("Statement").length).toBeGreaterThan(0);
  });

  it("keeps statement management readable and delegates its distinct actions", () => {
    const onImportStatement = vi.fn();
    const onDeleteStatementSnapshot = vi.fn();
    render(
      <PortfolioSourceSwitcher
        activeSource="statement"
        availableSources={["statement", "plaid"]}
        onSourceChange={() => Promise.resolve()}
        statementSnapshots={statementSnapshots}
        activeStatementSnapshotId="statement-july"
        onStatementSnapshotChange={() => Promise.resolve()}
        onImportStatement={onImportStatement}
        onDeleteStatementSnapshot={onDeleteStatementSnapshot}
        onDeletePortfolio={vi.fn()}
      />,
    );

    expect(screen.getByTestId("portfolio-source-statements-group")).toBeTruthy();
    expect(screen.getAllByText("Demo Brokerage · Jul 17").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: /import another statement/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /delete selected statement/i }),
    );

    expect(onImportStatement).toHaveBeenCalledTimes(1);
    expect(onDeleteStatementSnapshot).toHaveBeenCalledWith("statement-july");
  });

  it("does not offer a source change until the Vault is unlocked", () => {
    render(
      <PortfolioSourceSwitcher
        activeSource="statement"
        availableSources={["statement", "plaid"]}
        onSourceChange={() => Promise.resolve()}
        canChangePortfolioSource={false}
      />,
    );

    expect(screen.getByRole("tab", { name: "Brokerage" })).toBeDisabled();
    expect(
      screen.getByText("Unlock your Vault to change the active portfolio."),
    ).toBeTruthy();
  });

  it("renders connected-brokerage actions as separate rows", () => {
    const onRefreshPlaid = vi.fn();
    const onManageConnections = vi.fn();
    render(
      <PortfolioSourceSwitcher
        activeSource="plaid"
        availableSources={["statement", "plaid"]}
        onSourceChange={() => Promise.resolve()}
        freshness={{
          itemCount: 2,
          accountCount: 3,
          syncStatus: "completed",
          lastSyncedAt: "2026-07-17T12:00:00.000Z",
          institutionNames: ["Demo Brokerage"],
        }}
        onRefreshPlaid={onRefreshPlaid}
        onManageConnections={onManageConnections}
        onImportStatement={vi.fn()}
      />,
    );

    expect(screen.getByText("2 connected brokerages")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /refresh brokerage/i }));
    fireEvent.click(screen.getByRole("button", { name: /manage connections/i }));

    expect(onRefreshPlaid).toHaveBeenCalledTimes(1);
    expect(onManageConnections).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("portfolio-source-add-statement-group")).toBeTruthy();
  });
});
