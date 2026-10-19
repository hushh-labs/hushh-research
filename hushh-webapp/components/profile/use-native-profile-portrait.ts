"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { prepareProfilePortrait } from "@/lib/services/profile-portrait-service";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";

/** Memory-only presentation replica. Native gets bounded raster bytes, never a
 * remote URL, provider response, credential or a second avatar store. */
export function useNativeProfilePortrait(owner: string | null, active: boolean): string | undefined {
  const source = useEffectiveAvatarUrl(768);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [prepared, setPrepared] = useState<{ owner: string; source: string; generation: number; image: string } | null>(null);
  const admitted = active && owner !== null && privacy?.appIsActive === true && privacy.shielded === false;
  useEffect(() => {
    setPrepared(null);
    if (!admitted || !source || !owner) return;
    let current = true;
    const controller = new AbortController();
    const generation = privacy.generation;
    void prepareProfilePortrait(source, controller.signal).then(image => {
      const now = nativePrivacyObservation().state;
      if (current && now?.appIsActive && !now.shielded && now.generation === generation && image.length <= 100_000) {
        setPrepared({ owner, source, generation, image });
      }
    }).catch(() => undefined);
    return () => { current = false; controller.abort(); };
  }, [admitted, owner, source, privacy?.generation]);
  return admitted && prepared?.owner === owner && prepared.source === source && prepared.generation === privacy?.generation
    ? prepared.image : undefined;
}
