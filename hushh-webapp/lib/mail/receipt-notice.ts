/**
 * What One noticed in the owner's receipts and provider mail.
 *
 * The backend reads the evidence and a model decides whether anything deserves
 * attention; the server validates every quote, number and reference before it
 * answers. This module is the device's side: it strictly parses that answer,
 * chooses which saved receipts to send (ordinary code, bounded), decides when a
 * check is worth running again, and keeps findings bound to one mailbox.
 * Nothing here cancels, pays or changes a mailbox.
 */
import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { DurableResourceError } from "@/lib/services/durable-resource-error";

import { merchantKey } from "./receipt-cadence";
import type { ReceiptInsight } from "./receipt-insights";
import { receiptMoneyKind } from "./receipt-month-summary";

export const NOTICE_KINDS = ["plan_review", "inactive_plan", "refund_followup", "possible_duplicate", "price_rise"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const EVIDENCE_ROLES = ["paid", "provider_notice", "announcement", "refund_promise", "refund_confirmation", "cancellation", "charge"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export type FactValue = string | number | boolean | null;

export const NOTICE_LIMITS = { keys: 40, providers: 8, perProvider: 5, findings: 8, resolved: 20, cancellations: 16, evidence: 8, plans: 12, lookbackDays: 240 } as const;
/** A good check stays current this long unless the saved receipts change first. */
export const NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a failed check, wait this long before trying again on its own. */
export const NOTICE_RETRY_AFTER_MS = 30 * 60 * 1000;

export interface NoticeEvidence {
  evidenceId: string;
  openKey: string;
  role: EvidenceRole;
  quote: string;
  on: string;
  subject: string;
  from: string;
  domain: string;
}

export interface NoticePlan {
  label: string;
  domain: string;
  category: string;
  period: "monthly" | "yearly" | "unknown";
  amountMinor: number;
  currency: string;
  evidenceId: string;
  openKey: string;
  paidOn: string;
}

export interface NoticeFinding {
  id: string;
  kind: NoticeKind;
  headline: string;
  reason: string;
  /** "question" is a weaker clue: the card asks, and never claims. */
  strength: "clear" | "question";
  provider: { name: string; domain: string } | null;
  action: { id: string; label: string };
  evidence: NoticeEvidence[];
  plans: NoticePlan[];
  facts: Record<string, FactValue>;
  /** Who said it, and when: set for a provider's own usage statement. */
  attribution: { by: string; on: string; statement: string; evidenceId: string | null } | null;
  score: number;
  generatedAt: string;
}

export interface ResolvedNotice {
  priorId: string;
  headline: string;
  evidence: NoticeEvidence;
  at: string;
}

export interface ProviderCancellation {
  domain: string;
  on: string;
  subject: string;
  evidenceId: string;
  openKey: string;
}

export interface NoticeState {
  findings: NoticeFinding[];
  resolved: ResolvedNotice[];
  cancellations: ProviderCancellation[];
  /** When the last successful check finished. */
  checkedAt: string | null;
  /** Which saved receipts that check covered. */
  digest: string | null;
  model: string | null;
  coverage: { providers: number; messages: number } | null;
}

export interface NoticeCheck {
  accountKey: string;
  generatedAt: string;
  model: string;
  coverage: { providers: number; messages: number };
  findings: NoticeFinding[];
  resolved: Array<{ priorId: string; evidence: NoticeEvidence }>;
  cancellations: ProviderCancellation[];
  noneReason: string;
}

export function emptyNotice(): NoticeState {
  return { findings: [], resolved: [], cancellations: [], checkedAt: null, digest: null, model: null, coverage: null };
}

// ---- strict parsing (device storage and server answers share it) -------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const URLISH = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.-]+/i;
const bad = (): never => { throw new DurableResourceError("schema_invalid", "schema", "A Mail finding has an unexpected shape."); };
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number, min = 0): string => (typeof v === "string" && v.length >= min && v.length <= max ? v : bad());
const text = (v: unknown, max: number, min = 1): string => { const value = str(v, max, min); return URLISH.test(value) ? bad() : value; };
const day = (v: unknown): string => (typeof v === "string" && ISO_DAY.test(v) ? v : bad());
const stamp = (v: unknown): string => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : bad());
const minor = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : bad());
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad());
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad());

export function parseEvidence(value: unknown): NoticeEvidence {
  if (!isObj(value)) return bad();
  return {
    evidenceId: str(value.evidenceId ?? value.evidence_id, 80, 8),
    openKey: str(value.openKey ?? value.open_key, 340, 8),
    role: oneOf(value.role, EVIDENCE_ROLES),
    quote: str(value.quote, 400, 6),
    on: day(value.on),
    subject: str(value.subject, 160),
    from: str(value.from, 60),
    domain: str(value.domain, 120),
  };
}

function parseCancellation(value: unknown): ProviderCancellation {
  if (!isObj(value)) return bad();
  return {
    domain: str(value.domain, 120, 3), on: day(value.on), subject: str(value.subject, 160),
    evidenceId: str(value.evidenceId ?? value.evidence_id, 80, 8), openKey: str(value.openKey ?? value.open_key, 340, 8),
  };
}

function parsePlan(value: unknown): NoticePlan {
  if (!isObj(value)) return bad();
  return {
    label: text(value.label, 60), domain: str(value.domain, 120, 3), category: str(value.category, 40),
    period: oneOf(value.period, ["monthly", "yearly", "unknown"] as const),
    amountMinor: minor(value.amountMinor ?? value.amount_minor), currency: str(value.currency, 3, 1),
    evidenceId: str(value.evidenceId ?? value.evidence_id, 80, 8), openKey: str(value.openKey ?? value.open_key, 340, 8),
    paidOn: day(value.paidOn ?? value.paid_on),
  };
}

export function parseFinding(value: unknown): NoticeFinding {
  if (!isObj(value)) return bad();
  const facts: Record<string, FactValue> = {};
  if (isObj(value.facts)) {
    for (const [key, item] of Object.entries(value.facts).slice(0, 24)) {
      if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") facts[str(key, 40, 1)] = typeof item === "string" ? str(item, 200) : item;
      else bad();
    }
  }
  const attribution = value.attribution === null || value.attribution === undefined ? null : (() => {
    if (!isObj(value.attribution)) return bad();
    const a = value.attribution;
    const evidenceId = a.evidenceId ?? a.evidence_id;
    return { by: text(a.by, 60), on: day(a.on), statement: str(a.statement, 400, 6), evidenceId: evidenceId === null || evidenceId === undefined ? null : str(evidenceId, 80, 8) };
  })();
  const provider = value.provider === null || value.provider === undefined ? null : (() => {
    if (!isObj(value.provider)) return bad();
    return { name: text(value.provider.name, 60), domain: str(value.provider.domain, 120, 3) };
  })();
  const action = isObj(value.action) ? { id: str(value.action.id, 30, 3), label: text(value.action.label, 30) } : bad();
  const generatedAt = stamp(value.generatedAt ?? value.generated_at);
  return {
    id: str(value.id, 80, 8), kind: oneOf(value.kind, NOTICE_KINDS),
    headline: text(value.headline, 90, 6), reason: text(value.reason, 200, 10),
    strength: oneOf(value.strength, ["clear", "question"] as const),
    provider, action,
    evidence: arr(value.evidence, NOTICE_LIMITS.evidence).map(parseEvidence),
    plans: arr(value.plans ?? [], NOTICE_LIMITS.plans).map(parsePlan),
    facts, attribution, score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : 0,
    generatedAt,
  };
}

/** The saved part of the tracking document. A document saved before this existed has none, which is empty. */
export function parseNoticeState(value: unknown): NoticeState {
  if (value === undefined || value === null) return emptyNotice();
  if (!isObj(value)) return bad();
  return {
    findings: arr(value.findings, NOTICE_LIMITS.findings).map(parseFinding),
    resolved: arr(value.resolved, NOTICE_LIMITS.resolved).map((raw) => {
      if (!isObj(raw)) return bad();
      return { priorId: str(raw.priorId, 80, 8), headline: text(raw.headline, 90, 6), evidence: parseEvidence(raw.evidence), at: stamp(raw.at) };
    }),
    cancellations: arr(value.cancellations, NOTICE_LIMITS.cancellations).map(parseCancellation),
    checkedAt: value.checkedAt === null ? null : stamp(value.checkedAt),
    digest: value.digest === null ? null : str(value.digest, 40, 4),
    model: value.model === null ? null : str(value.model, 80),
    coverage: value.coverage === null ? null : (isObj(value.coverage) ? { providers: minor(value.coverage.providers), messages: minor(value.coverage.messages) } : bad()),
  };
}

/** The server's answer for one mailbox. Anything off-contract is refused whole, never half-shown. */
export function parseNoticeResponse(payload: unknown, expectedAccount: string): NoticeCheck {
  if (!isObj(payload)) return bad();
  // A check belongs to the mailbox it was asked about; another mailbox's answer never lands here.
  if (str(payload.account_key, 256, 1) !== expectedAccount) throw new DurableResourceError("binding_invalid", "readback", "That check was for another mailbox.");
  const coverage = isObj(payload.coverage) ? { providers: minor(payload.coverage.providers), messages: minor(payload.coverage.messages) } : bad();
  const seen = new Set<string>();
  const findings = arr(payload.findings, NOTICE_LIMITS.findings).map(parseFinding).filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
  return {
    accountKey: expectedAccount,
    generatedAt: stamp(payload.generated_at),
    model: str(payload.model, 80),
    coverage,
    findings,
    resolved: arr(payload.resolved ?? [], NOTICE_LIMITS.resolved).map((raw) => {
      if (!isObj(raw)) return bad();
      return { priorId: str(raw.prior_id, 80, 8), evidence: parseEvidence(raw.evidence) };
    }),
    cancellations: arr(payload.cancellations ?? [], NOTICE_LIMITS.cancellations).map(parseCancellation),
    noneReason: str(payload.none_reason ?? "", 200),
  };
}

// ---- which saved receipts to ask about ---------------------------------------------------------------

const DAY = 86_400_000;
const SEALED_KEY = /^(?:grs1_[A-Za-z0-9_-]{39,310}|gmail_live_[A-Za-z0-9_-]{2,267}\.[0-9a-f]{48})$/;

export interface NoticeInput {
  keys: string[];
  /** Stable for the same saved receipts; changes when a receipt is added, changed or removed. */
  digest: string;
}

function hash(value: string): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) ^ code) >>> 0;
  }
  return `d1_${a.toString(36)}${b.toString(36)}`;
}

/**
 * The newest receipts of the providers most worth a look: those that bill on a rhythm, have a refund or
 * cancellation, or show up often. Ordinary ranking only decides what the check reads; it decides nothing
 * about what the owner is told.
 */
export function selectNoticeInput(rows: readonly RecentReceiptRow[], now: Date, locators: Readonly<Record<string, string>> = {}): NoticeInput {
  const since = now.getTime() - NOTICE_LIMITS.lookbackDays * DAY;
  const groups = new Map<string, RecentReceiptRow[]>();
  for (const row of rows) {
    if (row.archived || row.sourceUnavailable || !row.receiptDate) continue;
    const at = Date.parse(row.receiptDate);
    // A restored row carries a stable reference; the sealed routing key that reopens its email is kept beside it.
    if (Number.isNaN(at) || at < since || !SEALED_KEY.test(locators[row.primaryReceiptKey] ?? row.primaryReceiptKey)) continue;
    const key = merchantKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ranked = [...groups.values()]
    .map((group) => {
      const newest = [...group].sort((a, b) => Date.parse(b.receiptDate!) - Date.parse(a.receiptDate!));
      const recurring = group.some((row) => row.recurrence === "recurring") ? 3 : 0;
      const trouble = group.some((row) => ["refund", "cancelled"].includes(receiptMoneyKind(row))) ? 3 : 0;
      return { newest, score: recurring + trouble + Math.min(group.length, 4) + (Date.parse(newest[0]!.receiptDate!) - since) / (NOTICE_LIMITS.lookbackDays * DAY) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, NOTICE_LIMITS.providers);
  const chosen = ranked.flatMap((group) => group.newest.slice(0, NOTICE_LIMITS.perProvider)).slice(0, NOTICE_LIMITS.keys);
  const keys = chosen.map((row) => locators[row.primaryReceiptKey] ?? row.primaryReceiptKey);
  const digest = hash(chosen.map((row) => `${row.primaryReceiptKey}|${row.receiptDate}|${row.status ?? ""}|${row.amount ?? ""}`).sort().join("\n"));
  return { keys, digest };
}

/** Whether a check is worth running now. Saved findings keep showing either way. */
export function noticeCheckDue(state: NoticeState, digest: string, now: Date, lastFailedAt: number | null): boolean {
  if (lastFailedAt !== null && now.getTime() - lastFailedAt < NOTICE_RETRY_AFTER_MS && state.digest === digest) return false;
  if (state.digest !== digest || !state.checkedAt) return true;
  return now.getTime() - Date.parse(state.checkedAt) >= NOTICE_MAX_AGE_MS;
}

// ---- showing findings ------------------------------------------------------------------------------------

export const ROLE_LABEL: Record<EvidenceRole, string> = {
  paid: "Payment",
  provider_notice: "Their email",
  announcement: "Their notice",
  refund_promise: "Refund promise",
  refund_confirmation: "Refund confirmation",
  cancellation: "Cancellation",
  charge: "Charge",
};

/** A saved finding in the shape the card and the list already use. */
export function noticeInsight(finding: NoticeFinding): ReceiptInsight {
  return {
    id: finding.id,
    kind: finding.kind,
    title: finding.headline,
    reason: finding.reason,
    receiptKeys: finding.evidence.map((item) => item.openKey),
    rowIds: [],
    action: { label: finding.action.label },
    origin: "notice",
    notice: finding,
  };
}

/** The provider's own cancellation email dated on or after the day the owner chose to cancel. */
export function providerCancellationFor(state: NoticeState, domain: string, requestedAt: string): ProviderCancellation | null {
  const since = new Date(requestedAt);
  since.setHours(0, 0, 0, 0);
  const sinceDay = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
  return state.cancellations.find((item) => item.domain === domain && item.on >= sinceDay) ?? null;
}

/** A plan's saved key: the provider and the currency, so two currencies never share one choice. */
export function noticePlanKey(plan: Pick<NoticePlan, "domain" | "currency">): string {
  return `${plan.domain}|${plan.currency}`;
}

export interface NoticeSource {
  subject: string;
  fromName: string | null;
  fromDomain: string | null;
  receivedAt: string | null;
  excerpt: string;
  truncated: boolean;
}

/** One email opened from a finding. */
export function parseNoticeSource(payload: unknown): NoticeSource {
  if (!isObj(payload)) return bad();
  return {
    subject: str(payload.subject, 240),
    fromName: payload.from_name === null || payload.from_name === undefined ? null : str(payload.from_name, 80),
    fromDomain: payload.from_domain === null || payload.from_domain === undefined ? null : str(payload.from_domain, 253),
    receivedAt: payload.received_at === null || payload.received_at === undefined ? null : stamp(payload.received_at),
    excerpt: str(payload.excerpt, 8_000),
    truncated: payload.truncated === true,
  };
}
