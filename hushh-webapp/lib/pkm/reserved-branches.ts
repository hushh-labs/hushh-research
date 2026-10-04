/**
 * Which PKM branches an app feature owns, and which writers may change them.
 *
 * The TypeScript half of `contracts/pkm/reserved-branches.v1.json`. The Python
 * half is `consent-protocol/hushh_mcp/consent/reserved_branches.py`; both read
 * one list so they cannot drift, the same reason `internal-path-keys.v1.json`
 * exists.
 *
 * `evaluateReservedWrite` answers "would this write be refused". The contract's
 * own `enforcement` value (`RESERVED_ENFORCEMENT_MODE`) decides what the write
 * coordinator does with the answer: `shadow` only counts it, `enforce` blocks
 * the save. It is a reviewed contract value, never an env flag, so the device
 * and the server read the same one.
 *
 * Deliberately dependency-free and not a client module, like
 * `internal-path-keys.ts`, so the coordinator and tests can import it alone.
 */

import internalPathKeys from "@/contracts/pkm/internal-path-keys.v1.json";
import contract from "@/contracts/pkm/reserved-branches.v1.json";

export const WILDCARD_BRANCH = "*";

export type ReservedWriterClass = "feature" | "memory_agent" | "migration";
export type ReservedRefusalReason =
  | "writer_unknown"
  | "memory_agent"
  | "writer_not_listed"
  | "auto_save_mode"
  | "capability_missing";
export type ReservedEnforcementMode = "shadow" | "enforce";
export type ReservedMemoryScreenPolicy = "read_only_reserved" | "editable";

/** Where the owner commits a re-routed fact: the owning feature's own screen. */
export type ReservedOfferAction = {
  routePattern: string;
  actionId: string;
  labelTemplate: string;
};

export type ReservedWriter = {
  writerId: string;
  feature: string;
  writerClass: ReservedWriterClass;
  surfaces: readonly string[];
  authorizationModes: readonly string[];
  requiresCapability: string | null;
};

export type ReservedEntry = {
  domain: string;
  branchPrefix: string;
  exceptPrefixes: readonly string[];
  ownerFeature: string;
  writerIds: ReadonlySet<string>;
  agentMemorySibling: string | null;
  shareable: string;
  sendToModel: string;
  offerAction: ReservedOfferAction | null;
};

/** One would-be refusal. Carries labels only, never a stored value. */
export type ReservedRefusal = {
  domain: string;
  branch: string;
  writerId: string;
  reason: ReservedRefusalReason;
};

type RawWriter = {
  feature: string;
  class: string;
  surfaces: string[];
  authorization_modes: string[];
  requires_capability?: string;
};

type RawEntry = {
  domain: string;
  branch_prefix: string;
  except: string[];
  owner_feature: string;
  writer_ids: string[];
  agent_memory_sibling: string | null;
  shareable: string;
  send_to_model: string;
  offer_action: { route_pattern: string; action_id: string; label_template: string } | null;
};

const WRITER_CLASSES: ReadonlySet<string> = new Set(["feature", "memory_agent", "migration"]);

function normalizePath(path: string | null | undefined): string {
  return String(path ?? "")
    .split(".")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .join(".");
}

function isAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

const WRITERS: ReadonlyMap<string, ReservedWriter> = new Map(
  Object.entries(contract.writers as Record<string, unknown>)
    .filter(([writerId, raw]) => !writerId.startsWith("$") && typeof raw === "object" && raw !== null)
    .map(([writerId, value]) => {
      const raw = value as RawWriter;
      if (!WRITER_CLASSES.has(raw.class)) {
        throw new Error(`reserved_branches_writer_class_invalid:${writerId}`);
      }
      return [
        writerId,
        {
          writerId,
          feature: raw.feature,
          writerClass: raw.class as ReservedWriterClass,
          surfaces: raw.surfaces,
          authorizationModes: raw.authorization_modes,
          requiresCapability: raw.requires_capability ?? null,
        },
      ] as const;
    }),
);

const ENTRIES: readonly ReservedEntry[] = (contract.entries as RawEntry[]).map((raw) => ({
  domain: raw.domain.trim().toLowerCase(),
  branchPrefix: raw.branch_prefix.trim().toLowerCase(),
  exceptPrefixes: raw.except.map((item) => normalizePath(item)),
  ownerFeature: raw.owner_feature,
  writerIds: new Set(raw.writer_ids),
  agentMemorySibling: raw.agent_memory_sibling ?? null,
  shareable: raw.shareable,
  sendToModel: raw.send_to_model,
  offerAction: raw.offer_action
    ? {
        routePattern: raw.offer_action.route_pattern,
        actionId: raw.offer_action.action_id,
        labelTemplate: raw.offer_action.label_template,
      }
    : null,
}));

export const RESERVED_REGISTRY_VERSION: number = contract.version;

function readEnum<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(normalized)) throw new Error(code);
  return normalized as T;
}

/** `shadow` (count) or `enforce` (block). Anything else fails the import closed. */
export const RESERVED_ENFORCEMENT_MODE: ReservedEnforcementMode = readEnum(
  (contract as { enforcement?: unknown }).enforcement,
  ["shadow", "enforce"] as const,
  "reserved_branches_enforcement_mode_invalid",
);

/** How the Memory screen treats an item inside a reserved branch. */
export const RESERVED_MEMORY_SCREEN_POLICY: ReservedMemoryScreenPolicy = readEnum(
  (contract as { memory_screen_policy?: unknown }).memory_screen_policy,
  ["read_only_reserved", "editable"] as const,
  "reserved_branches_memory_screen_policy_invalid",
);

/** Authorization modes that write without the owner reviewing this write. */
export const AUTO_SAVE_AUTHORIZATION_MODES: ReadonlySet<string> = new Set([
  "owner_auto_save_policy",
  "product_default_auto_save_policy",
]);

/** The offer's button text, `{label}` filled with the agent's short noun. */
export function reservedOfferLabel(offer: ReservedOfferAction, noun: string | null | undefined): string {
  const text = String(noun ?? "").replace(/\s+/g, " ").trim().slice(0, 48) || "this";
  return offer.labelTemplate.replace("{label}", text);
}

/** The catalogued writer for `writerId`, or null when it is unknown. */
export function writer(writerId: string | null | undefined): ReservedWriter | null {
  return WRITERS.get(String(writerId ?? "").trim().toLowerCase()) ?? null;
}

/**
 * The entry that reserves `path` (dotted, relative to `domain`), if any. A `*`
 * entry reserves the whole domain, including its root, apart from its
 * `except` branches; any other entry reserves its prefix and everything below.
 */
export function reservedEntryFor(
  domain: string | null | undefined,
  path: string | null | undefined,
): ReservedEntry | null {
  const canonicalDomain = String(domain ?? "").trim().toLowerCase();
  const normalized = normalizePath(path);
  for (const entry of ENTRIES) {
    if (entry.domain !== canonicalDomain) continue;
    if (entry.exceptPrefixes.some((item) => isAtOrBelow(normalized, item))) continue;
    if (entry.branchPrefix === WILDCARD_BRANCH) return entry;
    if (normalized && isAtOrBelow(normalized, entry.branchPrefix)) return entry;
  }
  return null;
}

export function isReservedPath(
  domain: string | null | undefined,
  path: string | null | undefined,
): boolean {
  return reservedEntryFor(domain, path) !== null;
}

function branchLabel(entry: ReservedEntry, path: string): string {
  if (entry.branchPrefix !== WILDCARD_BRANCH) return entry.branchPrefix;
  return path.split(".", 1)[0] || WILDCARD_BRANCH;
}

/**
 * Every reserved branch these paths touch that `writerId` may not change.
 *
 * Rules, identical on the server: an unknown writer is refused; a `migration`
 * writer is never refused here (its authority is the server-verified upgrade
 * claim); a `memory_agent` writer is refused on every reserved branch; any
 * other writer is refused unless the entry lists it.
 */
export function evaluateReservedWrite(params: {
  domain: string;
  paths: Iterable<string | null | undefined>;
  writerId: string | null | undefined;
  authorizationMode?: string | null;
  /** Capabilities the caller has already PROVEN, e.g. a Location finalize authority. */
  capabilities?: Iterable<string>;
}): ReservedRefusal[] {
  const canonicalDomain = String(params.domain ?? "").trim().toLowerCase();
  const writerId = String(params.writerId ?? "").trim().toLowerCase();
  const catalogued = writer(writerId);
  if (catalogued?.writerClass === "migration") return [];
  const mode = String(params.authorizationMode ?? "").trim().toLowerCase();
  const held = new Set([...(params.capabilities ?? [])].map((item) => String(item).trim().toLowerCase()));
  const refusals = new Map<string, ReservedRefusal>();
  for (const rawPath of params.paths) {
    const normalized = normalizePath(rawPath);
    const entry = reservedEntryFor(canonicalDomain, normalized);
    if (!entry) continue;
    let reason: ReservedRefusalReason;
    if (!catalogued) reason = "writer_unknown";
    else if (catalogued.writerClass === "memory_agent") reason = "memory_agent";
    else if (!entry.writerIds.has(writerId)) reason = "writer_not_listed";
    else if (AUTO_SAVE_AUTHORIZATION_MODES.has(mode)) reason = "auto_save_mode";
    else if (catalogued.requiresCapability && !held.has(catalogued.requiresCapability)) {
      reason = "capability_missing";
    } else continue;
    const branch = branchLabel(entry, normalized);
    const key = `${branch}|${reason}`;
    if (!refusals.has(key)) {
      refusals.set(key, { domain: canonicalDomain, branch, writerId, reason });
    }
  }
  return [...refusals.values()];
}

/* ---------- device-side value diff ---------- */

/**
 * Top-level keys that are bookkeeping rather than a branch (`updated_at`,
 * `schema_version`, `domain_intent`, ...). Every feature rewrites them on every
 * save, so comparing them would count noise. Read from the internal-path-keys
 * contract rather than restated here.
 */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set(
  [...internalPathKeys.internal_keys, ...internalPathKeys.internal_branches].map((key) =>
    key.trim().toLowerCase(),
  ),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]),
  );
}

function valueAt(record: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = record;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function reservedPrefixesFor(
  domain: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const prefixes = new Set<string>();
  for (const entry of ENTRIES) {
    if (entry.domain !== domain) continue;
    if (entry.branchPrefix !== WILDCARD_BRANCH) {
      prefixes.add(entry.branchPrefix);
      continue;
    }
    for (const key of [...Object.keys(before), ...Object.keys(after)]) {
      const normalized = key.trim().toLowerCase();
      if (!normalized || BOOKKEEPING_KEYS.has(normalized)) continue;
      if (reservedEntryFor(domain, normalized) === entry) prefixes.add(key);
    }
  }
  return [...prefixes];
}

/**
 * The reserved branches whose stored value this write would change.
 *
 * `after` is what the write hands to the merge: the whole domain for a
 * feature's own save, a partial candidate for a memory card. A branch counts
 * as touched when the candidate carries a different value for it, when a
 * `replace_domain` write drops it, or when a `delete_entity` targets it. This
 * is the check the server cannot run, because every segment is re-encrypted on
 * every write: a smuggled change behind an innocent `proposed_scope` is only
 * visible here.
 */
export function touchedReservedBranches(params: {
  domain: string;
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  mergeMode?: string | null;
  deleteTargetPath?: string | null;
}): string[] {
  const domain = String(params.domain ?? "").trim().toLowerCase();
  const before = isPlainRecord(params.before) ? params.before : {};
  const after = isPlainRecord(params.after) ? params.after : {};
  const mergeMode = String(params.mergeMode ?? "").trim().toLowerCase();
  const deleteTarget = normalizePath(params.deleteTargetPath);
  const touched: string[] = [];
  for (const prefix of reservedPrefixesFor(domain, before, after)) {
    const previous = valueAt(before, prefix);
    const next = valueAt(after, prefix);
    const changed = next !== undefined && !deepEqual(previous, next);
    const dropped = mergeMode === "replace_domain" && previous !== undefined && next === undefined;
    const deleted =
      mergeMode === "delete_entity" && Boolean(deleteTarget) &&
      isAtOrBelow(deleteTarget, normalizePath(prefix));
    if (changed || dropped || deleted) touched.push(prefix);
  }
  return touched;
}

/** Thrown by `assertReservedBranchesUntouched`; carries labels only, never a value. */
export class ReservedBranchWriteBlocked extends Error {
  readonly refusals: readonly ReservedRefusal[];
  constructor(refusals: readonly ReservedRefusal[]) {
    super(`reserved_branch_blocked:${refusals.map((item) => `${item.domain}.${item.branch}`).join(",")}`);
    this.name = "ReservedBranchWriteBlocked";
    this.refusals = refusals;
  }
}

/**
 * The device-side value check: every reserved branch this write would change,
 * judged against its writer. Returns the refusals; in `enforce` mode throws
 * `ReservedBranchWriteBlocked` when there are any. The server cannot run this
 * check, because each write re-encrypts the whole domain: a change smuggled
 * behind an innocent `proposed_scope` is only visible here, before encryption.
 */
export function assertReservedBranchesUntouched(params: {
  domain: string;
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  writerId: string | null | undefined;
  mergeMode?: string | null;
  deleteTargetPath?: string | null;
  authorizationMode?: string | null;
  capabilities?: Iterable<string>;
  mode?: ReservedEnforcementMode;
}): ReservedRefusal[] {
  const touched = touchedReservedBranches({
    domain: params.domain,
    before: params.before,
    after: params.after,
    mergeMode: params.mergeMode,
    deleteTargetPath: params.deleteTargetPath,
  });
  if (touched.length === 0) return [];
  const refusals = evaluateReservedWrite({
    domain: params.domain,
    paths: touched,
    writerId: params.writerId,
    authorizationMode: params.authorizationMode,
    capabilities: params.capabilities,
  });
  if (refusals.length && (params.mode ?? RESERVED_ENFORCEMENT_MODE) === "enforce") {
    throw new ReservedBranchWriteBlocked(refusals);
  }
  return refusals;
}

/**
 * The hint a structure preview carries when the registry moved its target into
 * an agent_memory sibling. The card is saveable; it is the one "reserved" hint
 * that is not a refusal.
 */
export const RESERVED_REROUTE_HINT = "reserved_target_rerouted_to_sibling";

/** True for a validation hint that refuses a reserved target, not a re-route. */
export function isReservedRefusalHint(hint: unknown): boolean {
  const text = String(hint ?? "").trim().toLowerCase();
  return text.includes("reserved") && text !== RESERVED_REROUTE_HINT;
}

/** The reserved entry, sibling and offer for a Memory item, when it is app-owned. */
export function reservedOwnerFor(
  domain: string | null | undefined,
  pathSegments: readonly (string | number)[],
): ReservedEntry | null {
  const path = pathSegments.filter((segment) => typeof segment === "string").join(".");
  return reservedEntryFor(domain, path);
}
