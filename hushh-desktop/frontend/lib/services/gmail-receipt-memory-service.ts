import { ApiService } from "@/lib/services/api-service";
import {
  buildGmailReceiptMemoryArtifactPath,
  GMAIL_RECEIPTS_API_TEMPLATES,
} from "@/lib/services/kai-profile-api-paths";

type ErrorEnvelope = {
  detail?:
    | string
    | {
        message?: string;
        code?: string;
      };
  message?: string;
  error?: string;
};

async function extractError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const payload = (raw ? JSON.parse(raw) : null) as ErrorEnvelope | null;
    const detailObj =
      payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
        ? payload.detail
        : null;
    const message =
      (typeof detailObj?.message === "string" ? detailObj.message : null) ||
      (typeof payload?.detail === "string" ? payload.detail : null) ||
      (typeof payload?.message === "string" ? payload.message : null) ||
      (typeof payload?.error === "string" ? payload.error : null);
    return (message || fallback).trim();
  } catch {
    return raw.trim() || fallback;
  }
}

function buildSealedHeaders(idToken: string, vaultOwnerToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    "X-Hushh-Consent": `Bearer ${vaultOwnerToken}`,
  };
}

export type ReceiptMemoryMerchantAffinity = {
  merchant_id: string;
  merchant_label: string;
  receipt_count_365d: number;
  active_month_count_365d?: number;
  last_purchase_at: string | null;
  affinity_score: number;
  primary_currency?: string | null;
  primary_currency_total_amount?: number | null;
  fact_id: string;
};

export type ReceiptMemoryPurchasePattern = {
  pattern_id: string;
  merchant_id: string;
  merchant_label: string;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly";
  occurrence_count: number;
  mean_interval_days?: number;
  confidence: number;
  first_observed_at?: string | null;
  last_observed_at: string | null;
  fact_id: string;
};

export type ReceiptMemoryRecentHighlight = {
  highlight_id: string;
  merchant_id: string;
  merchant_label: string;
  purchased_at: string | null;
  amount?: number | null;
  currency?: string | null;
  reason_code:
    | "high_value"
    | "unusually_large_for_merchant"
    | "new_merchant"
    | "returned_after_gap"
    | "recurring_charge_detected";
  fact_id: string;
};

export type ReceiptMemoryPreferenceSignal = {
  signal_id: string;
  signal_type: "merchant_loyalty" | "recurring_preference" | "shopping_habit";
  label: string;
  confidence: number;
  supporting_fact_ids: string[];
};

export type DeterministicReceiptMemoryProjection = {
  schema_version: number;
  source: {
    kind: "gmail_receipts";
    inference_window_days: number;
    highlights_window_days: number;
    generated_at: string | null;
    canonicalization_version: string;
    heuristic_version: string;
    source_watermark: {
      eligible_receipt_count: number;
      latest_receipt_updated_at: string | null;
      latest_receipt_id: number | null;
      latest_receipt_date: string | null;
      deterministic_config_version: string;
      inference_window_days: number;
      highlights_window_days: number;
    };
    source_watermark_hash: string;
    projection_hash: string;
  };
  observed_facts: {
    merchant_affinity: ReceiptMemoryMerchantAffinity[];
    purchase_patterns: ReceiptMemoryPurchasePattern[];
    recent_highlights: ReceiptMemoryRecentHighlight[];
  };
  inferred_preferences: ReceiptMemoryPreferenceSignal[];
  budget_stats: {
    merchant_count: number;
    pattern_count: number;
    highlight_count: number;
    signal_count: number;
    eligible_receipt_count: number;
  };
};

export type ReceiptMemoryEnrichment = {
  schema_version: number;
  based_on_projection_hash: string;
  model: string;
  generated_at: string | null;
  readable_summary: {
    text: string;
    highlights: string[];
  };
  signal_language?: Array<{
    signal_id: string;
    human_label?: string;
    rationale?: string;
  }>;
  validation?: Record<string, unknown>;
};

export type ShoppingReceiptsMemoryPayload = {
  receipts_memory: {
    schema_version: number;
    readable_summary: {
      text: string;
      highlights: string[];
      updated_at: string;
      source_label: string;
    };
    observed_facts: {
      merchant_affinity: Array<{
        merchant_id: string;
        merchant_label: string;
        affinity_score: number;
        receipt_count_365d: number;
        last_purchase_at: string | null;
        top_currency?: string | null;
      }>;
      purchase_patterns: Array<{
        pattern_id: string;
        merchant_label: string;
        cadence: "weekly" | "biweekly" | "monthly" | "quarterly";
        occurrence_count: number;
        last_observed_at: string | null;
        confidence: number;
      }>;
      recent_highlights: Array<{
        merchant_label: string;
        purchased_at: string | null;
        amount?: number | null;
        currency?: string | null;
        reason_code: string;
      }>;
    };
    inferred_preferences: {
      preference_signals: Array<{
        signal_id: string;
        label: string;
        confidence: number;
        basis_codes: string[];
      }>;
    };
    provenance: {
      source_kind: "gmail_receipts";
      artifact_id: string;
      deterministic_projection_hash: string;
      enrichment_hash?: string | null;
      inference_window_days: number;
      highlights_window_days: number;
      receipt_count_used: number;
      latest_receipt_updated_at?: string | null;
      imported_at: string;
    };
  };
};

export type ReceiptMemoryArtifact = {
  artifact_id: string;
  user_id: string;
  source_kind: "gmail_receipts";
  artifact_version: number;
  status: string;
  inference_window_days: number;
  highlights_window_days: number;
  source_watermark_hash: string;
  source_watermark: Record<string, unknown>;
  deterministic_schema_version: number;
  enrichment_schema_version?: number | null;
  enrichment_cache_key: string;
  deterministic_projection_hash: string;
  enrichment_hash?: string | null;
  candidate_pkm_payload_hash: string;
  deterministic_projection: DeterministicReceiptMemoryProjection;
  enrichment: ReceiptMemoryEnrichment | null;
  candidate_pkm_payload: ShoppingReceiptsMemoryPayload;
  debug_stats: {
    eligible_receipt_count: number;
    filtered_receipt_count: number;
    llm_input_token_budget_estimate: number;
    enrichment_mode: "llm" | "deterministic_fallback";
  };
  created_at: string | null;
  updated_at: string | null;
  freshness: {
    status: "fresh" | "stale";
    is_stale: boolean;
    stale_after_days: number;
    age_days?: number;
    reason: string;
  };
  persisted_pkm_data_version?: number | null;
  persisted_at?: string | null;
};

export class GmailReceiptMemoryService {
  static async preview(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    forceRefresh?: boolean;
  }): Promise<ReceiptMemoryArtifact> {
    const response = await ApiService.apiFetch(GMAIL_RECEIPTS_API_TEMPLATES.receiptsMemoryPreview, {
      method: "POST",
      headers: {
        ...buildSealedHeaders(params.idToken, params.vaultOwnerToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: params.userId,
        force_refresh: Boolean(params.forceRefresh),
      }),
    });
    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to build receipt memory preview."));
    }
    return (await response.json()) as ReceiptMemoryArtifact;
  }

  static async getArtifact(params: {
    idToken: string;
    vaultOwnerToken: string;
    userId: string;
    artifactId: string;
  }): Promise<ReceiptMemoryArtifact> {
    const query = new URLSearchParams({ user_id: params.userId }).toString();
    const response = await ApiService.apiFetch(
      `${buildGmailReceiptMemoryArtifactPath(params.artifactId)}?${query}`,
      {
        method: "GET",
        headers: buildSealedHeaders(params.idToken, params.vaultOwnerToken),
      }
    );
    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to load receipt memory artifact."));
    }
    return (await response.json()) as ReceiptMemoryArtifact;
  }
}
