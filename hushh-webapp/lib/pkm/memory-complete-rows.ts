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

import { reservedEntryFor } from "@/lib/pkm/reserved-branches";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function excluded(audience: MemoryRowAudience, key: string, domain: string, branch: string): boolean {
  if (audience === "agent") {
    if (shouldSkipPkmAgentContextKey(key)) return true;
    const entry = reservedEntryFor(domain, branch);
    if (entry && entry.sendToModel !== "full") return true;
    return false;
  }
  return shouldSkipPkmMemoryKey(key);
}

function humanize(segment: string): string {
  const text = String(segment || "").replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : segment;
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
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
      node.forEach((item, index) => walk(item, [...segments, String(index)], depth + 1));
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        const branch = [...segments, key].join(".");
        if (excluded(params.audience, key, params.domain, branch)) {
          if (params.audience === "self" && ["id", "source_id", "created_at", "updated_at", "revision"].includes(key) && (typeof value === "string" || typeof value === "number")) {
            rows.push({ path: branch, label: `Source › ${branch}`, value: String(value) });
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
    return { domain: params.domain, rows: [], withheld: [params.domain], truncated: false };
  }

  // Only the owning To-Do schema is eligible here. Other private branches
  // remain withheld, and no private task values travel in an agent document.
  if (params.domain === "one_todos" && params.audience === "self" && isRecord(params.domainData)) {
    const privateData = params.domainData._private;
    if (isRecord(privateData) && Array.isArray(privateData.tasks)) {
      const fields = ["id", "sourceId", "title", "type", "date", "time", "status", "sourceAgent", "link", "notes", "createdAt", "updatedAt", "completedAt", "deletedAt"];
      for (const task of privateData.tasks) {
        if (!isRecord(task) || typeof task.id !== "string") continue;
        for (const field of fields) {
          const value = renderScalar(task[field]);
          if (value) rows.push({ path: `tasks.${task.id}.${field}`, label: `Task ${task.id} › ${humanize(field)}`, value });
        }
      }
    }
  }
  if (params.domain === "one_living_sources" && params.audience === "self" && isRecord(params.domainData)) {
    const privateData = params.domainData._private;
    const inventory = isRecord(privateData) ? privateData.inventory : null;
    if (isRecord(inventory)) {
      if (inventory.complete !== true) truncated = true;
      if (Array.isArray(inventory.records)) {
        for (const record of inventory.records) {
          if (!isRecord(record)) { truncated = true; continue; }
          // The schema has no credentials or raw provider payloads.
          const key = `${String(record.kind)}:${String(record.id)}`;
          for (const field of ["kind", "id", "revision", "createdAt", "updatedAt", "capturedAt", "deletedAt", "value"]) {
            const value = renderScalar(record[field]);
            if (value) rows.push({ path: `${key}.${field}`, label: `${key} › ${humanize(field)}`, value });
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
