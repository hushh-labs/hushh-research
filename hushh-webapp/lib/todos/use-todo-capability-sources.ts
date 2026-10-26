"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTodoCapabilities, readTodoMail, type CapabilityRead } from "@/lib/services/todo-capability-sources";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export function useTodoCapabilitySources(input: {
  enabled: boolean; userId: string | null; vaultOwnerToken: string | null;
  idTokenProvider: (() => Promise<string>) | null; mailConnected: boolean; calendarConnected: boolean;
  mailStatusKnown: boolean; calendarStatusKnown: boolean; mailAccountKey?: string | null;
}) {
  const { enabled, userId, vaultOwnerToken, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, mailAccountKey } = input;
  const epoch = snapshotVaultSessionEpoch();
  const identity = useMemo(() => Symbol(`todo-sources-${Boolean(userId)}-${Boolean(vaultOwnerToken)}-${enabled}-${mailConnected}-${calendarConnected}-${mailStatusKnown}-${calendarStatusKnown}-${epoch}`), [userId, vaultOwnerToken, enabled, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, mailAccountKey, epoch]);
  const current = useRef(identity);
  current.current = identity;
  const provider = useRef(input.idTokenProvider);
  provider.current = input.idTokenProvider;
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState({ identity, reads: [] as CapabilityRead[], loading: true, error: false });
  const saved = useRef(snapshot);
  saved.current = snapshot;
  const mailLease = useRef<object | null>(null);
  const load = useCallback(async () => {
    if (!enabled || !userId || !vaultOwnerToken || !provider.current || current.current !== identity) return;
    abort.current?.abort();
    mailLease.current = null;
    const controller = new AbortController();
    abort.current = controller;
    const revision = ++request.current;
    const isCurrent = () => current.current === identity && request.current === revision && !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    setSnapshot(previous => ({ identity, reads: previous.identity === identity ? previous.reads : [], loading: true, error: false }));
    try {
      const reads = await readTodoCapabilities({ userId, vaultOwnerToken, getIdToken: provider.current, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, signal: controller.signal, isCurrent });
      if (isCurrent()) setSnapshot({ identity, reads, loading: false, error: false });
    } catch {
      if (isCurrent()) setSnapshot(previous => ({ ...previous, loading: false, error: true }));
    }
  }, [enabled, userId, vaultOwnerToken, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown, identity, epoch]);
  useEffect(() => {
    void load();
    return () => { request.current += 1; abort.current?.abort(); };
  }, [load]);
  const continueMail = useCallback(async () => {
    const previous = saved.current.identity === identity ? saved.current.reads.find(row => row.coverage.capability === "gmail") : null;
    if (!enabled || !userId || !vaultOwnerToken || !provider.current || !previous?.cursor || mailLease.current || current.current !== identity) return;
    const lease = {};
    mailLease.current = lease;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    const revision = ++request.current;
    const isCurrent = () => current.current === identity && request.current === revision && !controller.signal.aborted && isVaultSessionEpochCurrent(epoch);
    setSnapshot(state => ({ ...state, reads: state.reads.map(row => row === previous ? { ...row, coverage: { ...row.coverage, scanning: true } } : row) }));
    try {
      const idToken = await provider.current();
      if (!isCurrent()) return;
      const next = await readTodoMail({ userId, vaultOwnerToken, getIdToken: provider.current, mailConnected, calendarConnected,
        mailStatusKnown, calendarStatusKnown, signal: controller.signal, isCurrent }, idToken, previous);
      if (isCurrent()) setSnapshot(state => ({ ...state, reads: state.reads.map(row => row.coverage.capability === "gmail" ? next : row) }));
    } catch {
      if (isCurrent()) setSnapshot(state => ({ ...state, reads: state.reads.map(row => row.coverage.capability === "gmail"
        ? { ...row, coverage: { ...row.coverage, status: "incomplete", scanning: false, scanFailed: true } } : row) }));
    } finally { if (mailLease.current === lease) mailLease.current = null; }
  }, [enabled, userId, vaultOwnerToken, identity, epoch, mailConnected, calendarConnected, mailStatusKnown, calendarStatusKnown]);
  const visible = enabled && snapshot.identity === identity;
  const mail = visible ? snapshot.reads.find(row => row.coverage.capability === "gmail") : null;
  useEffect(() => {
    if (!mail?.cursor || mail.coverage.scanFailed || mail.coverage.scanning || snapshot.loading) return;
    const timer = setTimeout(() => void continueMail(), 1500);
    return () => clearTimeout(timer);
  }, [mail, snapshot.loading, continueMail]);
  return { reads: visible ? snapshot.reads : [], loading: enabled && (!visible || snapshot.loading), error: visible && snapshot.error, refresh: load, continueMail };
}
