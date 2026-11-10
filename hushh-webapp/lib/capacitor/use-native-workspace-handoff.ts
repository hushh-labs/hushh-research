"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { nativePrivacyObservation } from "./session-privacy";

/** Retire the native owner before exposing an authored web child. The feature
 * supplies its own current-state checks and owns the resulting child state. */
export function useNativeWorkspaceHandoff(retireForWeb: () => Promise<boolean>, session: unknown) {
  const intent = useRef(0);
  const [activationRevision, setActivationRevision] = useState(0);
  useLayoutEffect(() => {
    intent.current += 1;
    return () => { intent.current += 1; };
  }, [session]);

  const handoff = async (current: () => boolean, valid: () => boolean, open: () => void) => {
    const requested = ++intent.current;
    const epoch = snapshotVaultSessionEpoch();
    const privacy = nativePrivacyObservation().state;
    if (!current() || !privacy || !await retireForWeb()) return false;
    if (requested !== intent.current || !current() || !isVaultSessionEpochCurrent(epoch) ||
        nativePrivacyObservation().state?.generation !== privacy.generation || !valid()) {
      if (requested === intent.current && current()) setActivationRevision(value => value + 1);
      return false;
    }
    open();
    return true;
  };

  return { handoff, activationRevision, intent };
}
