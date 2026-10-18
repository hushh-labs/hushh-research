"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSharedWithYouCardModel } from "@/components/agent/consent/shared-with-you-card";
import { useReceivedDriveShareModel, useReceivedDriveSharesModel, useSharedWithYouModel } from "./shared-with-you-group";

type Location = { page: "shared" | "person" | "drive" | "files"; person: string | null; drive: string | null };
const emptyLocation: Location = { page: "shared", person: null, drive: null };
const nobody = { personRef: "", displayName: "Shared information" };

/** Same feature readers as the web, retained above the presentation boundary.
 * Only the active native person opens consented values. No key or URL enters
 * the native row handles, and this controller never grants or alters access. */
export function useMemorySharedModel({ owner, token, active, native, current, visit }: {
  owner: string; token: string | null; active: boolean; native: boolean; current: () => boolean; visit: string | null;
}) {
  const shared = useSharedWithYouModel(token, active);
  const received = useReceivedDriveSharesModel(token, active);
  const [stored, setStored] = useState<{ owner: string; visit: string | null; location: Location } | null>(null);
  const location = active && native && stored?.owner === owner && stored.visit === visit ? stored.location : null;
  useLayoutEffect(() => { setStored(previous => active && native && previous?.owner === owner && previous.visit === visit ? previous : null); }, [active, native, owner, visit]);
  const person = location?.page === "person" ? shared.people.find(value => value.personRef === location.person) ?? null : null;
  const card = useSharedWithYouCardModel({ person: person ? { personRef: person.personRef, displayName: person.person } : nobody,
    items: person?.items ?? [], active: !!person && active && native });
  const drive = location?.page === "files" ? received.shares?.find(value => value.shareId === location.drive) ?? null : null;
  const files = useReceivedDriveShareModel(drive, token, !!drive && active && native);
  const [disclosure, setDisclosure] = useState<{ lifetime: object; keys: readonly string[] } | null>(null);
  const exposed = disclosure?.lifetime === card.lifetime ? disclosure.keys : [];
  const actionRevision = useMemo(() => ({ lifetime: card.lifetime, id: crypto.randomUUID() }), [card.lifetime]).id;
  useLayoutEffect(() => { setDisclosure(null); }, [card.lifetime]);
  const copyOwner = useRef({ active, native, current, card, exposed });
  useLayoutEffect(() => { copyOwner.current = { active, native, current, card, exposed }; });
  const change = (next: Location | null) => { if (active && native && current()) setStored(next ? { owner, visit, location: next } : null); };
  const back = () => {
    if (!location) return false;
    change(location.page === "person" ? { ...emptyLocation, page: "shared" } : location.page === "files" ? { ...emptyLocation, page: "drive" } : null);
    return true;
  };
  return { shared, received, location, person, card, drive, files, exposed, actionRevision,
    canCopy: (key: string, lifetime: object, sensitive: boolean, data?: Record<string, unknown> | null) => {
      const live = copyOwner.current;
      return live.active && live.native && live.current() && live.card.lifetime === lifetime && live.card.mayRead(key, data) && (!sensitive || live.exposed.includes(key));
    },
    openShared: () => change({ ...emptyLocation, page: "shared" }), openDrive: () => change({ ...emptyLocation, page: "drive" }),
    selectPerson: (personRef: string) => { if (shared.people.some(value => value.personRef === personRef)) change({ ...emptyLocation, page: "person", person: personRef }); },
    selectDrive: (shareId: string) => { if (received.shares?.some(value => value.shareId === shareId)) change({ ...emptyLocation, page: "files", drive: shareId }); },
    toggleExposure: (key: string) => {
      if (!active || !native || !current() || copyOwner.current.card.lifetime !== card.lifetime || !card.mayRead(key)) return;
      const keys = exposed.includes(key) ? exposed.filter(value => value !== key) : [...exposed, key];
      copyOwner.current = { ...copyOwner.current, exposed: keys };
      setDisclosure({ lifetime: card.lifetime, keys });
    },
    reset: () => change(null), back };
}
export type MemorySharedModel = ReturnType<typeof useMemorySharedModel>;
