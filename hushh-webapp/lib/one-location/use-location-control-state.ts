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
  const owner = userId ?? null;
  const [snapshot, setSnapshot] = useState(() => ({
    owner,
    state: readOneLocationControlState(owner),
  }));

  useEffect(() => {
    setSnapshot({ owner, state: readOneLocationControlState(owner) });
    if (!owner) return;
    return subscribeOneLocationControlState(owner, (state) => setSnapshot({ owner, state }));
  }, [owner]);

  // Never lend the previous owner's device consent to a new owner for one render.
  return snapshot.owner === owner ? snapshot.state : readOneLocationControlState(owner);
}
