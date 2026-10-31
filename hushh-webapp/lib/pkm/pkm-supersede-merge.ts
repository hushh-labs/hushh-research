/**
 * Memory evolves; it does not silently overwrite or append.
 *
 * When a newer statement changes a value the person already has, the newer
 * value becomes current and the earlier one moves into a sibling `superseded`
 * list with the time it was replaced. Nothing the person said is deleted, and
 * nothing is stored twice. `superseded` is an internal branch in
 * `contracts/pkm/internal-path-keys.v1.json`: it is the owner's history, never
 * current information that can be requested or shared.
 *
 * Before this, a memory write merged with a plain deep merge (a changed value
 * vanished) and a correction whose payload was not entity-shaped was dropped
 * while the save still reported success.
 *
 * Pure and dependency-free: the write path and the result card share it, so
 * the counts the person sees are the counts of what was written.
 */

export const SUPERSEDED_KEY = "superseded";

/** Bookkeeping the writer owns; never compared, never kept as history. */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  SUPERSEDED_KEY,
  "created_at",
  "updated_at",
  "entity_id",
]);

export type SupersededEntry = { value: unknown; superseded_at: string };

/** What one memory write did to the stored information. */
export type PkmMergeOutcome = "saved" | "updated" | "merged" | "unchanged";

export type SupersedeMergeResult = {
  merged: Record<string, unknown>;
  /** Details that did not exist before. */
  added: number;
  /** Lists that gained items they did not already hold. */
  extended: number;
  superseded: number;
  unchanged: number;
};

type MergeCounts = Omit<SupersedeMergeResult, "merged">;

type ArrayPolicy = "union" | "replace";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function canonical(value: unknown): string {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => !BOOKKEEPING_KEYS.has(key))
      .sort()
      .map((key) => `${key}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameMemoryValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function appendSuperseded(
  target: Record<string, unknown>,
  key: string,
  previous: unknown,
  nowIso: string,
): void {
  const history = isPlainObject(target[SUPERSEDED_KEY])
    ? (target[SUPERSEDED_KEY] as Record<string, unknown>)
    : {};
  const entries = Array.isArray(history[key]) ? [...(history[key] as unknown[])] : [];
  entries.push({ value: clone(previous), superseded_at: nowIso } satisfies SupersededEntry);
  history[key] = entries;
  target[SUPERSEDED_KEY] = history;
}

function mergeInto(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
  nowIso: string,
  arrays: ArrayPolicy,
  counts: MergeCounts,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    // A model-supplied `superseded` or timestamp is never authority over history.
    if (BOOKKEEPING_KEYS.has(key)) continue;
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      mergeInto(current, value, nowIso, arrays, counts);
      continue;
    }
    if (isEmpty(value)) continue;
    if (isEmpty(current)) {
      target[key] = clone(value);
      counts.added += 1;
      continue;
    }
    if (sameMemoryValue(current, value)) {
      counts.unchanged += 1;
      continue;
    }
    if (arrays === "union" && Array.isArray(current) && Array.isArray(value)) {
      const next = [...current];
      for (const item of value) {
        if (!next.some((existing) => sameMemoryValue(existing, item))) next.push(clone(item));
      }
      if (next.length === current.length) {
        counts.unchanged += 1;
      } else {
        target[key] = next;
        counts.extended += 1;
      }
      continue;
    }
    appendSuperseded(target, key, current, nowIso);
    target[key] = clone(value);
    counts.superseded += 1;
  }
}

/**
 * Merge `incoming` onto `base`. A changed value is kept current and the
 * earlier one is recorded under `superseded`. `extend` unions lists (a new
 * tool joins the old ones); `correct` replaces a list and keeps the old list
 * in history, because a correction states the whole current truth.
 */
export function mergeWithSupersedeHistory(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  options: { nowIso: string; mode?: "extend" | "correct" },
): SupersedeMergeResult {
  const merged = clone(base) ?? {};
  const counts: MergeCounts = { added: 0, extended: 0, superseded: 0, unchanged: 0 };
  mergeInto(merged, incoming, options.nowIso, options.mode === "correct" ? "replace" : "union", counts);
  return { merged, ...counts };
}

/**
 * Classify a write before it is committed, from the same stored state the
 * write merges into. `unchanged` means every stated value was already there.
 */
export function classifyMergeOutcome(params: {
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  mergeMode?: string | null;
}): PkmMergeOutcome {
  const mode = String(params.mergeMode || "").trim().toLowerCase();
  const { added, extended, superseded } = mergeWithSupersedeHistory(
    params.existing,
    params.incoming,
    { nowIso: "1970-01-01T00:00:00.000Z", mode: mode === "correct_entity" ? "correct" : "extend" },
  );
  if (superseded > 0) return "updated";
  if (extended > 0) return "merged";
  // The merge agent decided this is more about a record the person already has.
  if (added > 0) return mode === "extend_entity" ? "merged" : "saved";
  return "unchanged";
}
