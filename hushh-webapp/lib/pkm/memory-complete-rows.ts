/**
 * Every value a domain holds, with nothing dropped for display.
 *
 * `buildPkmMemorySnapshot` exists to fill a browsing screen, so it caps cards
 * per domain, caps cards overall, clips values at 180 characters, and reports
 * `totalCards` as the count it *kept*. All three are right for a scrolling UI
 * and wrong for a record of what One holds: a document built from it would be
 * a truncated summary that reports itself as complete.
 *
 * This traversal is the document's own. It applies the same exclusion rules —
 * internal keys, audience rule, reserved-branch `send_to_model` — and then
 * emits every surviving leaf with its full value. When a bound is genuinely
 * hit (a pathological blob), it is reported rather than silently applied, so
 * the document can mark itself incomplete.
 *
 * Pure and import-safe.
 */

import { isPrivateWalletArtworkBranch, reservedEntryFor } from "@/lib/pkm/reserved-branches";
import { buildOwnerLivingFactIndex } from "@/lib/pkm/living-source-fact-index";
import type { LivingSourceInventory } from "@/lib/pkm/living-source-records";
import {
  shouldSkipPkmAgentContextKey,
  shouldSkipPkmMemoryKey,
} from "@/lib/pkm/pkm-memory-cards";

export type MemoryRowAudience = "self" | "agent";

export interface MemoryRow {
  /** Dotted path below the domain, e.g. `home.city`. */
  path: string;
  label: string;
  /** The value in full. Never clipped. */
  value: string;
}

export interface DomainRows {
  domain: string;
  rows: MemoryRow[];
  /** Branches withheld by an exclusion rule, so the omission is visible. */
  withheld: string[];
  /** True when a traversal bound stopped the walk before it finished. */
  truncated: boolean;
}

/**
 * Defensive bound against a pathological or malformed blob. Deliberately far
 * above any real domain, and hitting it sets `truncated` rather than quietly
 * shortening the record.
 */
const MAX_NODE_VISITS = 200_000;
const MAX_DEPTH = 24;
// The inventory itself stays intact in the encrypted vault. A rendered copy
// must have a separate bound so source records and fact rows cannot create an
// unbounded Markdown document while bypassing the ordinary traversal limit.
export const MAX_LIVING_SOURCE_MEMORY_ROWS = 20_000;
const MAX_RETAINED_LIVING_SOURCE_MEMORY_CHANGES = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function excluded(
  audience: MemoryRowAudience,
  key: string,
  domain: string,
  branch: string,
): boolean {
  if (isPrivateWalletArtworkBranch(domain, branch)) return true;
  if (audience === "agent") {
    if (shouldSkipPkmAgentContextKey(key)) return true;
    const entry = reservedEntryFor(domain, branch);
    if (entry && entry.sendToModel !== "full") return true;
    return false;
  }
  return shouldSkipPkmMemoryKey(key);
}

/** Deleted and conflicted change only with a source. Verified and stale move
 * with the reading clock and belong to the Live Mirror; naming them, or the
 * verification time, here rewrote memory.md every time a source was re-read. */
function sourceState(status: string): string {
  return status === "deleted" || status === "conflicted" ? ` · ${status}` : "";
}

function humanize(segment: string): string {
  const text = String(segment || "")
    .replace(/[_-]+/g, " ")
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : segment;
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

const GAP_VALUE_KEYS = [
  "committedChanges", "firstOccurredAt", "lastOccurredAt", "reason", "verifiedChanges",
].join();

function isGapCount(value: unknown): value is number | null {
  return value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isGapTime(value: unknown): boolean {
  return value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

/**
 * Plain text for a valid journal gap marker, or null when the marker is
 * malformed. A marker counts changes; it never carries the values in between.
 */
function gapMarkerText(change: Record<string, unknown>): string | null {
  const gap = change.value;
  if (change.id !== "*" || change.revision !== 0 || !isRecord(gap) ||
      Object.keys(gap).sort().join() !== GAP_VALUE_KEYS ||
      !isGapCount(gap.committedChanges) || !isGapCount(gap.verifiedChanges) ||
      // An unknown committed count is exactly what a journal gap means.
      gap.reason !== (gap.committedChanges === null ? "journal_gap" : "unobserved_changes") ||
      !isGapTime(gap.firstOccurredAt) || !isGapTime(gap.lastOccurredAt))
    return null;
  const committed = gap.committedChanges;
  if (committed === null) return "Some changes may be missing.";
  const changes = `${committed} ${committed === 1 ? "change" : "changes"} committed`;
  // Retention removed part of the span, so it is unknown what was seen.
  return gap.verifiedChanges === null
    ? `${changes}; recorded count unknown.`
    : `${changes}; ${gap.verifiedChanges} recorded. Values in between were not seen.`;
}

/**
 * Walk one decrypted domain completely.
 *
 * `domainData` is the decrypted object for `domain`. Every leaf that survives
 * the exclusion rules becomes a row with its full value.
 */
export function collectDomainRows(params: {
  domain: string;
  domainData: unknown;
  audience: MemoryRowAudience;
  /** Required to render private source facts; never passed for an agent export. */
  ownerUserId?: string;
  now?: string;
}): DomainRows {
  const rows: MemoryRow[] = [];
  const withheld = new Set<string>();
  let visits = 0;
  let truncated = false;

  const walk = (node: unknown, segments: string[], depth: number): void => {
    if (truncated) return;
    if (visits >= MAX_NODE_VISITS || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    visits += 1;

    if (Array.isArray(node)) {
      node.forEach((item, index) =>
        walk(item, [...segments, String(index)], depth + 1),
      );
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        const branch = [...segments, key].join(".");
        if (
          params.audience === "self" &&
          params.domain === "location" &&
          key === "source_receipts" &&
          [
            "saved_places.source_receipts",
            "visit_notes.source_receipts",
          ].includes(branch)
        ) {
          walk(value, [...segments, "provenance"], depth + 1);
          continue;
        }
        if (excluded(params.audience, key, params.domain, branch)) {
          if (
            params.audience === "self" &&
            [
              "id",
              "source_id",
              "created_at",
              "updated_at",
              "revision",
            ].includes(key) &&
            (typeof value === "string" || typeof value === "number")
          ) {
            rows.push({
              path: branch,
              label: `Source › ${branch}`,
              value: String(value),
            });
          } else withheld.add(branch);
          continue;
        }
        walk(value, [...segments, key], depth + 1);
      }
      return;
    }

    const text = renderScalar(node);
    if (!text) return;
    const path = segments.join(".");
    rows.push({
      path,
      label: segments.map(humanize).join(" › ") || humanize(params.domain),
      value: text,
    });
  };

  // The domain itself may be withheld outright.
  if (excluded(params.audience, params.domain, params.domain, "")) {
    return {
      domain: params.domain,
      rows: [],
      withheld: [params.domain],
      truncated: false,
    };
  }

  // Only the owning To-Do schema is eligible here. Other private branches
  // remain withheld, and no private task values travel in an agent document.
  if (
    params.domain === "one_todos" &&
    params.audience === "self" &&
    isRecord(params.domainData)
  ) {
    const privateData = params.domainData._private;
    if (isRecord(privateData) && Array.isArray(privateData.tasks)) {
      const fields = [
        "id",
        "sourceId",
        "revision",
        "title",
        "type",
        "date",
        "time",
        "status",
        "sourceAgent",
        "link",
        "notes",
        "createdAt",
        "updatedAt",
        "completedAt",
        "deletedAt",
      ];
      for (const task of privateData.tasks) {
        if (!isRecord(task) || typeof task.id !== "string") continue;
        for (const field of fields) {
          if (
            task.status === "deleted" &&
            ![
              "id",
              "sourceId",
              "revision",
              "status",
              "createdAt",
              "updatedAt",
              "deletedAt",
            ].includes(field)
          )
            continue;
          const value = renderScalar(task[field]);
          if (value)
            rows.push({
              path: `tasks.${task.id}.${field}`,
              label: `Task ${task.id} › ${humanize(field)}`,
              value,
            });
        }
      }
    }
  }
  if (
    params.domain === "one_living_sources" &&
    params.audience === "self" &&
    isRecord(params.domainData)
  ) {
    const privateData = params.domainData._private;
    const inventory = isRecord(privateData) ? privateData.inventory : null;
    if (isRecord(inventory)) {
      if (inventory.complete !== true) truncated = true;
      let sourceRows = 0;
      const pushSourceRow = (row: MemoryRow): boolean => {
        if (sourceRows >= MAX_LIVING_SOURCE_MEMORY_ROWS) {
          truncated = true;
          return false;
        }
        rows.push(row);
        sourceRows += 1;
        return true;
      };
      const history = isRecord(privateData) ? privateData.observed_history : null;
      if (isRecord(history)) {
        const changes = Array.isArray(history.changes) ? history.changes : null;
        if (!changes || changes.length > MAX_RETAINED_LIVING_SOURCE_MEMORY_CHANGES ||
            !Number.isSafeInteger(history.firstRetainedSequence) ||
            (history.truncatedAt !== null && typeof history.truncatedAt !== "string")) {
          truncated = true;
        } else {
          pushSourceRow({
            path: "observed_history.retention",
            label: "Recent observed changes · retention",
            value: `First retained sequence ${history.firstRetainedSequence}; earlier changes ${history.truncatedAt ? `removed at ${history.truncatedAt}` : "not recorded"}`,
          });
          // The encrypted history is already retained to 2,048 entries. Sort
          // by sequence so the visible slice is deterministic across reads.
          const orderedChanges = [...changes].sort((a, b) =>
            Number(isRecord(a) ? a.sequence : 0) - Number(isRecord(b) ? b.sequence : 0));
          for (const change of orderedChanges) {
            if (!isRecord(change) || !Number.isSafeInteger(change.sequence) ||
                typeof change.kind !== "string" || typeof change.id !== "string" ||
                typeof change.operation !== "string" ||
                !Number.isSafeInteger(change.revision) ||
                typeof change.capturedAt !== "string" || !isRecord(change.value)) {
              truncated = true;
              continue;
            }
            // A valid gap marker is an explicit, counted boundary rather than a
            // truncation. A malformed one cannot vouch for that span.
            const gapText = change.operation === "gap" ? gapMarkerText(change) : undefined;
            if (gapText === null) {
              truncated = true;
              continue;
            }
            if (!pushSourceRow({
              path: `observed_history.changes.${String(change.sequence).padStart(19, "0")}`,
              label: `Recent observed change #${change.sequence} · ${change.kind}:${change.id} · ${change.operation} · revision ${change.revision} · captured ${change.capturedAt}`,
              value: gapText ?? (change.operation === "delete" ? "Removed" : renderScalar(change.value)),
            })) break;
          }
        }
      } else if (history !== null && history !== undefined) {
        truncated = true;
      }
      // A private fact view is a lookup over the source records, not another
      // authority. The authenticated owner ID is supplied by memory-refresh.
      // Do not construct it for documents that may leave this owner session.
      const factIndex = params.ownerUserId && params.now &&
        typeof inventory.complete === "boolean" &&
        typeof inventory.observedAt === "string" &&
        Array.isArray(inventory.unavailable) &&
        Array.isArray(inventory.records)
        ? buildOwnerLivingFactIndex({
          expectedOwnerId: params.ownerUserId,
          inventory: inventory as unknown as LivingSourceInventory,
          now: params.now,
        })
        : null;
      if (params.ownerUserId && !factIndex) truncated = true;
      if (factIndex) {
        if (!factIndex.complete) truncated = true;
        for (const node of factIndex.nodes) {
          const source = node.provenance;
          if (!pushSourceRow({
            path: `facts.${encodeURIComponent(node.key)}`,
            label: `${node.predicate}${sourceState(node.status)} · ${source.kind}:${source.sourceId} · revision ${source.revision} · captured ${source.capturedAt}`,
            value: node.value === null
              ? node.status === "deleted" ? "Removed" : "Unresolved source conflict"
              : String(node.value),
          })) break;
        }
      }
      const stateByRecord = new Map(
        (factIndex?.nodes ?? [])
          .filter(node => node.predicate.endsWith(".__record"))
          .map(node => [JSON.stringify([node.provenance.kind, node.provenance.sourceId]), sourceState(node.status)] as const),
      );
      if (Array.isArray(inventory.records)) {
        const orderedRecords = [...inventory.records].sort((a, b) => {
          const key = (record: unknown) => isRecord(record)
            ? JSON.stringify([record.kind, record.id, record.revision]) : "";
          return key(a).localeCompare(key(b));
        });
        for (const record of orderedRecords) {
          if (sourceRows >= MAX_LIVING_SOURCE_MEMORY_ROWS) {
            truncated = true;
            break;
          }
          if (!isRecord(record)) {
            truncated = true;
            continue;
          }
          // The schema has no credentials or raw provider payloads.
          const key = `${String(record.kind)}:${String(record.id)}`;
          const state = stateByRecord.get(JSON.stringify([record.kind, record.id])) ?? "";
          for (const field of [
            "kind",
            "id",
            "revision",
            "createdAt",
            "updatedAt",
            "capturedAt",
            "deletedAt",
            "value",
          ]) {
            const value = renderScalar(record[field]);
            if (value && !pushSourceRow({
                path: `${key}.${field}`,
                label: `${key}${state} › ${humanize(field)}`,
                value,
              })) break;
          }
        }
      }
    }
  }
  walk(params.domainData, [], 0);
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return {
    domain: params.domain,
    rows,
    withheld: [...withheld].sort(),
    truncated,
  };
}
