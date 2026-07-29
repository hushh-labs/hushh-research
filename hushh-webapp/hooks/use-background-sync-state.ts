"use client";

import { useCallback, useMemo, useState } from "react";

export function useBackgroundSyncState() {
  const [activeSyncCount, setActiveSyncCount] = useState(0);

  const beginBackgroundSync = useCallback(() => {
    setActiveSyncCount((value) => value + 1);
  }, []);

  const endBackgroundSync = useCallback(() => {
    setActiveSyncCount((value) => Math.max(value - 1, 0));
  }, []);

  const resetBackgroundSyncState = useCallback(() => {
    setActiveSyncCount(0);
  }, []);

  const syncing = useMemo(() => activeSyncCount > 0, [activeSyncCount]);

  return {
    syncing,
    activeSyncCount,
    beginBackgroundSync,
    endBackgroundSync,
    resetBackgroundSyncState,
  };
}