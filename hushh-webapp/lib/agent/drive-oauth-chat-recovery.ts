"use client";

import type { PendingTextAttachment } from "@/lib/agent/large-text-attachment";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const RESOURCE_KEY = "agent_chat:drive_authorization_recovery:v1";
const HANDOFF_KEY = "one_drive_chat_recovery_handoff_v1";
const RETURN_KEY = "one_drive_chat_recovery_return_v1";
export const DRIVE_CHAT_RECOVERY_RETURN_EVENT = "hushh:drive-chat-recovery-return";
export const DRIVE_CHAT_RECOVERY_TTL_MS = 15 * 60 * 1_000;
const MAX_SNAPSHOT_BYTES = 256 * 1_024;
const ATTEMPT_ID = /^[A-Za-z0-9_-]{16,128}$/;

export type DriveChatRecoveryReason =
  | "web_full_page"
  | "native_oauth"
  | "native_picker";

export type CustomConnectorRecoveryReference = { connectorId: string; revision: string };
function validCustomReference(value: CustomConnectorRecoveryReference | undefined): boolean {
  return value === undefined || Boolean(value && /^custom_[a-f0-9]{32}$/.test(value.connectorId) &&
    /^[a-f0-9-]{36}$/i.test(value.revision));
}

export type DriveChatRecoveryState = {
  conversationId: string | null;
  input: string;
  attachment: PendingTextAttachment | null;
  composerExpanded: boolean;
  scrollTop: number;
  drawerOpen: boolean;
  drawerMode: "chats" | "connections";
};

type DriveChatRecoveryCapsule = {
  version: 1;
  ownerUserId: string;
  attemptId: string;
  reason: DriveChatRecoveryReason;
  createdAt: number;
  expiresAt: number;
  state: DriveChatRecoveryState;
};

type DriveChatRecoveryMarker = {
  version: 1;
  ownerUserId?: string;
  attemptId: string;
  reason: DriveChatRecoveryReason;
  expiresAt: number;
  customConnector?: CustomConnectorRecoveryReference;
  returnTo?: "connector_settings";
};

function readMarker(key: string): DriveChatRecoveryMarker | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) || "null") as
      Partial<DriveChatRecoveryMarker> | null;
    if (
      !value || value.version !== 1 ||
      !ATTEMPT_ID.test(value.attemptId || "") ||
      !["web_full_page", "native_oauth", "native_picker"].includes(value.reason || "") ||
      !Number.isFinite(value.expiresAt) ||
      (value.expiresAt ?? 0) <= Date.now() || !validCustomReference(value.customConnector)
      || (value.returnTo !== undefined && value.returnTo !== "connector_settings")
    ) return null;
    return value as DriveChatRecoveryMarker;
  } catch {
    return null;
  }
}

/** Opaque correlation only: no draft, owner token, provider code or state. */
export function readDriveChatRecoveryHandoff(): DriveChatRecoveryMarker | null {
  return readMarker(HANDOFF_KEY);
}

/** A Settings OAuth handoff has no Chat draft to recover. Keep only correlation in this tab. */
export function saveCustomConnectorSettingsHandoff(input: {
  ownerUserId: string;
  attemptId: string;
  customConnector: CustomConnectorRecoveryReference;
}): void {
  if (!input.ownerUserId || !input.customConnector || !ATTEMPT_ID.test(input.attemptId) ||
      !validCustomReference(input.customConnector)) {
    throw new Error("Invalid connector sign-in handoff.");
  }
  window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
    version: 1,
    ownerUserId: input.ownerUserId,
    attemptId: input.attemptId,
    reason: "web_full_page",
    expiresAt: Date.now() + DRIVE_CHAT_RECOVERY_TTL_MS,
    customConnector: input.customConnector,
    returnTo: "connector_settings",
  } satisfies DriveChatRecoveryMarker));
  window.sessionStorage.removeItem(RETURN_KEY);
}

/** Called only after an OAuth callback or native opaque return arrives. */
export function markDriveChatRecoveryReturned(input: {
  attemptId: string;
  reason: DriveChatRecoveryReason;
}): boolean {
  if (!ATTEMPT_ID.test(input.attemptId)) return false;
  const handoff = readDriveChatRecoveryHandoff();
  if (input.reason === "web_full_page" && (
    !handoff ||
    handoff.reason !== input.reason ||
    handoff.attemptId !== input.attemptId
  )) return false;
  if (handoff && handoff.attemptId !== input.attemptId) return false;
  if (handoff?.attemptId === input.attemptId && handoff.reason !== input.reason)
    return false;
  const matchingHandoff = handoff?.attemptId === input.attemptId ? handoff : null;
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({
      version: 1,
      ownerUserId: matchingHandoff?.ownerUserId,
      attemptId: input.attemptId,
      reason: input.reason,
      expiresAt: Math.min(matchingHandoff?.expiresAt ?? Infinity, Date.now() + DRIVE_CHAT_RECOVERY_TTL_MS),
    } satisfies DriveChatRecoveryMarker));
    window.dispatchEvent(new Event(DRIVE_CHAT_RECOVERY_RETURN_EVENT));
    return true;
  } catch {
    return false;
  }
}

function validState(value: unknown): value is DriveChatRecoveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DriveChatRecoveryState>;
  const attachment = state.attachment;
  return (
    (state.conversationId === null ||
      (typeof state.conversationId === "string" &&
        state.conversationId.length > 0 &&
        state.conversationId.length <= 256)) &&
    typeof state.input === "string" &&
    typeof state.composerExpanded === "boolean" &&
    typeof state.scrollTop === "number" &&
    Number.isFinite(state.scrollTop) &&
    state.scrollTop >= 0 &&
    state.scrollTop <= 10_000_000 &&
    typeof state.drawerOpen === "boolean" &&
    (state.drawerMode === "chats" || state.drawerMode === "connections") &&
    (attachment === null ||
      (typeof attachment === "object" &&
        typeof attachment.text === "string" &&
        typeof attachment.byteSize === "number" &&
        Number.isSafeInteger(attachment.byteSize) &&
        attachment.byteSize === new TextEncoder().encode(attachment.text).byteLength &&
        typeof attachment.isExpanded === "boolean"))
  );
}

export async function saveDriveChatRecovery(input: {
  ownerUserId: string;
  vaultKey: string;
  attemptId: string;
  reason: DriveChatRecoveryReason;
  state: DriveChatRecoveryState;
  customConnector?: CustomConnectorRecoveryReference;
}): Promise<void> {
  if (
    !input.ownerUserId ||
    !ATTEMPT_ID.test(input.attemptId) ||
    !validState(input.state) || !validCustomReference(input.customConnector)
  ) {
    throw new Error("Invalid Drive chat recovery state.");
  }
  const now = Date.now();
  const capsule: DriveChatRecoveryCapsule = {
    version: 1,
    ownerUserId: input.ownerUserId,
    attemptId: input.attemptId,
    reason: input.reason,
    createdAt: now,
    expiresAt: now + DRIVE_CHAT_RECOVERY_TTL_MS,
    state: input.state,
  };
  if (new TextEncoder().encode(JSON.stringify(capsule)).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("Drive chat recovery draft is too large.");
  }
  // Observable persistence is a precondition for leaving the mounted chat.
  await SecureResourceCacheService.writeRequired({
    userId: input.ownerUserId,
    resourceKey: RESOURCE_KEY,
    value: capsule,
    ttlMs: DRIVE_CHAT_RECOVERY_TTL_MS,
    vaultKey: input.vaultKey,
  });
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
      version: 1,
      ownerUserId: input.ownerUserId,
      attemptId: input.attemptId,
      reason: input.reason,
      expiresAt: capsule.expiresAt,
      ...(input.customConnector ? { customConnector: input.customConnector } : {}),
    } satisfies DriveChatRecoveryMarker));
    window.sessionStorage.removeItem(RETURN_KEY);
  } catch {
    await SecureResourceCacheService.invalidateResource(input.ownerUserId, RESOURCE_KEY);
    throw new Error("Drive chat recovery marker is unavailable.");
  }
}

export async function takeDriveChatRecovery(input: {
  ownerUserId: string;
  vaultKey: string;
}): Promise<DriveChatRecoveryState | null> {
  const returned = readMarker(RETURN_KEY);
  if (!returned || (returned.ownerUserId && returned.ownerUserId !== input.ownerUserId)) {
    return null;
  }
  try { window.sessionStorage.removeItem(RETURN_KEY); } catch { return null; }
  let capsule: DriveChatRecoveryCapsule | null;
  try {
    capsule = await SecureResourceCacheService.take<DriveChatRecoveryCapsule>({
      userId: input.ownerUserId,
      resourceKey: RESOURCE_KEY,
      vaultKey: input.vaultKey,
    });
  } catch {
    // Malformed or undecryptable data is already consumed and cannot arm a
    // navigation or inject content into another owner's chat.
    return null;
  }
  if (
    !capsule ||
    capsule.version !== 1 ||
    capsule.ownerUserId !== input.ownerUserId ||
    capsule.attemptId !== returned.attemptId ||
    capsule.reason !== returned.reason ||
    !ATTEMPT_ID.test(capsule.attemptId) ||
    !["web_full_page", "native_oauth", "native_picker"].includes(capsule.reason) ||
    !Number.isFinite(capsule.createdAt) ||
    !Number.isFinite(capsule.expiresAt) ||
    capsule.createdAt > Date.now() ||
    capsule.expiresAt <= Date.now() ||
    capsule.expiresAt - capsule.createdAt !== DRIVE_CHAT_RECOVERY_TTL_MS ||
    !validState(capsule.state) ||
    new TextEncoder().encode(JSON.stringify(capsule)).byteLength > MAX_SNAPSHOT_BYTES
  ) {
    return null;
  }
  return capsule.state;
}

export async function clearDriveChatRecovery(ownerUserId: string): Promise<void> {
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // The encrypted capsule is cleared independently below.
  }
  await SecureResourceCacheService.invalidateResource(ownerUserId, RESOURCE_KEY);
}
