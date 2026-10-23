"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTodoCapabilities, readTodoMemory, type CapabilityRead } from "@/lib/services/todo-capability-sources";
import { subscribeLiveMirror } from "@/lib/pkm/memory-refresh";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export function useTodoCapabilitySources(input: {
  enabled: boolean; userId: string | null; vaultOwnerToken: string | null;
  idTokenProvider: (() => Promise<string>) | null; mailConnected: boolean; calendarConnected: boolean;
  mailStatusKnown: boolean; calendarStatusKnown: boolean;
}) {
  const { enabled, userId, vaultOwnerToken, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown } = input;
  const epoch = snapshotVaultSessionEpoch();
  const identity = useMemo(() => Symbol(`todo-sources-${Boolean(userId)}-${Boolean(vaultOwnerToken)}-${enabled}-${mailConnected}-${calendarConnected}-${mailStatusKnown}-${calendarStatusKnown}-${epoch}`), [userId, vaultOwnerToken, enabled, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, epoch]);
  const current = useRef(identity);
  current.current = identity;
  const provider = useRef(input.idTokenProvider);
  provider.current = input.idTokenProvider;
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState({ identity, reads: [] as CapabilityRead[], loading: true, error: false });
  useEffect(() => {
    if (!enabled || !userId || !vaultOwnerToken) return;
    return subscribeLiveMirror(userId, () => {
      if (current.current !== identity || !isVaultSessionEpochCurrent(epoch)) return;
      const memory = readTodoMemory({ userId });
      setSnapshot(previous => previous.identity === identity
        ? { ...previous, reads: [...previous.reads.filter(read => read.coverage.capability !== "pkm"), memory] }
        : previous);
    });
  }, [enabled, userId, vaultOwnerToken, identity, epoch]);
  const load = useCallback(async () => {
    if (!enabled || !userId || !vaultOwnerToken || !provider.current || current.current !== identity) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const revision = ++request.current;
    const isCurrent = () => current.current === identity && request.current === revision && !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    setSnapshot(previous => ({ identity, reads: previous.identity === identity ? previous.reads : [], loading: true, error: false }));
    try {
      const reads = await readTodoCapabilities({ userId, vaultOwnerToken, getIdToken: provider.current, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, signal: controller.signal, isCurrent });
      if (isCurrent()) setSnapshot({ identity, reads: [...reads.filter(read => read.coverage.capability !== "pkm"), readTodoMemory({ userId })], loading: false, error: false });
    } catch {
      if (isCurrent()) setSnapshot(previous => ({ ...previous, loading: false, error: true }));
    }
  }, [enabled, userId, vaultOwnerToken, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, identity, epoch]);
  useEffect(() => {
    void load();
    return () => { request.current += 1; abort.current?.abort(); };
  }, [load]);
  const visible = enabled && snapshot.identity === identity;
  return { reads: visible ? snapshot.reads : [], loading: enabled && (!visible || snapshot.loading), error: visible && snapshot.error, refresh: load };
}
