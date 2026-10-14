/** Browser-only Files encryption. No key is sent to storage or persisted locally. */
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function unhex(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("FILES_KEY_INVALID");
  return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
}
export async function aes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function wrappingKey(
  vaultKey: string,
  owner: string,
): Promise<CryptoKey> {
  const raw = unhex(vaultKey);
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      buffer(raw),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(`hussh/shared-files/wrap/v1/${owner}`),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    raw.fill(0);
  }
}
export async function seal(
  key: CryptoKey,
  bytes: Uint8Array,
  context: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: buffer(nonce),
        additionalData: new TextEncoder().encode(context),
      },
      key,
      buffer(bytes),
    ),
  );
  const result = new Uint8Array(12 + encrypted.length);
  result.set(nonce);
  result.set(encrypted, 12);
  return bytesToBase64(result);
}
export async function open(
  key: CryptoKey,
  value: string,
  context: string,
): Promise<Uint8Array> {
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length < 28 || bytes.length > 4 * 1024 * 1024 + 128 * 1024)
      throw new Error();
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(bytes.slice(0, 12)),
          additionalData: new TextEncoder().encode(context),
        },
        key,
        buffer(bytes.slice(12)),
      ),
    );
  } catch {
    throw new Error("FILES_INTEGRITY_FAILURE");
  }
}
export async function namesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    buffer(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
export async function opaque(key: CryptoKey, context: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(context)),
    ),
  );
}
export async function chain(
  previous: string,
  content: Uint8Array,
): Promise<string> {
  const data = new Uint8Array(64);
  data.set(unhex(previous));
  data.set(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(content))),
    32,
  );
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
