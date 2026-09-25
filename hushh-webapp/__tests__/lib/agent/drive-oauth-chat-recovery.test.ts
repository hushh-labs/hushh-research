import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRIVE_CHAT_RECOVERY_TTL_MS,
  markDriveChatRecoveryReturned,
  readDriveChatRecoveryHandoff,
  saveCustomConnectorSettingsHandoff,
  saveDriveChatRecovery,
  takeDriveChatRecovery,
  type DriveChatRecoveryState,
} from "@/lib/agent/drive-oauth-chat-recovery";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const vaultKey = "ab".repeat(32);
const attemptId = "synthetic-drive-attempt-id";
let sequence = 0;
const owner = () => `drive-recovery-owner-${++sequence}`;
const state: DriveChatRecoveryState = {
  conversationId: "selected-conversation-id",
  input: "Private unsent draft",
  attachment: { text: "Private pasted attachment", byteSize: 25, isExpanded: false },
  composerExpanded: true,
  scrollTop: 220,
  drawerOpen: true,
  drawerMode: "connections",
};

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("Drive chat recovery capsule", () => {
  it("keeps a Settings sign-in handoff owner-bound without inventing a Chat draft", async () => {
    const ownerUserId = owner();
    const customConnector = { connectorId: `custom_${"a".repeat(32)}`, revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" };
    saveCustomConnectorSettingsHandoff({ ownerUserId, attemptId, customConnector });
    expect(readDriveChatRecoveryHandoff()).toMatchObject({ ownerUserId, attemptId, customConnector, returnTo: "connector_settings" });
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
    expect(() => saveCustomConnectorSettingsHandoff({ ownerUserId, attemptId: "invalid", customConnector })).toThrow();
  });
  it("encrypts owner-bound chat state and atomically restores it only once", async () => {
    const ownerUserId = owner();
    await saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId, reason: "web_full_page", state,
    });
    const raw = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open("hushh-secure-resource-cache", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction("resource_cache", "readonly");
        const request = transaction.objectStore("resource_cache").get(
          `${ownerUserId}:agent_chat:drive_authorization_recovery:v1`,
        );
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { resolve(request.result); database.close(); };
      };
    });
    expect(JSON.stringify(raw)).not.toContain("Private unsent draft");
    expect(JSON.stringify(raw)).not.toContain("Private pasted attachment");
    // An unrelated same-owner remount cannot consume the saved draft.
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "web_full_page" })).toBe(true);
    expect(await takeDriveChatRecovery({ ownerUserId: owner(), vaultKey })).toBeNull();
    const [first, second] = await Promise.all([
      takeDriveChatRecovery({ ownerUserId, vaultKey }),
      takeDriveChatRecovery({ ownerUserId, vaultKey }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toEqual(state);
  });

  it("fails closed when the encrypted draft is too large or malformed", async () => {
    const ownerUserId = owner();
    await expect(saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId, reason: "native_picker",
      state: { ...state, input: "x".repeat(300_000) },
    })).rejects.toThrow(/too large/);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();

    await saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId, reason: "native_picker", state,
    });
    await SecureResourceCacheService.writeRequired({
      userId: ownerUserId,
      resourceKey: "agent_chat:drive_authorization_recovery:v1",
      value: { version: 1, ownerUserId: "another-owner", state },
      ttlMs: DRIVE_CHAT_RECOVERY_TTL_MS,
      vaultKey,
    });
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "native_picker" })).toBe(true);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
  });

  it("expires after fifteen minutes without restoring stale chat", async () => {
    const ownerUserId = owner();
    const now = Date.now();
    await saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId, reason: "native_oauth", state,
    });
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "native_oauth" })).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now + DRIVE_CHAT_RECOVERY_TTL_MS + 1);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
  });

  it("rejects a native return that reuses the attempt ID for the wrong handoff", async () => {
    const ownerUserId = owner();
    await saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId, reason: "native_oauth", state,
    });
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "native_picker" })).toBe(false);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "native_oauth" })).toBe(true);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toEqual(state);
  });

  it("does not let an older native return consume a newer draft", async () => {
    const ownerUserId = owner();
    await saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId, reason: "native_oauth", state,
    });
    const newerAttemptId = "synthetic-newer-attempt-id";
    await saveDriveChatRecovery({
      ownerUserId, vaultKey, attemptId: newerAttemptId,
      reason: "native_picker", state: { ...state, input: "Newer draft" },
    });
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "native_oauth" })).toBe(false);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toBeNull();
    expect(markDriveChatRecoveryReturned({ attemptId: newerAttemptId, reason: "native_picker" })).toBe(true);
    expect(await takeDriveChatRecovery({ ownerUserId, vaultKey })).toMatchObject({ input: "Newer draft" });
  });

  it("does not disclose or consume the first owner's draft after an account switch", async () => {
    const firstOwner = owner();
    const secondOwner = owner();
    await saveDriveChatRecovery({
      ownerUserId: firstOwner, vaultKey, attemptId, reason: "native_oauth", state,
    });
    expect(markDriveChatRecoveryReturned({ attemptId, reason: "native_oauth" })).toBe(true);
    // Even an identical supplied key cannot bypass the owner-bound cache key
    // or consume the first person's one-use return marker.
    expect(await takeDriveChatRecovery({ ownerUserId: secondOwner, vaultKey })).toBeNull();
    expect(await takeDriveChatRecovery({ ownerUserId: firstOwner, vaultKey })).toEqual(state);
  });
});
