import { beforeEach, describe, expect, it, vi } from "vitest";
import { WIKI_PROJECTIONS_BRANCH } from "@/lib/personal-knowledge-model/manifest";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import type { SharedFilesAccess } from "@/lib/files/shared/store";
import {
  WIKI_TOOL_DECLARATIONS,
  normalizeWikiRecallRequest,
} from "@/lib/files/wiki/recall-client-tools";
import {
  materializeWikiReceiptToPkm,
  retractStaleWikiProjectionsFromPkm,
} from "@/lib/files/wiki/pkm-projection-sync";

describe("Personal Wiki <-> PKM write-through, existing-domain safety & recall contracts", () => {
  let storedDomainData: Record<string, Record<string, unknown>>;
  let storedManifests: Record<string, any>;
  let activeRecipientCount: number;

  const access: SharedFilesAccess = {
    owner: "usr_wave3_client",
    vaultKey: "a".repeat(64),
    ownerToken: "tok_wave3_owner",
    check: () => undefined,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    activeRecipientCount = 0;
    storedDomainData = {
      financial: {
        portfolio: {
          total_value: "$420,000",
        },
      },
      travel: {
        loyalty: {
          airline: "United Airlines",
        },
      },
    };
    storedManifests = {
      travel: {
        user_id: access.owner,
        domain: "travel",
        manifest_version: 2,
        top_level_scope_paths: ["loyalty"],
        externalizable_paths: ["loyalty.airline"],
        paths: [
          {
            json_path: "loyalty.airline",
            path_type: "leaf",
            exposure_eligibility: true,
            segment_id: "seg_loyalty",
          },
        ],
      },
    };

    vi.spyOn(PkmDomainResourceService, "getManyStaleFirst").mockImplementation(
      async ({ domains }) => ({
        snapshots: Object.fromEntries(
          domains
            .filter((d) => Boolean(storedDomainData[d]))
            .map((d) => [
              d,
              {
                key: { userId: access.owner, domain: d, segmentIds: [], contentRevision: 1 },
                data: JSON.parse(JSON.stringify(storedDomainData[d])),
                manifestRevision: 1,
                updatedAt: "2026-11-16T00:00:00Z",
                audit: {
                  cacheTier: "memory" as const,
                  source: "network" as const,
                  refreshedAt: "2026-11-16T00:00:00Z",
                },
              },
            ]),
        ),
        failedDomains: [],
      }),
    );

    vi.spyOn(
      PersonalKnowledgeModelService,
      "getMutationSharingImpact",
    ).mockImplementation(async () => ({
      activeRecipientCount,
      recipientLabels: activeRecipientCount > 0 ? ["Acme Advisor"] : [],
      entersNextExportRevision: activeRecipientCount > 0,
      summary: "",
      affectedGrantIds: activeRecipientCount > 0 ? ["grant_1"] : [],
      affectedExportIds: [],
    }));

    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementation(
      async (params: any) => {
        const currentDomainData = JSON.parse(
          JSON.stringify(storedDomainData[params.domain] ?? {}),
        );
        const currentManifest = storedManifests[params.domain] ?? null;
        const plan = await params.build({
          userId: params.userId,
          domain: params.domain,
          currentDomainData,
          currentManifest,
          currentEncryptedDomain: { dataVersion: 3 },
          baseFullBlob: { [params.domain]: currentDomainData },
          expectedDataVersion: 3,
          attempt: 0,
          upgradedInSession: false,
        });
        if (!plan.unchanged) {
          storedDomainData[params.domain] = JSON.parse(
            JSON.stringify(plan.domainData),
          );
          if (plan.manifest) {
            storedManifests[params.domain] = plan.manifest;
          }
        }
        return {
          saveState: "saved",
          success: true,
          idempotentReplay: Boolean(plan.unchanged),
          dataVersion: 4,
          fullBlob: { [params.domain]: storedDomainData[params.domain] },
        };
      },
    );
  });

  it("merges confirmed wiki projections into existing PKM domains without exposing _wiki_projections or clobbering siblings", async () => {
    // Active external grants hold unconfirmed auto-save in requires_confirmation
    activeRecipientCount = 1;
    const held = await materializeWikiReceiptToPkm(
      access,
      {
        receiptId: "wpr_1111222233334444",
        domain: "travel",
        jsonPath: "preferences.seat",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 2,
        claimId: "wcl_0123456789abcdef",
        sourceRevision: 1,
        statement: "Prefers aisle seats on long-haul flights",
        proposedValue: "Aisle",
      },
      { ownerConfirmed: false },
    );
    expect(held.outcome).toBe("requires_confirmation");
    expect(storedDomainData.travel?.preferences).toBeUndefined();

    // Explicit owner confirmation writes through cleanly alongside pre-existing loyalty.airline
    const confirmed = await materializeWikiReceiptToPkm(
      access,
      {
        receiptId: "wpr_1111222233334444",
        domain: "travel",
        jsonPath: "preferences.seat",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 2,
        claimId: "wcl_0123456789abcdef",
        sourceRevision: 2,
        statement: "Prefers aisle seats on long-haul flights",
        proposedValue: "Aisle",
      },
      { ownerConfirmed: true },
    );
    expect(confirmed.outcome).toBe("materialized");
    expect(storedDomainData.travel?.loyalty).toEqual({
      airline: "United Airlines",
    });
    expect((storedDomainData.travel?.preferences as any)?.seat).toBe("Aisle");
    expect(
      (storedDomainData.travel?.[WIKI_PROJECTIONS_BRANCH] as any)?.[
        "preferences.seat"
      ]?.receipt_id,
    ).toBe("wpr_1111222233334444");

    const nextManifest = storedManifests.travel;
    expect(nextManifest.top_level_scope_paths).toContain("loyalty");
    expect(nextManifest.top_level_scope_paths).toContain("preferences");
    expect(nextManifest.top_level_scope_paths).not.toContain(
      WIKI_PROJECTIONS_BRANCH,
    );
    expect(
      nextManifest.externalizable_paths.some((p: string) =>
        p.includes(WIKI_PROJECTIONS_BRANCH),
      ),
    ).toBe(false);

    // Selective Forget removes ONLY preferences.seat while keeping loyalty.airline intact!
    const retracted = await retractStaleWikiProjectionsFromPkm(access, [
      {
        receiptId: "wpr_1111222233334444",
        domain: "travel",
        jsonPath: "preferences.seat",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 3,
        claimId: "wcl_0123456789abcdef",
        sourceRevision: 3,
      },
    ]);
    expect(retracted.allSucceeded).toBe(true);
    expect(retracted.retractedPaths).toEqual(["travel.preferences.seat"]);
    expect(storedDomainData.travel?.loyalty).toEqual({
      airline: "United Airlines",
    });
    expect(storedDomainData.travel?.preferences).toBeUndefined();
    expect(storedDomainData.travel?.[WIKI_PROJECTIONS_BRANCH]).toBeUndefined();
    expect(
      storedManifests.travel.summary_projection.scope_materialization.preferences,
    ).toEqual({
      state: "stale",
      materialized_leaf_count: 0,
    });
  });

  it("refuses to clobber pre-existing non-wiki PKM leaves or nested financial specialist values", async () => {
    activeRecipientCount = 0;
    const siblingConflict = await materializeWikiReceiptToPkm(
      access,
      {
        receiptId: "wpr_aaaa222233334444",
        domain: "travel",
        jsonPath: "loyalty.airline",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 1,
        claimId: "wcl_aaaa222233334444",
        sourceRevision: 1,
        statement: "Primary airline is Delta",
        proposedValue: "Delta",
      },
      { ownerConfirmed: true },
    );
    expect(siblingConflict.outcome).toBe("conflicted");
    expect((storedDomainData.travel?.loyalty as any)?.airline).toBe(
      "United Airlines",
    );

    const nestedFinanceConflict = await materializeWikiReceiptToPkm(
      access,
      {
        receiptId: "wpr_bbbb222233334444",
        domain: "professional",
        jsonPath: "summary.total_value",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 1,
        claimId: "wcl_bbbb222233334444",
        sourceRevision: 1,
        statement: "Total value is $999,999",
        proposedValue: "$999,999",
      },
      { ownerConfirmed: true },
    );
    expect(nestedFinanceConflict.outcome).toBe("conflicted");
    if (nestedFinanceConflict.outcome === "conflicted") {
      expect(nestedFinanceConflict.conflict.authority).toBe("financial");
      expect(nestedFinanceConflict.conflict.path).toBe(
        "financial.portfolio.total_value",
      );
    }
  });

  it("preserves a newer non-wiki edit when retracting an older wiki projection", async () => {
    activeRecipientCount = 0;
    await materializeWikiReceiptToPkm(
      access,
      {
        receiptId: "wpr_cccc222233334444",
        domain: "travel",
        jsonPath: "preferences.hotel",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 1,
        claimId: "wcl_cccc222233334444",
        sourceRevision: 1,
        statement: "Prefers boutique hotels",
        proposedValue: "Boutique",
      },
      { ownerConfirmed: false },
    );
    // Simulate owner manually editing travel.preferences.hotel in Memory UI
    (storedDomainData.travel!.preferences as Record<string, unknown>).hotel =
      "Four Seasons";

    const res = await retractStaleWikiProjectionsFromPkm(access, [
      {
        receiptId: "wpr_cccc222233334444",
        domain: "travel",
        jsonPath: "preferences.hotel",
        pageId: "wpg_0123456789abcdef",
        pageRevision: 2,
        claimId: "wcl_cccc222233334444",
        sourceRevision: 2,
      },
    ]);
    expect(res.allSucceeded).toBe(true);
    expect(res.retractedPaths).toEqual([]);
    expect((storedDomainData.travel!.preferences as any).hotel).toBe(
      "Four Seasons",
    );
    expect(storedDomainData.travel?.[WIKI_PROJECTIONS_BRANCH]).toBeUndefined();
  });

  it("normalizes Shared client-proxy wiki recall tool declarations and requests deterministically", () => {
    expect(WIKI_TOOL_DECLARATIONS.map((d) => d.name)).toEqual([
      "search_wiki",
      "read_wiki_page",
      "trace_claim",
    ]);
    expect(normalizeWikiRecallRequest("search_wiki", { query: "  cortado  " })).toEqual({
      query: "cortado",
      limit: 5,
    });
    expect(
      normalizeWikiRecallRequest("read_wiki_page", {
        page_id: "wpg_0123456789abcdef",
        revision: 2,
      }),
    ).toEqual({
      page_id: "wpg_0123456789abcdef",
      revision: 2,
    });
    expect(() =>
      normalizeWikiRecallRequest("search_wiki", { query: "", extra: true }),
    ).toThrow();
  });
});
