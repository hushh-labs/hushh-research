/**
 * The key that seals this person's One chat history at rest.
 *
 * Derived in the browser from the unlocked vault key with HKDF-SHA256 and a
 * fixed, versioned label, so the vault key itself never leaves this device. Only
 * the derived key travels, in the `X-Hussh-Chat-Key` header of each chat request.
 * The backend holds it for that request alone, never persists or logs it, and
 * refuses chat history without it.
 *
 * Keep `ONE_CHAT_KEY_LABEL` and the wire prefix in sync with
 * consent-protocol/hushh_mcp/services/chat_key.py.
 */
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { hexToBytes } from "@/lib/vault/passphrase-key";
import { isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

export const ONE_CHAT_KEY_HEADER = "X-Hussh-Chat-Key";
export const ONE_CHAT_KEY_LABEL = "hussh-one-chat-v1";
const WIRE_PREFIX = "hck1.";
const VAULT_KEY_HEX = /^[0-9a-fA-F]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Thrown before any request when there is no unlocked vault key to derive from. */
export class ChatKeyUnavailableError extends Error {
  constructor() {
    super("Unlock your vault to open chat history.");
    this.name = "ChatKeyUnavailableError";
  }
}

/** The `X-Hussh-Chat-Key` value (`hck1.<64 hex>`) for this vault key. */
export async function deriveOneChatKey(vaultKeyHex: string | null | undefined): Promise<string> {
  const vaultKey = String(vaultKeyHex || "").trim();
  if (!VAULT_KEY_HEX.test(vaultKey)) {
    throw new ChatKeyUnavailableError();
  }
  const raw = new Uint8Array(32);
  raw.set(hexToBytes(vaultKey));
  const material = await crypto.subtle.importKey(
    "raw",
    raw,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(ONE_CHAT_KEY_LABEL),
    },
    material,
    256,
  );
  raw.fill(0);
  return `${WIRE_PREFIX}${toHex(new Uint8Array(bits))}`;
}

/** Request headers that carry this vault's chat key. */
export async function oneChatKeyHeaders(
  vaultKeyHex: string | null | undefined,
): Promise<Record<string, string>> {
  return { [ONE_CHAT_KEY_HEADER]: await deriveOneChatKey(vaultKeyHex) };
}

// ── Refusal lifecycle ───────────────────────────────────────────────────────
//
// The server refuses chat history with 403 CHAT_KEY_REQUIRED (no usable key
// reached it) or CHAT_KEY_MISMATCH (the key did not open the record). Either way
// this vault session cannot be trusted for chat, and retrying the same request
// cannot change the answer. Chat is treated as locked instead: vault custody is
// cleared so the person unlocks again and the key is derived afresh.

export type ChatKeyRefusalCode = "CHAT_KEY_REQUIRED" | "CHAT_KEY_MISMATCH" | "CHAT_KEY_INVALID";
const REFUSAL_CODES: readonly ChatKeyRefusalCode[] = [
  "CHAT_KEY_REQUIRED",
  "CHAT_KEY_MISMATCH",
  "CHAT_KEY_INVALID",
];

/**
 * - `unlock`: chat was locked; the person is being asked to unlock again.
 * - `exhausted`: a fresh unlock already happened and chat still refused, so
 *   locking again would only trap the person in an unlock loop.
 * - `stale`: the refusal belongs to a vault session that has already ended.
 */
export type ChatKeyRecovery = "unlock" | "exhausted" | "stale";

const RECOVERY_COPY: Record<ChatKeyRecovery, (code: ChatKeyRefusalCode) => string> = {
  unlock: () => "Unlock your vault to continue. Your message is kept and is sent once you unlock.",
  stale: () => "Your vault session changed. Unlock your vault, then try again.",
  exhausted: (code) =>
    code === "CHAT_KEY_MISMATCH"
      ? "Your chat history did not open with this vault. Start a new chat, or reload the page and unlock again."
      : "One still could not open your chat history. Reload the page, then unlock your vault.",
};

export class ChatKeyRefusalError extends Error {
  constructor(
    readonly code: ChatKeyRefusalCode,
    readonly recovery: ChatKeyRecovery,
  ) {
    super(RECOVERY_COPY[recovery](code));
    this.name = "ChatKeyRefusalError";
  }
}

export function isChatKeyRefusal(error: unknown): error is ChatKeyRefusalError {
  return error instanceof ChatKeyRefusalError;
}

/** The chat-key refusal code in a response body or transport message, if any. */
export function chatKeyRefusalCode(value: unknown): ChatKeyRefusalCode | null {
  if (typeof value === "string") {
    return REFUSAL_CODES.find((code) => value.includes(code)) ?? null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { code?: unknown; detail?: unknown };
  if (typeof record.code === "string") {
    const code = REFUSAL_CODES.find((candidate) => candidate === record.code);
    if (code) return code;
  }
  return record.detail && typeof record.detail === "object" ? chatKeyRefusalCode(record.detail) : null;
}

export const CHAT_KEY_LOCK_REQUESTED_REASON = "CHAT_KEY_REFUSED";
const forcedUnlockOwners = new Set<string>();

function currentOwnerId(): string {
  return snapshotValidatedAuthSessionOwner()?.userId ?? "";
}

/**
 * Route one refusal. The first for this owner locks the vault (the existing
 * `vault-lock-requested` path, which clears key and token together) so the app
 * shows its unlock flow. After that fresh unlock, a second refusal is
 * `exhausted` and never locks again until chat is accepted once more.
 * `vaultEpoch` is the vault session the refused request started in: a late
 * refusal from an earlier session never locks the current one.
 */
export function routeChatKeyRefusal(code: ChatKeyRefusalCode, vaultEpoch: number): ChatKeyRefusalError {
  if (!isVaultSessionEpochCurrent(vaultEpoch)) return new ChatKeyRefusalError(code, "stale");
  const owner = currentOwnerId();
  if (!owner || forcedUnlockOwners.has(owner)) return new ChatKeyRefusalError(code, "exhausted");
  forcedUnlockOwners.add(owner);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("vault-lock-requested", {
      detail: { reason: CHAT_KEY_LOCK_REQUESTED_REASON },
    }));
  }
  return new ChatKeyRefusalError(code, "unlock");
}

/** The server accepted this owner's chat key; a later refusal may lock again. */
export function noteChatKeyAccepted(): void {
  const owner = currentOwnerId();
  if (owner) forcedUnlockOwners.delete(owner);
}
