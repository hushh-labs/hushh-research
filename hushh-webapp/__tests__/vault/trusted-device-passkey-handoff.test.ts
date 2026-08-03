import { beforeEach, describe, expect, it, vi } from "vitest";
import handoffVector from "@/__tests__/fixtures/trusted-device-vault-handoff-v1.json";

const mocks = vi.hoisted(() => ({
  getVaultState: vi.fn(),
  unlockVault: vi.fn(),
  assertVaultKeyMatchesState: vi.fn(),
  authenticateWithPrf: vi.fn(),
  wrapExportKeyForConnector: vi.fn(),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getVaultState: mocks.getVaultState,
    unlockVault: mocks.unlockVault,
    assertVaultKeyMatchesState: mocks.assertVaultKeyMatchesState,
  },
}));

vi.mock("@/lib/vault/prf-auth", () => ({
  authenticateWithPrf: mocks.authenticateWithPrf,
}));

vi.mock("@/lib/vault/export-encrypt", () => ({
  wrapExportKeyForConnector: mocks.wrapExportKeyForConnector,
}));

import {
  buildTrustedDevicePasskeyHandoff,
  trustedDeviceVaultHandoffAad,
} from "@/lib/vault/trusted-device-passkey-handoff";

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("trusted-device passkey vault handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses an RP-compatible passkey wrapper and seals the vault key to Hermes", async () => {
    mocks.getVaultState.mockResolvedValue({
      vaultKeyHash: "hash",
      primaryMethod: "generated_default_web_prf",
      wrappers: [
        {
          method: "generated_default_web_prf",
          encryptedVaultKey: "encrypted",
          salt: "salt",
          iv: "iv",
          passkeyCredentialId: "credential",
          passkeyPrfSalt: "prf-salt",
          passkeyRpId: "one.hushh.ai",
        },
      ],
    });
    mocks.authenticateWithPrf.mockResolvedValue({
      vaultKeyHex: "a".repeat(64),
      credentialId: "credential",
    });
    mocks.unlockVault.mockResolvedValue("b".repeat(64));
    mocks.wrapExportKeyForConnector.mockResolvedValue({
      wrappedExportKey: "wrapped",
      wrappedKeyIv: "iv",
      wrappedKeyTag: "tag",
      senderPublicKey: "sender",
    });

    const handoff = await buildTrustedDevicePasskeyHandoff({
      userId: "user-1",
      deviceId: "device-1",
      state: "state-1",
      authorizationId: "authorization-1",
      expiresAt: 123456,
      recipientPublicKey: "recipient",
      hostname: "uat.one.hushh.ai",
      environment: "uat",
    });

    expect(mocks.authenticateWithPrf).toHaveBeenCalledWith(
      "user-1",
      "prf-salt",
      "credential",
      "one.hushh.ai",
    );
    expect(mocks.unlockVault).toHaveBeenCalledWith(
      "a".repeat(64),
      "encrypted",
      "salt",
      "iv",
    );
    expect(mocks.assertVaultKeyMatchesState).toHaveBeenCalledWith(
      expect.objectContaining({ vaultKeyHash: "hash" }),
      "b".repeat(64),
    );
    expect(mocks.wrapExportKeyForConnector).toHaveBeenCalledWith({
      exportKeyHex: "b".repeat(64),
      connectorPublicKey: "recipient",
      additionalData: trustedDeviceVaultHandoffAad({
        state: "state-1",
        authorizationId: "authorization-1",
        deviceId: "device-1",
        userId: "user-1",
        expiresAt: 123456,
        vaultKeyHash: "hash",
        wrapperId: "default",
        rpId: "one.hushh.ai",
        environment: "uat",
        recipientPublicKey: "recipient",
      }),
    });
    expect(handoff).toEqual({
      vault_handoff_wrapped_key: "wrapped",
      vault_handoff_iv: "iv",
      vault_handoff_tag: "tag",
      vault_handoff_sender_public_key: "sender",
      vault_handoff_alg: "X25519-AES256-GCM",
      vault_handoff_vault_key_hash: "hash",
      vault_handoff_wrapper_id: "default",
      vault_handoff_rp_id: "one.hushh.ai",
    });
  });

  it("decrypts the exact RP wrapper selected for the current host", async () => {
    mocks.getVaultState.mockResolvedValue({
      vaultKeyHash: "hash",
      primaryMethod: "generated_default_web_prf",
      wrappers: [
        {
          method: "generated_default_web_prf",
          encryptedVaultKey: "canonical-encrypted",
          salt: "canonical-salt",
          iv: "canonical-iv",
          passkeyCredentialId: "canonical-credential",
          passkeyPrfSalt: "canonical-prf-salt",
          passkeyRpId: "one.hushh.ai",
          passkeyLastUsedAt: 200,
        },
        {
          method: "generated_default_web_prf",
          encryptedVaultKey: "uat-encrypted",
          salt: "uat-salt",
          iv: "uat-iv",
          passkeyCredentialId: "uat-credential",
          passkeyPrfSalt: "uat-prf-salt",
          passkeyRpId: "uat.one.hushh.ai",
          passkeyLastUsedAt: 100,
        },
      ],
    });
    mocks.authenticateWithPrf.mockResolvedValue({
      vaultKeyHex: "a".repeat(64),
      credentialId: "uat-credential",
    });
    mocks.unlockVault.mockResolvedValue("b".repeat(64));
    mocks.wrapExportKeyForConnector.mockResolvedValue({
      wrappedExportKey: "wrapped",
      wrappedKeyIv: "iv",
      wrappedKeyTag: "tag",
      senderPublicKey: "sender",
    });

    await buildTrustedDevicePasskeyHandoff({
      userId: "user-1",
      deviceId: "device-1",
      state: "state-1",
      authorizationId: "authorization-1",
      expiresAt: 123456,
      recipientPublicKey: "recipient",
      hostname: "uat.one.hushh.ai",
      environment: "uat",
    });

    expect(mocks.authenticateWithPrf).toHaveBeenCalledWith(
      "user-1",
      "uat-prf-salt",
      "uat-credential",
      "uat.one.hushh.ai",
    );
    expect(mocks.unlockVault).toHaveBeenCalledWith(
      "a".repeat(64),
      "uat-encrypted",
      "uat-salt",
      "uat-iv",
    );
  });

  it("falls back without starting WebAuthn when no compatible passkey exists", async () => {
    mocks.getVaultState.mockResolvedValue({
      wrappers: [
        {
          method: "passphrase",
          encryptedVaultKey: "encrypted",
          salt: "salt",
          iv: "iv",
        },
      ],
    });

    await expect(
      buildTrustedDevicePasskeyHandoff({
        userId: "user-1",
        deviceId: "device-1",
        state: "state-1",
        authorizationId: "authorization-1",
        expiresAt: 123456,
        recipientPublicKey: "recipient",
        hostname: "uat.one.hushh.ai",
        environment: "uat",
      }),
    ).resolves.toBeNull();
    expect(mocks.authenticateWithPrf).not.toHaveBeenCalled();
  });

  it("binds ciphertext to the one-time authorization and selected wrapper", () => {
    expect(
      trustedDeviceVaultHandoffAad({
        state: "state-1",
        authorizationId: "authorization-1",
        deviceId: "device-1",
        userId: "user-1",
        expiresAt: 123456,
        vaultKeyHash: "hash",
        wrapperId: "wrapper-1",
        rpId: "uat.one.hushh.ai",
        environment: "uat",
        recipientPublicKey: "recipient",
      }),
    ).toBe(
      "hussh-one-trusted-device-vault-handoff-v1|state-1|authorization-1|device-1|user-1|123456|hash|wrapper-1|uat.one.hushh.ai|uat|recipient",
    );
  });

  it("matches the shared browser-to-Hermes X25519 golden vector", async () => {
    const pkcs8Prefix = Uint8Array.from([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
      0x04, 0x22, 0x04, 0x20,
    ]);
    const recipientPrivateRaw = decodeBase64(
      handoffVector.recipient_private_key_b64,
    );
    const recipientPkcs8 = new Uint8Array(
      pkcs8Prefix.length + recipientPrivateRaw.length,
    );
    recipientPkcs8.set(pkcs8Prefix);
    recipientPkcs8.set(recipientPrivateRaw, pkcs8Prefix.length);
    const algorithm = { name: "X25519" } as unknown as AlgorithmIdentifier;
    const recipientPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      arrayBuffer(recipientPkcs8),
      algorithm,
      false,
      ["deriveBits"],
    );
    const senderPublicKey = await crypto.subtle.importKey(
      "raw",
      arrayBuffer(decodeBase64(handoffVector.sender_public_key_b64)),
      algorithm,
      false,
      [],
    );
    const sharedSecret = await crypto.subtle.deriveBits(
      {
        name: "X25519",
        public: senderPublicKey,
      } as unknown as AlgorithmIdentifier,
      recipientPrivateKey,
      256,
    );
    const wrappingKeyBytes = await crypto.subtle.digest(
      "SHA-256",
      sharedSecret,
    );
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      wrappingKeyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const ciphertext = decodeBase64(handoffVector.wrapped_key_b64);
    const tag = decodeBase64(handoffVector.tag_b64);
    const sealed = new Uint8Array(ciphertext.length + tag.length);
    sealed.set(ciphertext);
    sealed.set(tag, ciphertext.length);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: arrayBuffer(decodeBase64(handoffVector.iv_b64)),
        additionalData: new TextEncoder().encode(handoffVector.aad),
      },
      wrappingKey,
      arrayBuffer(sealed),
    );
    const vaultKeyHex = Array.from(new Uint8Array(plaintext))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    expect(vaultKeyHex).toBe(handoffVector.vault_key_hex);
  });
});
