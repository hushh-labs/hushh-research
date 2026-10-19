"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readVoicePreferences, subscribeVoicePreferences, updateVoicePreferences, type OneVoicePreferencesState } from "@/lib/agent/voice-preferences";
import { readSpeakerphoneSafePreference, subscribeSpeakerphoneSafePreference, writeSpeakerphoneSafePreference } from "@/lib/one-voice/speakerphone-preferences";

/** Shared bindings, not another preference store. This leaf deliberately does
 * not import the Location/Connect API owners into the Live readiness surface. */
export function useVoicePreferenceOwner(owner: string | null) {
  const currentOwner = useRef(owner);
  useLayoutEffect(() => { currentOwner.current = owner; return () => { currentOwner.current = null; }; }, [owner]);
  return useCallback(() => !!owner && currentOwner.current === owner, [owner]);
}

export function useVoiceCommandPreferences(owner: string | null) {
  const current = useVoicePreferenceOwner(owner);
  const [snapshot, setSnapshot] = useState(() => ({ owner, value: readVoicePreferences(owner) }));
  useEffect(() => {
    setSnapshot({ owner, value: readVoicePreferences(owner) });
    if (!owner) return;
    return subscribeVoicePreferences(owner, value => setSnapshot({ owner, value }));
  }, [owner]);
  const change = useCallback((updater: (state: OneVoicePreferencesState) => OneVoicePreferencesState) => {
    if (current()) updateVoicePreferences(owner!, updater);
  }, [owner, current]);
  return { state: snapshot.owner === owner ? snapshot.value : readVoicePreferences(owner), change };
}

export function useVoiceSpeakerphonePreference(owner: string | null) {
  const current = useVoicePreferenceOwner(owner);
  const [snapshot, setSnapshot] = useState(() => ({ owner, value: readSpeakerphoneSafePreference(owner) }));
  useEffect(() => {
    setSnapshot({ owner, value: readSpeakerphoneSafePreference(owner) });
    if (!owner) return;
    return subscribeSpeakerphoneSafePreference(owner, value => setSnapshot({ owner, value }));
  }, [owner]);
  const change = useCallback((value: boolean) => {
    if (current()) writeSpeakerphoneSafePreference(owner!, value);
  }, [owner, current]);
  return { value: snapshot.owner === owner ? snapshot.value : readSpeakerphoneSafePreference(owner), change };
}
