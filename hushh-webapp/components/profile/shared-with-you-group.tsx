"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  MemoryAgentIcon,
  ShareRowIcon,
  SyncRowIcon,
} from "@/components/icons/agents";
import { SharedWithYouCard } from "@/components/agent/consent/shared-with-you-card";
import { humanSharedLabel, type SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { parseSharedFieldSensitivities } from "@/lib/consent/field-sensitivity";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { DriveSharingService, type ReceivedDriveBulkFilesPage, type ReceivedDriveBulkShare } from "@/lib/services/drive-sharing-service";
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
  /** The same items the chat's secure card opens (CONTRACT-2 C6 shape). */
  items: SharedWithMeCardItem[];
};

/** A share-list entry as a secure-card item: names, dates and refs, never values. */
export function sharedWithMeCardItem(share: SharedWithMeEntry): SharedWithMeCardItem {
  // C7 per field: an identifier inside a standard item stays marked sensitive.
  const fields = parseSharedFieldSensitivities(share.fields);
  return {
    key: share.requestId,
    grantRef: null,
    bundleId: share.bundleId,
    requestId: share.requestId,
    label: humanSharedLabel(share.label) ?? "Shared information",
    // Missing reads as sensitive in the card (C7 deny by default).
    sensitivity: share.sensitivity === "standard" ? "standard" : share.sensitivity ? "sensitive" : null,
    domain: null,
    fieldOutline: [],
    ...(fields.length ? { fields } : {}),
    sharedAt: null,
    accessEndsAt: typeof share.expiresAt === "number" && share.expiresAt > 0
      ? new Date(share.expiresAt).toISOString() : null,
    purpose: share.purpose?.trim() || null,
    status: "granted",
  };
}

/** One card per person who currently shares with you, their items inside it. */
export function groupSharesByPerson(shares: SharedWithMeEntry[]): PersonShares[] {
  const byPerson = new Map<string, PersonShares>();
  for (const share of shares) {
    const key = share.personRef || share.person;
    const entry = byPerson.get(key) ?? {
      personRef: share.personRef,
      person: share.person,
      profilePath: share.profilePath,
      labels: [],
      items: [],
    };
    if (!entry.labels.includes(share.label)) entry.labels.push(share.label);
    if (!entry.items.some((item) => item.requestId === share.requestId)) entry.items.push(sharedWithMeCardItem(share));
    byPerson.set(key, entry);
  }
  return [...byPerson.values()].sort((left, right) => left.person.localeCompare(right.person));
}

/**
 * Profile's view of memory beyond the categories list: the full, nested
 * Memory browser for what One remembers about you, and what other people
 * currently share with you. Each person's items open in the same secure card
 * the chat shows, decrypted on this device.
 */
export function SharedWithYouGroup({ vaultOwnerToken }: { vaultOwnerToken: string | null }) {
  const router = useRouter();
  const [shares, setShares] = useState<SharedWithMeEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

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
  }, [vaultOwnerToken, retry]);

  const people = useMemo(() => groupSharesByPerson(shares ?? []), [shares]);

  return (
    <>
      <SettingsGroup separatorInset testId="memory-browse-group">
        <SettingsRow
          icon={MemoryAgentIcon}
          iconTone="capability"
          title="Browse all memory"
          description="Every category, down to each saved detail."
          onClick={() => router.push(ROUTES.PKM)}
          chevron
          testId="memory-browse-row"
        />
      </SettingsGroup>
      {failed || shares === null || people.length === 0 ? (
        <SettingsGroup title="Shared with you" separatorInset testId="shared-with-you-group">
          {failed ? (
            <div className="space-y-2 px-4 py-3">
              <HelperText role="status">Shared information couldn’t load.</HelperText>
              <Button type="button" variant="muted" size="compact" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
            </div>
          ) : shares === null ? (
            <SettingsRow icon={SyncRowIcon} iconTone="capability" title="Checking what others share…" />
          ) : (
            <SettingsRow
              icon={ShareRowIcon}
              iconTone="capability"
              title="Nothing shared with you right now"
              description="When someone approves your request, it appears here."
            />
          )}
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Shared with you" separatorInset testId="shared-with-you-group"
          shellClassName="overflow-visible bg-transparent shadow-none" contentClassName="space-y-3">
          {people.map((entry) => (
            <SharedWithYouCard
              key={entry.personRef || entry.person}
              person={{ personRef: entry.personRef, displayName: entry.person }}
              items={entry.items}
              variant="profile"
            />
          ))}
        </SettingsGroup>
      )}
      <ReceivedDriveShares vaultOwnerToken={vaultOwnerToken} />
    </>
  );
}

/** Only confirmed Viewer grants appear here; no recipient Drive connection is needed. */
function ReceivedDriveShares({ vaultOwnerToken }: { vaultOwnerToken: string | null }) {
  const [snapshot, setSnapshot] = useState<{ token: string; epoch: number; shares: ReceivedDriveBulkShare[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!vaultOwnerToken) return;
    let active = true;
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => { if (!active || !isVaultSessionEpochCurrent(epoch)) throw new Error("session_changed"); };
    setSnapshot(null); setFailed(false);
    void DriveSharingService.receivedBulkShares(vaultOwnerToken, guard)
      .then(shares => { guard(); setSnapshot({ token: vaultOwnerToken, epoch, shares }); })
      .catch(() => { if (active && isVaultSessionEpochCurrent(epoch)) { setSnapshot(null); setFailed(true); } });
    return () => { active = false; };
  }, [vaultOwnerToken, retry]);

  const shares = snapshot?.token === vaultOwnerToken && isVaultSessionEpochCurrent(snapshot.epoch)
    ? snapshot.shares : null;
  if (!vaultOwnerToken) return null;
  return <SettingsGroup title="Drive files shared with you" separatorInset testId="received-drive-files-group">
    {failed ? <div className="space-y-2 px-4 py-3"><HelperText role="status">Couldn’t load Drive files.</HelperText>
      <Button type="button" variant="muted" size="compact" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>
      : shares === null ? <SettingsRow icon={SyncRowIcon} iconTone="capability" title="Checking Drive shares…" />
        : shares.length === 0 ? <SettingsRow icon={ShareRowIcon} iconTone="capability" title="No Drive files shared yet" />
          : shares.map(share => <ReceivedDriveShare key={share.shareId} share={share} token={vaultOwnerToken} />)}
  </SettingsGroup>;
}

function ReceivedDriveShare({ share, token }: { share: ReceivedDriveBulkShare; token: string }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [page, setPage] = useState<ReceivedDriveBulkFilesPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open) { setPage(null); return; }
    let active = true;
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => { if (!active || !isVaultSessionEpochCurrent(epoch)) throw new Error("session_changed"); };
    setPage(null); setFailed(false); setLoading(true);
    void DriveSharingService.receivedBulkFiles(token, share.shareId, guard, cursor)
      .then(next => { guard(); setPage(next); })
      .catch(() => { if (active && isVaultSessionEpochCurrent(epoch)) { setPage(null); setFailed(true); } })
      .finally(() => { if (active && isVaultSessionEpochCurrent(epoch)) setLoading(false); });
    return () => { active = false; };
  }, [open, token, share.shareId, cursor, retry]);

  const when = new Date(share.createdAt).toLocaleDateString();
  return <div className="space-y-2 px-4 py-3">
    <Button type="button" variant="muted" size="compact" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {share.sharedCount.toLocaleString()} {share.sharedCount === 1 ? "file" : "files"} · {when}
    </Button>
    {open ? <div className="space-y-2" aria-label="Shared Drive files" aria-busy={loading}>
      {share.status === "queued" || share.status === "running" ? <HelperText>More files may arrive as sharing continues.</HelperText> : null}
      {failed ? <div className="space-y-2"><HelperText role="status">Couldn’t load these files.</HelperText>
        <Button type="button" variant="muted" size="compact" onClick={() => setRetry(value => value + 1)}>Try again</Button></div> : null}
      {page?.files.length ? <ul className="space-y-1 text-sm">{page.files.map((file, index) =>
        <li key={`${file.openUrl}:${index}`} className="min-w-0 break-words">
          {file.openUrl ? <a href={file.openUrl} target="_blank" rel="noopener noreferrer"
            className="text-primary underline underline-offset-4">{file.name}</a> : file.name}
        </li>)}</ul> : null}
      {previous.length || page?.nextCursor ? <div className="flex gap-2">
        <Button type="button" variant="muted" size="compact" disabled={loading || !previous.length}
          onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(items => items.slice(0, -1)); }}>Previous</Button>
        <Button type="button" variant="muted" size="compact" disabled={loading || !page?.nextCursor}
          onClick={() => { setPrevious(items => [...items, cursor]); setCursor(page?.nextCursor ?? null); }}>Next 25</Button>
      </div> : null}
    </div> : null}
  </div>;
}
