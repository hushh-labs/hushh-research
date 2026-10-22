"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

import {
  GmailReceiptsService,
  type GmailNudge,
} from "@/lib/services/gmail-receipts-service";

export type UseGmailNudgesParams = {
  userId: string | null;
  vaultOwnerToken: string | null;
  isConnected: boolean;
  idTokenProvider: (() => Promise<string>) | null;
  limit?: number;
};

export type UseGmailNudgesResult = {
  nudges: GmailNudge[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => void;
};

/**
 * Fetches the connected Gmail account's nudges (needs_reply +
 * upcoming_meeting) once per session. Extracted from gmail-nudges-section.tsx
 * so the settings-page surface and Agent One's chat can share one fetch
 * implementation instead of drifting apart. Same gmail.readonly connection
 * as receipts -- no new scope. Returns everything list_nudges derives;
 * callers decide which type(s) to render.
 */
export function useGmailNudges({
  userId,
  vaultOwnerToken,
  isConnected,
  idTokenProvider,
  limit = 10,
}: UseGmailNudgesParams): UseGmailNudgesResult {
  const epoch = snapshotVaultSessionEpoch();
  const identity = useMemo(() => Symbol(`gmail-nudges:${Boolean(userId)}:${Boolean(vaultOwnerToken)}:${isConnected}:${limit}:${epoch}`), [userId, vaultOwnerToken, isConnected, limit, epoch]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [snapshot, setSnapshot] = useState({ identity, nudges: [] as GmailNudge[], loading: false, error: null as string | null, loaded: false });
  const inFlight = useRef<{ identity: symbol; queued: boolean } | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const canLoad = Boolean(isConnected && userId && vaultOwnerToken && idTokenProvider);
  const current = canLoad && snapshot.identity === identity;

  useEffect(() => {
    currentIdentity.current = identity;
    return () => { if (currentIdentity.current === identity) currentIdentity.current = Symbol("unmounted"); };
  }, [identity]);

  const load = useCallback(async () => {
    if (!isConnected || !userId || !vaultOwnerToken || !idTokenProvider || currentIdentity.current !== identity) return;
    if (inFlight.current?.identity === identity) { inFlight.current.queued = true; return; }
    const flight = { identity, queued: false };
    inFlight.current = flight;
    const isCurrent = () => currentIdentity.current === identity && isVaultSessionEpochCurrent(epoch);
    setSnapshot((previous) => ({ identity, nudges: previous.identity === identity ? previous.nudges : [], loading: true, error: null, loaded: previous.identity === identity && previous.loaded }));
    try {
      const idToken = await idTokenProvider();
      if (!isCurrent()) return;
      const response = await GmailReceiptsService.listNudges({ idToken, vaultOwnerToken, userId, limit });
      if (isCurrent()) setSnapshot({ identity, nudges: response.nudges ?? [], loading: false, error: null, loaded: true });
    } catch {
      if (isCurrent()) setSnapshot((previous) => ({ ...previous, loading: false, loaded: true,
        error: "Inbox details couldn’t load. Refresh to try again." }));
    } finally {
      if (inFlight.current === flight) inFlight.current = null;
      if (flight.queued && isCurrent()) loadRef.current();
    }
  }, [identity, epoch, isConnected, userId, vaultOwnerToken, idTokenProvider, limit]);
  useEffect(() => { loadRef.current = () => void load(); }, [load]);

  useEffect(() => {
    if (canLoad && (!current || (!snapshot.loaded && !snapshot.loading))) void load();
  }, [canLoad, current, snapshot.loaded, snapshot.loading, load]);

  return {
    nudges: current ? snapshot.nudges : [],
    loading: current && snapshot.loading,
    error: current ? snapshot.error : null,
    loaded: current && snapshot.loaded,
    refresh: () => void load(),
  };
}
