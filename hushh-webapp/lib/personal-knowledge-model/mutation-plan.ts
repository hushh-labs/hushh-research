import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { CURRENT_PKM_CONTRACT_VERSION } from "@/lib/personal-knowledge-model/upgrade-contracts";

export type PkmMutationOperation = "create" | "update" | "move" | "merge" | "delete";

export type PkmUserConfirmation = {
  confirmedByUser: true;
  authorizationMode?: never;
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

/**
 * A per-vault policy that the owner explicitly enabled in Memory. This is
 * deliberately distinct from a review-button confirmation in the receipt so
 * audits never claim that the owner reviewed an individual automatic write.
 */
export type PkmOwnerAutoSaveAuthorization = {
  authorizationMode: "owner_auto_save_policy";
  confirmedByUser?: never;
  surface: "chat" | "voice";
  source: string;
  autoSavePolicyVersion: 1;
  autoSavePolicyEnabledAt: string;
};

export type PkmWriteAuthorization = PkmUserConfirmation | PkmOwnerAutoSaveAuthorization;

export function isOwnerAutoSaveAuthorization(
  authorization: PkmWriteAuthorization
): authorization is PkmOwnerAutoSaveAuthorization {
  return Boolean(
    authorization &&
      "authorizationMode" in authorization &&
      authorization.authorizationMode === "owner_auto_save_policy"
  );
}

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
  writer_id: string;
  structure_agent_id: string;
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
    authorization_mode: "owner_confirmed" | "owner_auto_save_policy";
    auto_save_policy_version?: 1;
    auto_save_policy_enabled_at?: string;
  };
};

const MACHINE_PROVENANCE_ID = /^[a-z][a-z0-9_.:-]{0,127}$/;

function normalizedWriterId(value: string): string {
  const candidate = String(value || "").trim().toLowerCase();
  return MACHINE_PROVENANCE_ID.test(candidate) ? candidate : "owner_confirmed_write";
}

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

function normalizedScope(params: {
  currentManifest?: DomainManifest | null;
  targetManifest?: DomainManifest | null;
  scopePath?: string;
}): string {
  const [requestedScopePart = ""] = String(params.scopePath || "").trim().split(".", 1);
  const requestedScope = requestedScopePart.toLowerCase();
  const allowedScopes = new Set(
    [params.currentManifest, params.targetManifest]
      .flatMap((manifest) => manifest?.top_level_scope_paths || [])
      .map((scope) => {
        const [topLevelScope = ""] = String(scope || "").trim().split(".", 1);
        return topLevelScope.toLowerCase();
      })
      .filter(Boolean)
  );
  if (requestedScope) {
    if (allowedScopes.size > 0 && !allowedScopes.has(requestedScope)) {
      throw new Error("The confirmed PKM scope is not present in the current manifest.");
    }
    return requestedScope;
  }
  return allowedScopes.values().next().value || "profile";
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
  scopePath?: string;
  operation?: PkmMutationOperation;
  confidence?: number;
  explanation?: string;
  sourceRevision?: number;
  confirmation: PkmWriteAuthorization;
}): Promise<PkmMutationPlanV2> {
  const automatic = isOwnerAutoSaveAuthorization(params.confirmation);
  const automaticAuthorization = automatic
    ? params.confirmation as PkmOwnerAutoSaveAuthorization
    : null;
  const ownerConfirmation = automatic
    ? null
    : params.confirmation as PkmUserConfirmation;
  if (!automatic && params.confirmation.confirmedByUser !== true) {
    throw new Error("PKM mutation requires explicit owner confirmation.");
  }

  const domain = params.domain.trim().toLowerCase();
  const scope = normalizedScope({
    currentManifest: params.currentManifest,
    targetManifest: params.targetManifest,
    scopePath: params.scopePath,
  });
  const generatedHandle = `s_${(
    await sha256Hex(`${params.userId}:${domain}:${scope}`)
  ).slice(0, 12)}`;
  const sourceHandle = registryHandle(params.currentManifest, scope) || generatedHandle;
  const targetHandle = registryHandle(params.targetManifest, scope) || sourceHandle;
  const operation = params.operation || (params.currentManifest ? "update" : "create");
  if (automatic && operation === "delete") {
    throw new Error("Automatic PKM saving cannot delete saved information.");
  }
  const planId = opaqueId("plan");
  const sharingImpact = ownerConfirmation?.sharingImpact;
  const confirmedAt = automatic
    ? new Date().toISOString()
    : ownerConfirmation?.confirmedAt || new Date().toISOString();

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
      (automatic
        ? `The owner enabled automatic saving for this eligible ${operation} operation in ${titleize(domain)} / ${titleize(scope)}.`
        : `The owner reviewed this ${operation} operation for ${titleize(domain)} / ${titleize(scope)}.`),
    affected_grant_ids: sharingImpact?.affectedGrantIds || [],
    affected_export_ids: sharingImpact?.affectedExportIds || [],
    sharing_impact: {
      active_recipient_count: sharingImpact?.activeRecipientCount || 0,
      recipient_labels: sharingImpact?.recipientLabels || [],
      enters_next_export_revision: sharingImpact?.entersNextExportRevision === true,
      summary: sharingImpact?.summary || "No active recipients are affected.",
    },
    semantic_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    writer_id: normalizedWriterId(params.confirmation.source),
    structure_agent_id: "pkm_structure_agent",
    source_revision: Math.max(0, params.sourceRevision || 0),
    confirmation_receipt: {
      version: 2,
      receipt_id: opaqueId("receipt"),
      plan_id: planId,
      confirmed_by_user_id: params.userId,
      confirmed_at: confirmedAt,
      surface: params.confirmation.surface,
      displayed_domain: domain,
      displayed_scope: scope,
      sharing_impact_acknowledged:
        ownerConfirmation?.sharingImpactAcknowledged === true,
      authorization_mode: automatic ? "owner_auto_save_policy" : "owner_confirmed",
      ...(automatic
        ? {
            auto_save_policy_version: automaticAuthorization!.autoSavePolicyVersion,
            auto_save_policy_enabled_at: automaticAuthorization!.autoSavePolicyEnabledAt,
          }
        : {}),
    },
  };
}
