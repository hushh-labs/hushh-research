import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { canonicalJson, p1363ToDer } from "@/lib/services/owner-pod-crypto";
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

export type CallProof = { deviceId: string; nonce: string; expiresAt: number; signature: string };
export type CommunicationDevice = { userId: string; deviceId: string; keyId: string; publicKey: string; signingKey: string;
  enrollment: { payload: { keyId: string; publicKey: string }; proof: CallProof } };
export type CallEnvelope = { algorithm: "HPKE-P256-SHA256-AES256GCM-v1"; deviceId: string; keyId: string; enc: string; ciphertext: string };
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
export async function digest(value: unknown): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

function rawSignature(encoded: string): Uint8Array<ArrayBuffer> {
  const der = base64ToBytes(encoded);
  if (der.length < 8 || der.length > 72 || der[0] !== 48 || der[1] !== der.length - 2 || der[2] !== 2) throw new Error("Invalid device signature.");
  const rLen = der[3]!;
  const sAt = 4 + rLen;
  if (rLen < 1 || rLen > 33 || der[sAt] !== 2 || sAt + 2 + der[sAt + 1]! !== der.length) throw new Error("Invalid device signature.");
  const parts = [der.slice(4, sAt), der.slice(sAt + 2)];
  const raw = new Uint8Array(64);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const integer = part.length === 33 && part[0] === 0 ? part.slice(1) : part;
    if (integer.length > 32) throw new Error("Invalid device signature.");
    raw.set(integer, (index + 1) * 32 - integer.length);
  }
  if (bytesToBase64(p1363ToDer(raw)) !== encoded) throw new Error("Noncanonical device signature.");
  return raw;
}

export async function verifyCallProof(device: CommunicationDevice, operation: string, payload: Record<string, unknown>, proof: CallProof,
  options: { historicalEnrollment?: boolean } = {}): Promise<void> {
  if (proof.deviceId !== device.deviceId || (!options.historicalEnrollment && proof.expiresAt <= Math.floor(Date.now() / 1000))) throw new Error("The call authorization expired.");
  const key = await crypto.subtle.importKey("spki", base64ToBytes(device.signingKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature(proof.signature), bytes([
    "hussh-communications-command-v1", device.userId, operation, proof.deviceId, proof.nonce, proof.expiresAt, await digest(payload),
  ]));
  if (!valid) throw new Error("The call device signature could not be verified.");
}

export async function verifyCommunicationDevices(devices: CommunicationDevice[]): Promise<void> {
  if (!devices.length || devices.length > 40 || new Set(devices.map(device => device.deviceId)).size !== devices.length) throw new Error("The call devices changed.");
  for (const device of devices) {
    if (device.enrollment.payload.keyId !== device.keyId || device.enrollment.payload.publicKey !== device.publicKey) throw new Error("The call key changed.");
    await verifyCallProof(device, "register-key", device.enrollment.payload, device.enrollment.proof, { historicalEnrollment: true });
  }
}

export function callSignalContext(callId: string, conversationId: string, from: string, to: string, kind: "offer" | "answer", sequence: number): unknown[] {
  return ["hussh-call-signal-v1", callId, conversationId, from, to, kind, sequence];
}

/** RFC 9180 single-shot HPKE; every envelope uses a fresh sender context. */
export async function sealCallSignal(device: CommunicationDevice, context: unknown[], description: RTCSessionDescriptionInit): Promise<CallEnvelope> {
  const publicKey = await crypto.subtle.importKey("spki", base64ToBytes(device.publicKey), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const result = await suite.seal({ recipientPublicKey: publicKey, info: bytes(context).buffer }, bytes(description).buffer);
  return { algorithm: "HPKE-P256-SHA256-AES256GCM-v1", deviceId: device.deviceId, keyId: device.keyId,
    enc: bytesToBase64(new Uint8Array(result.enc)), ciphertext: bytesToBase64(new Uint8Array(result.ct)) };
}

export async function openCallSignal(identity: { deviceId: string; keyId: string; pair: CryptoKeyPair }, envelope: CallEnvelope, context: unknown[]): Promise<RTCSessionDescriptionInit> {
  if (envelope.algorithm !== "HPKE-P256-SHA256-AES256GCM-v1" || envelope.deviceId !== identity.deviceId || envelope.keyId !== identity.keyId) throw new Error("This call is for another device.");
  const plaintext = await suite.open({ recipientKey: identity.pair, enc: base64ToBytes(envelope.enc).buffer, info: bytes(context).buffer }, base64ToBytes(envelope.ciphertext).buffer);
  const description = JSON.parse(new TextDecoder().decode(plaintext)) as RTCSessionDescriptionInit;
  if (!["offer", "answer"].includes(description.type) || typeof description.sdp !== "string" || description.sdp.length > 60000
    || !/^a=fingerprint:sha-256 (?:[\dA-F]{2}:){31}[\dA-F]{2}\r?$/im.test(description.sdp)
    || /a=candidate:.* typ (?:host|srflx|prflx)(?: |\r?$)/im.test(description.sdp)) throw new Error("Unsupported or non-relay call description.");
  return description;
}
