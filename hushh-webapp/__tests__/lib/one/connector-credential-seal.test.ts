/**
 * The connector login seal must match the agent byte for byte (shared golden
 * vector with consent-protocol), open only at the addressed agent under its own
 * label, and refuse any change to the bound metadata or ciphertext.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { base64AnyDecode, base64UrlEncode } from "@/lib/one/ai-selection-seal";
import {
  ConnectorSealError,
  connectorTarget,
  sealConnectorCredential,
  sealConnectorCredentialWithFixedInputs,
  type AuthorizationCodePlaintext,
  type ConnectorCredentialEnvelope,
} from "@/lib/one/connector-credential-seal";
import { canonical, importPrivate } from "./open-ai-selection";

const VECTOR_FILE = path.resolve(process.cwd(), "..", "consent-protocol", "tests", "fixtures", "connector_credential_seal_vector_v1.json");

type Vector = {
  hkdfInfo: string;
  podPrivateKey: string;
  podPublicKey: string;
  ephemeralPrivateKey: string;
  iv: string;
  aad: ConnectorCredentialEnvelope["aad"];
  aadCanonical: string;
  plaintext: AuthorizationCodePlaintext;
  plaintextCanonical: string;
  expectedEnvelope: ConnectorCredentialEnvelope;
  expectedEnvelopeCanonical: string;
};

const vector = JSON.parse(fs.readFileSync(VECTOR_FILE, "utf8")) as Vector;
const buf = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
const X25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
const recipient = { hushhId: vector.aad.hushhId, podKeyId: vector.aad.podKeyId, publicKey: vector.podPublicKey };

/** Opens like the agent, written apart from the sealer, with the label as a parameter. */
async function openAsAgent(envelope: ConnectorCredentialEnvelope, info: string): Promise<string> {
  const agent = await importPrivate(base64AnyDecode(vector.podPrivateKey));
  const epk = base64AnyDecode(envelope.epk);
  const ephemeral = await crypto.subtle.importKey("raw", buf(epk), X25519, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ephemeral } as unknown as AlgorithmIdentifier, agent, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array([...epk, ...base64AnyDecode(vector.podPublicKey)]);
  const keyBytes = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: new TextEncoder().encode(info) }, hkdf, 256);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(base64AnyDecode(envelope.iv)), additionalData: new TextEncoder().encode(canonical(envelope.aad)) },
    key,
    buf(base64AnyDecode(envelope.ct)),
  );
  return new TextDecoder().decode(plaintext);
}

describe("connector credential seal golden vector", () => {
  it("produces the agent's expected envelope byte for byte", async () => {
    expect(canonical(vector.aad)).toBe(vector.aadCanonical);
    expect(canonical(vector.plaintext)).toBe(vector.plaintextCanonical);
    const envelope = await sealConnectorCredentialWithFixedInputs("gmail", vector.plaintext, recipient, {
      ephemeralPrivateKey: base64AnyDecode(vector.ephemeralPrivateKey),
      iv: base64AnyDecode(vector.iv),
      issuedAtMs: vector.aad.issuedAtMs,
      credentialId: vector.aad.credentialId,
    });
    expect(canonical(envelope)).toBe(vector.expectedEnvelopeCanonical);
    expect(envelope).toEqual(vector.expectedEnvelope);
    expect(await openAsAgent(envelope, vector.hkdfInfo)).toBe(vector.plaintextCanonical);
  });
});

describe("connector credential seal", () => {
  it("binds a fresh envelope to the agent, the connector and its own label", async () => {
    const envelope = await sealConnectorCredential("gmail", vector.plaintext, recipient, 1_790_000_000_000);
    expect(envelope.aad).toMatchObject({ purpose: "connector_credential", connectorId: "gmail", provider: "google" });
    expect(envelope.aad.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(envelope)).not.toContain(vector.plaintext.code);
    expect(await openAsAgent(envelope, vector.hkdfInfo)).toBe(canonical(vector.plaintext));
    // Negative controls: another purpose's label, a re-addressed connector, a flipped bit.
    await expect(openAsAgent(envelope, "hussh/ai-selection/v1")).rejects.toThrow();
    await expect(openAsAgent({ ...envelope, aad: { ...envelope.aad, connectorId: "calendar" } }, vector.hkdfInfo)).rejects.toThrow();
    const ct = base64AnyDecode(envelope.ct);
    ct[0] ^= 0x01;
    await expect(openAsAgent({ ...envelope, ct: base64UrlEncode(ct) }, vector.hkdfInfo)).rejects.toThrow();
  });

  it("refuses what the agent would refuse, before sealing", async () => {
    expect(() => connectorTarget("photos")).toThrow(ConnectorSealError);
    await expect(sealConnectorCredential("gmail", { ...vector.plaintext, codeVerifier: "short" }, recipient)).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    await expect(sealConnectorCredential("google_owner_client", vector.plaintext, recipient)).rejects.toMatchObject({ code: "CREDENTIAL_KIND_UNSUPPORTED" });
    await expect(sealConnectorCredential("gmail", vector.plaintext, { ...recipient, publicKey: "AAAA" })).rejects.toMatchObject({ code: "RECIPIENT_INVALID" });
  });
});
