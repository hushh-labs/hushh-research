import { isCurrentPersonExport } from "@/lib/consent/person-export-binding";
import { projectGrantPayload } from "@/lib/consent/project-grant-payload";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import {
  readInformationRequest,
  readInformationRequestExports,
  readSharedWithMe,
} from "@/lib/consent/information-request-reads";
import type { InformationRequestBundle } from "@/lib/services/person-profile-service";
import {
  fieldSensitivity,
  isNamedSensitiveField,
  parseSharedFieldSensitivities,
  sensitiveFieldNameSet,
  type SharedFieldSensitivity,
} from "@/lib/consent/field-sensitivity";
import { knownFieldLabel } from "@/lib/consent/field-labels";

/**
 * Contract C7. `sensitive` values are opened and shown on this device only;
 * a model turn receives their field-name outline, never the values.
 */
export type SharedSensitivity = "sensitive" | "standard";

export type OpenedPersonInformation = {
  requestId: string;
  label: string;
  data: Record<string, unknown>;
  /** Absent on a value built elsewhere; the label deny-list still applies. */
  sensitivity?: SharedSensitivity;
  /**
   * The server's per-field reading (C7, `fields[]`), when it sent one: an
   * identifier field inside a standard item is sensitive. Without it the
   * contract's key and value rules still apply to every field.
   */
  fields?: SharedFieldSensitivity[];
};

/**
 * Deny-by-default families (CONTRACT-2 C7): tax, financial, identity or
 * government ids, health and credentials. Matched against the domain, the
 * scope and the human label, with separators flattened so `tax_record` and
 * `attr.financial.tax.*` both read as words.
 */
const SENSITIVE_FAMILY = new RegExp(
  "\\b(?:tax(?:es)?|financ\\w*|bank\\w*|income|salary|payroll|wallet|payments?|credit|loans?|mortgage|" +
    "identity|identification|government|passport|ssn|social security|licen[cs]e|" +
    "health\\w*|medical|diagnos\\w*|prescriptions?|medications?|insurance|" +
    "credentials?|passwords?|passcodes?|secrets?)\\b",
  "i",
);
const DECLARED_SENSITIVE = new Set(["sensitive", "restricted", "high", "medium", "confidential"]);

/**
 * The one client reading of an item's sensitivity (C7, deny by default).
 * Missing means sensitive. A server declaration of sensitive always wins. A
 * declaration of `standard` still yields to the deny-list families, because
 * the server's own policy applies the same list and a stale row may predate it.
 */
export function resolveSharedSensitivity(input: {
  sensitivity?: unknown;
  domain?: string | null;
  scope?: string | null;
  label?: string | null;
}): SharedSensitivity {
  const declared = typeof input.sensitivity === "string" ? input.sensitivity.trim().toLowerCase() : "";
  if (!declared || DECLARED_SENSITIVE.has(declared)) return "sensitive";
  const words = [input.domain, input.scope, input.label]
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .join(" ")
    .replace(/[._\-*/:]+/g, " ");
  return SENSITIVE_FAMILY.test(words) ? "sensitive" : "standard";
}

type ProgressFieldHint = { label: string; scope: string | null; sensitivity: string | null };

/** `progress.fields[]` in item order: the raw scope and, once C7 lands, sensitivity. */
function progressFieldHints(progress: unknown): ProgressFieldHint[] {
  const fields = (progress as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, 100).map((raw) => {
    const field = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    return { label: text(field.label) ?? "", scope: text(field.scope), sensitivity: text(field.sensitivity) };
  });
}

function itemSensitivity(
  bundle: Pick<InformationRequestBundle, "items" | "progress">,
  item: InformationRequestBundle["items"][number],
  domain: string | null | undefined,
): SharedSensitivity {
  const hints = progressFieldHints(bundle.progress);
  const index = bundle.items.indexOf(item);
  // The server builds progress.fields from the same items in the same order.
  const hint = hints.length === bundle.items.length && index >= 0
    ? hints[index]
    : hints.find((entry) => entry.label === item.label);
  const declared = [item.sensitivity, hint?.sensitivity]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
  return resolveSharedSensitivity({
    // Either source saying sensitive wins; neither saying anything is sensitive.
    sensitivity: declared.find((value) => DECLARED_SENSITIVE.has(value)) ?? declared[0] ?? null,
    domain,
    scope: hint?.scope ?? null,
    label: item.label,
  });
}

/**
 * Open what another person approved for this requester, on this device only.
 *
 * The export was encrypted by the owner's browser to this person's connector
 * key; the private half of that key lives inside their own vault. Every step
 * re-reads the ledger, checks that the export still matches the approved item,
 * and re-checks the grant after decrypting, so a revocation mid-open wins. The
 * result stays in memory; nothing here writes or logs it.
 */
export async function openGrantedPersonInformation(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  bundleId: string;
  subjectRef: string;
  domainFor?: (requestId: string) => string | null | undefined;
  /**
   * Open only these items of the bundle (the secure card). Items among them
   * that are no longer shared come back in `endedRequestIds` instead of
   * failing the whole open.
   */
  requestIds?: readonly string[];
  isCurrent?: () => boolean;
}): Promise<{ values: OpenedPersonInformation[]; expiresAtMs: number; endedRequestIds: string[] } | null> {
  const current = input.isCurrent ?? (() => true);
  // Shares a read already on the wire (the doorbell's, the access watch's):
  // the re-check after decrypting below is the one that must be fresh.
  const bundle = await readInformationRequest({
    bundleId: input.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (bundle.bundleId !== input.bundleId || bundle.personRef !== input.subjectRef) {
    throw new Error("Mismatched request");
  }
  const wanted = input.requestIds ? new Set(input.requestIds) : null;
  const inScope = wanted ? bundle.items.filter((item) => wanted.has(item.requestId)) : bundle.items;
  const granted = inScope.filter((item) => item.status === "granted");
  const endedRequestIds = wanted
    ? inScope.filter((item) => item.status === "revoked" || item.status === "expired").map((item) => item.requestId)
    : [];
  if (!granted.length) {
    if (wanted) return { values: [], expiresAtMs: Number.MAX_SAFE_INTEGER, endedRequestIds };
    throw new Error("No current grant");
  }
  const connector = await OneKycClientZkService.readStoredConnector({
    userId: input.userId,
    vaultKey: input.vaultKey,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (!connector) throw new Error("Connection unavailable");
  const exports = await readInformationRequestExports({
    bundleId: bundle.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  const values: OpenedPersonInformation[] = [];
  let expiresAtMs = Number.MAX_SAFE_INTEGER;
  for (const item of granted) {
    const exact = exports.find((entry) => entry.requestId === item.requestId);
    if (!exact || !isCurrentPersonExport({
      item,
      scopeRef: exact.scopeRef,
      exportPackage: exact.encryptedExport,
      nowMs: Date.now(),
    })) {
      throw new Error("Export unavailable or changed");
    }
    const payload = await OneKycClientZkService.decryptScopedExport({
      exportPackage: exact.encryptedExport,
      connector,
    });
    if (!current()) return null;
    const domain = input.domainFor?.(item.requestId);
    const fields = parseSharedFieldSensitivities((item as { fields?: unknown }).fields);
    values.push({
      requestId: item.requestId,
      label: item.label,
      data: projectGrantPayload(payload, domain),
      sensitivity: itemSensitivity(bundle, item, domain),
      ...(fields.length ? { fields } : {}),
    });
    expiresAtMs = Math.min(expiresAtMs, exact.encryptedExport.export_envelope.aad.expires_at_ms);
  }
  const latest = await readInformationRequest({
    bundleId: bundle.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
    fresh: true,
  });
  if (!current()) return null;
  if (
    latest.bundleId !== bundle.bundleId ||
    latest.personRef !== input.subjectRef ||
    !values.every((value) =>
      latest.items.some((item) => item.requestId === value.requestId && item.status === "granted"),
    )
  ) {
    throw new Error("Grant changed while opening information");
  }
  return { values, expiresAtMs, endedRequestIds };
}

/** One item of the secure card, as the chat (C6) or Profile names it. */
export type SharedItemRef = {
  key: string;
  bundleId: string | null;
  requestId: string | null;
  /** C6's opaque reference; matched against the share list when no bundle is named. */
  grantRef: string | null;
  label: string;
  domain?: string | null;
};

/**
 * `bundleId` and `requestId` name what the item resolved to, so the card can
 * watch that access for its end even when the item named no bundle itself.
 */
export type SharedItemOpenResult =
  | { key: string; state: "open"; value: OpenedPersonInformation; expiresAtMs: number; bundleId: string; requestId: string }
  | { key: string; state: "ended"; bundleId?: string; requestId?: string }
  | { key: string; state: "unavailable" };

/**
 * Open the card's items on this device. An item that names no bundle (a C6
 * grant reference) is resolved through the person's current share list,
 * which names the bundle and item of every live approval; an item that no
 * longer appears there has nothing to open. Each bundle opens on its own, so
 * one failure never hides what another person's other items show.
 */
export async function openSharedItems(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  subjectRef: string;
  items: SharedItemRef[];
  isCurrent?: () => boolean;
}): Promise<SharedItemOpenResult[] | null> {
  const current = input.isCurrent ?? (() => true);
  const resolved = new Map<string, { bundleId: string; requestId: string }>();
  const unresolved: SharedItemRef[] = [];
  for (const item of input.items) {
    if (item.bundleId && item.requestId) resolved.set(item.key, { bundleId: item.bundleId, requestId: item.requestId });
    else unresolved.push(item);
  }
  if (unresolved.length) {
    const shares = (await readSharedWithMe({ vaultOwnerToken: input.vaultOwnerToken }))
      .filter((share) => share.personRef === input.subjectRef);
    if (!current()) return null;
    for (const item of unresolved) {
      const ref = item.requestId || item.grantRef;
      const match = (ref ? shares.find((share) => share.requestId === ref) : undefined)
        ?? shares.find((share) => (!item.bundleId || share.bundleId === item.bundleId) && share.label === item.label);
      if (match) resolved.set(item.key, { bundleId: match.bundleId, requestId: match.requestId });
    }
  }
  const byBundle = new Map<string, SharedItemRef[]>();
  for (const item of input.items) {
    const target = resolved.get(item.key);
    if (target) byBundle.set(target.bundleId, [...(byBundle.get(target.bundleId) ?? []), item]);
  }
  const results = new Map<string, SharedItemOpenResult>();
  await Promise.all([...byBundle.entries()].map(async ([bundleId, items]) => {
    const requestIdFor = (item: SharedItemRef) => resolved.get(item.key)!.requestId;
    try {
      const opened = await openGrantedPersonInformation({
        userId: input.userId,
        vaultKey: input.vaultKey,
        vaultOwnerToken: input.vaultOwnerToken,
        bundleId,
        subjectRef: input.subjectRef,
        requestIds: items.map(requestIdFor),
        domainFor: (requestId) => items.find((item) => requestIdFor(item) === requestId)?.domain,
        isCurrent: current,
      });
      if (!opened) return;
      for (const item of items) {
        const requestId = requestIdFor(item);
        const value = opened.values.find((entry) => entry.requestId === requestId);
        results.set(item.key, value
          ? { key: item.key, state: "open", value, expiresAtMs: opened.expiresAtMs, bundleId, requestId }
          : opened.endedRequestIds.includes(requestId)
            ? { key: item.key, state: "ended", bundleId, requestId }
            : { key: item.key, state: "unavailable" });
      }
    } catch {
      for (const item of items) results.set(item.key, { key: item.key, state: "unavailable" });
    }
  }));
  if (!current()) return null;
  return input.items.map((item) => results.get(item.key) ?? { key: item.key, state: "unavailable" });
}

const MAX_SHARED_TEXT_CHARS = 12_000;

function humanKey(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * "Label > path: value" lines for one standard item. A field whose key (or a
 * key above it) is identifier-class, whose value is identifier-shaped, or
 * that the server's `fields[]` names sensitive, is withheld and its name
 * collected instead (C7, field level): the EIN inside "Legal entity" never
 * leaves this device, while "Trade name" still reaches One.
 */
function appendLines(
  lines: string[],
  value: unknown,
  path: string[],
  keys: string[],
  withheld: { names: ReadonlySet<string>; hidden: string[] },
): void {
  if (value === null || value === undefined || value === "") return;
  const leaf = (text: string) => {
    const field = [...keys].reverse().find((key) => !/^\d+$/.test(key)) ?? "";
    if (fieldSensitivity(keys, text) === "standard" && !isNamedSensitiveField(withheld.names, field, humanKey(field))) {
      lines.push(`- ${path.join(" > ")}: ${text}`);
      return;
    }
    withheld.hidden.push(withheldFieldName(field));
  };
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object" || entry === null);
    if (scalars.length === value.length) {
      leaf(scalars.map(String).join(", "));
      return;
    }
    value.forEach((entry, index) => appendLines(lines, entry, [...path, String(index + 1)], [...keys, String(index + 1)], withheld));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Internal bookkeeping keys are not part of what was shared.
      if (key.startsWith("_")) continue;
      appendLines(lines, entry, [...path, humanKey(key)], [...keys, key], withheld);
    }
    return;
  }
  leaf(String(value));
}

/** The server's outline-name shape (`_OUTLINE_NAME`); anything else goes unnamed. */
const OUTLINE_NAME = /^[A-Za-z][A-Za-z &/-]{0,39}$/;

/** `_field_name` in consent_continuation.py: the fixed label, else the key, capitalised. */
function withheldFieldName(key: string): string {
  const leaf = humanKey(key);
  const name = knownFieldLabel(leaf) ?? (leaf ? leaf[0]!.toUpperCase() + leaf.slice(1) : "");
  return OUTLINE_NAME.test(name) ? name : "";
}

/**
 * The model's view of a standard item's identifier fields: names, never
 * values. Byte-for-byte `sensitive_fields_line` in consent_continuation.py,
 * so the server reads it back as the outline it would have written itself.
 */
export function sensitiveFieldsLine(label: string, names: readonly string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  const shown = unique.slice(0, MAX_OUTLINE_NAMES);
  const more = unique.length - shown.length;
  const listing = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  const plural = unique.length !== 1 ? "s" : "";
  return `- ${label}: sensitive field${plural} (${listing || "unnamed"}). Shown to the person in `
    + "the secure card on their device; the values are not shared with you.";
}

/** Bookkeeping keys that name the record's structure, not a field in it. */
const OUTLINE_SKIP_KEYS = new Set([
  "kind", "status", "id", "type", "state", "scope", "domain", "sensitivity", "source", "sources",
  "version", "schema", "confidence", "provenance", "tags", "created_at", "updated_at", "observed_at", "timestamp",
]);
const MAX_OUTLINE_NAMES = 8;

/**
 * Field names of a record, never its values: the keys that hold a value
 * directly (a leaf, or a list of leaves). Keys that hold further records are
 * walked, not named, because a key over nested records can itself be
 * information (an institution's name). Ids, internal and numeric keys are
 * dropped outright.
 */
export function sharedFieldNames(data: unknown): string[] {
  return sharedFieldOutline(data).names;
}

/** Field names plus how many fields there are, some of them unnamed on purpose. */
export function sharedFieldOutline(data: unknown): { names: string[]; count: number } {
  const names: string[] = [];
  let flagCount = 0;
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.slice(0, 50).forEach((entry) => walk(entry, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const lower = key.trim().toLowerCase();
      if (!lower || lower.startsWith("_") || OUTLINE_SKIP_KEYS.has(lower) || /(^|_)id$/.test(lower)
        || /\d{3,}/.test(lower) || lower.length > 40) continue;
      const leaf = value === null || typeof value !== "object"
        || (Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object"));
      if (!leaf) {
        walk(value, depth + 1);
        continue;
      }
      // A key over a bare yes/no is often the answer itself ("Married filing
      // jointly": true); it is counted, never named.
      if (typeof value === "boolean") {
        flagCount += 1;
        continue;
      }
      const name = humanKey(key).toLowerCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name[0]!.toUpperCase() + name.slice(1));
    }
  };
  walk(data, 0);
  return { names, count: names.length + flagCount };
}

/**
 * The model's view of a sensitive item: its label and field names only, e.g.
 * "Tax record: 4 fields (Filing year, Adjusted gross income, Refund, Filing
 * status)". The values stay in the secure card on this device.
 */
export function sensitiveSharedOutline(value: Pick<OpenedPersonInformation, "label" | "data">): string {
  const { names, count: total } = sharedFieldOutline(value.data);
  const shown = names.slice(0, MAX_OUTLINE_NAMES);
  const more = total - shown.length;
  const list = shown.length ? ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
  const count = total ? `${total} ${total === 1 ? "field" : "fields"}` : "shared";
  return `- ${value.label}: ${count}${list}. Sensitive: shown to the person in the secure card on their device; `
    + "the values are not shared with you.";
}

/** Missing sensitivity is sensitive; `standard` still yields to the deny-list. */
export function isSensitiveSharedValue(value: Pick<OpenedPersonInformation, "label" | "sensitivity">): boolean {
  return resolveSharedSensitivity({ sensitivity: value.sensitivity, label: value.label }) === "sensitive";
}

/**
 * The plain text One reads for the one follow-up turn: each approved item as
 * "Label > path: value" lines, bounded to the server's accepted size. A
 * sensitive item (C7) contributes its outline only; its values never leave
 * this device.
 */
export function formatSharedInformationForAgent(values: OpenedPersonInformation[]): string {
  const lines: string[] = [];
  for (const value of values) {
    if (isSensitiveSharedValue(value)) {
      lines.push(sensitiveSharedOutline(value));
      continue;
    }
    const withheld = { names: sensitiveFieldNameSet(value.fields), hidden: [] as string[] };
    appendLines(lines, value.data, [value.label], [], withheld);
    if (withheld.hidden.length) lines.push(sensitiveFieldsLine(value.label, withheld.hidden));
  }
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > MAX_SHARED_TEXT_CHARS) break;
    text = next;
  }
  return text;
}

/**
 * The answer a chat reports once the other person decides (contract C3).
 * `partially_granted` means some of what was asked was shared and some was
 * not; `revoked` means sharing was stopped, which is distinct from a request
 * or access window that simply ran out (`expired`).
 */
export type ConsentOutcome = "granted" | "partially_granted" | "denied" | "expired" | "revoked";

const CONSENT_OUTCOMES: ReadonlySet<string> = new Set<ConsentOutcome>([
  "granted",
  "partially_granted",
  "denied",
  "expired",
  "revoked",
]);

/**
 * The outcomes the server's continuation admission accepts as the turn's
 * outcome: all five, each as itself (`CONSENT_OUTCOME_LABELS` in
 * `consent_continuation.py`).
 */
export type ConsentContinuationWireOutcome = ConsentOutcome;

/**
 * The fixed text of the follow-up turn, sent as its message. It MUST equal
 * `CONSENT_OUTCOME_LABELS` in `consent-protocol/hushh_mcp/one_adk/consent_continuation.py`:
 * admission refuses a follow-up whose message is anything else. People never
 * read this text; the chip shows `consentOutcomeDisplayText` instead.
 */
export const CONSENT_OUTCOME_LABELS: Record<ConsentContinuationWireOutcome, string> = {
  granted: "Consent approved",
  partially_granted: "Partly approved",
  denied: "Request declined",
  expired: "Request expired",
  revoked: "Access ended",
};

/**
 * How each outcome travels to the server: as itself. Admission compares the
 * sent outcome with the ledger's own `progress.outcome`, which distinguishes a
 * partial approval and a stop from a lapse, so mapping them would be refused.
 */
export const CONSENT_WIRE_OUTCOME: Record<ConsentOutcome, ConsentContinuationWireOutcome> = {
  granted: "granted",
  partially_granted: "partially_granted",
  denied: "denied",
  expired: "expired",
  revoked: "revoked",
};

/** Outcomes that carry the other person's information into the answer turn. */
export function isSharedOutcome(outcome: string | null | undefined): outcome is "granted" | "partially_granted" {
  return outcome === "granted" || outcome === "partially_granted";
}

/** The exact message a follow-up turn for this outcome sends. */
export function consentContinuationSentLabel(outcome: ConsentOutcome): string {
  return CONSENT_OUTCOME_LABELS[CONSENT_WIRE_OUTCOME[outcome]];
}

/** A sent label read back from history, as the outcome the server recorded. */
export function wireOutcomeForSentLabel(text: string): ConsentContinuationWireOutcome | null {
  for (const [outcome, label] of Object.entries(CONSENT_OUTCOME_LABELS)) {
    if (label === text) return outcome as ConsentContinuationWireOutcome;
  }
  return null;
}

/** Access that was shared and has since ended: its answers are hidden. */
export function isAccessEndedOutcome(outcome: ConsentOutcome | null | undefined): boolean {
  return outcome === "revoked" || outcome === "expired";
}

function joinLabels(labels: readonly string[]): string {
  const clean = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}`;
}

/**
 * What the outcome chip says to the person, e.g. "Kushal shared Food
 * preferences". Display only: the turn itself always sends the fixed label.
 */
export function consentOutcomeDisplayText(input: {
  outcome: ConsentOutcome;
  personName?: string | null;
  sharedLabels?: readonly string[];
}): string {
  const name = input.personName?.trim() || "";
  const who = name || "They";
  const what = joinLabels(input.sharedLabels ?? []);
  switch (input.outcome) {
    case "granted":
      return what ? `${who} shared ${what}` : `${who} shared what you asked for`;
    case "partially_granted":
      return what ? `${who} shared ${what} and declined the rest` : `${who} shared part of what you asked for`;
    case "denied":
      return `${who} declined`;
    case "expired":
      return name ? `${name}'s request expired` : "Your request expired";
    case "revoked":
      return what ? `${who} stopped sharing ${what}` : `${who} stopped sharing`;
  }
}

/**
 * The shared chip once that sharing has ended: it no longer says "Kushal
 * shared Food preferences" beside answers that now read "Access ended".
 */
export function consentAccessEndedChipText(input: {
  reason: "revoked" | "expired";
  personName?: string | null;
  sharedLabels?: readonly string[];
}): string {
  const name = input.personName?.trim() || "";
  const what = joinLabels(input.sharedLabels ?? []);
  if (input.reason === "expired") {
    return what ? `Access to ${what} ended` : "Access ended";
  }
  const who = name || "They";
  return what ? `${who} stopped sharing ${what}` : `${who} stopped sharing`;
}

function progressOutcome(bundle: unknown): ConsentOutcome | "pending" | null {
  const progress = (bundle as { progress?: unknown } | null)?.progress;
  if (!progress || typeof progress !== "object") return null;
  const outcome = (progress as { outcome?: unknown }).outcome;
  if (outcome === "pending") return "pending";
  return typeof outcome === "string" && CONSENT_OUTCOMES.has(outcome) ? (outcome as ConsentOutcome) : null;
}

/**
 * The one answer a chat reports, or null while the request is still open.
 * Uses the server's `progress.outcome` when present; otherwise reads item
 * statuses the same way the server's `bundle_outcome` does, with the richer
 * partial and revoked readings layered on top.
 */
export function informationRequestOutcome(
  bundle: Pick<InformationRequestBundle, "items" | "cancelled">,
): ConsentOutcome | null {
  if (bundle.cancelled) return null;
  const fromServer = progressOutcome(bundle);
  if (fromServer === "pending") return null;
  if (fromServer) return fromServer;
  const statuses = bundle.items.map((item) => item.status);
  if (!statuses.length || statuses.includes("pending")) return null;
  if (statuses.includes("granted")) {
    return statuses.every((status) => status === "granted") ? "granted" : "partially_granted";
  }
  if (statuses.includes("denied")) return "denied";
  if (statuses.includes("revoked")) return "revoked";
  if (statuses.includes("expired")) return "expired";
  return null;
}

/** Labels of what is currently shared in this bundle, for display. */
export function sharedItemLabels(bundle: Pick<InformationRequestBundle, "items">): string[] {
  return bundle.items.filter((item) => item.status === "granted").map((item) => item.label);
}
