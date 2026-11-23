"use client";

import type { FileEntry, FilesPage, FilesSettings, WikiOverview, WikiPageDetail } from "@/lib/files/service";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  canSealOwnerUiCache,
  deleteEncryptedOwnerUiRecords,
  readEncryptedOwnerUiRecord,
  writeEncryptedOwnerUiRecord,
} from "@/lib/storage/encrypted-owner-ui-cache";

const FILES_HOSTING_NAMESPACE = "files:hosting:v1";
const FILES_SETTINGS_NAMESPACE = "files:settings:v1";
const FILES_WIKI_OVERVIEW_NAMESPACE = "files:wiki:overview:v1";

function filesListNamespace(parent: string): string {
  return `files:list:${parent}:live`;
}

type CachedSlot<T> = {
  ownerKey: string;
  vaultEpoch: number;
  value: T;
};

type CachedHostingSlot = {
  ownerKey: string;
  vaultKey: string;
  vaultEpoch: number;
  identity: AuthSessionOwnerSnapshot;
  hosting: "shared" | "pod";
};

const LIST_CACHE = new Map<string, CachedSlot<FilesPage>>();
const SETTINGS_CACHE = new Map<string, CachedSlot<FilesSettings>>();
const WIKI_OVERVIEW_CACHE = new Map<string, CachedSlot<WikiOverview>>();
const WIKI_PAGE_CACHE = new Map<string, CachedSlot<WikiPageDetail>>();
const FILE_TEXT_CACHE = new Map<string, CachedSlot<string>>();
const HOSTING_CACHE = new Map<string, CachedHostingSlot>();
const HYDRATIONS = new Map<
  string,
  Promise<{
    hosting: "shared" | "pod" | null;
    rootList: FilesPage | null;
    settings: FilesSettings | null;
    wikiOverview: WikiOverview | null;
  }>
>();

function activeVaultKeyForOwner(ownerKey: string): string | null {
  const entry = HOSTING_CACHE.get(ownerKey);
  if (
    !entry ||
    !isVaultSessionEpochCurrent(entry.vaultEpoch) ||
    entry.identity.userId !== ownerKey ||
    !isValidatedAuthSessionOwnerCurrent(entry.identity)
  ) {
    return null;
  }
  return entry.vaultKey;
}

function readSlot<T>(store: Map<string, CachedSlot<T>>, key: string): T | null {
  const entry = store.get(key);
  if (!entry || !isVaultSessionEpochCurrent(entry.vaultEpoch)) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function writeSlot<T>(store: Map<string, CachedSlot<T>>, key: string, ownerKey: string, value: T): void {
  const vaultEpoch = snapshotVaultSessionEpoch();
  store.set(key, { ownerKey, vaultEpoch, value });
}

function listKey(ownerKey: string, parent: string, cursor: string, trash: boolean): string {
  return `${ownerKey}:${parent}:${cursor}:${trash ? "trash" : "live"}`;
}

export function peekFilesListCache(ownerKey: string, parent: string, cursor = "", trash = false): FilesPage | null {
  return readSlot(LIST_CACHE, listKey(ownerKey, parent, cursor, trash));
}

export function setFilesListCache(ownerKey: string, parent: string, cursor: string, trash: boolean, value: FilesPage): void {
  writeSlot(LIST_CACHE, listKey(ownerKey, parent, cursor, trash), ownerKey, value);
  if (!cursor && !trash && parent.length <= 128) {
    const vaultKey = activeVaultKeyForOwner(ownerKey);
    if (vaultKey && canSealOwnerUiCache(vaultKey)) {
      void writeEncryptedOwnerUiRecord({
        ownerId: ownerKey,
        vaultKey,
        namespace: filesListNamespace(parent),
        value,
      });
    }
  }
}

export function peekFilesSettingsCache(ownerKey: string): FilesSettings | null {
  return readSlot(SETTINGS_CACHE, ownerKey);
}

export function setFilesSettingsCache(ownerKey: string, value: FilesSettings): void {
  writeSlot(SETTINGS_CACHE, ownerKey, ownerKey, value);
  const vaultKey = activeVaultKeyForOwner(ownerKey);
  if (vaultKey && canSealOwnerUiCache(vaultKey)) {
    void writeEncryptedOwnerUiRecord({
      ownerId: ownerKey,
      vaultKey,
      namespace: FILES_SETTINGS_NAMESPACE,
      value,
    });
  }
}

export function peekFilesWikiOverviewCache(ownerKey: string): WikiOverview | null {
  return readSlot(WIKI_OVERVIEW_CACHE, ownerKey);
}

export function setFilesWikiOverviewCache(ownerKey: string, value: WikiOverview): void {
  writeSlot(WIKI_OVERVIEW_CACHE, ownerKey, ownerKey, value);
  const vaultKey = activeVaultKeyForOwner(ownerKey);
  if (vaultKey && canSealOwnerUiCache(vaultKey)) {
    void writeEncryptedOwnerUiRecord({
      ownerId: ownerKey,
      vaultKey,
      namespace: FILES_WIKI_OVERVIEW_NAMESPACE,
      value,
    });
  }
}

export function peekFilesWikiPageCache(ownerKey: string, pageId: string): WikiPageDetail | null {
  return readSlot(WIKI_PAGE_CACHE, `${ownerKey}:${pageId}`);
}

export function setFilesWikiPageCache(ownerKey: string, pageId: string, value: WikiPageDetail): void {
  writeSlot(WIKI_PAGE_CACHE, `${ownerKey}:${pageId}`, ownerKey, value);
}

export function peekFilesTextCache(ownerKey: string, fileId: string, revision: number): string | null {
  return readSlot(FILE_TEXT_CACHE, `${ownerKey}:${fileId}:${revision}`);
}

export function setFilesTextCache(ownerKey: string, entry: FileEntry, text: string): void {
  writeSlot(FILE_TEXT_CACHE, `${ownerKey}:${entry.id}:${entry.revision}`, ownerKey, text);
}

export function peekFilesHostingCache(
  ownerKey: string | undefined,
  vaultKey: string | null,
): "shared" | "pod" | null {
  if (!ownerKey || !vaultKey) return null;
  const entry = HOSTING_CACHE.get(ownerKey);
  if (
    !entry ||
    entry.vaultKey !== vaultKey ||
    !isVaultSessionEpochCurrent(entry.vaultEpoch) ||
    entry.identity.userId !== ownerKey ||
    !isValidatedAuthSessionOwnerCurrent(entry.identity)
  ) {
    HOSTING_CACHE.delete(ownerKey);
    return null;
  }
  return entry.hosting;
}

export function setFilesHostingCache(
  ownerKey: string,
  vaultKey: string,
  hosting: "shared" | "pod",
): void {
  const identity = snapshotValidatedAuthSessionOwner();
  if (!identity || identity.userId !== ownerKey) return;
  HOSTING_CACHE.set(ownerKey, {
    ownerKey,
    vaultKey,
    vaultEpoch: snapshotVaultSessionEpoch(),
    identity,
    hosting,
  });
  if (canSealOwnerUiCache(vaultKey)) {
    void writeEncryptedOwnerUiRecord({
      ownerId: ownerKey,
      vaultKey,
      namespace: FILES_HOSTING_NAMESPACE,
      value: { hosting },
    });
  }
}

export function hydrateFilesCacheFromEncryptedCache(
  ownerKey: string | undefined,
  vaultKey: string | null | undefined,
): Promise<{
  hosting: "shared" | "pod" | null;
  rootList: FilesPage | null;
  settings: FilesSettings | null;
  wikiOverview: WikiOverview | null;
}> {
  if (!ownerKey || !vaultKey || !canSealOwnerUiCache(vaultKey)) {
    return Promise.resolve({
      hosting: null,
      rootList: null,
      settings: null,
      wikiOverview: null,
    });
  }
  const existingTask = HYDRATIONS.get(ownerKey);
  if (existingTask) return existingTask;

  const identity = snapshotValidatedAuthSessionOwner();
  const vaultEpoch = snapshotVaultSessionEpoch();
  const task = Promise.all([
    readEncryptedOwnerUiRecord<{ hosting?: unknown }>({
      ownerId: ownerKey,
      vaultKey,
      namespace: FILES_HOSTING_NAMESPACE,
    }),
    readEncryptedOwnerUiRecord<FilesPage>({
      ownerId: ownerKey,
      vaultKey,
      namespace: filesListNamespace("root"),
    }),
    readEncryptedOwnerUiRecord<FilesSettings>({
      ownerId: ownerKey,
      vaultKey,
      namespace: FILES_SETTINGS_NAMESPACE,
    }),
    readEncryptedOwnerUiRecord<WikiOverview>({
      ownerId: ownerKey,
      vaultKey,
      namespace: FILES_WIKI_OVERVIEW_NAMESPACE,
    }),
  ])
    .then(([hostingRec, listRec, settingsRec, wikiRec]) => {
      if (
        !identity ||
        identity.userId !== ownerKey ||
        !isValidatedAuthSessionOwnerCurrent(identity) ||
        !isVaultSessionEpochCurrent(vaultEpoch)
      ) {
        return { hosting: null, rootList: null, settings: null, wikiOverview: null };
      }

      const rawHosting = hostingRec?.value?.hosting;
      const hydratedHosting =
        rawHosting === "shared" || rawHosting === "pod" ? rawHosting : null;
      if (hydratedHosting && !peekFilesHostingCache(ownerKey, vaultKey)) {
        HOSTING_CACHE.set(ownerKey, {
          ownerKey,
          vaultKey,
          vaultEpoch,
          identity,
          hosting: hydratedHosting,
        });
      }

      const hydratedRoot =
        listRec?.value && Array.isArray(listRec.value.entries) ? listRec.value : null;
      if (hydratedRoot && !peekFilesListCache(ownerKey, "root", "", false)) {
        writeSlot(LIST_CACHE, listKey(ownerKey, "root", "", false), ownerKey, hydratedRoot);
      }

      const hydratedSettings =
        settingsRec?.value && typeof settingsRec.value.revision === "number"
          ? settingsRec.value
          : null;
      if (hydratedSettings && !peekFilesSettingsCache(ownerKey)) {
        writeSlot(SETTINGS_CACHE, ownerKey, ownerKey, hydratedSettings);
      }

      const hydratedWiki =
        wikiRec?.value && Array.isArray(wikiRec.value.pages) ? wikiRec.value : null;
      if (hydratedWiki && !peekFilesWikiOverviewCache(ownerKey)) {
        writeSlot(WIKI_OVERVIEW_CACHE, ownerKey, ownerKey, hydratedWiki);
      }

      return {
        hosting: peekFilesHostingCache(ownerKey, vaultKey) ?? hydratedHosting,
        rootList: peekFilesListCache(ownerKey, "root", "", false) ?? hydratedRoot,
        settings: peekFilesSettingsCache(ownerKey) ?? hydratedSettings,
        wikiOverview: peekFilesWikiOverviewCache(ownerKey) ?? hydratedWiki,
      };
    })
    .finally(() => {
      if (HYDRATIONS.get(ownerKey) === task) {
        HYDRATIONS.delete(ownerKey);
      }
    });

  HYDRATIONS.set(ownerKey, task);
  return task;
}

export function clearFilesHostingCache(ownerKey?: string): void {
  if (!ownerKey) {
    HOSTING_CACHE.clear();
    HYDRATIONS.clear();
    void deleteEncryptedOwnerUiRecords(undefined, FILES_HOSTING_NAMESPACE);
    return;
  }
  HOSTING_CACHE.delete(ownerKey);
  HYDRATIONS.delete(ownerKey);
  void deleteEncryptedOwnerUiRecords(ownerKey, FILES_HOSTING_NAMESPACE);
}

export function invalidateFilesMutationCache(ownerKey?: string): void {
  const dropByOwner = <T,>(store: Map<string, CachedSlot<T>>) => {
    if (!ownerKey) {
      store.clear();
      return;
    }
    for (const [key, entry] of store.entries()) {
      if (entry.ownerKey === ownerKey || !isVaultSessionEpochCurrent(entry.vaultEpoch)) {
        store.delete(key);
      }
    }
  };
  dropByOwner(LIST_CACHE);
  dropByOwner(SETTINGS_CACHE);
  dropByOwner(WIKI_OVERVIEW_CACHE);
  dropByOwner(WIKI_PAGE_CACHE);
  dropByOwner(FILE_TEXT_CACHE);
  void deleteEncryptedOwnerUiRecords(ownerKey, "files:list:");
  void deleteEncryptedOwnerUiRecords(ownerKey, FILES_SETTINGS_NAMESPACE);
  void deleteEncryptedOwnerUiRecords(ownerKey, "files:wiki:");
}

export function isPreviewableTextFilename(name: string): boolean {
  return /\.(md|markdown|mdx|txt|json|ya?ml|csv|log|ts|tsx|js|jsx|py|sh|toml|ini|conf)$/i.test(
    name.trim(),
  );
}

export function clearFilesCache(userId?: string): void {
  invalidateFilesMutationCache(userId);
  clearFilesHostingCache(userId);
}
