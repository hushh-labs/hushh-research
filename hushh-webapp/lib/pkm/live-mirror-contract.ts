import type { LivingSourceInput } from "@/lib/pkm/living-source-records";

/**
 * Live Mirror v1: the one owner-scoped projection that Profile, One's profile
 * sheet and the private agent read. It is derived in memory from the encrypted
 * source inventory, its observed history and the derived memory document. It
 * is never an authority, never persisted and never shared with another
 * person. Its Markdown is a deterministic preview generated from it.
 */
export type LiveMirrorKind = LivingSourceInput["kind"];

export const LIVE_MIRROR_KINDS = [
  "profile",
  "consent",
  "connection",
  "curated_oauth_connector",
  "document_earning",
  "payout_activity",
  "document_request_payment",
] as const satisfies readonly LiveMirrorKind[];

export const LIVE_MIRROR_SOURCE_LABELS: Record<LiveMirrorKind, string> = {
  profile: "Profile",
  consent: "Consents",
  connection: "Connections",
  curated_oauth_connector: "Connected apps",
  document_earning: "Earnings",
  payout_activity: "Wallet activity",
  document_request_payment: "Document payments",
};

/** A living source must be re-verified within this window to be current. */
export const LIVE_MIRROR_FRESHNESS_MS = 5 * 60_000;
/** 60s wakes let a healthy source reach about six minutes before its rescan lands. */
export const LIVE_MIRROR_STALE_GRACE_MS = 2 * 60_000;

/** One plain boundary line, shared by every surface that shows the mirror. */
export const LIVE_MEMORY_BOUNDARY_COPY = "Updates while the app is open and unlocked.";

/** Identifiers of other people. They never become mirror facts. */
export const LIVE_MIRROR_HIDDEN_PREDICATES = [
  "consent.counterpart",
  "connection.counterpartId",
  "document_request_payment.counterpartRef",
] as const;
/** URL-valued fields are reduced to presence (`true`) before they become facts. */
export const LIVE_MIRROR_PRESENCE_ONLY_PREDICATES = ["profile.photo"] as const;

export type LiveMirrorSourceState =
  | "current"
  | "updating"
  | "stale"
  | "unavailable"
  | "withheld"
  | "conflict"
  | "not_checked";

export type LiveMirrorOverall =
  | "locked"
  | "loading"
  | "current"
  | "updating"
  | "stale"
  | "partial"
  | "conflict"
  | "empty";

export type LiveMirrorFactState = "verified" | "stale" | "unavailable" | "deleted" | "conflicted";

export type LiveMirrorFactValue = string | number | boolean;

export interface LiveMirrorSource {
  /** "living:<kind>" for an inventory source, "saved:<domain>" for a saved-detail section. */
  id: string;
  group: "living" | "saved";
  kind: LiveMirrorKind | null;
  domain: string | null;
  label: string;
  /** Read-time state inside a LiveMirrorView. */
  state: LiveMirrorSourceState;
  verifiedAt: string | null;
  /** Living: freshness window plus grace. Saved sections are revision-based (null). */
  staleAfterMs: number | null;
  contentRevision: number | null;
  reason: "could_not_read" | "inventory_incomplete" | "excluded_by_rule" | null;
  withheld: string[];
  /** Non-deleted records for a living source; 0 for saved sections. */
  liveCount: number;
  /** Committed hints still awaiting verification; null means unknown after a journal reset. */
  pendingChanges: number | null;
  /** Commit to encrypted write lag of the last applied change, owner-only. */
  lastLagMs: number | null;
  medianLagMs: number | null;
}

export interface LiveMirrorFact {
  /** Owner-only lookup key. Never rendered raw and never sent to a model. */
  key: string;
  /** "<kind>.<field>". Record markers never become facts. */
  predicate: string;
  kind: LiveMirrorKind;
  /** Owner-only source record id. Never rendered raw and never sent to a model. */
  sourceId: string;
  /** Stable, human-safe record reference such as "Consent 2" or "Profile". */
  ref: string;
  field: string;
  label: string;
  /** Null when the record is deleted or its sources disagree. */
  value: LiveMirrorFactValue | null;
  /** Read-time state inside a LiveMirrorView. */
  state: LiveMirrorFactState;
  revision: number;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  verifiedAt: string | null;
}

/** An explicit record that committed changes were not individually captured. */
export interface LiveMirrorGap {
  reason: "unobserved_changes" | "journal_gap";
  committedChanges: number | null;
  verifiedChanges: number | null;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
}

export interface LiveMirrorHistoryEntry {
  sequence: number;
  kind: LiveMirrorKind;
  ref: string;
  revision: number;
  operation: "upsert" | "delete" | "gap";
  capturedAt: string;
  sourceUpdatedAt: string | null;
  /** Admitted fields only. Empty for gaps and for records that were later removed. */
  changes: { predicate: string; label: string; value: LiveMirrorFactValue | null }[];
  /** True only for a record's latest retained revision. */
  current: boolean;
  /** True when earlier values were hidden because the record was later removed. */
  redacted: boolean;
  gap: LiveMirrorGap | null;
}

export interface LiveMirrorHistory {
  /** Newest first. */
  entries: LiveMirrorHistoryEntry[];
  firstRetainedSequence: number;
  /** Changes dropped by the bounded retention window; 0 when nothing was dropped. */
  droppedCount: number;
  truncatedAt: string | null;
  /** Values changed while every client was closed or locked cannot be reconstructed. */
  coverage: "open_app_only";
}

/** One claim about a predicate, with where it came from. */
export interface LiveMirrorClaim {
  /** "soul" for the owner-authored chat memory, else the living source kind. */
  source: "soul" | LiveMirrorKind;
  label: string;
  value: LiveMirrorFactValue | null;
  revision: number | null;
  sourceUpdatedAt: string | null;
  verifiedAt: string | null;
  /** A money claim's own ISO currency from its copy; null when the copy names none; absent when the claim is not money. */
  currency?: string | null;
  /** "named": a Soul-versus-profile name claim. "record": one side of a record whose revisions disagree. */
  origin?: "named" | "record";
}

/** The sides disagree about one predicate. Every claim is shown; none is chosen. */
export interface LiveMirrorConflict {
  predicate: string;
  label: string;
  claims: LiveMirrorClaim[];
}

/** Where the owner changes a source's values; never a Live Mirror write path. */
export interface LiveMirrorSourceRoute {
  href: string;
  label: string;
}

export interface LiveMirrorProjection {
  schemaVersion: "live_mirror.v1";
  /** Consumers must drop the projection when this differs from the signed-in owner. */
  ownerId: string;
  /** Consumers must drop the projection when this differs from the current vault epoch. */
  vaultEpoch: number;
  builtAt: string;
  inventoryObservedAt: string | null;
  inventoryComplete: boolean;
  issues: readonly string[];
  /** The owner-authored Soul name differs from the verified account name. */
  nameConflict: boolean;
  /** Every disagreement, with both claims and their provenance. Empty when none. */
  conflicts?: LiveMirrorConflict[];
  /** Seven living kinds in LIVE_MIRROR_KINDS order, then saved sections by domain. */
  sources: LiveMirrorSource[];
  /** Sorted by key. */
  facts: LiveMirrorFact[];
  history: LiveMirrorHistory;
  /** Deterministic preview; values are Markdown- and HTML-escaped. */
  markdown: string;
}

/**
 * A projection with read-time states applied. "Current" is never trusted from
 * a cache: source and fact states, `overall` and `markdown` reflect `evaluatedAt`.
 */
export interface LiveMirrorView extends LiveMirrorProjection {
  evaluatedAt: string;
  overall: LiveMirrorOverall;
  lastVerifiedAt: string | null;
}
