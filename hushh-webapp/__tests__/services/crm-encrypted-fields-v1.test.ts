import { describe, expect, it } from "vitest";

import {
  CRM_ENCRYPTED_FIELDS_V1_PROFILE,
  createCrmEncryptedFieldsEnvelope,
  discardCrmEncryptedFieldsEphemeralKey,
} from "@/lib/connected-systems/crm-encrypted-fields-v1";
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function joined(ciphertext: string, tag: string): ArrayBuffer {
  const left = base64ToBytes(ciphertext);
  const right = base64ToBytes(tag);
  const value = new Uint8Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return arrayBuffer(value);
}

describe("crm-encrypted-fields.v1 browser envelope", () => {
  it("uses X25519 then direct SHA-256 and AES-GCM without AAD", async () => {
    const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
    const partner = await crypto.subtle.generateKey(x25519, true, ["deriveBits"]) as CryptoKeyPair;
    const publicKey = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", partner.publicKey)),
    );
    const envelope = await createCrmEncryptedFieldsEnvelope({
      configuration: {
        profile: CRM_ENCRYPTED_FIELDS_V1_PROFILE,
        configurationRevision: 1,
        recipientKey: { keyId: "mulesoft-uat-1", publicKey },
        keyDerivation: "SHA-256(X25519 shared secret)",
        aad: false,
      },
      direction: "update_request",
      payload: { additionalFields: { Title: "VP Sales" } },
    });
    const clientPublic = await crypto.subtle.importKey(
      "raw", arrayBuffer(base64ToBytes(envelope.clientPublicKey)), x25519, false, [],
    );
    const shared = await crypto.subtle.deriveBits(
      { name: "X25519", public: clientPublic } as unknown as AlgorithmIdentifier,
      partner.privateKey,
      256,
    );
    const digest = await crypto.subtle.digest("SHA-256", shared);
    const wrapKey = await crypto.subtle.importKey(
      "raw", digest, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
    );
    const payloadKeyBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(base64ToBytes(envelope.wrappedKeyIv)) },
      wrapKey,
      joined(envelope.wrappedPayloadKey, envelope.wrappedKeyTag),
    );
    const payloadKey = await crypto.subtle.importKey(
      "raw", payloadKeyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(base64ToBytes(envelope.payloadIv)) },
      payloadKey,
      joined(envelope.ciphertext, envelope.payloadTag),
    );

    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      additionalFields: { Title: "VP Sales" },
    });
    expect(envelope).not.toHaveProperty("aadSha256");
    expect(envelope).not.toHaveProperty("ownerSignature");
    expect(envelope).not.toHaveProperty("recipientKeyFingerprint");
    expect(discardCrmEncryptedFieldsEphemeralKey(envelope.clientOperationId)).toBe(false);
  });

  it("creates fresh keys, operation ids, and IVs for every operation", async () => {
    const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
    const partner = await crypto.subtle.generateKey(x25519, true, ["deriveBits"]) as CryptoKeyPair;
    const configuration = {
      profile: CRM_ENCRYPTED_FIELDS_V1_PROFILE,
      configurationRevision: 1,
      recipientKey: {
        keyId: "mulesoft-uat-1",
        publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", partner.publicKey))),
      },
      keyDerivation: "SHA-256(X25519 shared secret)" as const,
      aad: false as const,
    };
    const first = await createCrmEncryptedFieldsEnvelope({
      configuration, direction: "read_request", payload: { searchFields: { Email: "a@example.test" } },
    });
    const second = await createCrmEncryptedFieldsEnvelope({
      configuration, direction: "read_request", payload: { searchFields: { Email: "a@example.test" } },
    });

    expect(second.clientOperationId).not.toBe(first.clientOperationId);
    expect(second.clientPublicKey).not.toBe(first.clientPublicKey);
    expect(second.wrappedKeyIv).not.toBe(first.wrappedKeyIv);
    expect(second.payloadIv).not.toBe(first.payloadIv);
    expect(discardCrmEncryptedFieldsEphemeralKey(first.clientOperationId)).toBe(true);
    expect(discardCrmEncryptedFieldsEphemeralKey(second.clientOperationId)).toBe(true);
  });
});
