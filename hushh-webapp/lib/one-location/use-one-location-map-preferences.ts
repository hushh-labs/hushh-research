"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { OneLocationMapPreferencesResource } from "@/lib/one-location/one-location-map-preferences-resource";
import {
  dispatchOneLocationStateChanged,
  subscribeToOneLocationStateChanges,
} from "@/lib/one-location/one-location-state-events";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationMapPreferences } from "@/lib/one-location/types";

export type OneLocationMapPreferencesView = {
  preferences: OneLocationMapPreferences | null;
  loading: boolean;
  error: string | null;
  refresh: (options?: { invalidate?: boolean }) => Promise<void>;
  commit: (value: OneLocationMapPreferences) => void;
};

export function publishOneLocationMapPreferences(
  userId: string,
  value: OneLocationMapPreferences,
): void {
  OneLocationMapPreferencesResource.commit(userId, value);
  dispatchOneLocationStateChanged(userId, ["map_preferences"], {
    notificationType: "location_settings_changed",
    eventId: `local:map-preferences:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  });
}

export function useOneLocationMapPreferences(params: {
  userId: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
}): OneLocationMapPreferencesView {
  const userId = params.userId ?? null;
  const vaultOwnerToken = params.vaultOwnerToken ?? null;
  const [preferences, setPreferences] = useState<OneLocationMapPreferences | null>(
    () => (userId ? OneLocationMapPreferencesResource.readPresentation(userId) : null),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const refreshRevisionRef = useRef(0);
  const foregroundTaskRef = useRef<Promise<void> | null>(null);
  const foregroundQueuedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (options?: { invalidate?: boolean }) => {
      if (!userId || !vaultOwnerToken) return;
      const revision = ++refreshRevisionRef.current;
      if (options?.invalidate) {
        OneLocationMapPreferencesResource.invalidate(userId);
      }
      setLoading(true);
      try {
        const next = await OneLocationMapPreferencesResource.load(userId, () =>
          OneLocationService.getMapPreferences(vaultOwnerToken),
        );
        if (!mountedRef.current || refreshRevisionRef.current !== revision) return;
        setPreferences(next);
        setError(null);
      } catch (caught) {
        if (!mountedRef.current || refreshRevisionRef.current !== revision) return;
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "Map preferences could not be loaded.",
        );
      } finally {
        if (mountedRef.current && refreshRevisionRef.current === revision) {
          setLoading(false);
        }
      }
    },
    [userId, vaultOwnerToken],
  );

  const commit = useCallback(
    (value: OneLocationMapPreferences) => {
      if (!userId) return;
      refreshRevisionRef.current += 1;
      publishOneLocationMapPreferences(userId, value);
      setPreferences(value);
      setError(null);
    },
    [userId],
  );

  useEffect(() => {
    refreshRevisionRef.current += 1;
    if (!userId || !vaultOwnerToken) {
      setPreferences(null);
      setLoading(false);
      setError(null);
      return;
    }
    setPreferences(OneLocationMapPreferencesResource.readPresentation(userId));
    void refresh();
  }, [refresh, userId, vaultOwnerToken]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    return subscribeToOneLocationStateChanges((detail) => {
      if (
        detail.userId !== userId ||
        !detail.domains.includes("map_preferences")
      ) {
        return;
      }
      OneLocationMapPreferencesResource.invalidateFromEvent(
        userId,
        detail.eventId || String(detail.changedAt),
      );
      void refresh();
    });
  }, [refresh, userId, vaultOwnerToken]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    const reconcile = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (foregroundTaskRef.current) {
        foregroundQueuedRef.current = true;
        return;
      }
      const run = async () => {
        do {
          foregroundQueuedRef.current = false;
          await refresh();
        } while (foregroundQueuedRef.current);
      };
      const task = run().finally(() => {
        if (foregroundTaskRef.current === task) foregroundTaskRef.current = null;
      });
      foregroundTaskRef.current = task;
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => {
      if (appInteractionCoordinator.getLifecycleSnapshot().state === "active") {
        reconcile();
      }
    });
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      removeLifecycle();
    };
  }, [refresh, userId, vaultOwnerToken]);

  return { preferences, loading, error, refresh, commit };
}
