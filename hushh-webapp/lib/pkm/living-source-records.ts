/** Owner-only source provenance. These encrypted projections are derived,
 * not another authority and never an agent/shareable export. */
export interface LivingSourceInput {
  kind: "profile" | "consent";
  id: string;
  value: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface LivingSourceRecord extends LivingSourceInput {
  revision: number;
  capturedAt: string;
  deletedAt: string | null;
}
export interface LivingSourceInventory {
  records: LivingSourceRecord[];
  complete: boolean;
  unavailable: string[];
  observedAt: string;
}
export function reconcileLivingSources(
  previous: LivingSourceInventory | null,
  inputs: LivingSourceInput[],
  successfulKinds: readonly string[],
  unavailable: string[],
  now: string,
): LivingSourceInventory {
  const records = new Map(
    (previous?.records ?? []).map((record) => [
      `${record.kind}:${record.id}`,
      record,
    ]),
  );
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = `${input.kind}:${input.id}`;
    seen.add(key);
    const prior = records.get(key);
    if (
      prior &&
      !prior.deletedAt &&
      JSON.stringify(prior.value) === JSON.stringify(input.value)
    )
      continue;
    records.set(key, {
      ...input,
      createdAt: prior?.createdAt ?? input.createdAt,
      revision: (prior?.revision ?? 0) + 1,
      capturedAt: now,
      deletedAt: null,
    });
  }
  for (const [key, prior] of records) {
    if (
      successfulKinds.includes(prior.kind) &&
      !seen.has(key) &&
      !prior.deletedAt
    ) {
      records.set(key, {
        ...prior,
        value: {},
        revision: prior.revision + 1,
        updatedAt: now,
        capturedAt: now,
        deletedAt: now,
      });
    }
  }
  return {
    records: [...records.values()].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    ),
    complete: unavailable.length === 0,
    unavailable: [...unavailable].sort(),
    observedAt: now,
  };
}
