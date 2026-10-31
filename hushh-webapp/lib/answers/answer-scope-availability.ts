import { hasAnyValue, projectApprovedAnswer, type AnswerPeriod } from "@/lib/answers/answer-projection";
import type { ApprovedMemoryRetrieval } from "@/lib/pkm/memory-scope-retrieval";

export interface AnswerScopeAvailability {
  available: string[];
  missing: string[];
  unavailable: string[];
}

/** Classify exact owner-side scope reads without sending any values to the requester. */
export function answerScopeAvailability(params: {
  scopes: readonly string[];
  retrieval: ApprovedMemoryRetrieval;
  period?: AnswerPeriod | null;
}): AnswerScopeAvailability {
  const scopes = [...new Set(params.scopes)];
  const projected = projectApprovedAnswer({
    approvedScopes: scopes,
    projections: params.retrieval.projections,
    period: params.period,
  });
  const failed = new Set(params.retrieval.unavailableScopes);
  const result: AnswerScopeAvailability = { available: [], missing: [], unavailable: [] };
  for (const scope of scopes) {
    if (failed.has(scope) || !Object.hasOwn(projected.byScope, scope)) {
      result.unavailable.push(scope);
    } else if (hasAnyValue(projected.byScope[scope])) {
      result.available.push(scope);
    } else {
      result.missing.push(scope);
    }
  }
  return result;
}
