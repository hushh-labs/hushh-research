import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { callSignalContext, digest, openCallSignal, sealCallSignal, verifyCallProof } from "../../lib/direct-messages/call-crypto";
import { canonicalJson, p1363ToDer } from "../../lib/services/owner-pod-crypto";
import type { CommunicationDevice, CallEnvelope, CallProof } from "../../lib/direct-messages/call-crypto";

/** Compile the actual native wire source and prove HPKE + proofs both ways. */
export async function verifyCallingWireInterop() {
  assert.equal(process.platform, "darwin", "CryptoKit interoperability runs on the macOS iOS lane.");
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  const folder = mkdtempSync(path.join(tmpdir(), "hussh-calling-interop-"));
  try {
    const sdk = spawnSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"], { encoding: "utf8" });
    assert.equal(sdk.status, 0, sdk.stderr);
    const deviceCheck = spawnSync("xcrun", ["--sdk", "iphoneos", "swiftc", "-typecheck", "-sdk", sdk.stdout.trim(),
      "-target", "arm64-apple-ios17.0", "ios/App/App/Plugins/CallingWire.swift", "ios/App/App/Plugins/CallingIdentity.swift"], { encoding: "utf8" });
    assert.equal(deviceCheck.status, 0, deviceCheck.stderr);
    const binary = path.join(folder, "calling-wire");
    const compile = spawnSync("swiftc", ["-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
      "ios/App/App/Plugins/CallingWire.swift", "scripts/native/calling-wire-interop.swift", "-o", binary], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr);
    const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const encryption = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const b64 = (value: ArrayBuffer) => Buffer.from(value).toString("base64");
    const spki = async (key: CryptoKey) => b64(await crypto.subtle.exportKey("spki", key));
    const scalar = async (key: CryptoKey) => Buffer.from((await crypto.subtle.exportKey("jwk", key)).d!, "base64url").toString("base64");
    const payload = { keyId: crypto.randomUUID(), publicKey: await spki(encryption.publicKey) };
    const proof: CallProof = { deviceId: "tdv_synthetic_ios", nonce: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 90, signature: "" };
    const bytes = new TextEncoder().encode(canonicalJson(["hussh-communications-command-v1", "synthetic-owner", "register-key",
      proof.deviceId, proof.nonce, proof.expiresAt, await digest(payload)]));
    proof.signature = Buffer.from(p1363ToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing.privateKey, bytes)))).toString("base64");
    const device: CommunicationDevice = { userId: "synthetic-owner", deviceId: proof.deviceId, ...payload,
      signingKey: await spki(signing.publicKey), enrollment: { payload, proof } };
    const context = callSignalContext(crypto.randomUUID(), crypto.randomUUID(), "tdv_synthetic_peer", device.deviceId, "offer", 0);
    const description = { type: "offer" as const, sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill("AB").join(":")}\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ relay\r\n` };
    const envelope = await sealCallSignal(device, context, description);
    const input = path.join(folder, "input.json");
    const output = path.join(folder, "output.json");
    writeFileSync(input, JSON.stringify({ device, context: Buffer.from(canonicalJson(context)).toString("base64"), description,
      signed: { payload, proof }, envelope, encryptionScalar: await scalar(encryption.privateKey), signingScalar: await scalar(signing.privateKey) }));
    const run = spawnSync(binary, [input, output], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(output, "utf8")) as { envelope: CallEnvelope; signed: { payload: typeof payload; proof: CallProof }; fingerprint: string };
    await verifyCallProof(device, "register-key", result.signed.payload, result.signed.proof);
    const identity = { deviceId: device.deviceId, keyId: device.keyId, pair: encryption };
    assert.deepEqual(await openCallSignal(identity, result.envelope, context), description);
    await assert.rejects(openCallSignal(identity, result.envelope, [...context, "other-call"]));
    assert.equal(result.fingerprint, await digest([device.publicKey, "α/🗝", 42]));
    console.log("Swift/browser HPKE, DER proofs, canonical JSON and context rejection passed.");
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
