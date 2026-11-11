import {
  LIVING_VERIFICATION_PERSIST_MS,
  type LivingSourceInput,
  type LivingSourceInventory,
  type LivingSourceRecord,
} from "@/lib/pkm/living-source-records";

/**
 * An in-memory, owner-only lookup over an already decrypted source inventory.
 * It is not a source of truth, an answer or a sharing grant. The owner's own
 * private agent receives only the bounded, allowlisted Live Mirror packet
 * built from it on a consented, unlocked turn; nothing here is shareable.
 * Callers must retain the existing vault and owner-session fences.
 */
type SourceKind = LivingSourceInput["kind"];
type FactValue = string | number | boolean;
export type LivingFactStatus = "verified" | "stale" | "deleted" | "conflicted";

export interface LivingFactProvenance {
  kind: SourceKind;
  sourceId: string;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
  capturedAt: string;
  verifiedAt: string | null;
}

export interface LivingFactNode {
  /** JSON tuple avoids collisions between source IDs and field names. */
  key: string;
  predicate: string;
  value: FactValue | null;
  status: LivingFactStatus;
  provenance: LivingFactProvenance;
}

export interface OwnerLivingFactIndex {
  observedAt: string;
  complete: boolean;
  issues: readonly ("inventory_incomplete" | "invalid_record" | "owner_mismatch" | "conflict" | "source_stale")[];
  nodes: readonly LivingFactNode[];
  byPredicate: ReadonlyMap<string, readonly LivingFactNode[]>;
}

// Explicitly admitted fields. New source values never silently become facts.
// Age, sex, date of birth, coordinates, OAuth material and document content
// have no entry here; a model must not infer them from name, photo or activity.
const FIELDS = {
  profile: ["name", "photo", "email"],
  consent: ["scope", "status", "active", "counterpart", "expiresAt", "action"],
  connection: ["counterpartId", "establishedAt", "connectedFromContacts"],
  curated_oauth_connector: ["provider", "status", "connectedAt", "authStyle"],
  document_earning: ["stripeMode", "status", "grossCents", "refundCents", "netCents", "createdAt", "transferredAt", "settlementMethod"],
  payout_activity: ["kind", "mode", "occurredAt", "updatedAt", "amountCents", "coinsDelta", "status", "reversalStatus", "expectedArrivalAt", "type"],
  document_request_payment: ["counterpartRef", "mode", "status", "amountCents", "currency", "paidAt", "refundStatus", "refundAmountCents", "reconciliationRequired"],
} as const satisfies Record<SourceKind, readonly string[]>;

/** The admitted field allowlist, shared by every Live Mirror consumer. */
export const LIVING_SOURCE_FACT_FIELDS: { readonly [K in SourceKind]: readonly string[] } = FIELDS;

/** Plain owner-facing labels for the admitted fields. Display only. */
export const LIVING_SOURCE_FIELD_LABELS = {
  profile: { name: "Name", photo: "Photo", email: "Email" },
  consent: {
    scope: "Scope", status: "Status", active: "Active", counterpart: "Shared with",
    expiresAt: "Expires", action: "Last action",
  },
  connection: { counterpartId: "Person", establishedAt: "Connected", connectedFromContacts: "From contacts" },
  curated_oauth_connector: { provider: "App", status: "Status", connectedAt: "Connected", authStyle: "Sign-in type" },
  document_earning: {
    stripeMode: "Mode", status: "Status", grossCents: "Gross", refundCents: "Refunded",
    netCents: "Net", createdAt: "Created", transferredAt: "Paid out", settlementMethod: "Payout method",
  },
  payout_activity: {
    kind: "Activity", mode: "Mode", occurredAt: "Happened", updatedAt: "Updated", amountCents: "Amount",
    coinsDelta: "Coins", status: "Status", reversalStatus: "Reversal", expectedArrivalAt: "Expected", type: "Type",
  },
  document_request_payment: {
    counterpartRef: "Person", mode: "Mode", status: "Status", amountCents: "Amount", currency: "Currency",
    paidAt: "Paid", refundStatus: "Refund", refundAmountCents: "Refunded", reconciliationRequired: "Needs check",
  },
} as const satisfies { readonly [K in SourceKind]: Readonly<Record<(typeof FIELDS)[K][number], string>> };

const MAX_VERIFICATION_AGE_MS = 5 * 60_000;
const MAX_FACT_STRING_LENGTH = 2_048;

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && Object.hasOwn(FIELDS, value);
}

function isValidSourceRecord(value: unknown): value is LivingSourceRecord {
  if (!isRecord(value)) return false;
  return isSourceKind(value.kind) && typeof value.id === "string" && value.id.length > 0 &&
    Number.isSafeInteger(value.revision) && Number(value.revision) > 0 &&
    isRecord(value.value) && isDate(value.capturedAt) &&
    (value.createdAt === null || isDate(value.createdAt)) &&
    (value.updatedAt === null || isDate(value.updatedAt)) &&
    (value.deletedAt === null || isDate(value.deletedAt));
}

function isFactValue(value: unknown): value is FactValue {
  return typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value) ||
    typeof value === "string" && value.length <= MAX_FACT_STRING_LENGTH;
}

/** A time up to the clock tolerance ahead was stored by a device whose clock runs
 * ahead of this one; it is current, as it is in the Live Mirror. */
function isFresh(at: string | null, now: number): boolean {
  const age = at === null ? NaN : now - Date.parse(at);
  return Number.isFinite(age) && age >= -LIVING_VERIFICATION_PERSIST_MS && age <= MAX_VERIFICATION_AGE_MS;
}

function provenance(record: LivingSourceRecord, verifiedAt: string | null): LivingFactProvenance {
  return {
    kind: record.kind,
    sourceId: record.id,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capturedAt: record.capturedAt,
    verifiedAt,
  };
}

function fact(record: LivingSourceRecord, field: string, value: FactValue | null,
  status: LivingFactStatus, verifiedAt: string | null): LivingFactNode {
  return {
    key: JSON.stringify([record.kind, record.id, field]),
    predicate: `${record.kind}.${field}`,
    value,
    status,
    provenance: provenance(record, verifiedAt),
  };
}

/**
 * Build a bounded-field fact lookup from admitted, owner-scoped records.
 * Later source revisions supersede earlier ones. Conflicting values at the
 * same revision produce no selected value; a tombstone hides prior facts.
 */
export function buildOwnerLivingFactIndex(params: {
  expectedOwnerId: string;
  inventory: LivingSourceInventory;
  now: string;
}): OwnerLivingFactIndex {
  const now = Date.parse(params.now);
  if (!Number.isFinite(now) || !params.expectedOwnerId)
    throw new Error("A valid owner and verification time are required");

  const issues = new Set<OwnerLivingFactIndex["issues"][number]>();
  if (!params.inventory.complete) issues.add("inventory_incomplete");
  const grouped = new Map<string, LivingSourceRecord[]>();
  for (const candidate of params.inventory.records) {
    if (!isValidSourceRecord(candidate)) {
      issues.add("invalid_record");
      continue;
    }
    if (candidate.kind === "profile" && candidate.id !== params.expectedOwnerId) {
      issues.add("owner_mismatch");
      continue;
    }
    const key = JSON.stringify([candidate.kind, candidate.id]);
    const versions = grouped.get(key) ?? [];
    versions.push(candidate);
    grouped.set(key, versions);
  }
  if (issues.has("owner_mismatch")) grouped.clear();

  const nodes: LivingFactNode[] = [];
  for (const versions of grouped.values()) {
    const highestRevision = versions.reduce((highest, row) => Math.max(highest, row.revision), 0);
    const latest = versions.filter(row => row.revision === highestRevision);
    const chosen = latest[0]!;
    const signatures = new Set(latest.map(row => JSON.stringify([row.deletedAt !== null, row.value])));
    const verifiedAt = chosen.kind === "profile"
      ? params.inventory.observedAt
      : params.inventory.verifiedAt?.[chosen.kind] ?? null;
    if (signatures.size > 1) {
      issues.add("conflict");
      nodes.push(fact(chosen, "__record", null, "conflicted", verifiedAt));
      continue;
    }
    if (chosen.deletedAt !== null) {
      nodes.push(fact(chosen, "__record", null, "deleted", verifiedAt));
      continue;
    }
    const status: LivingFactStatus = params.inventory.unavailable.includes(chosen.kind) ||
      !isFresh(verifiedAt, now) ? "stale" : "verified";
    if (status === "stale") issues.add("source_stale");
    nodes.push(fact(chosen, "__record", true, status, verifiedAt));
    for (const field of FIELDS[chosen.kind]) {
      const value = chosen.value[field];
      if (value === null || value === undefined) continue;
      if (!isFactValue(value)) {
        issues.add("invalid_record");
        continue;
      }
      nodes.push(fact(chosen, field, value, status, verifiedAt));
    }
  }
  nodes.sort((left, right) => left.key.localeCompare(right.key));
  const byPredicate = new Map<string, LivingFactNode[]>();
  for (const node of nodes) {
    const bucket = byPredicate.get(node.predicate) ?? [];
    bucket.push(node);
    byPredicate.set(node.predicate, bucket);
  }
  return {
    observedAt: params.inventory.observedAt,
    complete: issues.size === 0,
    issues: [...issues].sort(),
    nodes,
    byPredicate,
  };
}
