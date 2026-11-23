import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import * as cipher from "@/lib/files/shared/crypto";
import {
  clearFilesCache,
  peekFilesListCache,
  setFilesListCache,
} from "@/lib/files/files-cache";
import { AGENT_CHAT_HISTORY_INVALIDATED_EVENT } from "@/lib/agent/agent-chat-history-events";
import { ApiService } from "@/lib/services/api-service";
import {
  ensureSharedToAceMigration,
  FILES_MIGRATION_COMPLETED_EVENT,
  hasCompletedSharedToAceMigration,
  resetSharedToAceMigrationMarkerForTests,
} from "@/lib/services/shared-to-ace-migration-service";
import { bytesToBase64 } from "@/lib/vault/base64";
import { isOwnerPodRoute } from "@/lib/services/pod-app-access";

const OWNER_ID = "owner-shared-to-ace";
const VAULT_KEY = "12".repeat(32);
const VAULT_TOKEN = "vault-owner-token";
const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";

async function sealTestObject(
  key: CryptoKey,
  ownerId: string,
  libraryId: string,
  namespace: string,
  objectId: string,
  value: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return cipher.seal(
    key,
    bytes,
    JSON.stringify(["hussh/shared-files/object/v1", ownerId, libraryId, namespace, objectId]),
  );
}

describe("Shared to ACE client migration bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSharedToAceMigrationMarkerForTests();
    clearFilesCache(OWNER_ID);
    publishValidatedAuthSessionPrincipal({
      firebaseUid: OWNER_ID,
      ownerId: OWNER_ID,
      accountGeneration: 0,
    });
    vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
    } as never);
  });

  it("allows agent-chat/migration/import in OWNER_POD_ROUTES", () => {
    expect(isOwnerPodRoute("agent-chat/migration/import")).toBe(true);
  });

  it("migrates sealed chat sessions and decrypts/uploads Shared files, chunks, and wiki pages idempotently", async () => {
    const rawMasterKey = new Uint8Array(32).fill(7);
    const wrapKey = await cipher.wrappingKey(VAULT_KEY, OWNER_ID);
    const keyEnvelopeCiphertext = await cipher.seal(
      wrapKey,
      rawMasterKey,
      `hussh/shared-files/key/v1/${OWNER_ID}/${LIBRARY_ID}`,
    );
    const masterAes = await cipher.aes(rawMasterKey);
    const contentKeyBytes = new Uint8Array(32).fill(9);
    const contentKeyHex = cipher.hex(contentKeyBytes);
    const contentAes = await cipher.aes(contentKeyBytes);

    const folderId = "a".repeat(32);
    const fileId = "b".repeat(32);
    const wikiPageId = "wpg_sharednote0001";
    const fileBytes = new TextEncoder().encode("Hushh Recovery Key Material");

    const sealedFolder = await sealTestObject(
      masterAes,
      OWNER_ID,
      LIBRARY_ID,
      "entries",
      folderId,
      {
        id: folderId,
        name: "Vault Backups",
        parent: "root",
        kind: "folder",
        state: "ready",
      },
    );
    const sealedFile = await sealTestObject(
      masterAes,
      OWNER_ID,
      LIBRARY_ID,
      "entries",
      fileId,
      {
        id: fileId,
        name: "recovery.txt",
        originalName: "recovery.txt",
        parent: folderId,
        kind: "file",
        size: fileBytes.byteLength,
        contentKey: contentKeyHex,
        state: "ready",
      },
    );
    const sealedChunk0 = await cipher.seal(
      contentAes,
      fileBytes,
      JSON.stringify(["hussh/shared-files/object/v1", OWNER_ID, LIBRARY_ID, `chunks:${fileId}`, "0"]),
    );
    const sealedWiki = await sealTestObject(
      masterAes,
      OWNER_ID,
      LIBRARY_ID,
      "wiki:revisions",
      wikiPageId,
      {
        page_id: wikiPageId,
        title: "Personal Strategy",
        folder: "root",
        tldr: "Imported from Shared",
        status_as_of: "2026-11-23",
        body: "Keep keys strictly client-side.",
      },
    );

    const sealedSession = {
      app_name: "agent_one",
      user_id: OWNER_ID,
      session_id: "conv-shared-1",
      payload_ciphertext: bytesToBase64(new TextEncoder().encode("opaque-chat-ciphertext")),
      payload_iv: "iv123",
      payload_tag: "tag123",
      payload_algorithm: "aes-256-gcm",
      revision: 3,
      updated_at: "2026-11-22T00:00:00Z",
    };

    const podCalls: Array<{ path: string; method: string; body: unknown }> = [];
    const hubCalls: Array<{ path: string; method: string; body: unknown }> = [];

    vi.spyOn(ApiService, "apiFetch").mockImplementation(async (url, init) => {
      const pathStr = String(url);
      const method = String(init?.method || "GET");
      const parsedBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
      hubCalls.push({ path: pathStr, method, body: parsedBody });

      if (pathStr === "/api/one/agent-chat/migration/sessions") {
        return Response.json({ status: "ready", sessions: [sealedSession], count: 1 });
      }
      if (pathStr === "/api/one/files/migration/manifest") {
        return Response.json({
          status: "ready",
          libraryId: LIBRARY_ID,
          keyEnvelope: { ciphertext: keyEnvelopeCiphertext, generation: "1" },
          folders: [{ id: folderId, ciphertext: sealedFolder, generation: "2" }],
          files: [{ id: fileId, ciphertext: sealedFile, generation: "3" }],
          wiki_pages: [{ page_id: wikiPageId, ciphertext: "", generation: "4" }],
          objects: [],
        });
      }
      if (pathStr === `/api/one/files/migration/wiki/${wikiPageId}`) {
        return Response.json({ page_id: wikiPageId, ciphertext: sealedWiki, generation: "4" });
      }
      if (pathStr === `/api/one/files/migration/file/${fileId}/chunk/0`) {
        return Response.json({ file_id: fileId, index: 0, ciphertext: sealedChunk0, generation: "5" });
      }
      if (pathStr === "/api/one/files/storage") {
        // Trigger manifest fallback cleanly by returning 404 on storage read.
        return Response.json({ detail: { code: "FILES_NOT_FOUND" } }, { status: 404 });
      }
      if (pathStr === "/api/one/files/migration/complete") {
        return Response.json({ status: "migrated" });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    });

    vi.spyOn(ApiService, "ownerPodRequest").mockImplementation(async (routePath, init) => {
      const method = String(init?.method || "GET");
      const parsedBody =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : init?.body instanceof ArrayBuffer
            ? new TextDecoder().decode(new Uint8Array(init.body))
            : null;
      podCalls.push({ path: routePath, method, body: parsedBody });

      if (routePath === "agent-chat/migration/import") {
        return Response.json({ status: "imported", imported: 1, skipped: 0 });
      }
      if (routePath === "files/create") {
        if ((parsedBody as { folder?: boolean })?.folder) {
          return Response.json({
            id: "pod-folder-1",
            name: "Vault Backups",
            originalName: "Vault Backups",
            parent: "root",
            kind: "folder",
            size: 0,
            received: 0,
            receivedHash: "0".repeat(64),
            state: "ready",
            revision: 1,
          });
        }
        return Response.json({
          id: "pod-file-1",
          name: "recovery.txt",
          originalName: "recovery.txt",
          parent: "pod-folder-1",
          kind: "file",
          size: fileBytes.byteLength,
          received: 0,
          receivedHash: "0".repeat(64),
          state: "uploading",
          revision: 1,
        });
      }
      if (routePath.startsWith("files/chunk?")) {
        return Response.json({ ok: true });
      }
      if (routePath === "files/complete") {
        return Response.json({
          id: "pod-file-1",
          name: "recovery.txt",
          originalName: "recovery.txt",
          parent: "pod-folder-1",
          kind: "file",
          size: fileBytes.byteLength,
          received: fileBytes.byteLength,
          receivedHash: "f".repeat(64),
          state: "ready",
          revision: 2,
        });
      }
      if (routePath === "files/wiki/page") {
        return Response.json({ pageId: wikiPageId, revision: 1, staledReceipts: [] });
      }
      return Response.json({ detail: "unexpected" }, { status: 500 });
    });

    setFilesListCache(OWNER_ID, "root", "", false, {
      entries: [],
      cursor: "",
      chunkBytes: 4096,
    });

    const chatEvents: string[] = [];
    const fileEvents: string[] = [];
    window.addEventListener(AGENT_CHAT_HISTORY_INVALIDATED_EVENT, () => chatEvents.push("chat"));
    window.addEventListener(FILES_MIGRATION_COMPLETED_EVENT, () => fileEvents.push("files"));

    const result = await ensureSharedToAceMigration({
      userId: OWNER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: VAULT_TOKEN,
      getIdToken: async () => "firebase-id-token",
    });

    expect(result).toEqual({
      status: "migrated",
      migratedSessions: 1,
      migratedFiles: 1,
      migratedWikiPages: 1,
    });
    expect(hasCompletedSharedToAceMigration(OWNER_ID)).toBe(true);
    expect(peekFilesListCache(OWNER_ID, "root", "", false)).toBeNull();
    expect(chatEvents).toEqual(["chat"]);
    expect(fileEvents).toEqual(["files"]);

    expect(podCalls).toEqual([
      {
        path: "agent-chat/migration/import",
        method: "POST",
        body: { sessions: [sealedSession] },
      },
      {
        path: "files/create",
        method: "POST",
        body: {
          name: "Vault Backups",
          parent: "root",
          size: 0,
          folder: true,
          request_id: `mig-folder-${folderId}`,
        },
      },
      {
        path: "files/create",
        method: "POST",
        body: {
          name: "recovery.txt",
          parent: "pod-folder-1",
          size: fileBytes.byteLength,
          request_id: `mig-file-${fileId}`,
        },
      },
      {
        path: "files/chunk?file_id=pod-file-1&index=0",
        method: "PUT",
        body: "Hushh Recovery Key Material",
      },
      {
        path: "files/complete",
        method: "POST",
        body: { file_id: "pod-file-1" },
      },
      {
        path: "files/wiki/page",
        method: "POST",
        body: {
          page_id: wikiPageId,
          expected_revision: 0,
          title: "Personal Strategy",
          folder: "root",
          tldr: "Imported from Shared",
          status_as_of: "2026-11-23",
          body: "Keep keys strictly client-side.",
          request_id: `mig-wiki-${wikiPageId}`,
        },
      },
    ]);

    expect(hubCalls.at(-1)).toEqual({
      path: "/api/one/files/migration/complete",
      method: "POST",
      body: { migrated_files: 1, migrated_wiki_pages: 1 },
    });

    // Subsequent unlock skips repeat migration automatically via local owner marker.
    const second = await ensureSharedToAceMigration({
      userId: OWNER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: VAULT_TOKEN,
      getIdToken: async () => "firebase-id-token",
    });
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already_migrated_local");
  });

  it("gracefully no-ops on 404 or empty migration manifests without failing", async () => {
    vi.spyOn(ApiService, "apiFetch").mockImplementation(async (url) => {
      if (String(url) === "/api/one/agent-chat/migration/sessions") {
        return Response.json({ detail: "not found" }, { status: 404 });
      }
      if (String(url) === "/api/one/files/migration/manifest") {
        return Response.json({ status: "empty", folders: [], files: [], wiki_pages: [] });
      }
      return Response.json({}, { status: 404 });
    });

    const result = await ensureSharedToAceMigration({
      userId: OWNER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: VAULT_TOKEN,
      getIdToken: async () => "firebase-id-token",
    });

    expect(result).toEqual({
      status: "empty",
      migratedSessions: 0,
      migratedFiles: 0,
      migratedWikiPages: 0,
    });
    expect(hasCompletedSharedToAceMigration(OWNER_ID)).toBe(true);
  });

  it("skips migration when hostingMode is not hussh_pods", async () => {
    vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({
      hostingMode: "byoc",
      state: "active",
    } as never);
    const fetchSpy = vi.spyOn(ApiService, "apiFetch");

    const result = await ensureSharedToAceMigration({
      userId: OWNER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: VAULT_TOKEN,
      getIdToken: async () => "firebase-id-token",
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "not_ace",
      migratedSessions: 0,
      migratedFiles: 0,
      migratedWikiPages: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hasCompletedSharedToAceMigration(OWNER_ID)).toBe(false);
  });
});
