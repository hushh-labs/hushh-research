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
import { hexToBytes } from "@/lib/vault/passphrase-key";

export const ONE_CHAT_KEY_HEADER = "X-Hussh-Chat-Key";
export const ONE_CHAT_KEY_LABEL = "hussh-one-chat-v1";
const WIRE_PREFIX = "hck1.";
const VAULT_KEY_HEX = /^[0-9a-fA-F]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** The `X-Hussh-Chat-Key` value (`hck1.<64 hex>`) for this vault key. */
export async function deriveOneChatKey(vaultKeyHex: string | null | undefined): Promise<string> {
  const vaultKey = String(vaultKeyHex || "").trim();
  if (!VAULT_KEY_HEX.test(vaultKey)) {
    throw new Error("Unlock your vault to open chat history.");
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
