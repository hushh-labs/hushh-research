"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import { TodoListPkmService, type TodoListState } from "@/lib/services/todo-list-pkm-service";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { TODO_LIST_PKM_DOMAIN } from "@/lib/services/todo-list-pkm-service";
import type { MailBrief } from "./mail-brief-client";
import { PRIVATE_MAIL_GRANTS_CHANGED, privateMailAccounts, type PrivateMailAccount } from "@/lib/services/private-google-connections";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** How many mailboxes one owner may connect. The add action disappears at this many. */
export const MAX_MAIL_ACCOUNTS = 3;
/** A failed mailbox check tries again by itself, then leaves the next try to the owner. */
const INVENTORY_RETRY_MS = [2_000, 6_000, 15_000] as const;

type Inventory = { scope: string; mode: "private" | "shared"; accounts: PrivateMailAccount[]; failed?: boolean };
type RecentRows = Awaited<ReturnType<typeof MailFollowupsService.recent>>["items"];
type Session = {
  recentRows?: RecentRows;
  rememberRecent: (rows: RecentRows) => void;
  inventoryFailed: boolean; resolving: boolean; private: boolean; accounts: PrivateMailAccount[]; selected: PrivateMailAccount | null;
  /** Mailboxes whose Google permission lapsed. Mail cannot be read from them until the owner reconnects. */
  expired: PrivateMailAccount[];
  savedTasks?: Promise<TodoListState>;
  brief?: MailBrief; briefUpdating: boolean; briefError: boolean; retryBrief: () => void;
  /** What needs the owner in each mailbox One has read this session, by mailbox. A mailbox not yet read has no entry. */
  attentionCounts: Readonly<Record<string, number>>;
  choose: (slot: string) => void; refresh: () => void;
};
const Context = createContext<Session | null>(null);
export const usePrivateMailSession = () => useContext(Context);

function preference(owner: string) { return "one.mail.slot.v1:" + encodeURIComponent(owner); }
function lastSlot(owner: string): string | null {
  try { return localStorage.getItem(preference(owner)); } catch { return null; }
}

export function PrivateMailSessionProvider({ children }: { children: ReactNode }) {
  const { userId, isAuthenticated, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, ownerTokenStatus, vaultOwnerToken, vaultKey } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, snapshotVaultSessionEpoch);
  const owner = isAuthenticated && !sessionVerificationRequired && isVaultUnlocked && ownerTokenStatus === "valid" ? userId : null;
  const scope = JSON.stringify([owner, epoch]);
  const [inventory, setInventory] = useState<Inventory>();
  const [choice, setChoice] = useState<{ scope: string; slot: string }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const failures = useRef(0);
  // The owner's own retry starts the automatic ones over.
  const retryNow = useCallback(() => { failures.current = 0; setRevision(value => value + 1); }, []);
  useEffect(() => {
    if (!owner) return;
    const wake = () => { if (document.visibilityState === "visible") refresh(); };
    const grantsChanged = () => { setInventory(undefined); refresh(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener(PRIVATE_MAIL_GRANTS_CHANGED, grantsChanged);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener(PRIVATE_MAIL_GRANTS_CHANGED, grantsChanged);
    };
  }, [owner, refresh]);
  const sequence = useRef(0);
  useEffect(() => {
    if (!owner) { setInventory(undefined); return; }
    const controller = new AbortController();
    const current = ++sequence.current;
    const valid = () => current === sequence.current && !controller.signal.aborted && snapshotVaultSessionEpoch() === epoch;
    async function load() {
      const privatePlacement = await ownerContentIsPrivate();
      if (!valid()) return;
      if (!privatePlacement) {
        setInventory({ scope, mode: "shared", accounts: [] });
        return;
      }
      const accounts = await privateMailAccounts(controller.signal);
      if (valid()) setInventory({ scope, mode: "private", accounts });
    }
    void load().catch(() => { if (valid()) setInventory({ scope, mode: "private", accounts: [], failed: true }); });
    return () => controller.abort();
  }, [scope, owner, epoch, revision]);

  const current = inventory?.scope === scope ? inventory : null;
  // A failed check (a private agent still waking, a dropped connection) is retried with a growing pause.
  useEffect(() => {
    if (!current?.failed) { failures.current = 0; return; }
    const delay = INVENTORY_RETRY_MS[failures.current];
    if (delay === undefined) return;
    failures.current += 1;
    const timer = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timer);
  }, [current, refresh]);
  const accounts = current?.accounts ?? [];
  const slot = choice?.scope === scope ? choice.slot : owner ? lastSlot(owner) : null;
  const available = accounts.filter(row => row.status === "connected" && row.capabilities.read);
  const expired = accounts.filter(row => row.status === "needs_reauth");
  const selected = (slot ? available.find(row => row.accountId === slot) : available.find(row => row.isDefault) ?? available[0]) ?? null;
  const choose = (id: string) => {
    if (!owner || !available.some(row => row.accountId === id)) return;
    setChoice({ scope, slot: id });
    try { localStorage.setItem(preference(owner), id); } catch { /* In-memory choice still works. */ }
  };
  const account = selected?.accountId;
  const connection = selected?.credentialId;
  const address = selected?.email;
  const briefScope = JSON.stringify([scope, account, connection]);
  const [tasks, setTasks] = useState<{scope: string; value: Promise<TodoListState>}>();
  useEffect(() => {
    if (!owner || !vaultKey || !vaultOwnerToken || !account || !connection) { setTasks(undefined); return; }
    const restore = () => {
      const value = TodoListPkmService.load({userId: owner, vaultKey, vaultOwnerToken}).then(result => ({
        ...result, tasks: result.tasks.filter(task => task.mailFollowup?.account === account && task.mailFollowup.connection === connection),
      }));
      void value.catch(() => {});
      setTasks({scope: briefScope, value});
    };
    restore();
    return subscribeToPkmDomainChanges(({userId, domain}) => {
      if (userId === owner && (domain === TODO_LIST_PKM_DOMAIN || domain === "*")) restore();
    });
  }, [owner, account, connection, vaultKey, vaultOwnerToken, briefScope]);
  const [briefRevision, setBriefRevision] = useState(0);
  const [counted, setCounted] = useState<{ scope: string; counts: Record<string, number> }>();
  // Session-only, partitioned by owner, unlock epoch, mailbox and grant generation.
  const savedBriefs = useRef(new Map<string, MailBrief>());
  const savedRows = useRef(new Map<string, RecentRows>());
  const rememberRecent = useCallback((rows: RecentRows) => {
    if (account && connection && snapshotVaultSessionEpoch() === epoch) savedRows.current.set(briefScope, rows);
  }, [account, connection, epoch, briefScope]);
  useEffect(() => {
    const rows = savedRows.current;
    const cache = savedBriefs.current;
    return () => { cache.clear(); rows.clear(); };
  }, [scope]);
  useEffect(() => {
    if (!current) return;
    const allowed = new Set(current.accounts.filter(row => row.status === "connected" && row.capabilities.read)
      .map(row => JSON.stringify([scope, row.accountId, row.credentialId])));
    for (const cache of [savedBriefs.current, savedRows.current]) {
      for (const key of cache.keys()) if (!allowed.has(key)) cache.delete(key);
    }
  }, [current, scope]);
  const [summary, setSummary] = useState<{scope: string; brief?: MailBrief; updating: boolean; error: boolean}>();
  useEffect(() => {
    if (!account || !connection || !address) { setSummary(undefined); return; }
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && snapshotVaultSessionEpoch() === epoch;
    setSummary(old => ({scope: briefScope, brief: old?.scope === briefScope ? old.brief : undefined, updating: true, error: false}));
    void MailFollowupsService.brief({account, connection, address}, abort.signal)
      .then(brief => {
        if (!current()) return;
        savedBriefs.current.set(briefScope, brief);
        setSummary({scope: briefScope, brief, updating: false, error: false});
        setCounted(old => ({ scope, counts: { ...(old?.scope === scope ? old.counts : {}), [account]: brief.attention.length } }));
      })
      .catch(() => { if (current()) setSummary(old => ({scope: briefScope, brief: old?.scope === briefScope ? old.brief : undefined, updating: false, error: true})); });
    return () => abort.abort();
  }, [account, address, connection, briefScope, briefRevision, epoch, scope, revision]);
  const visible = summary?.scope === briefScope ? summary : undefined;
  return <Context.Provider value={{ recentRows: selected ? savedRows.current.get(briefScope) : undefined, rememberRecent, inventoryFailed: current?.failed === true, resolving: Boolean(isAuthenticated && !current), private: current?.mode === "private", accounts, selected, expired, choose, refresh: retryNow,
    attentionCounts: counted?.scope === scope ? counted.counts : {}, savedTasks: tasks?.scope === briefScope ? tasks.value : undefined, brief: visible?.brief ?? (selected ? savedBriefs.current.get(briefScope) : undefined), briefUpdating: visible?.updating ?? true, briefError: visible?.error ?? false, retryBrief: () => setBriefRevision(value => value + 1) }}>{children}</Context.Provider>;
}
