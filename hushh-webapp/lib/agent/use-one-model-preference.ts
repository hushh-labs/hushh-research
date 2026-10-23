"use client";

import { useEffect, useRef, useState } from "react";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { onGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { ModelPreferenceService, type ModelPreference } from "@/lib/services/model-preference-service";

type Owner = { uid: string; getIdToken: () => Promise<string> };
type Observed = { value: ModelPreference; current: () => boolean };

/** Retire stale catalogs on owner, connection and foreground-route changes. */
export function useOneModelPreference(user: Owner | null, active: boolean) {
  const [observed, setObserved] = useState<Observed | null>(null);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const savingRequest = useRef<{ id: number; current: () => boolean; done: Promise<void> } | null>(null);
  useEffect(() => {
    let alive = true;
    let waitingForSave = false;
    const refresh = () => {
      const request = ++sequence.current;
      setObserved(null);
      const pending = savingRequest.current;
      if (pending?.current()) {
        // Discovery cannot race a dispatched mutation or release its single-flight
        // guard. Read once after settlement; never replay the model change.
        if (!waitingForSave) {
          waitingForSave = true;
          void pending.done.then(() => { waitingForSave = false; if (alive) refresh(); });
        }
        return;
      }
      savingRequest.current = null;
      setSaving(false);
      const owner = snapshotValidatedAuthSessionOwner();
      const ownerCurrent = () => alive && !!owner && user?.uid === owner.userId && isValidatedAuthSessionOwnerCurrent(owner);
      const current = () => ownerCurrent() && sequence.current === request;
      if (!active || !user || !current() || document.visibilityState === "hidden") return;
      void (async () => {
        try {
          const token = await user.getIdToken();
          if (!current()) return;
          const value = await ModelPreferenceService.get(token, current);
          if (current() && value) setObserved({ value, current: ownerCurrent });
        } catch {
          // An unavailable connection has no catalog. Chat retains its own authority.
        }
      })();
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    const unsubscribe = onGeminiRuntimeConfigurationChanged(refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; unsubscribe(); document.removeEventListener("visibilitychange", visible); };
  }, [user, active]);

  const change = (model: string) => {
    if (!active || !user || !observed?.current() || savingRequest.current !== null) return;
    const request = ++sequence.current;
    const current = () => observed.current() && sequence.current === request;
    setSaving(true);
    const done = (async () => {
      try {
        const token = await user.getIdToken();
        if (!current()) return;
        const value = await ModelPreferenceService.set(token, model, current);
        if (current()) setObserved({ value, current: observed.current });
      } catch {
        // Keep the last verified value; an unconfirmed choice is never displayed.
      } finally {
        if (savingRequest.current?.id === request) { savingRequest.current = null; setSaving(false); }
      }
    })();
    savingRequest.current = { id: request, current: observed.current, done };
  };
  return { modelPreference: active && observed?.current() ? observed.value : null,
    modelPreferenceSaving: saving, handleOneModelChange: change };
}
