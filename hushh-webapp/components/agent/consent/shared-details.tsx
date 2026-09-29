"use client";

/**
 * What someone shared, as a person would read it: a short list of
 * label and value rows. The decrypted record is a memory tree (entities,
 * kinds, statuses, memory ids); none of that structure is information, so it
 * is never rendered. Values stay in React memory only.
 */
import { useState } from "react";

export type SharedDetailRow = { label: string; values: string[] };

/** Structure and bookkeeping keys: never a label, never a value. */
const META_KEYS = new Set([
  "kind", "status", "id", "type", "state", "created_at", "updated_at", "createdat", "updatedat",
  "observed_at", "observedat", "timestamp", "confidence", "source", "sources", "version",
  "schema", "schema_version", "hash", "revision", "scope", "scope_ref", "scoperef", "domain",
  "sensitivity", "embedding", "vector", "provenance", "tags", "weight", "score", "salience",
  "entity_id", "memory_id", "segment_id", "path", "key", "ref", "uri", "checksum",
  // The export envelope's own bookkeeping (lib/consent/export-builder.ts).
  "source_domain", "manifest_version", "approved_paths", "approved_segment_ids", "segment_ids",
  "export_timestamp", "available_domains", "paths",
]);
/** Keys that only group values; their children keep the parent's label. */
const PASS_THROUGH_KEYS = new Set([
  "entities", "items", "records", "data", "values", "attributes", "observations", "facts",
  "notes", "summary", "description", "value", "text", "content", "details", "entries", "memories",
]);

const HEX_ID = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** A key path such as "preferences.entities._entities.kind": structure, not information. */
const KEY_PATH = /^(?:[a-z0-9_]+\.){2,}[a-z0-9_]+$/;
/** Counts and positions ("2", "item_count"): numbers about the record, not in it. */
const COUNT_KEY = /(^|_)(count|counts|total|totals|index|position|rank|order|size|length|num)$|^(n|num|number_of)_/;

/** Memory ids ("mem_65725402299c"), uuids, hex digests and *_id keys. */
export function isInternalKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (META_KEYS.has(k) || /(^|_)id$/.test(k) || /[a-z]Id$/.test(key)) return true;
  if (/^(mem|ent|seg|obs|rec|node|att)[_-]?[0-9a-f]{6,}$/i.test(k)) return true;
  return HEX_ID.test(k) || UUID.test(k) || /\d{6,}/.test(k);
}

function isInternalValue(value: string): boolean {
  const v = value.trim();
  return !v || UUID.test(v) || (HEX_ID.test(v) && v.length >= 12) || ISO_TIME.test(v)
    || /^(mem|ent|seg|obs|rec)[_-][0-9a-f]{6,}$/i.test(v)
    || (!/\s/.test(v) && (v.startsWith("_") || v.includes("._") || KEY_PATH.test(v)));
}

/** A sentence reads on its own; a short value needs its field ("Diet: vegetarian"). */
function readsOnItsOwn(value: string): boolean {
  return /[.!?]$/.test(value) || value.length > 60;
}

/**
 * Field keys whose word-by-word reading is wrong. Localhost run 4 (S3) showed
 * "Fein", "Naics code", "Trade name dba" and "Street 1" on a legal entity.
 */
const FIELD_LABELS: Record<string, string> = {
  fein: "Federal EIN",
  naics: "NAICS code",
  naics_code: "NAICS code",
  sic_code: "SIC code",
  dba: "Doing business as",
  trade_name_dba: "Trade name (DBA)",
  street_1: "Street address",
  street_2: "Address line 2",
  address_line_1: "Street address",
  address_line_2: "Address line 2",
  zip: "ZIP code",
  zip_code: "ZIP code",
  dob: "Date of birth",
  agi: "Adjusted gross income",
};

/** Initialisms read as people write them: "Ein" is "EIN". */
const INITIALISMS = new Set(["ein", "ssn", "itin", "tin", "agi", "irs", "dob", "zip", "iban", "swift", "vat", "gst", "llc", "llp", "naics", "sic", "dba", "url", "pin", "usa"]);

function sentenceCase(words: string[]): string {
  const text = words.map((word) => INITIALISMS.has(word) ? word.toUpperCase() : word).join(" ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** "food_preferences" and "foodPreferences" read as "Food preferences"; "fein" reads "Federal EIN". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  if (!spaced) return key;
  const known = FIELD_LABELS[spaced.replace(/ /g, "_")];
  return known ?? sentenceCase(spaced.split(" "));
}

/** Enum values a person would say differently ("C_CORP" is a C corporation). */
const ENUM_VALUES: Record<string, string> = {
  C_CORP: "C corporation",
  S_CORP: "S corporation",
  B_CORP: "B corporation",
  SOLE_PROP: "Sole proprietorship",
  NON_PROFIT: "Nonprofit",
};
/** A stored enum ("MARRIED_FILING_JOINTLY"): capitals and digits joined by underscores. */
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * A stored enum reads as words ("C_CORP" is "C corporation",
 * "MARRIED_FILING_JOINTLY" is "Married filing jointly"). Anything else is the
 * person's own value and is shown exactly as saved.
 */
export function humanValue(value: string): string {
  const known = ENUM_VALUES[value];
  if (known) return known;
  if (!UPPER_SNAKE.test(value)) return value;
  return sentenceCase(value.toLowerCase().split("_"));
}

const MAX_ROWS = 40;
const MAX_DEPTH = 8;

/**
 * Label and value rows from a decrypted record, as a person would read them.
 *
 * Only information survives: the export envelope's `__` keys, `_entities` and
 * `_items` structure, key paths, ids, times, counts and a bare number with no
 * field are dropped. A short value keeps its field ("Favorite cuisine:
 * Neapolitan pizza"); a sentence stands alone.
 */
export function humanSharedDetails(data: unknown, fallbackLabel: string): SharedDetailRow[] {
  const heading = fallbackLabel || "Shared";
  const rows = new Map<string, string[]>();
  const seenValues = new Set<string>();
  const push = (label: string, raw: string) => {
    const value = raw.trim();
    const normalized = value.toLowerCase().replace(/\s+/g, " ");
    if (isInternalValue(value) || seenValues.has(normalized) || rows.size >= MAX_ROWS) return;
    seenValues.add(normalized);
    const list = rows.get(label) ?? [];
    list.push(value);
    rows.set(label, list);
  };
  // `field` is the nearest human key above a value, or null when there is none.
  const pushScalar = (label: string, field: string | null, value: string, prose: boolean) => {
    // The item's own heading already names it; a field adds only when it differs.
    const named = field && field.toLowerCase() !== heading.toLowerCase() ? field : null;
    if (prose && readsOnItsOwn(value)) return push(label, value);
    if (!named) {
      if (prose) push(label, value);
      return; // A bare number or yes/no with no field says nothing.
    }
    if (!isInternalValue(value)) push(label, `${named}: ${value}`);
  };
  const walk = (node: unknown, label: string, field: string | null, depth: number) => {
    if (depth > MAX_DEPTH || node === null || node === undefined) return;
    if (typeof node === "string") return pushScalar(label, field, humanValue(node.trim()), true);
    if (typeof node === "number" && Number.isFinite(node)) return pushScalar(label, field, String(node), false);
    if (typeof node === "boolean") return pushScalar(label, field, node ? "Yes" : "No", false);
    if (Array.isArray(node)) {
      node.slice(0, 50).forEach((entry) => walk(entry, label, field, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const lower = key.trim().toLowerCase();
      // The envelope's metadata ("__export_metadata") is never information.
      if (lower.startsWith("__") || META_KEYS.has(lower)) continue;
      if (COUNT_KEY.test(lower) && (typeof value === "number" || typeof value === "string")) continue;
      if (lower === "label" || lower === "title" || lower === "name") {
        // A display name on a record is a value of that record, not a heading.
        if (typeof value === "string") push(label, value);
        continue;
      }
      // `_entities` and `_items` are the record's structure; their children
      // belong to the field above them.
      if (lower.startsWith("_") || isInternalKey(key) || PASS_THROUGH_KEYS.has(lower)) {
        walk(value, label, field, depth + 1);
      } else {
        const human = humanizeKey(key);
        walk(value, human, human, depth + 1);
      }
    }
  };
  walk(data, heading, null, 0);
  return [...rows.entries()].map(([label, values]) => ({ label, values }));
}

const LONG_VALUE = 160;
const VISIBLE_ROWS = 6;

function DetailValue({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const long = value.length > LONG_VALUE;
  return (
    <span className="block">
      <span className={long && !open ? "line-clamp-3" : undefined}>{value}</span>
      {long ? (
        <button type="button" onClick={() => setOpen((current) => !current)}
          className="mt-1 inline-flex min-h-11 cursor-pointer items-center text-xs font-medium text-accent-strong sm:min-h-8">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </span>
  );
}

/**
 * One row per shared item, headed by the server's human label for it
 * ("Food preferences"). Headings are never derived from the memory tree's own
 * keys on this device: that produced a "Preferences" row beside "Food
 * preferences" for the same item.
 */
export function sharedItemRows(
  values: Array<{ requestId: string; label: string; data: Record<string, unknown> }>,
): Array<SharedDetailRow & { key: string }> {
  return values.flatMap((value) => {
    const label = value.label.trim() || "Shared";
    const rowValues = humanSharedDetails(value.data, label).flatMap((row) => row.values);
    return rowValues.length ? [{ key: value.requestId, label, values: rowValues }] : [];
  });
}

export function SharedDetailsList({ values }: {
  values: Array<{ requestId: string; label: string; data: Record<string, unknown> }>;
}) {
  const [showAll, setShowAll] = useState(false);
  const allRows = sharedItemRows(values);
  const total = allRows.reduce((sum, row) => sum + row.values.length, 0);
  // At most VISIBLE_ROWS values before "Show all", across items in order.
  let budget = VISIBLE_ROWS;
  const rows = showAll ? allRows : allRows.flatMap((row) => {
    if (budget <= 0) return [];
    const shown = row.values.slice(0, budget);
    budget -= shown.length;
    return [{ ...row, values: shown }];
  });
  const visible = rows;
  if (!allRows.length) {
    return <p className="text-sm text-muted-foreground" data-testid="chat-shared-information">Nothing readable was shared yet.</p>;
  }
  return (
    <div data-testid="chat-shared-information" className="rounded-[var(--app-card-radius-compact)] bg-background/80">
      <dl className="divide-y divide-border/50">
        {visible.map((row) => (
          <div key={row.key} className="grid gap-0.5 px-3.5 py-2.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{row.label}</dt>
            <dd className="min-w-0 space-y-1 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
              {row.values.map((value, index) => <DetailValue key={index} value={value} />)}
            </dd>
          </div>
        ))}
      </dl>
      {total > VISIBLE_ROWS ? (
        <button type="button" onClick={() => setShowAll((current) => !current)}
          className="flex min-h-11 w-full cursor-pointer items-center justify-center border-t border-border/50 text-xs font-medium text-accent-strong">
          {showAll ? "Show fewer" : `Show all ${total}`}
        </button>
      ) : null}
    </div>
  );
}
