/**
 * Test-only opener for the C1 envelope, written separately from the sealer in
 * `lib/one/ai-selection-seal.ts` so a shared bug cannot make both sides agree.
 */
import { base64AnyDecode, type AiSelectionEnvelope } from "@/lib/one/ai-selection-seal";

const X25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
const PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];
const buf = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;

/** Sorted keys, no whitespace. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function importPrivate(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", buf(new Uint8Array([...PKCS8_PREFIX, ...raw])), X25519, false, ["deriveBits"]);
}

/** Open an envelope the way the agent does; throws on any tampering. */
export async function openAsAgent(envelope: AiSelectionEnvelope, agentPrivate: CryptoKey, agentPublicRaw: Uint8Array): Promise<string> {
  const epk = base64AnyDecode(envelope.epk);
  const ephemeral = await crypto.subtle.importKey("raw", buf(epk), X25519, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ephemeral } as unknown as AlgorithmIdentifier, agentPrivate, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const keyBytes = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(new Uint8Array([...epk, ...agentPublicRaw])), info: new TextEncoder().encode("hussh/ai-selection/v1") },
    hkdf,
    256,
  );
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(base64AnyDecode(envelope.iv)), additionalData: new TextEncoder().encode(canonical(envelope.aad)) },
    key,
    buf(base64AnyDecode(envelope.ct)),
  );
  return new TextDecoder().decode(plaintext);
}
