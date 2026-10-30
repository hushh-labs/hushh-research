"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useAuth } from "@/hooks/use-auth";
import { FEED_STATE_CHANGED_EVENT, feedStateChangeReason } from "@/lib/feed/feed-events";
import { receiptSnapshotRows, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  formatReceiptAmount,
  receiptAttentionLabel,
  UNAVAILABLE_RECEIPT_AMOUNT,
  type RecentReceiptRow,
} from "@/lib/profile/gmail-receipt-presentation";
import {
  GmailInformationRequestsService,
  type GmailInformationRequestWorkflow,
} from "@/lib/services/gmail-information-requests-service";
import { MailReceiptResourceService } from "@/lib/services/mail-receipt-resource-service";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

import {
  isMailAttentionHidden,
  mailAttentionStateKey,
  markMailAttentionDone,
  readMailAttentionDismissals,
  restoreMailAttention,
  snoozeMailAttention,
  subscribeMailAttentionDismissals,
} from "./mail-attention-dismissals";

export type MailAttentionReason = "overdue" | "payment_failed" | "suspended" | "renewal_due" | "details_request";

/** A factual Mail item the Email models already classified. Safe display fields only. */
export type MailAttentionItem = {
  /** Owner-device identity: `receipt:<display group id>` or `request:<workflow id>`. */
  id: string;
  /** Opaque digest of the identity and its current state. */
  stateKey: string;
  source: "receipt" | "details_request";
  reason: MailAttentionReason;
  title: string;
  subtitle: string;
  /** ISO instant the source mail arrived, when known. */
  receivedAt: string | null;
  /** Receipt display group id or information request workflow id, for navigation. */
  sourceRef: string;
};

export type UseMailAttentionResult = {
  items: readonly MailAttentionItem[];
  /** Hide for 24 hours. Returns an undo bound to the same owner. */
  remindLater: (item: MailAttentionItem) => () => void;
  /** Hide until the item changes. Returns an undo bound to the same owner. */
  markDone: (item: MailAttentionItem) => () => void;
};

const REFRESH_INTERVAL_MS = 120_000;
const REFRESH_SPACING_MS = 15_000;
/** Receipt attention is a point-in-time fact; an old notice is not a nudge. */
const RECEIPT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_LIMIT = 10;
const MAX_ITEMS = 10;
const EMPTY_ITEMS: readonly MailAttentionItem[] = Object.freeze([]);
const PRIORITY: Record<MailAttentionReason, number> = {
  payment_failed: 4, overdue: 4, suspended: 4, details_request: 3, renewal_due: 2,
};
const SUMMARY_ORDER: readonly MailAttentionReason[] = ["overdue", "payment_failed", "suspended", "details_request", "renewal_due"];
const SUMMARY_NOUNS: Record<MailAttentionReason, readonly [string, string]> = {
  overdue: ["overdue payment", "overdue payments"],
  payment_failed: ["failed payment", "failed payments"],
  suspended: ["suspended service", "suspended services"],
  details_request: ["request for your details", "requests for your details"],
  renewal_due: ["renewal due", "renewals due"],
};

/** Only stated, current attention: no prediction, review guess or archived group. */
function factualReason(row: RecentReceiptRow): MailAttentionReason | null {
  if (row.archived || row.sourceUnavailable || row.attentionIsPrediction) return null;
  const reason = row.attentionReason;
  if (row.attentionState === "needs_attention" && (reason === "overdue" || reason === "payment_failed" || reason === "suspended")) return reason;
  if (row.attentionState === "coming_up" && reason === "renewal_due") return reason;
  return null;
}

/** The newest mail in a group is the one that set its current state. */
function latestEvent(row: RecentReceiptRow, times: ReadonlyMap<string, string>): { ref: string; at: string } | null {
  let latest: { ref: string; at: string } | null = null;
  for (const ref of row.sourceReceiptKeys) {
    const at = times.get(ref);
    if (at && (!latest || Date.parse(at) > Date.parse(latest.at))) latest = { ref, at };
  }
  return latest;
}

/** Projects the shared, already-decided receipt groups. No new grouping or provider read. */
export function receiptAttentionCandidates(snapshot: ReceiptSnapshot): MailAttentionItem[] {
  let rows: RecentReceiptRow[];
  try { rows = receiptSnapshotRows(snapshot); } catch { return []; }
  const times = new Map<string, string>();
  for (const record of snapshot.sync?.records ?? []) {
    const ref = record.row.events[0]?.ref;
    if (ref && record.source_time) times.set(ref, record.source_time);
  }
  return rows.flatMap((row) => {
    const reason = factualReason(row);
    const event = reason ? latestEvent(row, times) : null;
    if (!reason || !event) return [];
    const label = receiptAttentionLabel(row.attentionState, row.attentionReason) ?? "";
    const amount = formatReceiptAmount(row.currency, row.amount);
    const id = `receipt:${row.id}`;
    return [{
      id, stateKey: mailAttentionStateKey(id, `${reason}:${event.ref}`), source: "receipt" as const, reason,
      title: row.merchantName, subtitle: amount === UNAVAILABLE_RECEIPT_AMOUNT ? label : `${label} · ${amount}`,
      receivedAt: event.at, sourceRef: row.id,
    }];
  });
}

function readableLabel(label: unknown): string {
  if (typeof label !== "string") return "";
  const readable = label.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return readable ? `${readable.charAt(0).toUpperCase()}${readable.slice(1)}` : "";
}

/** Labels of what was asked for, never a requested or stored value. */
export function detailRequestItem(workflow: GmailInformationRequestWorkflow): MailAttentionItem | null {
  if (workflow.status !== "detected" || typeof workflow.workflow_id !== "string" || !workflow.workflow_id) return null;
  const received = workflow.received_at || workflow.created_at || null;
  const receivedAt = received && Number.isFinite(Date.parse(received)) ? received : null;
  const labels = Array.isArray(workflow.requested_field_labels) ? workflow.requested_field_labels : [];
  const id = `request:${workflow.workflow_id}`;
  return {
    id, stateKey: mailAttentionStateKey(id, `detected:${receivedAt ?? ""}`), source: "details_request",
    reason: "details_request", title: "Request for your details",
    subtitle: labels.slice(0, 3).map(readableLabel).filter(Boolean).join(", ") || "Personal information",
    receivedAt, sourceRef: workflow.workflow_id,
  };
}

export function summarizeMailAttention(items: readonly MailAttentionItem[]): string {
  const counts = new Map<MailAttentionReason, number>();
  for (const item of items) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return SUMMARY_ORDER.flatMap((reason) => {
    const count = counts.get(reason) ?? 0;
    return count ? [`${count} ${SUMMARY_NOUNS[reason][count === 1 ? 0 : 1]}`] : [];
  }).join(" · ");
}

function receivedMs(item: MailAttentionItem): number {
  const value = item.receivedAt ? Date.parse(item.receivedAt) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

function byPriority(left: MailAttentionItem, right: MailAttentionItem): number {
  return PRIORITY[right.reason] - PRIORITY[left.reason] || receivedMs(right) - receivedMs(left) || left.id.localeCompare(right.id);
}

/** Mount, focus, visible return, Feed activity and a visible-only 120 s task, coalesced. */
function useMailAttentionRefresh(active: boolean, epoch: number): { key: number; at: number } {
  const [tick, setTick] = useState(() => ({ key: 0, at: Date.now() }));
  const schedule = useRef<(() => void) | null>(null);
  const taskId = `mail-attention:${useId()}`;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    const run = () => {
      if (timer || document.visibilityState === "hidden" || !isVaultSessionEpochCurrent(epoch)) return;
      timer = setTimeout(() => {
        timer = null;
        if (document.visibilityState === "hidden" || !isVaultSessionEpochCurrent(epoch)) return;
        lastRefreshAt = Date.now();
        setTick((value) => ({ key: value.key + 1, at: lastRefreshAt }));
      }, Math.max(500, lastRefreshAt + REFRESH_SPACING_MS - Date.now()));
    };
    const onFeed = (event: Event) => { if (feedStateChangeReason(event) !== "read") run(); };
    schedule.current = run;
    window.addEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      schedule.current = null;
      if (timer) clearTimeout(timer);
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [active, epoch]);
  usePeriodicTask(taskId, REFRESH_INTERVAL_MS, () => schedule.current?.(), { enabled: active });
  return tick;
}

type ReceiptSession = { ownerId: string | null; vaultKey: string | null; vaultOwnerToken: string | null; account: string | null };

/** Reads the Mail Receipts resource: memory first, then the owner's encrypted device copy. */
function useReceiptAttention({ ownerId, vaultKey, vaultOwnerToken, account }: ReceiptSession, refreshKey: number) {
  const resource = useSyncExternalStore(
    MailReceiptResourceService.subscribe,
    () => MailReceiptResourceService.peek(ownerId ?? "", account ?? ""),
    () => MailReceiptResourceService.peek("", ""),
  );
  useEffect(() => {
    if (!ownerId || !vaultKey || !vaultOwnerToken || !account || resource.hydrated) return;
    void MailReceiptResourceService.hydrate({ userId: ownerId, vaultKey, vaultOwnerToken }, account).catch(() => undefined);
  }, [ownerId, vaultKey, vaultOwnerToken, account, resource.hydrated, refreshKey]);
  const snapshot = ownerId && account ? resource.snapshot : null;
  return useMemo(() => (snapshot ? receiptAttentionCandidates(snapshot) : []), [snapshot]);
}

type RequestSession = {
  active: boolean; scope: symbol; epoch: number; vaultOwnerToken: string | null;
  idTokenProvider: () => Promise<string>; refreshKey: number;
};

/** Detected requests for the owner's details. A failure shows nothing. */
function useDetailRequests({ active, scope, epoch, vaultOwnerToken, idTokenProvider, refreshKey }: RequestSession) {
  const [state, setState] = useState<{ scope: symbol; items: readonly MailAttentionItem[] }>({ scope, items: EMPTY_ITEMS });
  useEffect(() => {
    if (!active || !vaultOwnerToken) return;
    let current = true;
    const isCurrent = () => current && isVaultSessionEpochCurrent(epoch);
    void (async () => {
      try {
        const firebaseIdToken = await idTokenProvider();
        if (!firebaseIdToken || !isCurrent()) return;
        const result = await GmailInformationRequestsService.list({ firebaseIdToken, vaultOwnerToken, limit: REQUEST_LIMIT });
        if (!isCurrent()) return;
        const workflows = Array.isArray(result?.workflows) ? result.workflows : [];
        setState({ scope, items: workflows.map(detailRequestItem).filter((item): item is MailAttentionItem => item !== null) });
      } catch {
        if (isCurrent()) setState({ scope, items: EMPTY_ITEMS });
      }
    })();
    return () => { current = false; };
  }, [active, scope, epoch, vaultOwnerToken, idTokenProvider, refreshKey]);
  return active && state.scope === scope ? state.items : EMPTY_ITEMS;
}

/**
 * Owner-scoped Mail items for the chat welcome. Reads only after vault unlock
 * with Gmail connected; it never starts a mailbox scan and never offers to
 * connect. Nothing is returned while loading, on error or when nothing qualifies.
 */
export function useMailAttention(): UseMailAttentionResult {
  const { user, userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const ownerId = userId ?? null;
  const unlocked = Boolean(ownerId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const idTokenProvider = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const gmail = useGmailConnectorStatus({ userId: ownerId, enabled: unlocked, idTokenProvider: user ? idTokenProvider : null });
  const status = gmail.status;
  const connected = status?.connected === true && status.needs_reauth !== true;
  const account = connected ? status?.google_sub || status?.google_email || null : null;
  const active = unlocked && connected;
  // The epoch fences responses from old credentials; token renewal advances it,
  // so display continuity follows the owner, account and unlock state instead.
  const epoch = snapshotVaultSessionEpoch();
  const scope = useMemo(
    () => Symbol(`mail-attention:${Boolean(ownerId)}:${Boolean(account)}:${active}`),
    [ownerId, account, active],
  );
  const tick = useMailAttentionRefresh(active, epoch);
  const receipts = useReceiptAttention({ ownerId: active ? ownerId : null, vaultKey, vaultOwnerToken, account }, tick.key);
  const requests = useDetailRequests({ active, scope, epoch, vaultOwnerToken, idTokenProvider, refreshKey: tick.key });
  const dismissals = useSyncExternalStore(
    subscribeMailAttentionDismissals,
    () => readMailAttentionDismissals(active ? ownerId : null),
    () => readMailAttentionDismissals(null),
  );
  const items = useMemo(() => {
    if (!active) return EMPTY_ITEMS;
    const recent = receipts.filter((item) => tick.at - receivedMs(item) <= RECEIPT_WINDOW_MS);
    return [...recent, ...requests]
      .filter((item) => !isMailAttentionHidden(dismissals, item.stateKey, tick.at))
      .sort(byPriority)
      .slice(0, MAX_ITEMS);
  }, [active, receipts, requests, dismissals, tick.at]);
  const ownerRef = useRef(ownerId);
  useEffect(() => { ownerRef.current = ownerId; }, [ownerId]);
  const choose = useCallback((item: MailAttentionItem, hide: typeof snoozeMailAttention) => {
    if (!ownerId) return () => undefined;
    hide(ownerId, item.stateKey, Date.now());
    return () => { if (ownerRef.current === ownerId) restoreMailAttention(ownerId, item.stateKey, Date.now()); };
  }, [ownerId]);
  const remindLater = useCallback((item: MailAttentionItem) => choose(item, snoozeMailAttention), [choose]);
  const markDone = useCallback((item: MailAttentionItem) => choose(item, markMailAttentionDone), [choose]);
  return { items, remindLater, markDone };
}
