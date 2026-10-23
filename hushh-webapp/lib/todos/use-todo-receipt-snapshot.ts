"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { loadReceiptSnapshot, type ReceiptStoreSession } from "@/lib/mail/receipt-store";
import type { ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { MailReceiptResourceService } from "@/lib/services/mail-receipt-resource-service";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import { subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

/** Subscribe to Mail's existing publisher; revalidate encrypted saved information
 * for this authority before displaying it. Never scan or write from To-do. */
export function useTodoReceiptSnapshot(input: {
  userId: string; accountKey: string | null; vaultKey: string | null;
  vaultOwnerToken: string | null; enabled: boolean;
}) {
  const { userId, accountKey, vaultKey, vaultOwnerToken, enabled } = input;
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const owner = snapshotValidatedAuthSessionOwner();
  const generation = owner?.generation;
  const ready = Boolean(enabled && userId && accountKey && vaultKey && vaultOwnerToken && owner?.userId === userId);
  const resource = useSyncExternalStore(MailReceiptResourceService.subscribe,
    () => ready ? MailReceiptResourceService.peek(userId, accountKey!) : null, () => null);
  const published = resource?.snapshot;
  const [reset, setReset] = useState(0);
  const identity = useMemo(() => Symbol(`todo-receipts-${Boolean(userId)}-${Boolean(accountKey)}-${Boolean(vaultKey)}-${Boolean(vaultOwnerToken)}-${ready}-${epoch}-${generation}-${Boolean(published)}-${reset}`), [userId, accountKey, vaultKey, vaultOwnerToken, ready, epoch, generation, published, reset]);
  const current = useRef(identity);
  current.current = identity;
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState({ identity, snapshot: null as ReceiptSnapshot | null, loading: true, error: false });
  useEffect(() => {
    if (!ready) return;
    return subscribeDurableOwnerReset(ownerId => {
      if (ownerId !== userId) return;
      revision.current += 1;
      controller.current?.abort();
      setReset(value => value + 1);
    });
  }, [ready, userId]);
  const load = useCallback(async () => {
    if (!ready || !accountKey || !vaultKey || !vaultOwnerToken || current.current !== identity) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const request = ++revision.current;
    const authority = snapshotValidatedAuthSessionOwner();
    const isCurrent = () => Boolean(authority && authority.userId === userId && isValidatedAuthSessionOwnerCurrent(authority) &&
      current.current === identity && revision.current === request && !abort.signal.aborted && isVaultSessionEpochCurrent(epoch));
    if (!isCurrent()) return;
    setState(previous => ({ identity, snapshot: previous.identity === identity ? previous.snapshot : null, loading: true, error: false }));
    try {
      // hydrate's warm path is not credential-scoped. Use the canonical encrypted
      // reader even when Mail has a warm snapshot; peek is an invalidation signal.
      const session: ReceiptStoreSession = { userId, vaultKey, vaultOwnerToken, isCurrent, signal: abort.signal };
      const saved = await loadReceiptSnapshot(session, accountKey);
      if (isCurrent()) setState({ identity, snapshot: saved?.value ?? null, loading: false, error: false });
    } catch {
      if (isCurrent()) setState(previous => ({ ...previous, loading: false, error: true }));
    }
  }, [ready, userId, accountKey, vaultKey, vaultOwnerToken, identity, epoch]);
  useEffect(() => {
    void load();
    return () => { revision.current += 1; controller.current?.abort(); };
  }, [load]);
  const visible = ready && state.identity === identity;
  return {
    snapshot: visible ? state.snapshot : null,
    loading: ready && (!visible || state.loading),
    error: visible && state.error,
    refresh: load,
  };
}
