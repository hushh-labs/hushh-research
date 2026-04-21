import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PkmDomainDetailPanel } from "@/components/profile/pkm-data-manager";
import type { PkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";

const previewPresentation: PkmSectionPreviewPresentation = {
  title: "Portfolio",
  description: "Holdings, balances, and imported account details.",
  summary: "Snapshot of your saved holdings and balances.",
  stats: [
    { label: "Accounts", value: "2" },
    { label: "Holdings", value: "14" },
  ],
  groups: [
    {
      kind: "fields",
      title: "Saved values",
      fields: [
        { label: "Total value", value: "$412,000" },
        { label: "Cash", value: "$18,000", tone: "muted" },
      ],
    },
  ],
};

describe("PkmDomainDetailPanel", () => {
  it("shows section view actions and removes generic access framing", () => {
    render(
      <PkmDomainDetailPanel
        domain={{
          key: "financial",
          title: "Financial",
          summary: "Kai keeps a readable view of your financial details across portfolio, analytics, and documents.",
          highlights: [
            "19 saved details",
            "Organized into Portfolio, Analytics, and Documents",
            "Portfolio imports is the current source",
          ],
          sections: ["Portfolio", "Analytics", "Documents"],
          sourceLabels: ["Portfolio imports"],
          updatedAt: "2026-04-16T03:10:00.000Z",
          detailCount: 19,
          status: "complete",
          statusLabel: "Complete",
          accessEntries: [],
          accessSummary: "No active access",
          accessCount: 0,
          attentionFlags: [],
          permissionCount: 2,
          enabledPermissionCount: 1,
        }}
        permissions={[
          {
            key: "financial:portfolio",
            scopeHandle: "financial.portfolio",
            topLevelScopePath: "portfolio",
            label: "Portfolio",
            description: "Holdings, balances, and imported account details.",
            exposureEnabled: true,
            sensitivityTier: "confidential",
            activeReaderCount: 0,
            requesterLabels: [],
            counterpartSummary: "No one currently has access.",
            includesBroadAccess: false,
          },
        ]}
        upgrade={{
          status: "current",
          label: "Current",
          description: "This domain is ready to manage.",
          canManagePermissions: true,
        }}
        manifestLoading={false}
        manifestError={null}
        pendingPermissionKeys={[]}
        previewOpen={false}
        previewTitle=""
        previewDescription=""
        previewPresentation={null}
        previewLoading={false}
        previewError={null}
        onPreviewOpenChange={vi.fn()}
        onPreviewPermission={vi.fn()}
        onTogglePermission={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        "Kai keeps a readable view of your financial details across portfolio, analytics, and documents."
      )
    ).toBeTruthy();
    expect(screen.getByText("19 saved details")).toBeTruthy();
    expect(screen.getByText("Organized into Portfolio, Analytics, and Documents")).toBeTruthy();
    expect(screen.getByText("Sharing controls")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View Portfolio data" })).toBeTruthy();
    expect(screen.queryByText("What's saved here")).toBeNull();
    expect(screen.queryByText("Current access")).toBeNull();
  });

  it("renders semantic preview content instead of raw saved_data tree markup", () => {
    render(
      <PkmDomainDetailPanel
        domain={{
          key: "financial",
          title: "Financial",
          summary: "Kai keeps a readable view of your financial details across portfolio, analytics, and documents.",
          highlights: [],
          sections: ["Portfolio"],
          sourceLabels: ["Portfolio imports"],
          updatedAt: "2026-04-16T03:10:00.000Z",
          detailCount: 19,
          status: "complete",
          statusLabel: "Complete",
          accessEntries: [],
          accessSummary: "No active access",
          accessCount: 0,
          attentionFlags: [],
          permissionCount: 1,
          enabledPermissionCount: 1,
        }}
        permissions={[
          {
            key: "financial:portfolio",
            scopeHandle: "financial.portfolio",
            topLevelScopePath: "portfolio",
            label: "Portfolio",
            description: "Holdings, balances, and imported account details.",
            exposureEnabled: true,
            sensitivityTier: "confidential",
            activeReaderCount: 0,
            requesterLabels: [],
            counterpartSummary: "No one currently has access.",
            includesBroadAccess: false,
          },
        ]}
        upgrade={{
          status: "current",
          label: "Current",
          description: "This domain is ready to manage.",
          canManagePermissions: true,
        }}
        manifestLoading={false}
        manifestError={null}
        pendingPermissionKeys={[]}
        previewOpen
        previewTitle="Portfolio"
        previewDescription="Holdings, balances, and imported account details."
        previewPresentation={previewPresentation}
        previewLoading={false}
        previewError={null}
        onPreviewOpenChange={vi.fn()}
        onPreviewPermission={vi.fn()}
        onTogglePermission={vi.fn()}
      />
    );

    expect(screen.getByText("Snapshot of your saved holdings and balances.")).toBeTruthy();
    expect(screen.getByText("2 accounts")).toBeTruthy();
    expect(screen.getByText("14 holdings")).toBeTruthy();
    expect(screen.getByText("Total value")).toBeTruthy();
    expect(screen.getByText("$412,000")).toBeTruthy();
    expect(screen.queryByText("saved_data")).toBeNull();
    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    expect(dialogContent?.className).toContain("sm:max-w-[min(26rem,calc(100vw-8rem))]");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
