import { beforeEach, describe, expect, it, vi } from "vitest";
const prepMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/agent-pkm-memory-preparation", () => ({
  requestPkmMemoryPreparation: prepMock,
}));
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
  syncWikiPagesToPkmProjections,
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

  it("retires classic memory.md rewrites via consolidateDirect under wiki_primary while preserving pending-turn withdrawal", async () => {
    const sessionOwnerMod = await import("@/lib/auth/session-owner");
    const { SecureDurableResourceService } = await import(
      "@/lib/services/secure-durable-resource-service"
    );
    const markdownMemory = await import("@/lib/pkm/markdown-memory");
    const { createChatMemoryRuntime } = await import(
      "@/lib/agent/chat-memory-runtime"
    );

    vi.spyOn(
      sessionOwnerMod,
      "snapshotValidatedAuthSessionOwner",
    ).mockReturnValue({
      userId: access.owner,
      email: "wave4@example.com",
    } as any);
    vi.spyOn(SecureDurableResourceService, "read").mockResolvedValue(null);
    vi.spyOn(SecureDurableResourceService, "version").mockResolvedValue({
      generation: 1,
      revision: 0,
    });
    vi.spyOn(SecureDurableResourceService, "write").mockResolvedValue({
      generation: 1,
      revision: 1,
    });
    vi.spyOn(markdownMemory, "loadMarkdownMemory").mockResolvedValue({
      markdown: "# memory.md\n\n## Preferences\n- Classic note\n",
      updatedAt: null,
      revision: 1,
      hasStoredDocument: true,
    } as any);
    const replaceSpy = vi.spyOn(markdownMemory, "replaceChatMarkdownMemory");
    const rewriteSpy = vi.fn(async () => ({ markdown: "# memory.md\n" }));
    const consolidateDirectSpy = vi.fn(async () => true);

    const runtime = createChatMemoryRuntime({
      getSession: () => ({
        userId: access.owner,
        vaultKey: access.vaultKey,
        vaultOwnerToken: access.ownerToken,
      }),
      rewrite: rewriteSpy,
      consolidateDirect: consolidateDirectSpy,
      tokenThreshold: 100_000,
    });
    await runtime.registerSnapshot({
      conversationId: "conv_wiki_primary_1",
      messages: [
        {
          id: "msg_1",
          conversationId: "conv_wiki_primary_1",
          role: "user",
          content: "Remember that my home airport is SFO.",
        },
        {
          id: "msg_2",
          conversationId: "conv_wiki_primary_1",
          role: "assistant",
          content: "Noted — home airport is SFO.",
        },
      ],
    });

    const ok = await runtime.trigger("remember");
    runtime.clear();
    expect(ok).toBe(true);
    expect(consolidateDirectSpy).toHaveBeenCalledTimes(1);
    expect(
      consolidateDirectSpy.mock.calls[0]?.[0]?.messages.map((m: any) => m.id),
    ).toEqual(["msg_1", "msg_2"]);
    // Classic rewrite and classic one_memory.markdown save are completely bypassed!
    expect(rewriteSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("syncs compiled wiki claims into default PKM consent scopes while holding shared-grant items as candidates", async () => {
    prepMock.mockResolvedValueOnce({
      payload: {
        preview_cards: [
          {
            target_domain: "professional",
            structure_decision: { target_domain: "professional" },
            target_entity_scope: "role.title",
            primary_json_path: "role.title",
            source_quote: "Works as principal engineer at Hussh.",
            source_text: "Works as principal engineer at Hussh.",
            write_mode: "can_save",
            requires_confirmation: false,
            candidate_payload: { role: { title: "Principal Engineer at Hussh" } },
          },
          {
            target_domain: "travel",
            structure_decision: { target_domain: "travel" },
            target_entity_scope: "preferences.seat",
            primary_json_path: "preferences.seat",
            source_quote: "Prefers window seats on red-eye flights.",
            source_text: "Prefers window seats on red-eye flights.",
            write_mode: "can_save",
            requires_confirmation: false,
            candidate_payload: { preferences: { seat: "Window" } },
            sharing_impact: {
              active_recipient_count: 1,
              recipient_labels: ["Travel Concierge"],
              enters_next_export_revision: true,
              summary: "Updates shared travel preference.",
              affected_grant_ids: ["grant_travel_1"],
              affected_export_ids: [],
            },
          },
        ],
      },
    } as any);

    const derivedCalls: Array<{ domain: string; requireOwnerConfirmation: boolean; activeRecipientCount: number }> = [];
    const syncResult = await syncWikiPagesToPkmProjections(
      access,
      {
        overview: async () => ({
          captureOptIn: false,
          pages: [
            { pageId: "wpg_1111222233334444", revision: 1 },
            { pageId: "wpg_5555666677778888", revision: 1 },
          ],
          projectedClaimKeys: [],
        }),
        readPage: async (pageId) =>
          pageId === "wpg_1111222233334444"
            ? {
                pageId,
                revision: 1,
                claims: [
                  { claimId: "wcl_1111222233334444", statement: "Works as principal engineer at Hussh.", status: "active" },
                ],
              }
            : {
                pageId,
                revision: 1,
                claims: [
                  { claimId: "wcl_5555666677778888", statement: "Prefers window seats on red-eye flights.", status: "active" },
                ],
              },
        deriveProjection: async (input) => {
          derivedCalls.push({
            domain: input.targetDomain,
            requireOwnerConfirmation: input.requireOwnerConfirmation,
            activeRecipientCount: input.activeRecipientCount,
          });
          const state =
            input.activeRecipientCount > 0 || input.requireOwnerConfirmation
              ? "private_candidate"
              : "materialized";
          return {
            receiptId: `wpr_${input.claimId.slice(4)}`,
            state,
            domain: input.targetDomain,
            jsonPath: input.jsonPath,
            pageId: input.pageId,
            pageRevision: 1,
            claimId: input.claimId,
            sourceRevision: 1,
          };
        },
      },
      { explicitChatSave: true, surface: "chat" },
    );

    expect(syncResult.materializedCount).toBe(1);
    expect(syncResult.candidateCount).toBe(1);
    expect(derivedCalls).toEqual([
      { domain: "professional", requireOwnerConfirmation: false, activeRecipientCount: 0 },
      { domain: "travel", requireOwnerConfirmation: false, activeRecipientCount: 1 },
    ]);
    // Unshared safe professional claim automatically materialized its consent scope via owner-confirmed chat save!
    expect((storedDomainData.professional?.role as any)?.title).toBe("Principal Engineer at Hussh");
    expect(storedManifests.professional?.top_level_scope_paths).toContain("role");
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "professional",
        confirmation: expect.objectContaining({
          confirmedByUser: true,
          surface: "chat",
          source: "agent_chat_owner_request",
        }),
      }),
    );
    // Negative control: shared-grant travel claim NEVER auto-wrote into storedDomainData.travel.preferences!
    expect(storedDomainData.travel?.preferences).toBeUndefined();
  });
});


