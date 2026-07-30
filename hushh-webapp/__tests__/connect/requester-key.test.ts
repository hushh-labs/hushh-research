// @vitest-environment node
//
// This suite exercises the real WebCrypto X25519 + AES-GCM round-trip through
// the production owner-side producers (`export-encrypt.ts`) and the requester's
// unwrap seam (`requester-key.ts`). It must run under the Node environment, not
// jsdom: `crypto.subtle` here is Node's webcrypto, which validates its
// `ArrayBuffer` arguments against Node's realm. Under jsdom, `new Uint8Array()`
// yields a jsdom-realm ArrayBuffer that Node's webcrypto rejects with
// "2nd argument is not instance of ArrayBuffer" — which is exactly why the rest
// of the suite mocks `export-encrypt`. Running in Node keeps one realm end to
// end, so we test the actual crypto instead of a mock.
import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import {
  encryptForExport,
  generateExportKey,
  wrapExportKeyForConnector,
} from "@/lib/vault/export-encrypt";
import {
  CONNECT_REQUESTER_WRAPPING_ALG,
  decryptConnectScopedExportWithPrivateKey,
  type ConnectScopedExportEnvelope,
} from "@/lib/connect/requester-key";

const X25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;

/** Generate a Connect requester keypair (as `ensureConnectRequesterKey` does),
 * returning the private CryptoKey plus the raw base64 public key the owner side
 * wraps to. Keeps the test pure — no IndexedDB (unavailable under jsdom). */
async function makeRequesterKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
}> {
  const pair = (await crypto.subtle.generateKey(X25519, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  return { privateKey: pair.privateKey, publicKey };
}

/** Produce the exact envelope the data-owner's `handleApprove` emits for one
 * granted scope: export key wrapped to the requester's public key, plus the
 * scope value encrypted under that export key. Both halves carry AAD. */
async function ownerSealScope(params: {
  requesterPublicKey: string;
  connectorKeyId: string;
  plaintext: string;
  keyAad: string;
  dataAad: string;
}): Promise<ConnectScopedExportEnvelope> {
  const exportKeyHex = await generateExportKey();
  const data = await encryptForExport(params.plaintext, exportKeyHex, {
    additionalData: params.dataAad,
  });
  const wrapped = await wrapExportKeyForConnector({
    exportKeyHex,
    connectorPublicKey: params.requesterPublicKey,
    connectorKeyId: params.connectorKeyId,
    additionalData: params.keyAad,
  });
  return {
    wrappingAlg: wrapped.wrappingAlg,
    connectorKeyId: wrapped.connectorKeyId,
    wrappedExportKey: wrapped.wrappedExportKey,
    wrappedKeyIv: wrapped.wrappedKeyIv,
    wrappedKeyTag: wrapped.wrappedKeyTag,
    senderPublicKey: wrapped.senderPublicKey,
    keyAdditionalData: params.keyAad,
    ciphertext: data.ciphertext,
    iv: data.iv,
    tag: data.tag,
    dataAdditionalData: params.dataAad,
  };
}

describe("connect requester-key ZK round-trip", () => {
  const connectorKeyId = "connect-req-abc123def456ghijk789";
  const keyAad = `hushh-one-connect-wrapped-key-v1|attr.financial.portfolio.net_worth|${connectorKeyId}`;
  const dataAad = `hushh-one-connect-scoped-export-v1|attr.financial.portfolio.net_worth|${connectorKeyId}`;

  it("recovers a scope value the owner sealed to the requester's public key", async () => {
    const requester = await makeRequesterKeypair();
    const payload = JSON.stringify({
      scope: "attr.financial.portfolio.net_worth",
      value: "1,00,00,000",
      currency: "INR",
    });

    const envelope = await ownerSealScope({
      requesterPublicKey: requester.publicKey,
      connectorKeyId,
      plaintext: payload,
      keyAad,
      dataAad,
    });

    const recovered = await decryptConnectScopedExportWithPrivateKey(
      requester.privateKey,
      envelope,
    );

    expect(JSON.parse(recovered)).toEqual({
      scope: "attr.financial.portfolio.net_worth",
      value: "1,00,00,000",
      currency: "INR",
    });
    expect(envelope.wrappingAlg).toBe(CONNECT_REQUESTER_WRAPPING_ALG);
  });

  it("cannot be decrypted by a different requester key (sealed for someone else)", async () => {
    const requester = await makeRequesterKeypair();
    const attacker = await makeRequesterKeypair();
    const envelope = await ownerSealScope({
      requesterPublicKey: requester.publicKey,
      connectorKeyId,
      plaintext: "secret",
      keyAad,
      dataAad,
    });

    await expect(
      decryptConnectScopedExportWithPrivateKey(attacker.privateKey, envelope),
    ).rejects.toThrow();
  });

  it("rejects a tampered wrapped export key (AEAD integrity)", async () => {
    const requester = await makeRequesterKeypair();
    const envelope = await ownerSealScope({
      requesterPublicKey: requester.publicKey,
      connectorKeyId,
      plaintext: "secret",
      keyAad,
      dataAad,
    });
    // Flip a byte in the wrapped key ciphertext. Decode -> mutate a real byte
    // -> re-encode, so the change always lands on ciphertext. (A naive edit of
    // the final base64 char can hit only padding bits and be a no-op, making
    // the tamper — and this integrity assertion — silently flaky.)
    const rawWrapped = base64ToBytes(envelope.wrappedExportKey);
    rawWrapped[0] ^= 0xff;
    const tampered: ConnectScopedExportEnvelope = {
      ...envelope,
      wrappedExportKey: bytesToBase64(rawWrapped),
    };

    await expect(
      decryptConnectScopedExportWithPrivateKey(requester.privateKey, tampered),
    ).rejects.toThrow();
  });

  it("rejects when the data AAD does not match what the owner bound", async () => {
    const requester = await makeRequesterKeypair();
    const envelope = await ownerSealScope({
      requesterPublicKey: requester.publicKey,
      connectorKeyId,
      plaintext: "secret",
      keyAad,
      dataAad,
    });
    const wrongAad: ConnectScopedExportEnvelope = {
      ...envelope,
      dataAdditionalData: `${dataAad}|tampered`,
    };

    await expect(
      decryptConnectScopedExportWithPrivateKey(requester.privateKey, wrongAad),
    ).rejects.toThrow();
  });

  it("rejects an unsupported wrapping algorithm", async () => {
    const requester = await makeRequesterKeypair();
    const envelope = await ownerSealScope({
      requesterPublicKey: requester.publicKey,
      connectorKeyId,
      plaintext: "secret",
      keyAad,
      dataAad,
    });

    await expect(
      decryptConnectScopedExportWithPrivateKey(requester.privateKey, {
        ...envelope,
        wrappingAlg: "RSA-OAEP",
      }),
    ).rejects.toThrow(/Unsupported wrapping algorithm/);
  });
});
