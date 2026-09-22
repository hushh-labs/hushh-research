"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [nudges, setNudges] = useState<GmailNudge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const canLoad = Boolean(isConnected && userId && vaultOwnerToken && idTokenProvider);

  const load = useCallback(async () => {
    if (!userId || !vaultOwnerToken || !idTokenProvider) return;
    setLoading(true);
    setError(null);
    try {
      const idToken = await idTokenProvider();
      const response = await GmailReceiptsService.listNudges({
        idToken,
        vaultOwnerToken,
        userId,
        limit,
      });
      setNudges(response.nudges ?? []);
    } catch {
      // A background nudge refresh must never spin while the local backend is
      // unavailable. Keep the failure private and leave a deliberate refresh
      // action instead of re-running the effect on every render.
      setError("Inbox details couldn’t load. Refresh to try again.");
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [userId, vaultOwnerToken, idTokenProvider, limit]);

  useEffect(() => {
    if (canLoad && !loaded && !loading) {
      void load();
    }
  }, [canLoad, loaded, loading, load]);

  return {
    nudges: isConnected ? nudges : [],
    loading,
    error,
    loaded,
    refresh: () => void load(),
  };
}
