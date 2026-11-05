"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { AccountService, type AccountEmailAlias } from "@/lib/services/account-service";
import { ConnectionsService, type ConnectionSummaryEntry } from "@/lib/services/connections-service";
import { calendarHusshPeople, type CalendarHusshPeople } from "./calendar-hussh-people";

const EMPTY_CONNECTIONS: readonly ConnectionSummaryEntry[] = [];
const EMPTY_ALIASES: readonly AccountEmailAlias[] = [];

/** One owner-scoped Connections read for all Calendar person avatars. */
export function useCalendarHusshPeople({ userId, accountKey, connectionRevision, getIdToken, vaultOwnerToken }: {
  userId: string;
  accountKey: string;
  connectionRevision?: number;
  getIdToken: () => Promise<string>;
  vaultOwnerToken: string | null;
}): CalendarHusshPeople {
  const { user, userId: currentUserId } = useAuth();
  const ownerPhotoUrl = useEffectiveAvatarUrl();
  const authGeneration = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => 0);
  const owner = snapshotValidatedAuthSessionOwner();
  const admitted = currentUserId === userId && owner?.userId === userId;
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: object | null; connections: readonly ConnectionSummaryEntry[]; aliases: readonly AccountEmailAlias[] }>({
    key: null, connections: EMPTY_CONNECTIONS, aliases: EMPTY_ALIASES,
  });
  const getIdTokenRef = useRef(getIdToken);
  const lastFocusRefresh = useRef(0);
  // The token itself never becomes a cache key, but a token change invalidates
  // the visible photo snapshot synchronously, before the next owner read.
  const key = useMemo(() => ({
    userId, accountKey, connectionRevision, authGeneration, vaultUnlocked: Boolean(vaultOwnerToken), refresh,
  }), [userId, accountKey, connectionRevision, authGeneration, vaultOwnerToken, refresh]);

  useEffect(() => {
    getIdTokenRef.current = getIdToken;
  }, [getIdToken]);

  useEffect(() => {
    const ownerAtRequest = snapshotValidatedAuthSessionOwner();
    if (!admitted || !ownerAtRequest || ownerAtRequest.generation !== authGeneration) return;
    let active = true;
    setSnapshot({ key, connections: EMPTY_CONNECTIONS, aliases: EMPTY_ALIASES });
    void (async () => {
      const [connectionsResult, aliasesResult] = await Promise.allSettled([
        getIdTokenRef.current().then(idToken => ConnectionsService.listConnections({ idToken })),
        vaultOwnerToken ? AccountService.listEmailAliases(vaultOwnerToken) : Promise.resolve(null),
      ]);
      if (!active || !isValidatedAuthSessionOwnerCurrent(ownerAtRequest)) return;
      const connections = connectionsResult.status === "fulfilled" ? connectionsResult.value : EMPTY_CONNECTIONS;
      const aliasesResponse = aliasesResult.status === "fulfilled" ? aliasesResult.value : null;
      const aliases = aliasesResponse?.user_id === userId ? aliasesResponse.aliases : EMPTY_ALIASES;
      setSnapshot({ key, connections, aliases });
    })();
    return () => { active = false; };
  }, [admitted, authGeneration, key, userId, vaultOwnerToken]);

  useEffect(() => {
    const unsubscribe = subscribeToConnectionGraphChanges(detail => {
      if (detail.userId === userId) setRefresh(value => value + 1);
    });
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefresh.current < 5_000) return;
      lastFocusRefresh.current = now;
      setRefresh(value => value + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => { unsubscribe(); window.removeEventListener("focus", onFocus); };
  }, [userId]);

  const current = admitted && snapshot.key === key ? snapshot : null;
  return calendarHusshPeople({
    connections: current?.connections ?? EMPTY_CONNECTIONS,
    ownerId: admitted ? userId : "",
    ownerEmail: user?.email,
    ownerEmailVerified: admitted && user?.emailVerified === true,
    ownerPhotoUrl: admitted ? ownerPhotoUrl : null,
    ownerAliases: current?.aliases ?? EMPTY_ALIASES,
  });
}
