import {
  canonicalActionBinding,
  type LocalActionContinuation,
} from "@/lib/agent/local-onboarding-actions";

export type CommandContinuationProof = {
  kind: "audience" | "membership";
  operation_id: string;
  snapshot: string;
  total_units: number;
  completed_unit_indices: number[];
  pending_unit_indices: number[];
};

export function commandContinuation(
  value: CommandContinuationProof,
  binding: Record<string, unknown>,
): LocalActionContinuation {
  const limit = value.kind === "membership" ? 250 : 5000;
  const completed = value.completed_unit_indices,
    pending = value.pending_unit_indices;
  const indices =
    Array.isArray(completed) && Array.isArray(pending)
      ? [...completed, ...pending]
      : [];
  const count =
    value.kind === "audience" && Array.isArray(binding.recipientIds)
      ? binding.recipientIds.length
      : value.kind === "membership" && Array.isArray(binding.people)
        ? Math.ceil(
            binding.people.filter((person) => !person.member).length / 20,
          )
        : -1;
  if (
    !["audience", "membership"].includes(value.kind) ||
    !/^[a-f0-9]{64}$/.test(value.operation_id) ||
    !/^[a-f0-9]{64}$/.test(value.snapshot) ||
    !Number.isSafeInteger(value.total_units) ||
    value.total_units < 1 ||
    value.total_units > limit ||
    value.total_units !== count ||
    !pending?.length ||
    indices.length !== count ||
    new Set(indices).size !== count ||
    indices.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= count,
    )
  )
    throw Error(
      "The saved operation's receipt indices could not be verified. Review Location.",
    );
  return {
    kind: value.kind,
    operationId: value.operation_id,
    totalUnits: count,
    completedUnitIndices: [...completed],
    pendingUnitIndices: [...pending],
    originalBinding: binding,
  };
}

/** Select only unperformed people without re-expanding a named Circle. */
export function pendingAudienceBinding(
  binding: Record<string, unknown>,
  continuation?: LocalActionContinuation,
): Record<string, unknown> {
  if (!continuation) return binding;
  if (
    continuation.kind !== "audience" ||
    canonicalActionBinding(binding) !==
      canonicalActionBinding(continuation.originalBinding) ||
    !Array.isArray(binding.recipientIds) ||
    !Array.isArray(binding.people)
  )
    throw Error("The original audience changed. Review the unfinished task.");
  const ids = continuation.pendingUnitIndices.map(
    (index) => (binding.recipientIds as string[])[index]!,
  );
  return {
    ...binding,
    recipientIds: ids,
    people: binding.people.filter((person) => ids.includes(person.id)),
    replacements: Array.isArray(binding.replacements)
      ? binding.replacements.filter((grant) =>
          ids.includes(grant.recipientUserId),
        )
      : [],
    sourceCircleByRecipient: Object.fromEntries(
      Object.entries(binding.sourceCircleByRecipient || {}).filter(([id]) =>
        ids.includes(id),
      ),
    ),
  };
}
