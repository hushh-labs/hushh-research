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

type Inventory = { scope: string; mode: "private" | "shared"; accounts: PrivateMailAccount[]; failed?: boolean };
type Session = {
  inventoryFailed: boolean; resolving: boolean; private: boolean; accounts: PrivateMailAccount[]; selected: PrivateMailAccount | null;
  savedTasks?: Promise<TodoListState>;
  brief?: MailBrief; briefUpdating: boolean; briefError: boolean; retryBrief: () => void;
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
  const accounts = current?.accounts ?? [];
  const slot = choice?.scope === scope ? choice.slot : owner ? lastSlot(owner) : null;
  const available = accounts.filter(row => row.status === "connected" && row.capabilities.read);
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
  const [summary, setSummary] = useState<{scope: string; brief?: MailBrief; updating: boolean; error: boolean}>();
  useEffect(() => {
    if (!account || !connection || !address) { setSummary(undefined); return; }
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && snapshotVaultSessionEpoch() === epoch;
    setSummary(old => ({scope: briefScope, brief: old?.scope === briefScope ? old.brief : undefined, updating: true, error: false}));
    void MailFollowupsService.brief({account, connection, address}, abort.signal)
      .then(brief => { if (current()) setSummary({scope: briefScope, brief, updating: false, error: false}); })
      .catch(() => { if (current()) setSummary(old => ({scope: briefScope, brief: old?.scope === briefScope ? old.brief : undefined, updating: false, error: true})); });
    return () => abort.abort();
  }, [account, address, connection, briefScope, briefRevision, epoch]);
  const visible = summary?.scope === briefScope ? summary : undefined;
  return <Context.Provider value={{ inventoryFailed: current?.failed === true, resolving: Boolean(isAuthenticated && !current), private: current?.mode === "private", accounts, selected, choose, refresh, savedTasks: tasks?.scope === briefScope ? tasks.value : undefined, brief: visible?.brief, briefUpdating: visible?.updating ?? true, briefError: visible?.error ?? false, retryBrief: () => setBriefRevision(value => value + 1) }}>{children}</Context.Provider>;
}
