import { describe, expect, it } from "vitest";

import {
  buildShoppingReceiptMemoryPreparedDomain,
  hasMatchingReceiptMemoryProvenance,
} from "@/lib/profile/gmail-receipt-memory-pkm";
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
