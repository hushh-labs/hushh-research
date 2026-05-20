import { describe, expect, it } from "vitest";

import {
  buildPkmDomainPresentation,
  buildPkmDomainPermissionPresentation,
  buildPkmDomainUpgradePresentation,
  buildPkmProfileSummaryPresentation,
  isConsumerVisiblePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";

const domain = {
  key: "financial",
  displayName: "Financial",
  icon: "wallet",
  color: "#123456",
  attributeCount: 8,
  summary: {},
  availableScopes: [],
  lastUpdated: "2026-04-10T10:00:00Z",
};

describe("pkm profile presentation", () => {
  it("builds consumer permission rows from scope registry and matches broad access", () => {
    const permissions = buildPkmDomainPermissionPresentation({
      domain,
      manifest: {
        domain: "financial",
        manifest_version: 4,
        domain_contract_version: 2,
        readable_summary_version: 1,
        summary_projection: {},
        top_level_scope_paths: ["portfolio", "documents"],
        externalizable_paths: [],
        paths: [],
        scope_registry: [
          {
            scope_handle: "financial.portfolio",
            scope_label: "Portfolio",
            segment_ids: ["portfolio"],
            sensitivity_tier: "confidential",
            exposure_enabled: true,
            summary_projection: {
              top_level_scope_path: "portfolio",
            },
          },
          {
            scope_handle: "financial.updated_at",
            scope_label: "Updated At",
            segment_ids: ["root"],
            sensitivity_tier: "confidential",
            exposure_enabled: true,
            summary_projection: {
              top_level_scope_path: "updated_at",
              consumer_visible: false,
              internal_only: true,
            },
          },
        ],
      },
      activeGrants: [
        {
          id: "grant-1",
          kind: "active_grant",
          status: "active",
          action: "grant",
          scope: "attr.financial.*",
          counterpart_type: "developer",
          counterpart_label: "Planner Pro",
          expires_at: "2026-04-30T10:00:00Z",
        },
      ],
      upgradeState: null,
    });

    expect(permissions).toEqual([
      expect.objectContaining({
        key: "financial:portfolio",
        label: "Portfolio",
        exposureEnabled: true,
        requesterLabels: ["Planner Pro"],
        includesBroadAccess: true,
      }),
    ]);
    expect(permissions[0]?.counterpartSummary).toContain("broad or direct access");
    expect(permissions).toHaveLength(1);
  });

  it("keeps upgrade compatibility separate from manifest concurrency", () => {
    const upgrade = buildPkmDomainUpgradePresentation({
      domain,
      manifest: {
        domain: "financial",
        manifest_version: 1,
        domain_contract_version: 1,
        readable_summary_version: 1,
        summary_projection: {},
        top_level_scope_paths: ["portfolio"],
        externalizable_paths: [],
        paths: [],
      },
      upgradeState: {
        domain: "financial",
        currentDomainContractVersion: 1,
        targetDomainContractVersion: 2,
        currentReadableSummaryVersion: 1,
        targetReadableSummaryVersion: 1,
        upgradedAt: null,
        needsUpgrade: true,
      },
    });

    expect(upgrade).toEqual(
      expect.objectContaining({
        status: "updating",
        canManagePermissions: true,
      })
    );

    const missingManifest = buildPkmDomainUpgradePresentation({
      domain,
      manifest: null,
      upgradeState: null,
    });

    expect(missingManifest).toEqual(
      expect.objectContaining({
        status: "missing_manifest",
        canManagePermissions: false,
      })
    );
  });

  it("filters structural highlight noise from the consumer domain surface", () => {
    const presentation = buildPkmDomainPresentation({
      domain: {
        ...domain,
        attributeCount: 19,
        readableHighlights: [
          "19 saved details",
          "Organized into Analysis, Analysis History, and Analytics",
          "995 consent-ready branches",
          "Latest import synced from brokerage statement",
        ],
      },
      activeGrants: [],
      manifest: {
        domain: "financial",
        manifest_version: 4,
        domain_contract_version: 2,
        readable_summary_version: 1,
        summary_projection: {
          readable_highlights: [
            "19 saved details",
            "Organized into Analysis, Analysis History, and Analytics",
            "995 consent-ready branches",
            "Latest import synced from brokerage statement",
          ],
        },
        top_level_scope_paths: ["analysis", "analysis_history", "analytics"],
        externalizable_paths: [],
        paths: [],
      },
      upgradeState: null,
    });

    expect(presentation.highlights).toEqual(["Latest import synced from brokerage statement"]);
  });

  it("hides internal runtime domains and ignores structural path counts for consumer rows", () => {
    expect(
      isConsumerVisiblePkmDomain({
        ...domain,
        key: "kyc_workflow",
        displayName: "Kyc Workflow",
      })
    ).toBe(false);

    const presentation = buildPkmDomainPresentation({
      domain: {
        ...domain,
        key: "travel",
        displayName: "Travel",
        attributeCount: 0,
        summary: {
          path_count: 18,
          consumer_item_count: 1,
          last_content_at: "2026-04-16T05:54:38Z",
          readable_source_label: "PKM Upgrade",
        },
        readableSourceLabel: "PKM Upgrade",
      },
      activeGrants: [],
      manifest: null,
      upgradeState: null,
    });

    expect(presentation.detailCount).toBe(1);
    expect(presentation.sourceLabels).toEqual(["Saved memory"]);

    const summary = buildPkmProfileSummaryPresentation({
      metadata: null,
      domains: [presentation],
      activeGrants: [],
    });
    expect(summary.totalDomains).toBe(1);
    expect(summary.totalAttributes).toBe(1);
  });

  it("does not treat structural-only path counts as user memory", () => {
    const presentation = buildPkmDomainPresentation({
      domain: {
        ...domain,
        key: "shopping",
        displayName: "Shopping",
        attributeCount: 0,
        summary: {
          path_count: 43,
          externalizable_path_count: 41,
          last_content_at: "2026-05-17T10:00:00Z",
        },
      },
      activeGrants: [],
      manifest: {
        domain: "shopping",
        manifest_version: 4,
        domain_contract_version: 2,
        readable_summary_version: 2,
        summary_projection: {},
        top_level_scope_paths: ["receipts_memory"],
        externalizable_paths: [],
        paths: [],
      },
      upgradeState: null,
    });

    expect(presentation.detailCount).toBe(0);
    expect(presentation.statusLabel).toBe("Ready");
    expect(presentation.attentionFlags).not.toContain("Refresh recommended");
  });
});
