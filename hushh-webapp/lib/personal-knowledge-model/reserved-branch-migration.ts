/**
 * PKM upgrade step 5: move agent-written entries out of app-owned branches.
 *
 * Before the reserved-branch registry (`contracts/pkm/reserved-branches.v1.json`)
 * existed, the chat memory pipeline could file a fact inside a branch an app
 * feature owns, such as `financial.profile` or `location.saved_places`. Those
 * entries now belong in the entry's `agent_memory` sibling, where the Memory
 * screen can edit them and the owning feature's data stays its own.
 *
 * The step is deterministic and conservative:
 *
 * - **Agent-written** (moved to the sibling): a member of an `entities` map whose
 *   key is a memory-agent id (`mem_<hash>`, `_stable_entity_id` in
 *   `pkm_agent_lab_service.py`), or whose value has the whole memory-agent entity
 *   shape (`summary`, `kind` and an `observations` list, `_build_entity_record`).
 *   No app writer produces either.
 * - **App-written** (kept exactly in place): everything else.
 * - **Ambiguous** (quarantined, never moved): an agent marker that contradicts
 *   itself or its provenance. A partial entity shape, a `mem_` key whose value is
 *   not an object, an agent-shaped entry stamped with an app feature's writer
 *   label, a list item carrying `observations` (a list has no keyed home in the
 *   sibling), an entry whose sibling already holds a different value, or a
 *   reserved entry whose sibling is in another domain or absent.
 *
 * Provenance the device can see is the decrypted blob itself. `pkm_events` has no
 * per-path writer and no client read route, so the cross-check is the entry's
 * own `source` / `writer_id` / `source_agent` label, judged against the closed
 * writer catalog.
 *
 * Every occurrence that changes place is reported as lineage, so the upgrade
 * gate proves zero loss at the occurrence level. A supersede history
 * (`entities.superseded.<id>`, `pkm-supersede-merge.ts`) travels with its entity.
 * Quarantine keeps the exact value under `__quarantine_v1`, keyed by where it
 * came from, so a reviewed release can restore it. Running the step again
 * finds nothing to do.
 *
 * Pure: no I/O, no logging, no clock. Labels only ever leave through the report.
 */

import {
  PKM_QUARANTINE_SEGMENT_ID,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import {
  reservedEntryFor,
  writer as catalogWriter,
  type ReservedEntry,
  WILDCARD_BRANCH,
} from "@/lib/pkm/reserved-branches";

export const RESERVED_MIGRATION_QUARANTINE_KEY = "reserved_branch_migration_v1" as const;

const ENTITY_MAP_KEY = "entities";
const HISTORY_KEY = "superseded";
const MEMORY_AGENT_ID = /^mem_[a-z0-9_]+$/i;
const PROVENANCE_KEYS = ["source", "writer_id", "source_agent"] as const;

export type ReservedMigrationClassification =
  | "moved"
  | "equal_value_deduplicated"
  | "quarantined";

export type ReservedMigrationReason =
  | "agent_entity_id"
  | "agent_entity_shape"
  | "ambiguous_partial_entity_shape"
  | "ambiguous_non_object_agent_entry"
  | "ambiguous_feature_provenance"
  | "ambiguous_list_item"
  | "sibling_collision"
  | "sibling_in_other_domain"
  | "no_sibling";

export type ReservedMigrationOccurrenceLineage = {
  sourcePointer: string;
  targetPointer: string;
  classification: ReservedMigrationClassification;
};

/** One relocated node. Paths and labels only, never a stored value. */
export type ReservedMigrationItem = {
  sourcePointer: string;
  targetPointer: string;
  classification: ReservedMigrationClassification;
  reason: ReservedMigrationReason;
  occurrences: number;
};

export type ReservedMigrationReport = {
  schemaVersion: "pkm_reserved_branch_migration.v1";
  domain: string;
  /** Agent entries moved into the sibling (entity count). */
  moved: number;
  /** Agent entries already present, equal, in the sibling. */
  deduplicated: number;
  /** Ambiguous entries preserved under `__quarantine_v1`. */
  quarantined: number;
  /** Leaf occurrences inside reserved branches that stayed exactly in place. */
  keptOccurrences: number;
  movedOccurrences: number;
  deduplicatedOccurrences: number;
  quarantinedOccurrences: number;
  /** App list occurrences whose index shifted because an ambiguous item left the list. */
  reindexedOccurrences: number;
  items: ReservedMigrationItem[];
};

export type ReservedMigrationResult = {
  domainData: Record<string, unknown>;
  lineage: ReservedMigrationOccurrenceLineage[];
  report: ReservedMigrationReport;
};

type Segment = string | number;

type Candidate =
  | { kind: "entity"; path: Segment[]; entry: ReservedEntry; reason: ReservedMigrationReason }
  | { kind: "list_item"; path: Segment[]; entry: ReservedEntry };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function escapePointer(segment: Segment): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointer(path: readonly Segment[]): string {
  return path.map((segment) => `/${escapePointer(segment)}`).join("");
}

function dotted(path: readonly Segment[]): string {
  return path.filter((segment): segment is string => typeof segment === "string").join(".");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

/** Every JSON leaf (and empty container) under `value`, as pointers relative to it. */
function relativeOccurrences(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix];
    return value.flatMap((item, index) => relativeOccurrences(item, `${prefix}/${index}`));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [prefix];
    return entries.flatMap(([key, child]) => relativeOccurrences(child, `${prefix}/${escapePointer(key)}`));
  }
  return [prefix];
}

function valueAt(root: unknown, path: readonly Segment[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (Array.isArray(cursor) && typeof segment === "number") cursor = cursor[segment];
    else if (isRecord(cursor) && typeof segment === "string") cursor = cursor[segment];
    else return undefined;
  }
  return cursor;
}

function provenanceLabels(value: Record<string, unknown>): string[] {
  return PROVENANCE_KEYS.map((key) => value[key])
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    .map((label) => label.trim().toLowerCase());
}

/** True when the entry names an app feature (or the upgrade) as its writer. */
function hasFeatureProvenance(value: Record<string, unknown>): boolean {
  return provenanceLabels(value).some((label) => {
    const catalogued = catalogWriter(label);
    return catalogued !== null && catalogued.writerClass !== "memory_agent";
  });
}

function hasObservations(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.observations);
}

function hasFullEntityShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    typeof value.kind === "string" &&
    Array.isArray(value.observations)
  );
}

/**
 * Classify one member of an `entities` map. `null` means app-written: no agent
 * marker at all, so the walk continues inside it.
 */
function classifyEntity(key: string, value: unknown): ReservedMigrationReason | null {
  const agentId = MEMORY_AGENT_ID.test(key);
  if (!agentId && !hasObservations(value)) return null;
  if (!isRecord(value)) return "ambiguous_non_object_agent_entry";
  if (hasFeatureProvenance(value)) return "ambiguous_feature_provenance";
  if (agentId) return "agent_entity_id";
  return hasFullEntityShape(value) ? "agent_entity_shape" : "ambiguous_partial_entity_shape";
}

/** The reserved branch root of `path` under `entry`: the prefix, or the top key for `*`. */
function branchRootLength(entry: ReservedEntry): number {
  return entry.branchPrefix === WILDCARD_BRANCH ? 1 : entry.branchPrefix.split(".").length;
}

/** Sibling branches of this domain that the walk must never treat as reserved data. */
function protectedTopLevelKeys(domain: string, data: Record<string, unknown>): Set<string> {
  const keys = new Set<string>([PKM_QUARANTINE_SEGMENT_ID]);
  for (const key of Object.keys(data)) {
    const entry = reservedEntryFor(domain, key);
    const sibling = entry?.agentMemorySibling ?? null;
    if (!sibling) continue;
    const [siblingDomain, ...rest] = sibling.split(".");
    if (siblingDomain === domain && rest.length) keys.add(rest.join("."));
  }
  // A sibling branch is never itself reserved (it is an `except` or outside
  // every prefix), but name it explicitly so a contract edit cannot make the
  // walk consume the very place it moves things into.
  keys.add("agent_memory");
  return keys;
}

function collectCandidates(domain: string, data: Record<string, unknown>): Candidate[] {
  const candidates: Candidate[] = [];
  const skipTop = protectedTopLevelKeys(domain, data);

  const visit = (value: unknown, path: Segment[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemPath = [...path, index];
        const entry = reservedEntryFor(domain, dotted(itemPath));
        if (entry && hasObservations(item)) {
          candidates.push({ kind: "list_item", path: itemPath, entry });
          return;
        }
        visit(item, itemPath);
      });
      return;
    }
    if (!isRecord(value)) return;
    const parentKey = path[path.length - 1];
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 0 && skipTop.has(key)) continue;
      if (key === HISTORY_KEY) continue;
      const childPath = [...path, key];
      if (parentKey === ENTITY_MAP_KEY) {
        const entry = reservedEntryFor(domain, dotted(childPath));
        const reason = entry ? classifyEntity(key, child) : null;
        if (entry && reason) {
          candidates.push({ kind: "entity", path: childPath, entry, reason });
          continue;
        }
      }
      visit(child, childPath);
    }
  };

  visit(data, []);
  return candidates;
}

function ensureContainer(root: Record<string, unknown>, path: readonly Segment[]): Record<string, unknown> | null {
  let cursor: Record<string, unknown> = root;
  for (const rawSegment of path) {
    const segment = String(rawSegment);
    const next = cursor[segment];
    if (next === undefined) {
      cursor[segment] = {};
    } else if (!isRecord(next)) {
      return null;
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  return cursor;
}

function deleteKey(root: Record<string, unknown>, path: readonly Segment[]): void {
  const parent = valueAt(root, path.slice(0, -1));
  if (isRecord(parent)) delete parent[String(path[path.length - 1])];
}

/** Drop an `entities` map, or its history map, only when this step emptied it. */
function pruneEmptied(root: Record<string, unknown>, mapPath: readonly Segment[]): void {
  const history = valueAt(root, [...mapPath, HISTORY_KEY]);
  if (isRecord(history) && Object.keys(history).length === 0) deleteKey(root, [...mapPath, HISTORY_KEY]);
  const map = valueAt(root, mapPath);
  if (isRecord(map) && Object.keys(map).length === 0) deleteKey(root, mapPath);
}

/**
 * Move every agent-written entry out of `domain`'s reserved branches.
 * Idempotent: a second run over its own output returns it unchanged.
 */
export function relocateAgentEntriesFromReservedBranches(params: {
  domain: string;
  domainData: Record<string, unknown>;
}): ReservedMigrationResult {
  const domain = String(params.domain || "").trim().toLowerCase();
  const source = params.domainData;
  const next = clone(source);
  const lineage: ReservedMigrationOccurrenceLineage[] = [];
  const items: ReservedMigrationItem[] = [];
  const touchedMaps = new Map<string, Segment[]>();
  const candidates = collectCandidates(domain, source);

  const record = (
    sourcePath: readonly Segment[],
    targetPath: readonly Segment[],
    classification: ReservedMigrationClassification,
    reason: ReservedMigrationReason,
    value: unknown,
  ): void => {
    const relative = relativeOccurrences(value);
    for (const rel of relative) {
      lineage.push({
        sourcePointer: `${pointer(sourcePath)}${rel}`,
        targetPointer: `${pointer(targetPath)}${rel}`,
        classification,
      });
    }
    items.push({
      sourcePointer: pointer(sourcePath),
      targetPointer: pointer(targetPath),
      classification,
      reason,
      occurrences: relative.length,
    });
  };

  const quarantine = (sourcePath: readonly Segment[], reason: ReservedMigrationReason, value: unknown): void => {
    const store = ensureContainer(next, [PKM_QUARANTINE_SEGMENT_ID, RESERVED_MIGRATION_QUARANTINE_KEY]);
    if (!store) throw new Error("PKM quarantine storage is not an object; refusing to relocate.");
    const base = pointer(sourcePath);
    const holdsEqual = (slot: unknown) => isRecord(slot) && jsonEqual(slot.value, value);
    let key = base;
    for (let attempt = 2; store[key] !== undefined && !holdsEqual(store[key]); attempt += 1) {
      key = `${base}#${attempt}`;
    }
    const recordPath = [PKM_QUARANTINE_SEGMENT_ID, RESERVED_MIGRATION_QUARANTINE_KEY, key, "value"];
    if (store[key] !== undefined) {
      record(sourcePath, recordPath, "equal_value_deduplicated", reason, value);
      return;
    }
    store[key] = { reason, source_pointer: base, value: clone(value) };
    record(sourcePath, recordPath, "quarantined", reason, value);
  };

  /** Place `value` at `targetPath`: new, equal (deduplicated), or a collision. */
  const place = (
    sourcePath: readonly Segment[],
    targetPath: readonly Segment[],
    reason: ReservedMigrationReason,
    value: unknown,
  ): "placed" | "collision" => {
    const container = ensureContainer(next, targetPath.slice(0, -1));
    const leafKey = String(targetPath[targetPath.length - 1]);
    if (!container) return "collision";
    if (container[leafKey] === undefined) {
      container[leafKey] = clone(value);
      record(sourcePath, targetPath, "moved", reason, value);
      return "placed";
    }
    if (jsonEqual(container[leafKey], value)) {
      record(sourcePath, targetPath, "equal_value_deduplicated", reason, value);
      return "placed";
    }
    return "collision";
  };

  const listRemovals = new Map<string, { arrayPath: Segment[]; indices: number[] }>();

  for (const candidate of candidates) {
    if (candidate.kind === "list_item") {
      const arrayPath = candidate.path.slice(0, -1);
      const index = candidate.path[candidate.path.length - 1] as number;
      quarantine(candidate.path, "ambiguous_list_item", valueAt(source, candidate.path));
      const key = pointer(arrayPath);
      const pending = listRemovals.get(key) ?? { arrayPath, indices: [] };
      pending.indices.push(index);
      listRemovals.set(key, pending);
      continue;
    }

    const path = candidate.path;
    const value = valueAt(source, path);
    const mapPath = path.slice(0, -1);
    const entityKey = String(path[path.length - 1]);
    const historyPath = [...mapPath, HISTORY_KEY, entityKey];
    const history = valueAt(source, historyPath);
    touchedMaps.set(pointer(mapPath), mapPath);
    deleteKey(next, path);
    if (history !== undefined) deleteKey(next, historyPath);

    const sibling = candidate.entry.agentMemorySibling;
    const [siblingDomain, ...siblingRest] = (sibling ?? "").split(".");
    const isAgent = candidate.reason === "agent_entity_id" || candidate.reason === "agent_entity_shape";
    let reason: ReservedMigrationReason = candidate.reason;
    // An entity inside a list has no keyed home in the sibling.
    if (isAgent && path.some((segment) => typeof segment === "number")) reason = "ambiguous_list_item";
    else if (isAgent && !sibling) reason = "no_sibling";
    else if (isAgent && siblingDomain !== domain) reason = "sibling_in_other_domain";

    if (reason !== candidate.reason || !isAgent) {
      quarantine(path, reason, value);
      if (history !== undefined) quarantine(historyPath, reason, history);
      continue;
    }

    const rest = path.slice(branchRootLength(candidate.entry));
    const targetPath = [...siblingRest, ...rest];
    if (place(path, targetPath, reason, value) === "collision") {
      quarantine(path, "sibling_collision", value);
      if (history !== undefined) quarantine(historyPath, "sibling_collision", history);
      continue;
    }
    if (history !== undefined) {
      const targetHistory = [...targetPath.slice(0, -1), HISTORY_KEY, entityKey];
      if (place(historyPath, targetHistory, reason, history) === "collision") {
        quarantine(historyPath, "sibling_collision", history);
      }
    }
  }

  // List items leave last, highest index first, and every app item that
  // follows one shifts down. That shift is recorded, never assumed.
  let reindexedOccurrences = 0;
  const alreadyRelocated = new Set(lineage.map((entry) => entry.sourcePointer));
  for (const { arrayPath, indices } of listRemovals.values()) {
    const original = valueAt(source, arrayPath);
    const target = valueAt(next, arrayPath);
    if (!Array.isArray(original) || !Array.isArray(target)) continue;
    const removed = new Set(indices);
    for (const index of [...removed].sort((a, b) => b - a)) target.splice(index, 1);
    let shift = 0;
    original.forEach((item, index) => {
      if (removed.has(index)) {
        shift += 1;
        return;
      }
      if (shift === 0) return;
      for (const rel of relativeOccurrences(item)) {
        if (alreadyRelocated.has(`${pointer([...arrayPath, index])}${rel}`)) continue;
        lineage.push({
          sourcePointer: `${pointer([...arrayPath, index])}${rel}`,
          targetPointer: `${pointer([...arrayPath, index - shift])}${rel}`,
          classification: "moved",
        });
        reindexedOccurrences += 1;
      }
    });
  }

  for (const mapPath of touchedMaps.values()) pruneEmptied(next, mapPath);

  const relocated = new Set(lineage.map((entry) => entry.sourcePointer));
  const keptOccurrences = reservedLeafPointers(domain, source).filter((leaf) => !relocated.has(leaf)).length;
  const sum = (classification: ReservedMigrationClassification, field: "count" | "occurrences") =>
    items
      .filter((item) => item.classification === classification)
      .reduce((total, item) => total + (field === "count" ? 1 : item.occurrences), 0);

  return {
    domainData: next,
    lineage,
    report: {
      schemaVersion: "pkm_reserved_branch_migration.v1",
      domain,
      moved: sum("moved", "count"),
      deduplicated: sum("equal_value_deduplicated", "count"),
      quarantined: sum("quarantined", "count"),
      keptOccurrences,
      movedOccurrences: sum("moved", "occurrences"),
      deduplicatedOccurrences: sum("equal_value_deduplicated", "occurrences"),
      quarantinedOccurrences: sum("quarantined", "occurrences"),
      reindexedOccurrences,
      items,
    },
  };
}

/** Leaf pointers that sit inside a reserved branch (sibling and quarantine excluded). */
function reservedLeafPointers(domain: string, data: Record<string, unknown>): string[] {
  const skipTop = protectedTopLevelKeys(domain, data);
  const leaves: string[] = [];
  const visit = (value: unknown, path: Segment[]): void => {
    const isContainer = Array.isArray(value) || isRecord(value);
    const children: Array<[Segment, unknown]> = Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : isRecord(value)
        ? Object.entries(value)
        : [];
    if (!isContainer || children.length === 0) {
      if (path.length > 0 && reservedEntryFor(domain, dotted(path))) leaves.push(pointer(path));
      return;
    }
    for (const [segment, child] of children) {
      if (path.length === 0 && skipTop.has(String(segment))) continue;
      visit(child, [...path, segment]);
    }
  };
  visit(data, []);
  return leaves;
}
