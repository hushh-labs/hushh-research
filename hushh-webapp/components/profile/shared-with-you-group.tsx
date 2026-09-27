"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  ShareNetworkIcon as SharedIcon,
  TreeStructureIcon as MemoryIcon,
} from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ROUTES } from "@/lib/navigation/routes";
import {
  PersonProfileService,
  type SharedWithMeEntry,
} from "@/lib/services/person-profile-service";

type PersonShares = {
  personRef: string;
  person: string;
  profilePath: string | null;
  labels: string[];
};

/** One row per person who currently shares with you, their items underneath. */
export function groupSharesByPerson(shares: SharedWithMeEntry[]): PersonShares[] {
  const byPerson = new Map<string, PersonShares>();
  for (const share of shares) {
    const key = share.personRef || share.person;
    const entry = byPerson.get(key) ?? {
      personRef: share.personRef,
      person: share.person,
      profilePath: share.profilePath,
      labels: [],
    };
    if (!entry.labels.includes(share.label)) entry.labels.push(share.label);
    byPerson.set(key, entry);
  }
  return [...byPerson.values()].sort((left, right) => left.person.localeCompare(right.person));
}

/**
 * Profile's view of memory beyond the categories list: the full, nested
 * Memory browser for what One remembers about you, and what other people
 * currently share with you. The list shows names and item labels only; the
 * shared values open on each person's page, decrypted on this device.
 */
export function SharedWithYouGroup({ vaultOwnerToken }: { vaultOwnerToken: string | null }) {
  const router = useRouter();
  const [shares, setShares] = useState<SharedWithMeEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!vaultOwnerToken) return;
    let active = true;
    setFailed(false);
    void PersonProfileService.listSharedWithMe({ vaultOwnerToken })
      .then((next) => {
        if (active) setShares(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [vaultOwnerToken]);

  const people = useMemo(() => groupSharesByPerson(shares ?? []), [shares]);

  return (
    <>
      <SettingsGroup separatorInset testId="memory-browse-group">
        <SettingsRow
          icon={MemoryIcon}
          iconTone="purple"
          title="Browse all memory"
          description="Every category, down to each saved detail."
          onClick={() => router.push(ROUTES.PKM)}
          chevron
          testId="memory-browse-row"
        />
      </SettingsGroup>
      <SettingsGroup title="Shared with you" separatorInset testId="shared-with-you-group">
        {failed ? (
          <SettingsRow
            icon={SharedIcon}
            iconTone="gray"
            title="Shared information couldn’t load"
            description="Refresh to try again."
          />
        ) : shares === null ? (
          <SettingsRow icon={SharedIcon} iconTone="gray" title="Checking what others share…" />
        ) : people.length === 0 ? (
          <SettingsRow
            icon={SharedIcon}
            iconTone="gray"
            title="Nothing shared with you right now"
            description="When someone approves your request, it appears here."
          />
        ) : (
          people.map((entry) => (
            <SettingsRow
              key={entry.personRef || entry.person}
              icon={SharedIcon}
              iconTone="indigo"
              title={entry.person}
              description={`${entry.labels.length} ${entry.labels.length === 1 ? "item" : "items"} · ${entry.labels.slice(0, 3).join(", ")}${entry.labels.length > 3 ? "…" : ""}`}
              onClick={entry.profilePath ? () => router.push(entry.profilePath!) : undefined}
              chevron={Boolean(entry.profilePath)}
              testId="shared-with-you-person"
            />
          ))
        )}
      </SettingsGroup>
    </>
  );
}
