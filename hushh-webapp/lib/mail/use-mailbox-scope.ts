"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiService } from "@/lib/services/api-service";
import {
  PRIVATE_MAIL_GRANTS_CHANGED,
  privateMailAccounts,
  type PrivateMailAccount,
} from "@/lib/services/private-google-connections";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

type Inventory =
  | { status: "shared" }
  | { status: "private"; accounts: PrivateMailAccount[] }
  | { status: "error" };

const noAccounts: PrivateMailAccount[] = [];

export function useMailboxScope(owner: string | null, enabled: boolean) {
  const epoch = useSyncExternalStore(
    subscribeVaultSessionEpoch,
    snapshotVaultSessionEpoch,
    snapshotVaultSessionEpoch,
  );
  const scope = JSON.stringify([owner, epoch]);
  const [inventory, setInventory] = useState<{ scope: string; value: Inventory }>();
  const [choice, setChoice] = useState<{ scope: string; accountId: string }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !owner) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    async function load() {
      const { hostingMode } = await ApiService.getPersonalAgentStatusForRouting();
      if (!current()) return;
      if (hostingMode === "shared") {
        setInventory({ scope, value: { status: "shared" } });
      } else if (hostingMode === "byoc" || hostingMode === "hussh_pods") {
        const accounts = await privateMailAccounts(controller.signal);
        if (current()) setInventory({ scope, value: { status: "private", accounts } });
      } else {
        throw new Error("Mail placement is unavailable.");
      }
    }
    void load().catch(() => {
      if (current()) setInventory({ scope, value: { status: "error" } });
    });
    return () => controller.abort();
  }, [enabled, owner, scope, epoch, revision]);

  useEffect(() => {
    if (!enabled || !owner) return;
    function grantsChanged() {
      setInventory(undefined);
      refresh();
    }
    window.addEventListener(PRIVATE_MAIL_GRANTS_CHANGED, grantsChanged);
    return () => window.removeEventListener(PRIVATE_MAIL_GRANTS_CHANGED, grantsChanged);
  }, [enabled, owner, refresh]);

  const visible = enabled && inventory?.scope === scope ? inventory.value : undefined;
  const accounts = visible?.status === "private" ? visible.accounts : noAccounts;
  const selectedId = choice?.scope === scope ? choice.accountId : "all";
  const selected = accounts.find((account) => account.accountId === selectedId);
  return {
    epoch,
    status: visible?.status ?? "loading",
    accounts,
    selected,
    selectedId,
    choose: (accountId: string) => {
      if (accountId === "all" || accounts.some((account) => account.accountId === accountId && account.capabilities.read)) {
        setChoice({ scope, accountId });
      }
    },
    refresh,
  };
}

export type MailboxScope = ReturnType<typeof useMailboxScope>;
