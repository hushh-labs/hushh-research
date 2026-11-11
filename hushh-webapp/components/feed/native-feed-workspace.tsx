"use client";

import { createNativeWorkspaceHandles, useNativeWorkspaceHandoff } from "@/lib/capacitor/use-native-workspace-handoff";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspace, useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";

import { useBackLayer } from "@/lib/navigation/back-layers";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import type { NativeDrawerRow, NativeDrawerSection, NativeWorkspaceInlineAction } from "@/lib/capacitor/native-drawers";
import { nativePersonInitials, useNativeWorkspacePortraits } from "@/components/app-ui/use-native-workspace-portraits";
import { AlertTriangle, Bot, Database, FileText, Mail, MapPin, MessageCircle, Newspaper, ShieldCheck, TrendingUp, UserRound, ScanSearch, Users } from "@/components/icons";
import { CalendarAgentIcon, ConsentAgentIcon, EmergencyRowIcon, FinanceAgentIcon, JoinRowIcon, LocationAgentIcon, PeopleRowIcon } from "@/components/icons/agents";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import type { FeedActionable, FeedActionButton } from "@/lib/feed/use-feed-actionables";
import type { FeedDriveProgress } from "@/lib/feed/drive-request-progress";
import type { FeedSmsAlertGroup } from "@/lib/feed/feed-sms-grouping";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { updateProgressStage } from "@/lib/feed/agent-update-status";
import type { FeedItem } from "@/lib/services/feed-service";
import { usePayoutSnapshot } from "@/components/consent/payouts/use-payout-snapshot";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";
import { bankPayoutCopy } from "@/components/consent/payouts/payout-copy";
import { nativeFeedbackToast as toast } from "@/lib/capacitor/native-feedback";
import { ownerFacingConsentError } from "@/lib/consent/consent-owner-copy";
import { ARMED_ACTION_DEFAULT_DISARM_MS } from "@/lib/ui/use-armed-action";
import { useVault } from "@/lib/vault/vault-context";
import { useFeedPushPrompt } from "./feed-push-prompt";

export type NativeFeedRecord = { key: string; lane: string } & (
  { kind: "action"; value: FeedActionable } | { kind: "history"; value: FeedItem; unread: boolean } |
  { kind: "progress"; value: FeedDriveProgress } | { kind: "sms"; value: FeedSmsAlertGroup }
);
export type NativeFeedModel = {
  owner: string | null; current: () => boolean; records: NativeFeedRecord[];
  loading: boolean; errors: readonly string[]; retry: () => Promise<unknown>;
  overflow: readonly { label: string; href: string }[];
  hasNew: boolean; showNew: () => void;
  canLoadMore: boolean; loadingMore: boolean; loadMoreError: string | null; loadMore: () => Promise<void>;
  canClear: boolean; clearing: boolean; clearArmed: boolean; clear: () => void; cancelClear: () => void;
  removing: string | null; openHistory: (item: FeedItem) => void; removeHistory: (item: FeedItem) => Promise<void>;
  webChildOpen: boolean;
};

type FeedView = { selectedKey: string | null; smsKey: string | null; page: number; groupPage: number };
const emptyView = (): FeedView => ({ selectedKey: null, smsKey: null, page: 0, groupPage: 0 });
const nativeSymbols = new Map<unknown, string>([
  [AlertTriangle, "exclamationmark.triangle"], [Bot, "sparkles"], [Database, "externaldrive"], [FileText, "doc.text"],
  [Mail, "envelope"], [MapPin, "mappin.and.ellipse"], [MessageCircle, "bubble.left"], [Newspaper, "newspaper"],
  [ShieldCheck, "checkmark.shield"], [TrendingUp, "chart.line.uptrend.xyaxis"], [UserRound, "person.crop.circle"], [ScanSearch, "person.text.rectangle"], [Users, "person.2"],
  [CalendarAgentIcon, "calendar"], [ConsentAgentIcon, "checkmark.shield"], [EmergencyRowIcon, "exclamationmark.triangle"],
  [FinanceAgentIcon, "chart.line.uptrend.xyaxis"], [JoinRowIcon, "person.2.badge.plus"], [LocationAgentIcon, "mappin.and.ellipse"], [PeopleRowIcon, "person.2"],
]);
function phoneDecisions(item: FeedActionable): FeedActionButton[] {
  return item.actions.length ? item.phoneActions?.length ? item.phoneActions : item.actions : [];
}
function recordPerson(record: NativeFeedRecord) {
  return record.kind === "history" ? presentFeedItem(record.value).person : record.kind === "sms" ? record.value.latest.person : record.kind === "action" ? record.value.person : undefined;
}

/** A whole route body. Rich pricing/file readers explicitly retire this owner
 * before their existing React presentation; native receives only values/handles. */
export function NativeFeedWorkspace(props: { model: NativeFeedModel; fallback: ReactNode }) {
  if (!customNativePresentationEnabled()) return props.fallback;
  return <NativeFeedPresentation {...props} />;
}
function NativeFeedPresentation({ model, fallback }: { model: NativeFeedModel; fallback: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const query = useSearchParams();
  const [child, setChild] = useState<{ done: boolean } | null>(null);
  const [view, setView] = useState(emptyView);
  const handoff = useNativeWorkspaceHandoff(presentation.retireForWeb, model.owner);
  const failed = presentation.status.phase === "web" && (presentation.status.reason === "unsupported" || presentation.status.reason === "failure");
  useLayoutEffect(() => { if (child?.done && !model.webChildOpen) setChild(null); }, [child, model.webChildOpen]);
  useLayoutEffect(() => { setChild(null); setView(emptyView()); }, [model.owner]);
  const runWeb = async (action: () => void | Promise<void>) => {
    const current = () => model.current() && normalizeStaticExportPathname(window.location.pathname) === "/one/feed";
    await handoff.handoff(current, () => true, () => {
      const intent = handoff.intent.current;
      setChild({ done: false });
      void Promise.resolve().then(action).catch(error => { if (intent === handoff.intent.current && current()) toast.error(ownerFacingConsentError(error, "That didn't go through. Try again.")); })
        .finally(() => { if (intent === handoff.intent.current && current()) setChild({ done: true }); });
    });
  };
  // Payment reconciliation retains its complete existing status reader.
  const paymentReturn = query.has("paymentRequestId") || query.has("answerPaymentRequestId");
  const unsupportedActions = model.records.some(record => (record.kind === "action" ? [record.value] : record.kind === "sms" ? record.value.items : []).some(item => {
    const actions = phoneDecisions(item); return actions.length + (actions.some(action => action.confirm) ? 1 : 0) > 6;
  }));
  if (!customNativePresentationEnabled() || !model.owner || !isVaultUnlocked || paymentReturn || child || failed || unsupportedActions) return presentation.status.held ? <div aria-busy="true" /> : fallback;
  return <NativeFeedBody view={view} setView={setView} model={model} presentation={presentation} runWeb={runWeb} activationRevision={handoff.activationRevision} />;
}

function NativeFeedBody({ model, presentation, runWeb, activationRevision, view, setView }: {
  view: FeedView; setView: Dispatch<SetStateAction<FeedView>>;
  model: NativeFeedModel; presentation: ReturnType<typeof useNativeWorkspacePresentation>;
  runWeb: (action: () => void | Promise<void>) => Promise<void>; activationRevision: number;
}) {
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/"), router = useRouter();
  const contentFrame = useRef<HTMLDivElement>(null), mounted = useRef(false), running = useRef(false);
  const latest = useRef({ model, pathname });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { latest.current = { model, pathname }; });
  const current = () => mounted.current && latest.current.pathname === "/one/feed" && latest.current.model.current();
  const { selectedKey, smsKey, page, groupPage } = view;
  const setSelectedKey = useCallback((selectedKey: string | null) => setView(value => ({ ...value, selectedKey })), [setView]);
  const setSmsKey = useCallback((smsKey: string | null) => setView(value => ({ ...value, smsKey })), [setView]);
  const setPage = (page: number) => setView(value => ({ ...value, page }));
  const setGroupPage = useCallback((groupPage: number) => setView(value => ({ ...value, groupPage })), [setView]);
  const [armed, setArmed] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  useEffect(() => {
    if (!armed || armed === "history-remove") return;
    const timer = setTimeout(() => setArmed(null), ARMED_ACTION_DEFAULT_DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const handles = useMemo(() => createNativeWorkspaceHandles(String(model.owner)), [model.owner]);
  const push = useFeedPushPrompt();
  const bank = usePayoutSnapshot(DocumentPayoutService.bankPayouts, { bankOnly: true, refreshOnFeedChange: true, ignoreReadyEvent: true });
  const latestBank = bank.token ? bank.data?.payouts[0] : null;
  const back = () => {
    if (running.current) return true;
    if (activeArmed) { setArmed(null); return true; }
    if (selected) { setSelectedKey(null); return true; }
    if (smsVisible) { setSmsKey(null); return true; }
    if (model.clearArmed) { model.cancelClear(); return true; }
    return false;
  };
  const run = async (action: () => unknown) => {
    if (!current() || running.current) return;
    running.current = true; setBusy(true);
    try { await action(); }
    catch (error) { if (current()) toast.error(ownerFacingConsentError(error, "That didn't go through. Try again.")); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const action = (key: string, label: string, callback: () => unknown, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handles(key); actions.set(id, () => run(callback));
    return { id, label, enabled: !busy && !model.clearing, ...extra };
  };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({ id: handles(key), label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const sections: NativeDrawerSection[] = [];
  const section = (key: string, rows: NativeDrawerRow[], title?: string) => { if (rows.length) sections.push({ id: `feed-${key}`, ...(title ? { title } : {}), rows }); };
  const stamp = (value?: number | string | null) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : "";
  const group = model.records.find(record => record.key === smsKey && record.kind === "sms");
  const records = model.records;
  const selected = records.find(record => record.key === selectedKey);
  const index = Math.min(page, Math.max(0, Math.ceil(records.length / 24) - 1));
  const visible = selected ? [selected] : records.slice(index * 24, (index + 1) * 24);
  const smsVisible = group?.kind === "sms" && group.value.items.length > 1 && visible.some(record => record.key === group.key);
  const groupIndex = group?.kind === "sms" ? Math.min(groupPage, Math.max(0, Math.ceil(group.value.items.length / 24) - 1)) : 0;
  const children: NativeFeedRecord[] = !selected && group?.kind === "sms" && smsVisible
    ? group.value.items.slice(groupIndex * 24, (groupIndex + 1) * 24).map(value => ({ key: `sms:${value.id}`, lane: group.lane, kind: "action", value })) : [];
  const portraits = useNativeWorkspacePortraits(model.owner, pathname === "/one/feed", [...visible, ...children].map(record => ({ key: record.key, source: recordPerson(record)?.photoUrl })));
  const graphics = (record: NativeFeedRecord): Partial<NativeDrawerRow> => {
    const person = recordPerson(record);
    if (person) return { avatar: { initials: nativePersonInitials(person.displayName), ...(portraits.get(record.key) ? { jpeg: portraits.get(record.key) } : {}) } };
    const icon = record.kind === "history" ? presentFeedItem(record.value).icon : record.kind === "action" ? record.value.icon : undefined;
    return { symbol: nativeSymbols.get(icon) ?? (record.kind === "progress" ? "doc.text" : "bell") };
  };
  useLayoutEffect(() => {
    if (selectedKey && !selected) { setSelectedKey(null); setArmed(null); }
    if (smsKey && !smsVisible) { setSmsKey(null); setGroupPage(0); }
  }, [selectedKey, selected, smsKey, smsVisible, setSelectedKey, setSmsKey, setGroupPage]);
  const select = (record: NativeFeedRecord) => {
    setArmed(null);
    if (record.kind === "sms") { setSmsKey(smsKey === record.key ? null : record.key); setSelectedKey(null); setGroupPage(0); }
    else if (record.kind === "progress") router.push(record.value.href);
    else setSelectedKey(record.key);
  };
  const label = (record: NativeFeedRecord) => record.kind === "history" ? presentFeedItem(record.value).label : record.kind === "sms" ? record.value.latest.person?.displayName || record.value.latest.title : record.value.title;
  const detail = (record: NativeFeedRecord) => record.kind === "history" ? [presentFeedItem(record.value).description, stamp(record.value.created_at), record.unread ? "Unread" : null].filter(Boolean).join(" · ") :
    record.kind === "sms" ? `${record.value.items.length} recent SMS alerts · ${record.value.activeCount ? `${record.value.activeCount} active` : "All ended"}${record.value.latest.displayTimestamp ? ` · ${stamp(record.value.latest.displayTimestamp)}` : ""}` :
    [record.value.description, stamp(record.kind === "action" ? record.value.displayTimestamp : record.value.queuedAt ?? record.value.requestedAt)].filter(Boolean).join(" · ");
  const bindDecision = (item: FeedActionable, value: FeedActionButton) => action(`decision:${item.id}:${value.key}`, value.confirm && armed === `decision:${item.id}:${value.key}` ? `Confirm ${value.label}` : value.label, async () => {
    if (value.disabled) return;
    if (value.confirm && armed !== `decision:${item.id}:${value.key}`) { setArmed(`decision:${item.id}:${value.key}`); return; }
    setArmed(null);
    setPendingAction(`decision:${item.id}:${value.key}`);
    try {
      if (value.presentation === "web") await runWeb(value.run);
      else await value.run();
    } finally { if (mounted.current) setPendingAction(null); }
  }, { enabled: !busy && !value.disabled, pending: pendingAction === `decision:${item.id}:${value.key}`, destructive: value.tone === "danger" });
  const decisions = (item: FeedActionable): NativeWorkspaceInlineAction[] => {
    const values: NativeWorkspaceInlineAction[] = phoneDecisions(item).map(value => {
      const row = bindDecision(item, value);
      return { id: row.id, label: row.label, enabled: row.enabled, pending: row.pending, tone: value.tone, ...(value.phoneIcon ? { symbol: "info.circle" } : {}) };
    });
    if (armed?.startsWith(`decision:${item.id}:`)) {
      const cancel = action(`cancel:${item.id}`, "Cancel", () => setArmed(null));
      values.push({ id: cancel.id, label: cancel.label, enabled: cancel.enabled, tone: "ghost" });
    }
    return values;
  };
  const actionRecord = (record: NativeFeedRecord & { kind: "action" }): NativeDrawerRow => {
    const item = record.value;
    const primary = item.href && !item.actions.length ? () => router.push(item.href!) : item.onSelect;
    const row = primary ? action(`record:${record.key}`, label(record), () => item.onSelectPresentation === "web" ? runWeb(primary) : primary()) : read(`record:${record.key}`, label(record));
    const inlineActions = decisions(item), milestone = item.updateProgress ? updateProgressStage(item.updateProgress) : null;
    return { ...row, detail: detail(record), chevron: !!primary, ...graphics(record),
      ...(item.emphasis === "emergency" ? { trailing: "Emergency", iconHex: "#ef4444" } : {}),
      ...(inlineActions.length ? { inlineActions } : {}), ...(milestone != null ? { milestone } : {}) };
  };
  if (selected) {
    section("detail", [{ ...read("title", label(selected), detail(selected)), ...graphics(selected) }]);
    if (selected.kind === "history") {
      const item = selected.value, view = presentFeedItem(item);
      section("history-actions", [
        ...(view.href || item.event_type === "document_share_files_sent" ? [action("open-history", "Open", () => item.event_type === "document_share_files_sent" ? runWeb(() => model.openHistory(item)) : model.openHistory(item), { chevron: true })] : []),
        action("keep", "Keep in Feed", () => toast.success("Kept in Feed")),
        action("remove", armed === "history-remove" ? "Confirm remove from Feed" : "Remove from Feed", async () => {
          if (armed !== "history-remove") { setArmed("history-remove"); return; }
          setArmed(null); await model.removeHistory(item); if (current()) setSelectedKey(null);
        }, { destructive: true, enabled: !busy && model.removing !== item.id }),
        ...(armed ? [action("cancel-remove", "Cancel", () => setArmed(null))] : []),
      ]);
    }
  } else {
    if (push) section("push", [read("push-copy", push.message),
      ...((push.permission === "default" || push.permission === "granted" || push.permission === "denied") ? [action("push-enable", push.permission === "denied" ? "Open settings" : push.permission === "granted" ? "Retry notifications" : "Turn on notifications", push.enable, { enabled: !push.isRetryingPushRegistration && !busy })] : [])]);
    if (latestBank) section("bank", [read("bank", "Bank payout", `${bank.data?.stripeMode === "test" ? "Test · " : ""}${bankPayoutCopy(latestBank)}`),
      ...(bank.failed ? [read("bank-error", "Couldn't check bank payouts right now.")] : []),
      ...(bank.data?.stripeMode === "test" ? [read("bank-test", "Simulated deposits. No real money moves.")] : []),
      read("bank-info", "Bank payouts may combine earnings from multiple requests.")]);
    const lanes = [...new Set(visible.map(record => record.lane))];
    for (const [i, lane] of lanes.entries()) section(`lane-${i}`, visible.filter(record => record.lane === lane).flatMap((record): NativeDrawerRow[] => {
      if (record.kind === "action") return [actionRecord(record)];
      if (record.kind === "sms" && record.value.items.length === 1) return [actionRecord({ ...record, kind: "action", value: record.value.latest })];
      const row = action(`record:${record.key}`, label(record), () => select(record), { detail: detail(record), chevron: true, ...graphics(record), ...(record.kind === "sms" ? { expanded: record.key === smsKey } : {}) });
      if (record.kind !== "sms" || record.key !== smsKey) return [row];
      return [row, ...children.filter((child): child is NativeFeedRecord & { kind: "action" } => child.kind === "action").map(actionRecord),
        ...(groupIndex > 0 ? [action(`sms-previous:${record.key}`, "Previous SMS alerts", () => setGroupPage(groupIndex - 1))] : []),
        ...((groupIndex + 1) * 24 < record.value.items.length ? [action(`sms-next:${record.key}`, "More SMS alerts", () => setGroupPage(groupIndex + 1))] : [])];
    }), lane);
    if (model.loading) section("loading", [read("loading", "Loading activity…")]);
    if (model.errors.length) section("errors", [...model.errors.map((error, i) => read(`error-${i}`, error)), action("retry", "Retry activity", model.retry)]);
    if (!records.length && !model.loading && !model.errors.length && !latestBank) section("empty", [read("empty", "No activity yet")]);
    section("window", [...(index > 0 ? [action("previous", "Previous activity", () => setPage(index - 1))] : []), ...((index + 1) * 24 < records.length ? [action("next", "More activity", () => setPage(index + 1))] : [])]);
    section("more", [
      ...model.overflow.map((link, i) => action(`overflow-${i}`, link.label, () => router.push(link.href), { chevron: true })),
      ...(model.hasNew ? [action("new", "New activity", model.showNew)] : []),
      ...(model.loadMoreError ? [read("more-error", model.loadMoreError)] : []),
      ...(model.canLoadMore ? [action("load-more", model.loadingMore ? "Loading older activity…" : model.loadMoreError ? "Retry older activity" : "Load more", model.loadMore, { enabled: !model.loadingMore && !busy })] : []),
      ...(model.canClear ? [action("clear", model.clearing ? "Clearing…" : model.clearArmed ? "Confirm clear" : "Clear Feed", model.clear, { destructive: model.clearArmed, enabled: !model.clearing && !busy }), ...(model.clearArmed ? [action("cancel-clear", "Cancel", model.cancelClear)] : [])] : []),
    ]);
  }
  const activeArmed = armed === "history-remove" ? !!selected : armed !== null && actions.has(handles(armed));
  useBackLayer("/one/feed", activeArmed ? 3 : selected ? 2 : smsVisible || model.clearArmed ? 1 : 0, back);
  useLayoutEffect(() => { if (armed && !activeArmed) setArmed(null); }, [armed, activeArmed]);
  const phase = useNativeWorkspace({ owner: model.owner!, content: { workspace: "feed", page: "overview", title: selected ? "Activity" : "Feed", enabled: true, backEnabled: false, sections }, actions, current, back,
    presentationOwner: presentation.owner, contentFrame, active: pathname === "/one/feed", activationRevision });
  return <AppPageShell as="main" ref={contentFrame} width="reading" data-native-feed-workspace={phase} aria-busy={phase !== "native"}
    nativeTest={{ routeId: "/one/feed", marker: phase === "native" ? "native-route-feed" : "native-feed-admission", authState: "authenticated", dataState: phase === "blocked" ? "error" : phase !== "native" ? "booting" : model.loading ? "loading" : model.records.length ? "loaded" : model.errors.length ? "unavailable-valid" : "empty-valid" }} />;
}
