"use client";

import type { FileEntry, FilesPage, FilesSettings, WikiOverview, WikiPageDetail } from "@/lib/files/service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

type CachedSlot<T> = {
  ownerKey: string;
  vaultEpoch: number;
  value: T;
};

const LIST_CACHE = new Map<string, CachedSlot<FilesPage>>();
const SETTINGS_CACHE = new Map<string, CachedSlot<FilesSettings>>();
const WIKI_OVERVIEW_CACHE = new Map<string, CachedSlot<WikiOverview>>();
const WIKI_PAGE_CACHE = new Map<string, CachedSlot<WikiPageDetail>>();
const FILE_TEXT_CACHE = new Map<string, CachedSlot<string>>();

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
}

export function peekFilesSettingsCache(ownerKey: string): FilesSettings | null {
  return readSlot(SETTINGS_CACHE, ownerKey);
}

export function setFilesSettingsCache(ownerKey: string, value: FilesSettings): void {
  writeSlot(SETTINGS_CACHE, ownerKey, ownerKey, value);
}

export function peekFilesWikiOverviewCache(ownerKey: string): WikiOverview | null {
  return readSlot(WIKI_OVERVIEW_CACHE, ownerKey);
}

export function setFilesWikiOverviewCache(ownerKey: string, value: WikiOverview): void {
  writeSlot(WIKI_OVERVIEW_CACHE, ownerKey, ownerKey, value);
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
}

export function isPreviewableTextFilename(name: string): boolean {
  return /\.(md|markdown|mdx|txt|json|ya?ml|csv|log|ts|tsx|js|jsx|py|sh|toml|ini|conf)$/i.test(
    name.trim(),
  );
}

export function clearFilesCache(userId?: string): void {
  invalidateFilesMutationCache(userId);
}
