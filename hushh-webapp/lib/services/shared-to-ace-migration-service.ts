"use client";

import {
  clearAgentChatHistoryCache,
} from "@/lib/agent/agent-chat-history-cache";
import { dispatchAgentChatHistoryInvalidated } from "@/lib/agent/agent-chat-history-events";
import { snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import * as cipher from "@/lib/files/shared/crypto";
import { SharedFilesLibrary } from "@/lib/files/shared/library";
import { SharedFilesStore, type SharedFilesAccess } from "@/lib/files/shared/store";
import type { FileEntry } from "@/lib/files/service";
import { clearFilesCache } from "@/lib/files/files-cache";
import { SharedWikiLibrary } from "@/lib/files/wiki/library";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { base64ToBytes } from "@/lib/vault/base64";

const MIGRATION_MARKER_PREFIX = "hushh.shared_to_ace_migrated.v1.";
const CHUNK_BYTES = 4 * 1024 * 1024;
const VAULT_KEY_HEX = /^[0-9a-f]{64}$/i;
const ZERO_HEX = "0".repeat(64);
const decoder = new TextDecoder("utf-8", { fatal: true });

export const FILES_MIGRATION_COMPLETED_EVENT = "files-migration-completed";

type MigrationMarkerState = {
  chat: boolean;
  files: boolean;
  updatedAt: number;
};

type SealedChatSessionRow = {
  app_name: string;
  user_id: string;
  session_id: string;
  payload_ciphertext: string;
  payload_iv: string;
  payload_tag: string;
  payload_algorithm: string;
  revision: number;
  updated_at: string;
};

type MigrationManifestFolder = {
  id: string;
  path?: string;
  ciphertext: string;
  generation?: string;
};

type MigrationManifestFile = {
  id: string;
  path?: string;
  ciphertext: string;
  generation?: string;
};

type MigrationManifestWikiPage = {
  page_id: string;
  path?: string;
  ciphertext?: string;
  generation?: string;
};

type FilesMigrationManifestResponse = {
  status: "empty" | "ready" | "migrated";
  libraryId?: string;
  keyEnvelope?: { ciphertext?: string | null; generation?: string };
  folders?: MigrationManifestFolder[];
  files?: MigrationManifestFile[];
  wiki_pages?: MigrationManifestWikiPage[];
  objects?: string[];
};

export type SharedToAceMigrationInput = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  hostingMode?: string | null;
  signal?: AbortSignal;
  force?: boolean;
  getIdToken?: () => Promise<string | null>;
};

export type SharedToAceMigrationResult = {
  status: "migrated" | "empty" | "skipped" | "failed";
  reason?: string;
  migratedSessions: number;
  migratedFiles: number;
  migratedWikiPages: number;
};

const IN_FLIGHT_MIGRATIONS = new Map<string, Promise<SharedToAceMigrationResult>>();

function markerStorageKey(userId: string): string {
  return `${MIGRATION_MARKER_PREFIX}${userId}`;
}

function readMarker(userId: string): MigrationMarkerState {
  if (typeof window === "undefined" || !userId) {
    return { chat: false, files: false, updatedAt: 0 };
  }
  try {
    const raw = window.localStorage.getItem(markerStorageKey(userId));
    if (!raw) return { chat: false, files: false, updatedAt: 0 };
    const parsed = JSON.parse(raw) as Partial<MigrationMarkerState> | null;
    return {
      chat: parsed?.chat === true,
      files: parsed?.files === true,
      updatedAt: typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return { chat: false, files: false, updatedAt: 0 };
  }
}

function writeMarker(userId: string, marker: MigrationMarkerState): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(markerStorageKey(userId), JSON.stringify(marker));
  } catch {
    // Ignore storage quota or private mode issues.
  }
}

export function hasCompletedSharedToAceMigration(userId: string): boolean {
  const marker = readMarker(userId);
  return marker.chat && marker.files;
}

export function resetSharedToAceMigrationMarkerForTests(userId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) {
      window.localStorage.removeItem(markerStorageKey(userId));
      return;
    }
    for (let idx = window.localStorage.length - 1; idx >= 0; idx -= 1) {
      const key = window.localStorage.key(idx);
      if (key?.startsWith(MIGRATION_MARKER_PREFIX)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage access failures.
  }
}

function dispatchFilesMigrationCompleted(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  window.dispatchEvent(
    new CustomEvent(FILES_MIGRATION_COMPLETED_EVENT, {
      detail: { userId },
    }),
  );
}

async function resolveDefaultIdToken(): Promise<string | null> {
  const currentUser = AuthService.getCurrentUser();
  if (!currentUser || typeof currentUser.getIdToken !== "function") {
    return null;
  }
  try {
    const token = await currentUser.getIdToken();
    return token ? String(token) : null;
  } catch {
    return null;
  }
}

function assertMigrationSessionCurrent(
  userId: string,
  vaultKey: string,
  vaultEpoch: number,
  signal?: AbortSignal,
): void {
  signal?.throwIfAborted();
  if (!userId || !VAULT_KEY_HEX.test(vaultKey)) {
    throw new Error("MIGRATION_VAULT_REQUIRED");
  }
  if (!isVaultSessionEpochCurrent(vaultEpoch)) {
    throw new DOMException("Vault session changed", "AbortError");
  }
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (principal && principal.ownerId !== userId) {
    throw new DOMException("Owner changed", "AbortError");
  }
}

async function migrateSealedChatSessions(params: {
  userId: string;
  idToken: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ done: boolean; imported: number }> {
  params.assertCurrent();
  const response = await ApiService.apiFetch("/api/one/agent-chat/migration/sessions", {
    method: "GET",
    cache: "no-store",
    signal: params.signal,
    headers: {
      Authorization: `Bearer ${params.idToken}`,
    },
  });
  params.assertCurrent();
  if (response.status === 404) {
    return { done: true, imported: 0 };
  }
  if (!response.ok) {
    return { done: false, imported: 0 };
  }
  const payload = (await response.json()) as {
    status?: string;
    sessions?: SealedChatSessionRow[];
  };
  if (
    payload.status === "empty" ||
    !Array.isArray(payload.sessions) ||
    payload.sessions.length === 0
  ) {
    return { done: true, imported: 0 };
  }

  const importResponse = await ApiService.ownerPodRequest("agent-chat/migration/import", {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessions: payload.sessions }),
  });
  params.assertCurrent();
  if (!importResponse.ok) {
    return { done: false, imported: 0 };
  }
  const importResult = (await importResponse.json()) as {
    status?: string;
    imported?: number;
  };
  const importedCount = Number(importResult.imported || 0);
  if (importedCount > 0) {
    clearAgentChatHistoryCache(params.userId, { includeDevice: true });
    dispatchAgentChatHistoryInvalidated(params.userId);
  }
  return { done: true, imported: importedCount };
}

async function createPodFolderIdempotent(params: {
  name: string;
  parent: string;
  sourceId: string;
  signal?: AbortSignal;
}): Promise<FileEntry> {
  const response = await ApiService.ownerPodRequest("files/create", {
    method: "POST",
    signal: params.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: params.name,
      parent: params.parent,
      size: 0,
      folder: true,
      request_id: `mig-folder-${params.sourceId}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`POD_FILES_CREATE_FOLDER_FAILED:${response.status}`);
  }
  return (await response.json()) as FileEntry;
}

async function uploadPodFileIdempotent(params: {
  sourceId: string;
  name: string;
  parent: string;
  size: number;
  readChunk: (index: number) => Promise<Uint8Array>;
  signal?: AbortSignal;
}): Promise<FileEntry> {
  const createResponse = await ApiService.ownerPodRequest("files/create", {
    method: "POST",
    signal: params.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: params.name,
      parent: params.parent,
      size: params.size,
      request_id: `mig-file-${params.sourceId}`,
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`POD_FILES_CREATE_FAILED:${createResponse.status}`);
  }
  const podEntry = (await createResponse.json()) as FileEntry;
  if (podEntry.state === "ready") {
    return podEntry;
  }

  const totalChunks = params.size === 0 ? 0 : Math.ceil(params.size / CHUNK_BYTES);
  const startIndex = Math.floor((podEntry.received || 0) / CHUNK_BYTES);
  for (let idx = startIndex; idx < totalChunks; idx += 1) {
    params.signal?.throwIfAborted();
    const chunkBytes = await params.readChunk(idx);
    const putResponse = await ApiService.ownerPodRequest(
      `files/chunk?${new URLSearchParams({
        file_id: podEntry.id,
        index: String(idx),
      })}`,
      {
        method: "PUT",
        signal: params.signal,
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(chunkBytes).buffer,
      },
    );
    if (!putResponse.ok) {
      throw new Error(`POD_FILES_CHUNK_FAILED:${putResponse.status}`);
    }
  }
  const completeResponse = await ApiService.ownerPodRequest("files/complete", {
    method: "POST",
    signal: params.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: podEntry.id }),
  });
  if (!completeResponse.ok) {
    throw new Error(`POD_FILES_COMPLETE_FAILED:${completeResponse.status}`);
  }
  return (await completeResponse.json()) as FileEntry;
}

async function uploadPodWikiPageIdempotent(params: {
  pageId: string;
  title: string;
  folder: string;
  tldr: string;
  statusAsOf: string;
  body: string;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await ApiService.ownerPodRequest("files/wiki/page", {
    method: "POST",
    signal: params.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      page_id: params.pageId,
      expected_revision: 0,
      title: params.title,
      folder: params.folder || "root",
      tldr: params.tldr || "",
      status_as_of: params.statusAsOf || "2026-01-01",
      body: params.body || "",
      request_id: `mig-wiki-${params.pageId}`,
    }),
  });
  if (response.status === 409) {
    // Already present with revision >= 1 on Pod.
    return;
  }
  if (!response.ok) {
    throw new Error(`POD_WIKI_CREATE_FAILED:${response.status}`);
  }
}

async function migrateViaSharedLibrary(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<{ migratedFiles: number; migratedWikiPages: number; hadLibrary: boolean }> {
  const access: SharedFilesAccess = {
    owner: params.userId,
    vaultKey: params.vaultKey,
    ownerToken: params.vaultOwnerToken,
    check: params.assertCurrent,
  };
  const sharedStore = new SharedFilesStore(access);
  const initialized = await sharedStore.readyIfInitialized(params.signal);
  if (!initialized) {
    return { migratedFiles: 0, migratedWikiPages: 0, hadLibrary: false };
  }
  const sharedLib = new SharedFilesLibrary(access, sharedStore);
  const sharedWiki = new SharedWikiLibrary(access, sharedStore);

  const folderIdMap = new Map<string, string>([["root", "root"]]);
  const queue: Array<{ sharedParent: string; podParent: string }> = [
    { sharedParent: "root", podParent: "root" },
  ];
  const visitedFolders = new Set<string>(["root"]);
  const fileWork: Array<{ entry: FileEntry; podParent: string }> = [];

  while (queue.length > 0) {
    const next = queue.shift()!;
    let cursor = "";
    for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
      params.assertCurrent();
      const page = await sharedLib.list(next.sharedParent, cursor, false, params.signal);
      for (const entry of page.entries) {
        if (entry.state !== "ready") continue;
        if (entry.kind === "folder") {
          if (visitedFolders.has(entry.id)) continue;
          visitedFolders.add(entry.id);
          const podFolder = await createPodFolderIdempotent({
            name: entry.name,
            parent: next.podParent,
            sourceId: entry.id,
            signal: params.signal,
          });
          folderIdMap.set(entry.id, podFolder.id);
          queue.push({ sharedParent: entry.id, podParent: podFolder.id });
        } else if (entry.kind === "file") {
          fileWork.push({ entry, podParent: next.podParent });
        }
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
  }

  let migratedFiles = 0;
  for (const item of fileWork) {
    params.assertCurrent();
    await uploadPodFileIdempotent({
      sourceId: item.entry.id,
      name: item.entry.originalName || item.entry.name,
      parent: item.podParent,
      size: item.entry.size,
      signal: params.signal,
      readChunk: async (index) => {
        const result = await sharedLib.chunk(item.entry.id, index, undefined, params.signal);
        if (!(result instanceof Uint8Array)) {
          throw new Error("SHARED_CHUNK_READ_FAILED");
        }
        return result;
      },
    });
    migratedFiles += 1;
  }

  let migratedWikiPages = 0;
  const wikiSummaries = await sharedWiki.listPages(undefined, params.signal);
  for (const summary of wikiSummaries) {
    params.assertCurrent();
    const page = await sharedWiki.readPage(summary.page_id, undefined, params.signal);
    await uploadPodWikiPageIdempotent({
      pageId: page.page_id,
      title: page.title,
      folder: page.folder || "root",
      tldr: page.tldr || "",
      statusAsOf: page.status_as_of || "2026-01-01",
      body: page.body || "",
      signal: params.signal,
    });
    migratedWikiPages += 1;
  }

  return { migratedFiles, migratedWikiPages, hadLibrary: true };
}

async function openManifestEnvelope(
  ciphertextB64: string,
  encryptionKey: CryptoKey,
  candidates: string[],
): Promise<Uint8Array> {
  let lastError: unknown;
  for (const context of candidates) {
    try {
      return await cipher.open(encryptionKey, ciphertextB64, context);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("FILES_INTEGRITY_FAILURE");
}

function decodeBase64JsonEnvelope(ciphertextB64: string): string {
  const bytes = base64ToBytes(ciphertextB64);
  return decoder.decode(bytes);
}

async function decryptManifestJson<T>(params: {
  ciphertextB64: string;
  encryptionKey: CryptoKey;
  userId: string;
  libraryId: string;
  namespaces: string[];
  objectId: string;
}): Promise<T> {
  // Handle both raw base64(AES-GCM) and base64(JSON({"ciphertext": "..."})) envelopes.
  let innerCiphertext = params.ciphertextB64;
  try {
    const maybeJson = JSON.parse(decodeBase64JsonEnvelope(params.ciphertextB64)) as {
      ciphertext?: string;
    } | null;
    if (maybeJson && typeof maybeJson.ciphertext === "string") {
      innerCiphertext = maybeJson.ciphertext;
    }
  } catch {
    // Expected when ciphertextB64 directly encodes AES-GCM nonce+ciphertext bytes.
  }

  const contexts: string[] = [];
  for (const ns of params.namespaces) {
    contexts.push(
      JSON.stringify([
        "hussh/shared-files/object/v1",
        params.userId,
        params.libraryId,
        ns,
        params.objectId,
      ]),
    );
  }
  const plainBytes = await openManifestEnvelope(innerCiphertext, params.encryptionKey, contexts);
  return JSON.parse(decoder.decode(plainBytes)) as T;
}

async function migrateViaManifestFallback(params: {
  userId: string;
  vaultKey: string;
  idToken: string;
  manifest: FilesMigrationManifestResponse;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<{ migratedFiles: number; migratedWikiPages: number }> {
  const libraryId = params.manifest.libraryId || ZERO_HEX;
  const envelopeRaw = params.manifest.keyEnvelope?.ciphertext;
  const foldersRaw = params.manifest.folders ?? [];
  const filesRaw = params.manifest.files ?? [];
  const wikiRaw = params.manifest.wiki_pages ?? [];
  if (!envelopeRaw || (foldersRaw.length === 0 && filesRaw.length === 0 && wikiRaw.length === 0)) {
    return { migratedFiles: 0, migratedWikiPages: 0 };
  }

  let innerEnvelope = envelopeRaw;
  try {
    const wrappedJson = JSON.parse(decodeBase64JsonEnvelope(envelopeRaw)) as {
      ciphertext?: string;
    } | null;
    if (wrappedJson && typeof wrappedJson.ciphertext === "string") {
      innerEnvelope = wrappedJson.ciphertext;
    }
  } catch {
    // Direct AES-GCM envelope bytes.
  }

  const wrapKey = await cipher.wrappingKey(params.vaultKey, params.userId);
  const rawLibraryKey = await cipher.open(
    wrapKey,
    innerEnvelope,
    `hussh/shared-files/key/v1/${params.userId}/${libraryId}`,
  );
  let masterAes: CryptoKey;
  try {
    masterAes = await cipher.aes(rawLibraryKey);
  } finally {
    rawLibraryKey.fill(0);
  }

  const folderEntries: Array<{
    id: string;
    name: string;
    parent: string;
    state?: string;
  }> = [];
  for (const item of foldersRaw) {
    params.assertCurrent();
    const decrypted = await decryptManifestJson<{
      id?: string;
      name: string;
      parent?: string;
      state?: string;
    }>({
      ciphertextB64: item.ciphertext,
      encryptionKey: masterAes,
      userId: params.userId,
      libraryId,
      namespaces: ["entries", "folders"],
      objectId: item.id,
    });
    if (decrypted.state && decrypted.state !== "ready") continue;
    folderEntries.push({
      id: decrypted.id || item.id,
      name: decrypted.name,
      parent: decrypted.parent || "root",
      state: decrypted.state,
    });
  }

  const folderIdMap = new Map<string, string>([["root", "root"]]);
  const pending = [...folderEntries];
  let safetyCounter = 0;
  while (pending.length > 0 && safetyCounter < 512) {
    safetyCounter += 1;
    let progressed = false;
    for (let idx = pending.length - 1; idx >= 0; idx -= 1) {
      const folder = pending[idx]!;
      const podParent = folderIdMap.get(folder.parent);
      if (!podParent) continue;
      params.assertCurrent();
      const created = await createPodFolderIdempotent({
        name: folder.name,
        parent: podParent,
        sourceId: folder.id,
        signal: params.signal,
      });
      folderIdMap.set(folder.id, created.id);
      pending.splice(idx, 1);
      progressed = true;
    }
    if (!progressed) {
      for (const orphan of pending.splice(0)) {
        const created = await createPodFolderIdempotent({
          name: orphan.name,
          parent: "root",
          sourceId: orphan.id,
          signal: params.signal,
        });
        folderIdMap.set(orphan.id, created.id);
      }
    }
  }

  let migratedFiles = 0;
  for (const item of filesRaw) {
    params.assertCurrent();
    const meta = await decryptManifestJson<{
      id?: string;
      name: string;
      originalName?: string;
      parent?: string;
      size: number;
      chunks?: number;
      contentKey?: string;
      state?: string;
    }>({
      ciphertextB64: item.ciphertext,
      encryptionKey: masterAes,
      userId: params.userId,
      libraryId,
      namespaces: ["entries", "files"],
      objectId: item.id,
    });
    if (meta.state && meta.state !== "ready") continue;
    const fileId = meta.id || item.id;
    const podParent = folderIdMap.get(meta.parent || "root") ?? "root";
    const chunkKey = meta.contentKey ? await cipher.aes(cipher.unhex(meta.contentKey)) : masterAes;

    await uploadPodFileIdempotent({
      sourceId: fileId,
      name: meta.originalName || meta.name,
      parent: podParent,
      size: meta.size,
      signal: params.signal,
      readChunk: async (index) => {
        const chunkResp = await ApiService.apiFetch(
          `/api/one/files/migration/file/${encodeURIComponent(fileId)}/chunk/${index}`,
          {
            method: "GET",
            cache: "no-store",
            signal: params.signal,
            headers: { Authorization: `Bearer ${params.idToken}` },
          },
        );
        if (!chunkResp.ok) {
          throw new Error(`SHARED_MIGRATION_CHUNK_FAILED:${chunkResp.status}`);
        }
        const chunkPayload = (await chunkResp.json()) as { ciphertext: string };
        let chunkCiphertext = chunkPayload.ciphertext;
        try {
          const unwrapped = JSON.parse(decodeBase64JsonEnvelope(chunkPayload.ciphertext)) as {
            ciphertext?: string;
          } | null;
          if (unwrapped && typeof unwrapped.ciphertext === "string") {
            chunkCiphertext = unwrapped.ciphertext;
          }
        } catch {
          // Direct AES-GCM bytes.
        }
        return openManifestEnvelope(chunkCiphertext, chunkKey, [
          JSON.stringify([
            "hussh/shared-files/object/v1",
            params.userId,
            libraryId,
            `chunks:${fileId}`,
            String(index),
          ]),
          JSON.stringify([
            "hussh/shared-files/object/v1",
            params.userId,
            libraryId,
            "chunks",
            `${fileId}:${index}`,
          ]),
        ]);
      },
    });
    migratedFiles += 1;
  }

  let migratedWikiPages = 0;
  for (const item of wikiRaw) {
    params.assertCurrent();
    let wikiCiphertext = item.ciphertext ?? "";
    if (!wikiCiphertext && item.page_id) {
      const wikiResp = await ApiService.apiFetch(
        `/api/one/files/migration/wiki/${encodeURIComponent(item.page_id)}`,
        {
          method: "GET",
          cache: "no-store",
          signal: params.signal,
          headers: { Authorization: `Bearer ${params.idToken}` },
        },
      );
      if (wikiResp.ok) {
        const wikiPayload = (await wikiResp.json()) as { ciphertext?: string };
        if (wikiPayload.ciphertext) {
          wikiCiphertext = wikiPayload.ciphertext;
        }
      }
    }
    if (!wikiCiphertext) continue;
    const pageDoc = await decryptManifestJson<{
      page_id?: string;
      title: string;
      folder?: string;
      tldr?: string;
      status_as_of?: string;
      body?: string;
    }>({
      ciphertextB64: wikiCiphertext,
      encryptionKey: masterAes,
      userId: params.userId,
      libraryId,
      namespaces: ["wiki:revisions", "wiki:pages", "wiki"],
      objectId: item.page_id,
    });
    await uploadPodWikiPageIdempotent({
      pageId: pageDoc.page_id || item.page_id,
      title: pageDoc.title,
      folder: pageDoc.folder || "root",
      tldr: pageDoc.tldr || "",
      statusAsOf: pageDoc.status_as_of || "2026-01-01",
      body: pageDoc.body || "",
      signal: params.signal,
    });
    migratedWikiPages += 1;
  }

  return { migratedFiles, migratedWikiPages };
}

async function migrateSharedFilesAndWiki(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  idToken: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ done: boolean; migratedFiles: number; migratedWikiPages: number }> {
  params.assertCurrent();
  const manifestResponse = await ApiService.apiFetch("/api/one/files/migration/manifest", {
    method: "GET",
    cache: "no-store",
    signal: params.signal,
    headers: {
      Authorization: `Bearer ${params.idToken}`,
    },
  });
  params.assertCurrent();
  if (manifestResponse.status === 404) {
    return { done: true, migratedFiles: 0, migratedWikiPages: 0 };
  }
  if (!manifestResponse.ok) {
    return { done: false, migratedFiles: 0, migratedWikiPages: 0 };
  }

  const manifest = (await manifestResponse.json()) as FilesMigrationManifestResponse;
  if (manifest.status === "empty" || manifest.status === "migrated") {
    return { done: true, migratedFiles: 0, migratedWikiPages: 0 };
  }

  let migratedFiles = 0;
  let migratedWikiPages = 0;

  try {
    const libraryResult = await migrateViaSharedLibrary({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      assertCurrent: params.assertCurrent,
      signal: params.signal,
    });
    migratedFiles += libraryResult.migratedFiles;
    migratedWikiPages += libraryResult.migratedWikiPages;
    if (!libraryResult.hadLibrary || (migratedFiles === 0 && migratedWikiPages === 0)) {
      const fallback = await migrateViaManifestFallback({
        userId: params.userId,
        vaultKey: params.vaultKey,
        idToken: params.idToken,
        manifest,
        assertCurrent: params.assertCurrent,
        signal: params.signal,
      });
      migratedFiles += fallback.migratedFiles;
      migratedWikiPages += fallback.migratedWikiPages;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { done: false, migratedFiles, migratedWikiPages };
  }

  const completeResponse = await ApiService.apiFetch("/api/one/files/migration/complete", {
    method: "POST",
    signal: params.signal,
    headers: {
      Authorization: `Bearer ${params.idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      migrated_files: migratedFiles,
      migrated_wiki_pages: migratedWikiPages,
    }),
  });
  if (!completeResponse.ok) {
    return { done: false, migratedFiles, migratedWikiPages };
  }

  clearFilesCache(params.userId);
  if (migratedFiles > 0 || migratedWikiPages > 0) {
    dispatchFilesMigrationCompleted(params.userId);
  }
  return { done: true, migratedFiles, migratedWikiPages };
}

export async function runSharedToAceMigration(
  input: SharedToAceMigrationInput,
): Promise<SharedToAceMigrationResult> {
  const { userId, vaultKey, vaultOwnerToken, signal, force = false } = input;
  if (!userId || !VAULT_KEY_HEX.test(vaultKey) || !vaultOwnerToken) {
    return {
      status: "skipped",
      reason: "vault_locked",
      migratedSessions: 0,
      migratedFiles: 0,
      migratedWikiPages: 0,
    };
  }

  const existingMarker = force
    ? { chat: false, files: false, updatedAt: 0 }
    : readMarker(userId);
  if (existingMarker.chat && existingMarker.files) {
    return {
      status: "skipped",
      reason: "already_migrated_local",
      migratedSessions: 0,
      migratedFiles: 0,
      migratedWikiPages: 0,
    };
  }

  const vaultEpoch = snapshotVaultSessionEpoch();
  const assertCurrent = () =>
    assertMigrationSessionCurrent(userId, vaultKey, vaultEpoch, signal);

  try {
    assertCurrent();
    let hostingMode = input.hostingMode ?? null;
    if (!hostingMode) {
      const status = await ApiService.getPersonalAgentStatus({ signal });
      assertCurrent();
      hostingMode = status?.hostingMode ?? null;
    }
    if (hostingMode !== "hussh_pods") {
      return {
        status: "skipped",
        reason: "not_ace",
        migratedSessions: 0,
        migratedFiles: 0,
        migratedWikiPages: 0,
      };
    }

    const idToken = input.getIdToken
      ? await input.getIdToken()
      : await resolveDefaultIdToken();
    assertCurrent();
    if (!idToken) {
      return {
        status: "skipped",
        reason: "missing_id_token",
        migratedSessions: 0,
        migratedFiles: 0,
        migratedWikiPages: 0,
      };
    }

    const nextMarker: MigrationMarkerState = { ...existingMarker, updatedAt: Date.now() };
    let migratedSessions = 0;
    let migratedFiles = 0;
    let migratedWikiPages = 0;

    if (!nextMarker.chat) {
      const chatResult = await migrateSealedChatSessions({
        userId,
        idToken,
        signal,
        assertCurrent,
      });
      migratedSessions = chatResult.imported;
      if (chatResult.done) {
        nextMarker.chat = true;
      }
    }

    if (!nextMarker.files) {
      const filesResult = await migrateSharedFilesAndWiki({
        userId,
        vaultKey,
        vaultOwnerToken,
        idToken,
        signal,
        assertCurrent,
      });
      migratedFiles = filesResult.migratedFiles;
      migratedWikiPages = filesResult.migratedWikiPages;
      if (filesResult.done) {
        nextMarker.files = true;
      }
    }

    nextMarker.updatedAt = Date.now();
    writeMarker(userId, nextMarker);

    const anyMigrated =
      migratedSessions > 0 || migratedFiles > 0 || migratedWikiPages > 0;
    return {
      status: anyMigrated
        ? "migrated"
        : nextMarker.chat && nextMarker.files
          ? "empty"
          : "failed",
      migratedSessions,
      migratedFiles,
      migratedWikiPages,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        status: "skipped",
        reason: "aborted",
        migratedSessions: 0,
        migratedFiles: 0,
        migratedWikiPages: 0,
      };
    }
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "migration_failed",
      migratedSessions: 0,
      migratedFiles: 0,
      migratedWikiPages: 0,
    };
  }
}

export async function ensureSharedToAceMigration(
  input: SharedToAceMigrationInput,
): Promise<SharedToAceMigrationResult> {
  if (!input.force && hasCompletedSharedToAceMigration(input.userId)) {
    return {
      status: "skipped",
      reason: "already_migrated_local",
      migratedSessions: 0,
      migratedFiles: 0,
      migratedWikiPages: 0,
    };
  }
  const existing = IN_FLIGHT_MIGRATIONS.get(input.userId);
  if (existing) {
    return existing;
  }
  const task = runSharedToAceMigration(input).finally(() => {
    if (IN_FLIGHT_MIGRATIONS.get(input.userId) === task) {
      IN_FLIGHT_MIGRATIONS.delete(input.userId);
    }
  });
  IN_FLIGHT_MIGRATIONS.set(input.userId, task);
  return task;
}
