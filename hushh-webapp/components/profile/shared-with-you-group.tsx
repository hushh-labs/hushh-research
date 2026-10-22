"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import {
  MemoryAgentIcon,
  ShareRowIcon,
  SyncRowIcon,
} from "@/components/icons/agents";
import { SharedWithYouCard } from "@/components/agent/consent/shared-with-you-card";
import { humanSharedLabel, type SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { parseSharedFieldSensitivities } from "@/lib/consent/field-sensitivity";
import { readSharedWithMe } from "@/lib/consent/information-request-reads";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { DriveSharingService, type ReceivedDriveBulkFilesPage, type ReceivedDriveBulkShare } from "@/lib/services/drive-sharing-service";
import { ROUTES } from "@/lib/navigation/routes";
import type { SharedWithMeEntry } from "@/lib/services/person-profile-service";

export type PersonShares = {
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
export function useSharedWithYouModel(vaultOwnerToken: string | null, active = true) {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [snapshot, setSnapshot] = useState<{ token: string; epoch: number; shares: SharedWithMeEntry[] | null; failed: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!vaultOwnerToken || !active) return;
    let current = true;
    const accepted = () => current && isVaultSessionEpochCurrent(epoch);
    setSnapshot(null);
    void readSharedWithMe({ vaultOwnerToken })
      .then((next) => {
        if (accepted()) setSnapshot({ token: vaultOwnerToken, epoch, shares: next, failed: false });
      })
      .catch(() => {
        if (accepted()) setSnapshot({ token: vaultOwnerToken, epoch, shares: null, failed: true });
      });
    return () => { current = false; };
  }, [vaultOwnerToken, epoch, retry, active]);
  const current = active && snapshot?.token === vaultOwnerToken && snapshot.epoch === epoch;
  const shares = current ? snapshot.shares : null;
  const failed = current ? snapshot.failed : false;
  const people = useMemo(() => groupSharesByPerson(shares ?? []), [shares]);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  return { shares, failed, people, refresh };
}
export type SharedWithYouModel = ReturnType<typeof useSharedWithYouModel>;

export function SharedWithYouGroup({ vaultOwnerToken, model, received }: { vaultOwnerToken: string | null; model?: SharedWithYouModel; received?: ReceivedDriveSharesModel }) {
  return model ? <SharedWithYouBody vaultOwnerToken={vaultOwnerToken} model={model} received={received} /> : <OwnedSharedWithYouGroup vaultOwnerToken={vaultOwnerToken} />;
}
function OwnedSharedWithYouGroup({ vaultOwnerToken }: { vaultOwnerToken: string | null }) {
  const model = useSharedWithYouModel(vaultOwnerToken);
  return <SharedWithYouBody vaultOwnerToken={vaultOwnerToken} model={model} />;
}
function SharedWithYouBody({ vaultOwnerToken, model, received }: { vaultOwnerToken: string | null; model: SharedWithYouModel; received?: ReceivedDriveSharesModel }) {
  const router = useRouter();
  const { shares, failed, people } = model;

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
              <Button type="button" variant="muted" size="compact" onClick={model.refresh}>Try again</Button>
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
      {received ? <ReceivedDriveSharesBody vaultOwnerToken={vaultOwnerToken} model={received} /> : <ReceivedDriveShares vaultOwnerToken={vaultOwnerToken} />}
    </>
  );
}

/** Only confirmed Viewer grants appear here; no recipient Drive connection is needed. */
export function useReceivedDriveSharesModel(vaultOwnerToken: string | null, active = true) {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [snapshot, setSnapshot] = useState<{ token: string; epoch: number; shares: ReceivedDriveBulkShare[] | null; failed: boolean } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!vaultOwnerToken || !active) return;
    let current = true;
    const guard = () => { if (!current || !isVaultSessionEpochCurrent(epoch)) throw new Error("session_changed"); };
    setSnapshot(null);
    void DriveSharingService.receivedBulkShares(vaultOwnerToken, guard)
      .then(shares => { guard(); setSnapshot({ token: vaultOwnerToken, epoch, shares, failed: false }); })
      .catch(() => { if (current && isVaultSessionEpochCurrent(epoch)) setSnapshot({ token: vaultOwnerToken, epoch, shares: null, failed: true }); });
    return () => { current = false; };
  }, [vaultOwnerToken, epoch, retry, active]);

  const current = active && snapshot?.token === vaultOwnerToken && isVaultSessionEpochCurrent(snapshot.epoch);
  const shares = current ? snapshot.shares : null;
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  return { shares, failed: current && snapshot.failed, refresh };
}
export type ReceivedDriveSharesModel = ReturnType<typeof useReceivedDriveSharesModel>;

function ReceivedDriveShares({ vaultOwnerToken }: { vaultOwnerToken: string | null }) {
  const model = useReceivedDriveSharesModel(vaultOwnerToken);
  return <ReceivedDriveSharesBody vaultOwnerToken={vaultOwnerToken} model={model} />;
}
function ReceivedDriveSharesBody({ vaultOwnerToken, model }: { vaultOwnerToken: string | null; model: ReceivedDriveSharesModel }) {
  const { shares, failed } = model;
  if (!vaultOwnerToken) return null;
  return <SettingsGroup title="Drive files shared with you" separatorInset testId="received-drive-files-group">
    {failed ? <div className="space-y-2 px-4 py-3"><HelperText role="status">Couldn’t load Drive files.</HelperText>
      <Button type="button" variant="muted" size="compact" onClick={model.refresh}>Try again</Button></div>
      : shares === null ? <SettingsRow icon={SyncRowIcon} iconTone="capability" title="Checking Drive shares…" />
        : shares.length === 0 ? <SettingsRow icon={ShareRowIcon} iconTone="capability" title="No Drive files shared yet" />
          : shares.map(share => <ReceivedDriveShare key={share.shareId} share={share} token={vaultOwnerToken} />)}
  </SettingsGroup>;
}

export function useReceivedDriveShareModel(share: ReceivedDriveBulkShare | null, token: string | null, open: boolean) {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const shareId = share?.shareId;
  const owner = JSON.stringify([token, epoch, shareId]); // Private request identity only.
  const [position, setPosition] = useState<{ owner: string; cursor: string | null; previous: (string | null)[] } | null>(null);
  const cursor = position?.owner === owner ? position.cursor : null;
  const previous = position?.owner === owner ? position.previous : [];
  const [snapshot, setSnapshot] = useState<{ owner: string; cursor: string | null; page: ReceivedDriveBulkFilesPage | null; failed: boolean; loading: boolean } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || !token || !shareId) { setSnapshot(null); return; }
    let active = true;
    const guard = () => { if (!active || !isVaultSessionEpochCurrent(epoch)) throw new Error("session_changed"); };
    setSnapshot({ owner, cursor, page: null, failed: false, loading: true });
    void DriveSharingService.receivedBulkFiles(token, shareId, guard, cursor)
      .then(page => { guard(); setSnapshot({ owner, cursor, page, failed: false, loading: false }); })
      .catch(() => { if (active && isVaultSessionEpochCurrent(epoch)) setSnapshot({ owner, cursor, page: null, failed: true, loading: false }); });
    return () => { active = false; };
  }, [open, token, shareId, owner, epoch, cursor, retry]);
  const admitted = open && isVaultSessionEpochCurrent(epoch) && snapshot?.owner === owner && snapshot.cursor === cursor;
  const page = admitted ? snapshot.page : null;
  const loading = open && (!admitted || snapshot.loading);
  const failed = admitted && snapshot.failed;
  return { page, loading, failed, canPrevious: previous.length > 0, canNext: !!page?.nextCursor,
    retry: () => setRetry(value => value + 1),
    previous: () => { if (!loading && previous.length && isVaultSessionEpochCurrent(epoch)) setPosition({ owner, cursor: previous.at(-1) ?? null, previous: previous.slice(0, -1) }); },
    next: () => { if (!loading && page?.nextCursor && isVaultSessionEpochCurrent(epoch)) setPosition({ owner, cursor: page.nextCursor, previous: [...previous, cursor] }); } };
}

function ReceivedDriveShare({ share, token }: { share: ReceivedDriveBulkShare; token: string }) {
  const [open, setOpen] = useState(false);
  const model = useReceivedDriveShareModel(share, token, open);
  const { page, loading, failed } = model;

  const when = new Date(share.createdAt).toLocaleDateString();
  return <div className="space-y-2 px-4 py-3">
    <Button type="button" variant="muted" size="compact" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {share.sharedCount.toLocaleString()} {share.sharedCount === 1 ? "file" : "files"} · {when}
    </Button>
    {open ? <div className="space-y-2" aria-label="Shared Drive files" aria-busy={loading}>
      {share.status === "queued" || share.status === "running" ? <HelperText>More files may arrive as sharing continues.</HelperText> : null}
      {failed ? <div className="space-y-2"><HelperText role="status">Couldn’t load these files.</HelperText>
        <Button type="button" variant="muted" size="compact" onClick={model.retry}>Try again</Button></div> : null}
      {page?.files.length ? <ul className="space-y-1 text-sm">{page.files.map((file, index) =>
        <li key={`${file.openUrl}:${index}`} className="min-w-0 break-words">
          {file.openUrl ? <a href={file.openUrl} target="_blank" rel="noopener noreferrer"
            className="text-primary underline underline-offset-4">{file.name}</a> : file.name}
        </li>)}</ul> : null}
      {model.canPrevious || model.canNext ? <div className="flex gap-2">
        <Button type="button" variant="muted" size="compact" disabled={loading || !model.canPrevious}
          onClick={model.previous}>Previous</Button>
        <Button type="button" variant="muted" size="compact" disabled={loading || !model.canNext}
          onClick={model.next}>Next 25</Button>
      </div> : null}
    </div> : null}
  </div>;
}
