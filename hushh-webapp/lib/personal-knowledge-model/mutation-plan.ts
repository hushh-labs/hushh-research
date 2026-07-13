import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { CURRENT_PKM_CONTRACT_VERSION } from "@/lib/personal-knowledge-model/upgrade-contracts";

export type PkmMutationOperation = "create" | "update" | "move" | "merge" | "delete";

export type PkmUserConfirmation = {
  confirmedByUser: true;
  surface: "chat" | "voice" | "web" | "ios" | "android" | "import";
  source: string;
  confirmedAt?: string;
  sharingImpactAcknowledged?: boolean;
  sharingImpact?: {
    activeRecipientCount: number;
    recipientLabels: string[];
    entersNextExportRevision: boolean;
    summary: string;
    affectedGrantIds: string[];
    affectedExportIds: string[];
  };
};

export type PkmMutationPlanV2 = {
  version: 2;
  plan_id: string;
  operation: PkmMutationOperation;
  source_scope_handle?: string;
  target_scope_handle?: string;
  proposed_domain: string;
  proposed_scope: string;
  friendly_domain_name: string;
  friendly_scope_name: string;
  confidence: number;
  explanation: string;
  affected_grant_ids: string[];
  affected_export_ids: string[];
  sharing_impact: {
    active_recipient_count: number;
    recipient_labels: string[];
    enters_next_export_revision: boolean;
    summary: string;
  };
  semantic_contract_version: string;
  source_revision: number;
  confirmation_receipt: {
    version: 2;
    receipt_id: string;
    plan_id: string;
    confirmed_by_user_id: string;
    confirmed_at: string;
    surface: PkmUserConfirmation["surface"];
    displayed_domain: string;
    displayed_scope: string;
    sharing_impact_acknowledged: boolean;
  };
};

function titleize(value: string): string {
  return value
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function opaqueId(kind: "plan" | "receipt"): string {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, "_");
  const entropy = uuid || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `pkm_${kind}_${entropy}`;
}

async function sha256Hex(value: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // Deterministic non-cryptographic fallback used only for the opaque registry
  // lookup handle in restricted test/webview environments.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16).padStart(12, "0");
}

function normalizedScope(manifest: DomainManifest | null | undefined): string {
  return (
    manifest?.top_level_scope_paths?.find((scope) => typeof scope === "string" && scope.trim()) ||
    "profile"
  )
    .trim()
    .toLowerCase();
}

function registryHandle(
  manifest: DomainManifest | null | undefined,
  scope: string
): string | undefined {
  return manifest?.scope_registry?.find((entry) => {
    const projectionScope = String(entry.summary_projection?.top_level_scope_path || "").trim();
    return projectionScope === scope;
  })?.scope_handle;
}

export async function buildConfirmedPkmMutationPlanV2(params: {
  userId: string;
  domain: string;
  currentManifest?: DomainManifest | null;
  targetManifest?: DomainManifest | null;
  operation?: PkmMutationOperation;
  confidence?: number;
  explanation?: string;
  sourceRevision?: number;
  confirmation: PkmUserConfirmation;
}): Promise<PkmMutationPlanV2> {
  if (params.confirmation.confirmedByUser !== true) {
    throw new Error("PKM mutation requires explicit owner confirmation.");
  }

  const domain = params.domain.trim().toLowerCase();
  const scope = normalizedScope(params.targetManifest || params.currentManifest);
  const generatedHandle = `s_${(
    await sha256Hex(`${params.userId}:${domain}:${scope}`)
  ).slice(0, 12)}`;
  const sourceHandle = registryHandle(params.currentManifest, scope) || generatedHandle;
  const targetHandle = registryHandle(params.targetManifest, scope) || sourceHandle;
  const operation = params.operation || (params.currentManifest ? "update" : "create");
  const planId = opaqueId("plan");
  const sharingImpact = params.confirmation.sharingImpact;

  return {
    version: 2,
    plan_id: planId,
    operation,
    ...(operation === "create" ? {} : { source_scope_handle: sourceHandle }),
    ...(operation === "delete" ? {} : { target_scope_handle: targetHandle }),
    proposed_domain: domain,
    proposed_scope: scope,
    friendly_domain_name: titleize(domain),
    friendly_scope_name: titleize(scope),
    confidence: Math.max(0, Math.min(1, params.confidence ?? 1)),
    explanation:
      params.explanation ||
      `The owner reviewed this ${operation} operation for ${titleize(domain)} / ${titleize(scope)}.`,
    affected_grant_ids: sharingImpact?.affectedGrantIds || [],
    affected_export_ids: sharingImpact?.affectedExportIds || [],
    sharing_impact: {
      active_recipient_count: sharingImpact?.activeRecipientCount || 0,
      recipient_labels: sharingImpact?.recipientLabels || [],
      enters_next_export_revision: sharingImpact?.entersNextExportRevision === true,
      summary: sharingImpact?.summary || "No active recipients are affected.",
    },
    semantic_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    source_revision: Math.max(0, params.sourceRevision || 0),
    confirmation_receipt: {
      version: 2,
      receipt_id: opaqueId("receipt"),
      plan_id: planId,
      confirmed_by_user_id: params.userId,
      confirmed_at: params.confirmation.confirmedAt || new Date().toISOString(),
      surface: params.confirmation.surface,
      displayed_domain: domain,
      displayed_scope: scope,
      sharing_impact_acknowledged: params.confirmation.sharingImpactAcknowledged === true,
    },
  };
}
