"use client";

import { useEffect, useState } from "react";

import {
  readOneLocationControlState,
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
    return subscribeOneLocationControlState(userId, setState);
  }, [userId]);

  return state;
}
