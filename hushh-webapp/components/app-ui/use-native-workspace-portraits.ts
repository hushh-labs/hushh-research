"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { prepareProfilePortrait } from "@/lib/services/profile-portrait-service";

export function nativePersonInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] ?? "").join("").toUpperCase().slice(0, 8);
}

/** Only the current page's public thumbnails live here. Owner/page/privacy
 * changes abort transfer and immediately hide the previous replica. */
export function useNativeWorkspacePortraits(owner: string | null, active: boolean, people: readonly { key: string; source?: string | null }[]) {
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const sources = JSON.stringify(people.slice(0, 48).filter(person => person.source).map(({ key, source }) => ({ key, source: source! })));
  const admitted = active && !!owner && privacy?.appIsActive === true && !privacy.shielded;
  const [prepared, setPrepared] = useState<{ owner: string; sources: string; generation: number; images: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    setPrepared(null);
    if (!admitted || !owner) return;
    const controller = new AbortController(), generation = privacy.generation;
    const destinations = new Map<string, string[]>();
    for (const { key, source } of JSON.parse(sources) as { key: string; source: string }[])
      destinations.set(source, [...(destinations.get(source) ?? []), key]);
    const queue = [...destinations].map(([source, keys]) => ({ source, keys }));
    const images = new Map<string, string>();
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < queue.length) {
        const person = queue[cursor++]!;
        try {
          const image = await prepareProfilePortrait(person.source, controller.signal, "people");
          if (image.length <= 40_000 && !controller.signal.aborted) for (const key of person.keys) images.set(key, image);
        } catch {
          // Missing/unavailable public photos retain the same initials fallback.
          // Credential-bearing and arbitrary hosts never enter the media loader.
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker)).then(() => {
      const now = nativePrivacyObservation().state;
      if (!controller.signal.aborted && now?.appIsActive && !now.shielded && now.generation === generation)
        setPrepared({ owner, sources, generation, images });
    });
    return () => controller.abort();
  }, [owner, admitted, sources, privacy?.generation]);
  return admitted && prepared?.owner === owner && prepared.sources === sources && prepared.generation === privacy?.generation
    ? prepared.images : new Map<string, string>();
}
