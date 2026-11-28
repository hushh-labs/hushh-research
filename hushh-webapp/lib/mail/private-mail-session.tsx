"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import { TodoListPkmService, type TodoListState } from "@/lib/services/todo-list-pkm-service";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { TODO_LIST_PKM_DOMAIN } from "@/lib/services/todo-list-pkm-service";
import { deleteEncryptedOwnerUiRecords, readEncryptedOwnerUiRecord, writeEncryptedOwnerUiRecord } from "@/lib/storage/encrypted-owner-ui-cache";
import { parseMailBrief, type MailBrief } from "./mail-brief-client";
import { PRIVATE_MAIL_GRANTS_CHANGED, privateMailAccounts, type PrivateMailAccount } from "@/lib/services/private-google-connections";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** How many mailboxes one owner may connect. The add action disappears at this many. */
export const MAX_MAIL_ACCOUNTS = 3;
/** A failed mailbox check tries again by itself, then leaves the next try to the owner. */
const INVENTORY_RETRY_MS = [2_000, 6_000, 15_000] as const;

const BRIEF_FRESH_MS = 5 * 60_000;
const briefNamespace = (account: string, credential: string) => `mail.brief.v1/${account}/${credential}/`;

type Inventory = { scope: string; mode: "private" | "shared"; accounts: PrivateMailAccount[]; failed?: boolean };
type RecentRows = Awaited<ReturnType<typeof MailFollowupsService.recent>>["items"];
type Session = {
  recentRows?: RecentRows;
  recentScope?: string;
  rememberRecent: (key: string, rows: RecentRows) => void;
  inventoryFailed: boolean; resolving: boolean; private: boolean; accounts: PrivateMailAccount[]; selected: PrivateMailAccount | null;
  /** Mailboxes whose Google permission lapsed. Mail cannot be read from them until the owner reconnects. */
  expired: PrivateMailAccount[]; reconnectMailbox: PrivateMailAccount | null;
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
  const checkedAt = useRef(new Map<string, number>());
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
      const inventory = await privateMailAccounts(controller.signal);
      const accounts = await Promise.all(inventory.map(async row => {
        if (row.email || !row.capabilities.read || !valid()) return row;
        try {
          const mailbox = await MailFollowupsService.account(row.accountId, row.credentialId, controller.signal);
          return { ...row, email: mailbox.address };
        } catch {
          return row;
        }
      }));
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
  const expired = accounts.filter(row => !row.capabilities.read);
  const reconnectMailbox = expired.find(row => row.accountId === slot) ?? (!available.length ? expired[0] ?? null : null);
  const selected = (slot ? available.find(row => row.accountId === slot) : available.find(row => row.isDefault) ?? available[0]) ?? null;
  const choose = (id: string) => {
    // A newly authorized slot can arrive before the refreshed inventory. Only
    // the verified, readable inventory above can resolve a choice into a selected account.
    if (!owner || (!accounts.some(row => row.accountId === id) && !/^[a-f0-9]{32}$/.test(id))) return;
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
  // Visible results belong to one authenticated session, mailbox and grant generation.
  const [saved, setSaved] = useState<Record<string, {brief?: MailBrief; rows?: RecentRows}>>({});
  const rememberRecent = useCallback((key: string, rows: RecentRows) => {
    setSaved(old => ({ ...old, [key]: { ...old[key], rows } }));
  }, []);
  useEffect(() => {
    if (!owner) { setSaved({}); return; }
    if (!current || current.failed) return;
    const allowed = new Set(current.accounts.filter(row => row.status === "connected" && row.capabilities.read)
      .map(row => JSON.stringify([scope, row.accountId, row.credentialId])));
    for (const key of checkedAt.current.keys()) {
      if (!allowed.has(key)) checkedAt.current.delete(key);
    }
    setSaved(old => Object.keys(old).every(key => allowed.has(key)) ? old :
      Object.fromEntries(Object.entries(old).filter(([key]) => allowed.has(key))));
  }, [owner, current, scope]);
  const [summary, setSummary] = useState<{scope: string; updating: boolean; error: boolean}>();
  const manualRefresh = useRef(false);
  const retryBrief = useCallback(() => {
    manualRefresh.current = true;
    setBriefRevision(n => n + 1);
  }, []);
  useEffect(() => {
    if (!owner || !vaultKey || !account || !connection || !address) { setSummary(undefined); return; }
    const cache = { ownerId: owner, vaultKey, namespace: briefNamespace(account, connection) };
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && snapshotVaultSessionEpoch() === epoch;
    // Only a live, readable grant reaches this effect. A later disk read must never replace a live result.
    let liveResult = false;
    void readEncryptedOwnerUiRecord<unknown>(cache).then(record => {
      if (!current() || liveResult || !record) return;
      const brief = parseMailBrief(record.value);
      if (brief.account !== account) return;
      setSaved(old => old[briefScope]?.brief ? old : { ...old, [briefScope]: { ...old[briefScope], brief } });
    }).catch(() => {});
    let pending = false;
    const update = (force = false) => {
      if (pending || !current()) return;
      if (!force && Date.now() - (checkedAt.current.get(briefScope) ?? 0) < BRIEF_FRESH_MS) {
        setSummary({scope: briefScope, updating: false, error: false});
        return;
      }
      pending = true;
      setSummary({scope: briefScope, updating: true, error: false});
      void MailFollowupsService.brief({account, connection, address}, abort.signal, wire => {
        if (current()) void writeEncryptedOwnerUiRecord({ ...cache, value: wire }).catch(() => {});
      }).then(brief => {
        if (!current()) return;
        liveResult = true;
        checkedAt.current.set(briefScope, Date.now());
        setSaved(old => ({ ...old, [briefScope]: { ...old[briefScope], brief } }));
        setSummary({scope: briefScope, updating: false, error: false});
      }).catch(() => {
        if (current()) setSummary({scope: briefScope, updating: false, error: true});
      }).finally(() => { pending = false; });
    };
    update(manualRefresh.current);
    manualRefresh.current = false;
    const wake = () => { if (document.visibilityState === "visible") update(); };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      abort.abort();
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [owner, vaultKey, account, address, connection, briefScope, briefRevision, epoch]);

  const knownGrants = useRef<{ owner: string; namespaces: Set<string> } | null>(null);
  useEffect(() => {
    if (!owner || !current || current.failed) return;
    const namespaces = new Set(current.accounts.filter(row => row.status === "connected" && row.capabilities.read)
      .map(row => briefNamespace(row.accountId, row.credentialId)));
    if (knownGrants.current?.owner === owner) {
      for (const previous of knownGrants.current.namespaces) {
        if (!namespaces.has(previous)) void deleteEncryptedOwnerUiRecords(owner, previous).catch(() => {});
      }
    }
    knownGrants.current = {owner, namespaces};
  }, [owner, current]);
  const visible = summary?.scope === briefScope ? summary : undefined;
  const attentionCounts = Object.fromEntries(available.flatMap(row => {
    const brief = saved[JSON.stringify([scope, row.accountId, row.credentialId])]?.brief;
    return brief ? [[row.accountId, brief.attention.length]] : [];
  }));
  return <Context.Provider value={{ recentScope: selected ? briefScope : undefined, recentRows: selected ? saved[briefScope]?.rows : undefined, rememberRecent, inventoryFailed: current?.failed === true, resolving: Boolean(isAuthenticated && !current), private: current?.mode === "private", accounts, selected, expired, reconnectMailbox, choose, refresh: retryNow,
    attentionCounts, savedTasks: tasks?.scope === briefScope ? tasks.value : undefined, brief: selected ? saved[briefScope]?.brief : undefined, briefUpdating: visible?.updating ?? true, briefError: visible?.error ?? false, retryBrief }}>{children}</Context.Provider>;
}
