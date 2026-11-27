"use client";

import { parseMainLocationProposal, type MainLocationProposal } from "@/lib/agent/main-chat-location-contract";
import { snapshotValidatedAuthSessionOwner, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { ROUTES } from "@/lib/navigation/routes";
import { canSealOwnerUiCache, deleteEncryptedOwnerUiRecords, readEncryptedOwnerUiRecord, writeEncryptedOwnerUiRecord } from "@/lib/storage/encrypted-owner-ui-cache";
import { isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

const POINTER = "one:location:chat-setup:v1";
const TTL = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namespace = (id: string) => `location-chat-setup:v1:${id}`;
export const LOCATION_CHAT_SETUP_PARAM = "locationChatSetup";
export const LOCATION_CHAT_SETUP_RETURN_PARAM = "locationSetupReturn";
export type LocationChatSetupScope = { ownerId: string; vaultKey: string; vaultEpoch: number };
type Intent = { conversationId: string; messageId: string; proposal: MainLocationProposal };
type Record = Intent & { id: string; expiresAt: number; runtime: string; vaultEpoch: number; authGeneration: number };
type Phase = "intro" | "consent" | "completed" | "cancelled";
type Pointer = { id: string; expiresAt: number; phase: Phase };
let runtime: string | undefined;
let admittedOwner: string | null = null;

function pointer(): Pointer | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(POINTER) ?? "null") as Pointer | null;
    if (value && UUID.test(value.id) && Number.isFinite(value.expiresAt) &&
      value.expiresAt > Date.now() && ["intro", "consent", "completed", "cancelled"].includes(value.phase)) return value;
    const owner = snapshotValidatedAuthSessionOwner()?.userId;
    if (owner && value && UUID.test(value.id)) void deleteEncryptedOwnerUiRecords(owner, namespace(value.id));
    window.sessionStorage.removeItem(POINTER);
  } catch { /* Restricted storage cannot carry a handoff. */ }
  return null;
}

function savePointer(value: Pointer | null) {
  try {
    if (value) window.sessionStorage.setItem(POINTER, JSON.stringify(value));
    else window.sessionStorage.removeItem(POINTER);
    return true;
  } catch { return false; }
}

if (typeof window !== "undefined") {
  subscribeAuthSessionGeneration(() => {
    const next = snapshotValidatedAuthSessionOwner()?.userId ?? null;
    if (admittedOwner && next !== admittedOwner) {
      const active = pointer();
      savePointer(null);
      if (active) void deleteEncryptedOwnerUiRecords(admittedOwner, namespace(active.id));
    }
    admittedOwner = next;
  });
}

function validScope(scope: LocationChatSetupScope) {
  const auth = snapshotValidatedAuthSessionOwner();
  if (auth?.userId !== scope.ownerId || !canSealOwnerUiCache(scope.vaultKey) || !isVaultSessionEpochCurrent(scope.vaultEpoch)) return null;
  admittedOwner = auth.userId;
  runtime ??= crypto.randomUUID();
  return auth;
}

function validChatId(id: string) {
  return typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\s\p{Cc}]/u.test(id);
}

export function getPendingLocationChatSetupId() { return pointer()?.id ?? null; }

export async function beginLocationChatSetup(input: LocationChatSetupScope & Intent): Promise<string | null> {
  const auth = validScope(input);
  const { id, action, people, circles, durationHours, durationMode, direction, conversation } = input.proposal;
  const proposal = parseMainLocationProposal({ type: "location.chat_action", id, action, people, circles, durationHours, durationMode, direction, conversation });
  if (!auth || !proposal?.conversation || proposal.action === "share_pin" || !validChatId(input.conversationId) || !validChatId(input.messageId)) return null;
  const previous = pointer();
  const next: Pointer = { id: crypto.randomUUID(), expiresAt: Date.now() + TTL, phase: "intro" };
  if (!savePointer(next)) return null;
  if (previous) await deleteEncryptedOwnerUiRecords(input.ownerId, namespace(previous.id));
  const scope = { ownerId: input.ownerId, vaultKey: input.vaultKey, namespace: namespace(next.id) };
  const record: Record = { id: next.id, expiresAt: next.expiresAt, runtime: runtime!, vaultEpoch: input.vaultEpoch,
    authGeneration: auth.generation, conversationId: input.conversationId, messageId: input.messageId, proposal };
  await writeEncryptedOwnerUiRecord({ ...scope, value: record });
  if (!(await readEncryptedOwnerUiRecord<Record>(scope)) || validScope(input)?.generation !== auth.generation || pointer()?.id !== next.id) {
    if (pointer()?.id === next.id) savePointer(null);
    await deleteEncryptedOwnerUiRecords(input.ownerId, scope.namespace);
    return null;
  }
  return `${ROUTES.ONE_LOCATION}?${LOCATION_CHAT_SETUP_PARAM}=${next.id}`;
}

async function readHandoff(input: LocationChatSetupScope & { handoffId: string }, consume = false) {
  const active = pointer();
  const auth = validScope(input);
  if (!auth || !active || active.id !== input.handoffId) return null;
  const result = await readEncryptedOwnerUiRecord<Record>({ ownerId: input.ownerId, vaultKey: input.vaultKey, namespace: namespace(active.id), consume });
  const record = result?.value;
  if (validScope(input)?.generation !== auth.generation || pointer()?.id !== active.id) return null;
  // A concurrent one-shot read can lose the record while the winning reader
  // is decrypting it. The winner alone clears the tab pointer.
  if (!record) return null;
  if (record.id !== active.id || record.expiresAt <= Date.now() ||
    (record.runtime === runtime && (record.vaultEpoch !== input.vaultEpoch || record.authGeneration !== auth.generation))) {
    savePointer(null);
    return null;
  }
  return { record, phase: pointer()!.phase };
}

export async function getLocationChatSetupPhase(input: LocationChatSetupScope & { handoffId: string }) {
  return (await readHandoff(input))?.phase ?? null;
}

export async function advanceLocationChatSetup(input: LocationChatSetupScope & { handoffId: string }, phase: Exclude<Phase, "intro">) {
  const current = await readHandoff(input);
  const active = pointer();
  if (!current || !active || active.phase === "cancelled" || active.phase === "completed") return false;
  if (phase === "completed") {
    // The tab pointer controls navigation. Only an owner-sealed settlement
    // records that the Location screen verified the current consent version.
    const receipt = { ownerId: input.ownerId, vaultKey: input.vaultKey, namespace: `${namespace(active.id)}:completed` };
    await writeEncryptedOwnerUiRecord({ ...receipt, value: active.id });
    if ((await readEncryptedOwnerUiRecord<string>(receipt))?.value !== active.id ||
      !validScope(input) || pointer()?.id !== active.id || pointer()?.phase !== active.phase) return false;
  }
  return savePointer({ ...active, phase });
}

export function locationChatSetupReturnUrl(id: string) {
  return UUID.test(id) ? `${ROUTES.HOME}?${LOCATION_CHAT_SETUP_RETURN_PARAM}=${id}` : ROUTES.HOME;
}

export async function consumeLocationChatSetup(input: LocationChatSetupScope & { handoffId: string }): Promise<(Intent & { outcome: "completed" | "cancelled" }) | null> {
  const current = await readHandoff(input, true);
  if (!current) return null;
  savePointer(null);
  const { conversationId, messageId, proposal } = current.record;
  const completed = current.phase === "completed" && (await readEncryptedOwnerUiRecord<string>({
    ownerId: input.ownerId, vaultKey: input.vaultKey, namespace: `${namespace(input.handoffId)}:completed`, consume: true,
  }))?.value === input.handoffId;
  if (!validScope(input)) return null;
  // Back before Finish returns to the thread, without resuming a share.
  return { conversationId, messageId, proposal, outcome: completed ? "completed" : "cancelled" };
}
