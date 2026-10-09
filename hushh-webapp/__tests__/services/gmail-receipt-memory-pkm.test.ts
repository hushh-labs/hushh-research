import { describe, expect, it } from "vitest";

import {
  buildShoppingReceiptCanonicalIndexPreparedDomain,
  buildShoppingReceiptMemoryPreparedDomain,
  hasMatchingReceiptMemoryProvenance,
  RECEIPT_MEMORY_SAVE_WRITER,
} from "@/lib/profile/gmail-receipt-memory-pkm";
import { evaluateReservedWrite } from "@/lib/pkm/reserved-branches";
import {
  RECEIPT_INDEX_BRANCH,
  type ReceiptCanonicalIndex,
  type ReceiptIndexTransaction,
} from "@/lib/profile/gmail-receipt-memory-index";
import { shouldSkipPkmAgentContextKey, shouldSkipPkmMemoryKey } from "@/lib/pkm/pkm-memory-cards";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import type { ReceiptMemoryArtifact } from "@/lib/services/gmail-receipt-memory-service";

function buildArtifact(): ReceiptMemoryArtifact {
  return {
    artifact_id: "artifact-1",
    user_id: "user-1",
    source_kind: "gmail_receipts",
    artifact_version: 1,
    status: "ready",
    inference_window_days: 365,
    highlights_window_days: 90,
    source_watermark_hash: "watermark-1",
    source_watermark: {},
    deterministic_schema_version: 1,
    enrichment_schema_version: null,
    enrichment_cache_key: "deterministic-only",
    deterministic_projection_hash: "projection-1",
    enrichment_hash: null,
    candidate_pkm_payload_hash: "candidate-1",
    deterministic_projection: {
      schema_version: 1,
      source: {
        kind: "gmail_receipts",
        inference_window_days: 365,
        highlights_window_days: 90,
        generated_at: "2026-04-01T00:00:00Z",
        canonicalization_version: "merchant_canonicalization_v1",
        heuristic_version: "receipt_memory_v1",
        source_watermark: {
          eligible_receipt_count: 3,
          latest_receipt_updated_at: "2026-04-01T00:00:00Z",
          latest_receipt_id: 9,
          latest_receipt_date: "2026-03-30T00:00:00Z",
          deterministic_config_version: "receipt_memory_v1",
          inference_window_days: 365,
          highlights_window_days: 90,
        },
        source_watermark_hash: "watermark-1",
        projection_hash: "projection-1",
      },
      observed_facts: {
        merchant_affinity: [],
        purchase_patterns: [],
        recent_highlights: [],
      },
      inferred_preferences: [],
      budget_stats: {
        merchant_count: 0,
        pattern_count: 0,
        highlight_count: 0,
        signal_count: 0,
        eligible_receipt_count: 3,
      },
    },
    enrichment: null,
    candidate_pkm_payload: {
      receipts_memory: {
        schema_version: 1,
        readable_summary: {
          text: "Kai sees strong receipt signals around Amazon and Apple.",
          highlights: ["Top merchants: Amazon, Apple"],
          updated_at: "2026-04-01T00:00:00Z",
          source_label: "Gmail receipts",
        },
        observed_facts: {
          merchant_affinity: [],
          purchase_patterns: [],
          recent_highlights: [],
        },
        inferred_preferences: {
          preference_signals: [],
        },
        provenance: {
          source_kind: "gmail_receipts",
          artifact_id: "artifact-1",
          deterministic_projection_hash: "projection-1",
          enrichment_hash: null,
          inference_window_days: 365,
          highlights_window_days: 90,
          receipt_count_used: 3,
          latest_receipt_updated_at: "2026-04-01T00:00:00Z",
          imported_at: "2026-04-01T00:00:00Z",
        },
      },
    },
    debug_stats: {
      eligible_receipt_count: 3,
      filtered_receipt_count: 3,
      llm_input_token_budget_estimate: 10,
      enrichment_mode: "deterministic_fallback",
    },
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    freshness: {
      status: "fresh",
      is_stale: false,
      stale_after_days: 7,
      reason: "watermark_current",
    },
    persisted_pkm_data_version: null,
    persisted_at: null,
  };
}

describe("gmail-receipt-memory-pkm", () => {
  it("builds a prepared shopping domain while preserving sibling data", () => {
    const currentManifest: DomainManifest = {
      domain: "shopping",
      manifest_version: 2,
      domain_contract_version: 1,
      readable_summary_version: 1,
      summary_projection: {
        readable_summary: "Existing shopping memory.",
      },
      top_level_scope_paths: ["wishlists"],
      externalizable_paths: ["wishlists.items"],
      paths: [
        {
          json_path: "wishlists",
          path_type: "object",
          exposure_eligibility: true,
        },
        {
          json_path: "wishlists.items",
          path_type: "array",
          exposure_eligibility: true,
        },
      ],
    };

    const prepared = buildShoppingReceiptMemoryPreparedDomain({
      currentDomainData: {
        wishlists: {
          items: ["Noise-cancelling headphones"],
        },
      },
      currentManifest,
      artifact: buildArtifact(),
    });

    expect(prepared.domainData.wishlists).toEqual({
      items: ["Noise-cancelling headphones"],
    });
    expect(prepared.domainData.receipts_memory).toBeTruthy();
    expect(prepared.manifest.top_level_scope_paths).toEqual(
      expect.arrayContaining(["wishlists", "receipts_memory"])
    );
    expect(prepared.manifest.externalizable_paths.some((path) => path.startsWith("receipts_memory"))).toBe(
      false
    );
    expect(
      prepared.manifest.paths
        .filter((path) => path.json_path.startsWith("receipts_memory"))
        .every((path) => path.exposure_eligibility === false)
    ).toBe(true);
  });

  it("detects matching receipt-memory provenance hashes", () => {
    const artifact = buildArtifact();

    expect(
      hasMatchingReceiptMemoryProvenance(
        {
          receipts_memory: {
            provenance: {
              deterministic_projection_hash: "projection-1",
              enrichment_hash: null,
            },
          },
        },
        artifact
      )
    ).toBe(true);

    expect(
      hasMatchingReceiptMemoryProvenance(
        {
          receipts_memory: {
            provenance: {
              deterministic_projection_hash: "projection-2",
              enrichment_hash: null,
            },
          },
        },
        artifact
      )
    ).toBe(false);
  });
});


function indexOf(count: number): ReceiptCanonicalIndex {
  const transactions: ReceiptIndexTransaction[] = Array.from({ length: count }, (_, n) => ({
    ref: `txn_${(n + 1).toString(16).padStart(24, "0")}`,
    merchant: `Shop ${n + 1}`,
    amount: 10 + n,
    currency: "USD",
    category: null,
    status: "paid",
    transaction_date: "2026-10-01",
    identifiers: [{ kind: "order", value: `O-${n + 1}` }],
    detail: null,
  }));
  return {
    schema: "receipt_canonical_index.v1",
    generated_at: "2026-10-09T10:00:00Z",
    total_transactions: count,
    truncated: false,
    transactions,
  };
}

describe("gmail-receipt-memory-pkm canonical index", () => {
  const now = new Date("2026-10-09T10:00:00Z");
  const currentDomainData = {
    wishlists: { items: ["Noise-cancelling headphones"] },
    receipts_memory: {
      schema_version: 1,
      readable_summary: {
        text: "Kai sees strong receipt signals around Amazon.",
        highlights: ["Top merchants: Amazon"],
        updated_at: "2026-04-01T00:00:00Z",
        source_label: "Gmail receipts",
      },
      observed_facts: { merchant_affinity: [], purchase_patterns: [], recent_highlights: [] },
      inferred_preferences: { preference_signals: [] },
      provenance: { source_kind: "gmail_receipts", artifact_id: "artifact-1" },
    },
  };

  it("extends the existing payload, preserving siblings and summary fields, and stays non-shareable", () => {
    const prepared = buildShoppingReceiptCanonicalIndexPreparedDomain({
      currentDomainData,
      currentManifest: null,
      index: indexOf(3),
      digest: "digest-1",
      now,
    });
    const memory = prepared.domainData.receipts_memory as Record<string, unknown>;
    expect(prepared.domainData.wishlists).toEqual(currentDomainData.wishlists);
    expect(memory.readable_summary).toEqual(currentDomainData.receipts_memory.readable_summary);
    expect((memory[RECEIPT_INDEX_BRANCH] as ReceiptCanonicalIndex).transactions).toHaveLength(3);
    // The canonical index, like every receipts_memory path, can never be shared.
    const receiptPaths = prepared.manifest.paths.filter((path) =>
      path.json_path.startsWith("receipts_memory"),
    );
    expect(receiptPaths.length).toBeGreaterThan(0);
    expect(receiptPaths.every((path) => path.exposure_eligibility === false)).toBe(true);
    expect(
      prepared.manifest.externalizable_paths.some((path) => path.startsWith("receipts_memory")),
    ).toBe(false);
    expect(prepared.structureDecision.source_agent).toBe(RECEIPT_MEMORY_SAVE_WRITER);
    expect(prepared.summary).toMatchObject({
      readable_summary: "Kai sees strong receipt signals around Amazon.",
      receipt_memory_projection_hash: "digest-1",
      source: RECEIPT_MEMORY_SAVE_WRITER,
    });
  });

  it("declares only the registered writer, so the reserved-branch guard accepts the save", () => {
    // UAT 2026-10-09: the pre-save validation carries no mutation plan, so the
    // backend judged the write by structure_decision.source_agent, which was the
    // legacy "gmail_receipt_memory_v1" -> pkm.reserved_refused writer_unknown (422).
    const prepared = buildShoppingReceiptCanonicalIndexPreparedDomain({
      currentDomainData,
      currentManifest: null,
      index: indexOf(3),
      digest: "digest-1",
      now,
    });
    const receiptPaths = prepared.manifest.paths
      .map((path) => path.json_path)
      .filter((path) => path.startsWith("receipts_memory"));
    expect(receiptPaths.length).toBeGreaterThan(0);
    expect(
      prepared.manifest.paths
        .filter((path) => path.json_path.startsWith("receipts_memory"))
        .every((path) => path.source_agent === RECEIPT_MEMORY_SAVE_WRITER),
    ).toBe(true);

    const judge = (writerId: string) =>
      evaluateReservedWrite({
        domain: "shopping",
        paths: receiptPaths,
        writerId,
        authorizationMode: null,
      });
    // What the validation request is judged by, and what the real write carries.
    expect(judge(String(prepared.structureDecision.source_agent))).toEqual([]);
    expect(judge(RECEIPT_MEMORY_SAVE_WRITER)).toEqual([]);
    // Negative control: the old declared writer is refused by the same rule.
    expect(judge("gmail_receipt_memory_v1").map((refusal) => refusal.reason)).toContain(
      "writer_unknown",
    );
  });

  it("describes the shape of the index, not its size", () => {
    const small = buildShoppingReceiptCanonicalIndexPreparedDomain({
      currentDomainData: {}, currentManifest: null, index: indexOf(2), digest: "a", now,
    });
    const large = buildShoppingReceiptCanonicalIndexPreparedDomain({
      currentDomainData: {}, currentManifest: null, index: indexOf(100), digest: "a", now,
    });
    expect(large.manifest.path_count).toBe(small.manifest.path_count);
  });

  it("keeps the index out of One's prompt packet and Memory cards by its private spelling", () => {
    expect(RECEIPT_INDEX_BRANCH.startsWith("_")).toBe(true);
    expect(shouldSkipPkmAgentContextKey(RECEIPT_INDEX_BRANCH)).toBe(true);
    expect(shouldSkipPkmMemoryKey(RECEIPT_INDEX_BRANCH)).toBe(true);
    // Negative control: without the underscore the same branch would flood the packet.
    expect(shouldSkipPkmAgentContextKey("canonical_index")).toBe(false);
  });
});
