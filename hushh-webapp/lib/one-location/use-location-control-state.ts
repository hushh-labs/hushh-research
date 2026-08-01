"use client";

import { useEffect, useState } from "react";

import {
  readOneLocationControlState,
  refreshOneLocationControlStateFromPreferences,
  subscribeOneLocationControlState,
  type OneLocationControlState,
} from "@/lib/one-location/location-control-state";

export function useOneLocationControlState(
  userId: string | null | undefined,
): OneLocationControlState {
  const [state, setState] = useState<OneLocationControlState>(() =>
    readOneLocationControlState(userId),
  );

  useEffect(() => {
    setState(readOneLocationControlState(userId));
    if (!userId) return;
    const unsubscribe = subscribeOneLocationControlState(userId, setState);
    const onStorage = () => {
      refreshOneLocationControlStateFromPreferences(userId);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  }, [userId]);

  return state;
}
