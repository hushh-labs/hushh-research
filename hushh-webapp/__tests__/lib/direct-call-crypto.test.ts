import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callSignalContext, openCallSignal, sealCallSignal, verifyCallProof, digest, type CommunicationDevice } from "@/lib/direct-messages/call-crypto";
import { canonicalJson, p1363ToDer } from "@/lib/services/owner-pod-crypto";
import { bytesToBase64 } from "@/lib/vault/base64";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });

async function device() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const record = { deviceId: "synthetic-device", keyId: crypto.randomUUID(), userId: "synthetic-owner",
    publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
    signingKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", signing.publicKey))) } as CommunicationDevice;
  return { pair, signing, record };
}
const description: RTCSessionDescriptionInit = { type: "offer", sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill("AB").join(":")}\r\na=candidate:1 1 UDP 1 192.0.2.1 443 typ relay\r\n` };

describe("device-bound HPKE signaling", () => {
  it("opens with a nonextractable installation handle and refuses cross-call/recipient substitution", async () => {
    const { pair, record } = await device();
    expect(pair.privateKey.extractable).toBe(false);
    const context = callSignalContext("call", "conversation", "caller", record.deviceId, "offer", 0);
    const envelope = await sealCallSignal(record, context, description);
    const identity = { deviceId: record.deviceId, keyId: record.keyId, pair };
    expect(await openCallSignal(identity, envelope, context)).toEqual(description);
    await expect(openCallSignal(identity, envelope, [...context.slice(0, 1), "other-call", ...context.slice(2)])).rejects.toThrow();
    await expect(openCallSignal({ ...identity, deviceId: "foreign-device" }, envelope, context)).rejects.toThrow("another device");
    await expect(openCallSignal(identity, { ...envelope, ciphertext: "AAAA" + envelope.ciphertext.slice(4) }, context)).rejects.toThrow();
  });

  it("uses independent single-shot contexts for concurrent seals and rejects host candidates", async () => {
    const { pair, record } = await device();
    const context = callSignalContext("call", "conversation", "caller", record.deviceId, "offer", 0);
    const sealed = await Promise.all([sealCallSignal(record, context, description), sealCallSignal(record, context, description)]);
    expect(sealed[0]!.enc).not.toBe(sealed[1]!.enc);
    const invalid = await sealCallSignal(record, context, { ...description, sdp: description.sdp!.replace("typ relay", "typ host") });
    await expect(openCallSignal({ ...record, pair }, invalid, context)).rejects.toThrow("non-relay");
  });

  it("binds canonical signed ciphertext to its owner, operation, nonce and expiration", async () => {
    const { record, signing } = await device();
    const payload = { callId: "synthetic-call", sequence: 1, envelope: { ciphertext: "opaque", label: "हिंदी" } };
    const proof = { deviceId: record.deviceId, nonce: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 90, signature: "" };
    const data = canonicalJson(["hussh-communications-command-v1", record.userId, "signal", proof.deviceId, proof.nonce, proof.expiresAt, await digest(payload)]);
    proof.signature = bytesToBase64(p1363ToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing.privateKey, new TextEncoder().encode(data)))));
    await expect(verifyCallProof(record, "signal", payload, proof)).resolves.toBeUndefined();
    await expect(verifyCallProof(record, "signal", { ...payload, sequence: 2 }, proof)).rejects.toThrow();
    await expect(verifyCallProof({ ...record, userId: "foreign-owner" }, "signal", payload, proof)).rejects.toThrow();
    await expect(verifyCallProof(record, "signal", payload, { ...proof, expiresAt: 0 })).rejects.toThrow("expired");
  });
});
