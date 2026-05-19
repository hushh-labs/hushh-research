import type { OneKycScopeCandidate, OneKycWorkflow } from "@/lib/services/one-kyc-service";

export function scopeCandidates(workflow: OneKycWorkflow): OneKycScopeCandidate[] {
  const direct = workflow.candidate_scopes;
  if (Array.isArray(direct) && direct.length) return direct;
  const metadataCandidates = workflow.metadata?.candidate_scopes;
  if (Array.isArray(metadataCandidates)) {
    return metadataCandidates.filter(
      (candidate): candidate is OneKycScopeCandidate =>
        Boolean(candidate && typeof candidate === "object" && "scope" in candidate)
    );
  }
  return workflow.requested_scope
    ? [
        {
          scope: workflow.requested_scope,
          domain: workflow.requested_scope.includes("financial") ? "financial" : "identity",
          label: workflow.requested_scope,
        },
      ]
    : [];
}

export function selectedScopesForWorkflow(
  workflow: OneKycWorkflow,
  localSelections: Record<string, string[]>
): string[] {
  const local = localSelections[workflow.workflow_id];
  if (local) return local;
  if (Array.isArray(workflow.selected_scopes) && workflow.selected_scopes.length) {
    return workflow.selected_scopes;
  }
  if (Array.isArray(workflow.requested_scopes) && workflow.requested_scopes.length) {
    return workflow.requested_scopes;
  }
  if (workflow.requested_scope) {
    return [workflow.requested_scope];
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
    .map((candidate) => candidate.label || candidate.scope);
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
