import type { OneKycScopeCandidate, OneKycWorkflow } from "@/lib/services/one-kyc-service";

/**
 * Coerce a scope to the canonical `attr.<domain>[.path]` grammar the KYC lane
 * uses. Some workflows persist bare candidate scopes (e.g. `identity.passport`)
 * while `selected_scopes`/`consent_requests` are canonical (`attr.identity.passport`).
 * Without normalization, the UI compares bare vs canonical: checkboxes never
 * appear selected, the eye-icon preview (parseAttrScope) fails, and the scope
 * selection looks "changed". Prefix `attr.` when missing so every consumer sees
 * one consistent form.
 */
// KYC concept -> real identity segment. The LLM routing sometimes emits paths
// that don't exist in the PKM (identity.tax_id, financial.bank_accounts,
// financial.cash_positions). This snaps those onto the segments that actually
// hold the data so the eye-icon preview and the selection checkboxes resolve.
// Applied identically to candidate and selected scopes so they always match.
const KYC_SCOPE_SNAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/passport/, "attr.identity.passport"],
  [/licen[sc]e|driver|(^|[._])dl([._]|$)/, "attr.identity.drivers_license"],
  [/\btax\b|tax_id|ssn|tin|itin|w-?9|w-?8|taxpayer/, "attr.identity.tax"],
  [/bank|account|routing|cash|iban|swift|cheque|check|deposit|payout/, "attr.identity.bank"],
];

export function canonicalKycScope(scope: string): string {
  const value = String(scope || "").trim().toLowerCase();
  if (!value) return value;
  for (const [pattern, mapped] of KYC_SCOPE_SNAP) {
    if (pattern.test(value)) return mapped;
  }
  return value.startsWith("attr.") ? value : `attr.${value}`;
}

export function scopeCandidates(workflow: OneKycWorkflow): OneKycScopeCandidate[] {
  const normalize = (candidates: OneKycScopeCandidate[]): OneKycScopeCandidate[] =>
    candidates.map((candidate) => ({
      ...candidate,
      scope: canonicalKycScope(candidate.scope),
    }));

  const direct = workflow.candidate_scopes;
  if (Array.isArray(direct) && direct.length) return normalize(direct);
  const metadataCandidates = workflow.metadata?.candidate_scopes;
  if (Array.isArray(metadataCandidates)) {
    return normalize(
      metadataCandidates.filter(
        (candidate): candidate is OneKycScopeCandidate =>
          Boolean(candidate && typeof candidate === "object" && "scope" in candidate)
      )
    );
  }
  return workflow.requested_scope
    ? [
        {
          scope: canonicalKycScope(workflow.requested_scope),
          domain: workflow.requested_scope.includes("financial") ? "financial" : "identity",
          label: friendlyScopeLabel(workflow.requested_scope),
        },
      ]
    : [];
}

export function selectedScopesForWorkflow(
  workflow: OneKycWorkflow,
  localSelections: Record<string, string[]>
): string[] {
  const local = localSelections[workflow.workflow_id];
  if (local) return local.map(canonicalKycScope);
  if (Array.isArray(workflow.selected_scopes) && workflow.selected_scopes.length) {
    return workflow.selected_scopes.map(canonicalKycScope);
  }
  if (Array.isArray(workflow.requested_scopes) && workflow.requested_scopes.length) {
    return workflow.requested_scopes.map(canonicalKycScope);
  }
  if (workflow.requested_scope) {
    return [canonicalKycScope(workflow.requested_scope)];
  }
  const recommended = scopeCandidates(workflow)
    .filter((candidate) => candidate.recommended !== false)
    .map((candidate) => candidate.scope);
  if (recommended.length) return recommended;
  return [];
}

export function selectedScopeLabels(workflow: OneKycWorkflow): string[] {
  const selectedScopes = new Set(selectedScopesForWorkflow(workflow, {}));
  return scopeCandidates(workflow)
    .filter((candidate) => selectedScopes.has(candidate.scope))
    .map((candidate) => candidate.label || friendlyScopeLabel(candidate.scope));
}

function friendlyScopeLabel(scope: string): string {
  const parts = scope
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "attr" && part !== "*");
  if (!parts.length) return "Selected information";
  const text = parts.join(" ").replaceAll("_", " ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} information`;
}

export function detectedDomains(workflow: OneKycWorkflow): string[] {
  const fromCandidates = scopeCandidates(workflow)
    .map((candidate) => candidate.domain)
    .filter(Boolean);
  if (fromCandidates.length) return Array.from(new Set(fromCandidates));
  const metadata = workflow.metadata?.detected_domains;
  return Array.isArray(metadata) ? metadata.map(String) : [];
}

export function isKycClientDraftReady(workflow: OneKycWorkflow): boolean {
  return workflow.status === "waiting_on_user" && workflow.draft_status === "ready";
}

function normalizedConsentAction(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function metadataArray(workflow: OneKycWorkflow, key: string): unknown[] {
  const value = workflow.metadata?.[key];
  return Array.isArray(value) ? value : [];
}

export function hasApprovedKycWorkflowAccess(workflow: OneKycWorkflow): boolean {
  if (isKycClientDraftReady(workflow)) return true;
  const consentRequests = workflow.consent_requests || [];
  if (
    consentRequests.length > 0 &&
    consentRequests.every((request) => normalizedConsentAction(request.status) === "GRANTED")
  ) {
    return true;
  }
  const metadataRequests = metadataArray(workflow, "consent_requests");
  if (
    metadataRequests.length > 0 &&
    metadataRequests.every(
      (request) =>
        request &&
        typeof request === "object" &&
        normalizedConsentAction((request as Record<string, unknown>).status) === "GRANTED"
    )
  ) {
    return true;
  }
  const statuses = metadataArray(workflow, "consent_statuses");
  return (
    statuses.length > 0 &&
    statuses.every(
      (status) =>
        status &&
        typeof status === "object" &&
        normalizedConsentAction((status as Record<string, unknown>).action) === "CONSENT_GRANTED"
    )
  );
}

export function needsKycWorkflowAccessApproval(workflow: OneKycWorkflow): boolean {
  return workflow.status === "needs_scope" && !hasApprovedKycWorkflowAccess(workflow);
}

export function removeKycWorkflowLocalState<T>(
  current: Record<string, T>,
  workflowId: string
): Record<string, T> {
  if (!(workflowId in current)) return current;
  const next = { ...current };
  delete next[workflowId];
  return next;
}

export function retainReadyKycWorkflowLocalState<T>(
  current: Record<string, T>,
  workflows: OneKycWorkflow[]
): Record<string, T> {
  const readyWorkflowIds = new Set(
    workflows.filter(isKycClientDraftReady).map((workflow) => workflow.workflow_id)
  );
  const entries = Object.entries(current).filter(([workflowId]) => readyWorkflowIds.has(workflowId));
  if (entries.length === Object.keys(current).length) return current;
  return Object.fromEntries(entries) as Record<string, T>;
}
