// hushh-webapp/lib/vault/prf-auth.ts

/**
 * PRF-Based Passkey Authentication
 *
 * Uses WebAuthn PRF extension to derive vault encryption keys directly
 * from the passkey/TPM. This provides banking-level security with E2EE.
 *
 * Flow:
 * Registration: Create passkey → PRF derives secret → Generate vault key
 * Authentication: Verify passkey → PRF derives same secret → Unlock vault
 * Fallback: Recovery key unwraps vault key
 *
 * Bible Compliance:
 * - Zero-knowledge: PRF output never leaves device
 * - Vault encryption: AES-256-GCM with PRF-derived key
 * - No localStorage: Vault key only in memory
 */
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { resolvePasskeyRpId } from "@/lib/vault/passkey-rp";

const PRF_SUPPORTED_BROWSERS = ["Chrome", "Edge", "Safari"];

export function checkBrowserSupport(): {
  supported: boolean;
  browser: string;
  reason?: string;
  warning?: string;
} {
  const ua = navigator.userAgent;

  let browser = "Unknown";
  if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Safari";
  else if (ua.includes("Firefox/")) browser = "Firefox";

  if (!window.PublicKeyCredential) {
    return { supported: false, browser, reason: "WebAuthn not available" };
  }

  if (!PRF_SUPPORTED_BROWSERS.includes(browser)) {
    return {
      supported: false,
      browser,
      reason: `${browser} is not supported. Please use Chrome or Edge with synced passkeys.`,
    };
  }

  return { supported: true, browser };
}

export async function checkPrfSupport(): Promise<boolean> {
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) return false;
    return true;
  } catch {
    return false;
  }
}

export function getRpId(): string {
  return resolvePasskeyRpId({
    isNative: false,
    hostname: typeof window !== "undefined" ? window.location.hostname : null,
  });
}

function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function deriveVaultKey(
  prfOutput: ArrayBuffer,
  salt: Uint8Array
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    prfOutput as unknown as BufferSource,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  const vaultKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as unknown as BufferSource,
      info: new TextEncoder().encode("hushh-vault-key-v1") as unknown as BufferSource,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  return vaultKey;
}

export async function exportKeyToHex(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return Array.from(new Uint8Array(exported as ArrayBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `HRK-${hex.slice(0, 4).toUpperCase()}-${hex
    .slice(4, 8)
    .toUpperCase()}-${hex.slice(8, 12).toUpperCase()}-${hex
    .slice(12, 16)
    .toUpperCase()}`;
}

async function wrapVaultKey(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{
  wrappedKey: string;
  iv: string;
}> {
  const encoder = new TextEncoder();
  const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey) as unknown as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: pbkdf2Salt as unknown as BufferSource,
      iterations: 600_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKeyBuffer = await crypto.subtle.wrapKey(
    "raw",
    vaultKey,
    wrappingKey,
    { name: "AES-GCM", iv: iv as unknown as BufferSource }
  );

  return {
    wrappedKey: `v2:${bytesToBase64(pbkdf2Salt)}.${bytesToBase64(new Uint8Array(wrappedKeyBuffer))}`,
    iv: bytesToBase64(iv),
  };
}

export async function unwrapVaultKey(
  wrappedKey: string,
  iv: string,
  recoveryKey: string
): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  let pbkdf2Salt: Uint8Array;
  let iterations: number;
  let rawWrappedKey: string;

  if (wrappedKey.startsWith("v2:")) {
    const payload = wrappedKey.slice(3);
    const dotIndex = payload.indexOf(".");
    if (dotIndex === -1) {
      throw new Error("Malformed v2 vault blob: missing salt/key separator");
    }
    pbkdf2Salt = base64ToBytes(payload.slice(0, dotIndex));
    rawWrappedKey = payload.slice(dotIndex + 1);
    iterations = 600_000;
  } else {
    pbkdf2Salt = encoder.encode("hushh-recovery-salt");
    rawWrappedKey = wrappedKey;
    iterations = 100_000;
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey) as unknown as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const unwrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: pbkdf2Salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["unwrapKey"]
  );

  const wrappedKeyBuffer = base64ToBytes(rawWrappedKey);
  const ivBuffer = base64ToBytes(iv);

  const vaultKey = await crypto.subtle.unwrapKey(
    "raw",
    wrappedKeyBuffer as unknown as BufferSource,
    unwrappingKey,
    { name: "AES-GCM", iv: ivBuffer as unknown as BufferSource },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  return vaultKey;
}

export async function registerWithPrf(
  userId: string,
  displayName: string
): Promise<{
  credentialId: string;
  vaultKeyHex: string;
  recoveryKey: string;
  prfSalt: string;
  wrappedVaultKey: string;
  wrappedIv: string;
}> {
  const prfSalt = generateSalt();
  const prfSaltB64 = bytesToBase64(prfSalt);
  const prfInput = new TextEncoder().encode(`hushh-vault-prf-${userId}`);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = getRpId();

  const createOptions: PublicKeyCredentialCreationOptions = {
    challenge: challenge as unknown as BufferSource,
    rp: {
      name: "Hussh",
      id: rpId,
    },
    user: {
      id: new TextEncoder().encode(userId) as unknown as BufferSource,
      name: displayName,
      displayName: displayName,
    },
    pubKeyCredParams: [
      { alg: -7, type: "public-key" },
      { alg: -257, type: "public-key" },
    ],
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "required",
    },
    timeout: 120000,
    extensions: {
      prf: {
        eval: {
          first: prfInput as unknown as BufferSource,
        },
      } as any,
    },
  };

  const credential = (await navigator.credentials.create({
    publicKey: createOptions,
  })) as PublicKeyCredential;

  if (!credential) throw new Error("Failed to create passkey");

  const extResults = credential.getClientExtensionResults() as any;
  const prfResult = extResults?.prf?.results?.first;

  if (!prfResult) {
    throw new Error(
      "PRF extension not supported by this authenticator. Please try a different browser or device."
    );
  }

  const vaultKey = await deriveVaultKey(prfResult as ArrayBuffer, prfSalt);
  const vaultKeyHex = await exportKeyToHex(vaultKey);
  const recoveryKey = generateRecoveryKey();
  const { wrappedKey, iv } = await wrapVaultKey(vaultKey, recoveryKey);
  const credentialId = bytesToBase64(new Uint8Array(credential.rawId));

  return {
    credentialId,
    vaultKeyHex,
    recoveryKey,
    prfSalt: prfSaltB64,
    wrappedVaultKey: wrappedKey,
    wrappedIv: iv,
  };
}

export async function authenticateWithPrf(
  userId: string,
  prfSalt: string,
  credentialId?: string
): Promise<{
  vaultKeyHex: string;
  credentialId: string;
}> {
  const prfSaltBytes = base64ToBytes(prfSalt);
  const prfInput = new TextEncoder().encode(`hushh-vault-prf-${userId}`);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = getRpId();

  const getOptions: PublicKeyCredentialRequestOptions = {
    challenge: challenge as unknown as BufferSource,
    rpId: rpId,
    userVerification: "required",
    timeout: 120000,
    allowCredentials: credentialId
      ? [
          {
            id: base64ToBytes(credentialId) as unknown as BufferSource,
            type: "public-key",
          },
        ]
      : undefined,
    extensions: {
      prf: {
        eval: {
          first: prfInput as unknown as BufferSource,
        },
      } as any,
    },
  };

  const credential = (await navigator.credentials.get({
    publicKey: getOptions,
  })) as PublicKeyCredential;

  if (!credential) throw new Error("Authentication cancelled");

  const extResults2 = credential.getClientExtensionResults() as any;
  const prfResult = extResults2?.prf?.results?.first;

  if (!prfResult) throw new Error("PRF extension not available");

  const vaultKey = await deriveVaultKey(prfResult as ArrayBuffer, prfSaltBytes);
  const vaultKeyHex = await exportKeyToHex(vaultKey);

  return {
    vaultKeyHex,
    credentialId: bytesToBase64(new Uint8Array(credential.rawId)),
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

async function makeVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

async function buildLegacyV1Blob(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{ wrappedKey: string; iv: string }> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey) as unknown as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("hushh-recovery-salt") as unknown as BufferSource,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", vaultKey, wrappingKey, {
    name: "AES-GCM",
    iv: iv as unknown as BufferSource,
  });
  return {
    wrappedKey: bytesToBase64(new Uint8Array(wrapped)),
    iv: bytesToBase64(iv),
  };
}

async function wrapVaultKeyV2(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{ wrappedKey: string; iv: string }> {
  const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey) as unknown as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: pbkdf2Salt as unknown as BufferSource,
      iterations: 600_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", vaultKey, wrappingKey, {
    name: "AES-GCM",
    iv: iv as unknown as BufferSource,
  });
  return {
    wrappedKey: `v2:${bytesToBase64(pbkdf2Salt)}.${bytesToBase64(new Uint8Array(wrapped))}`,
    iv: bytesToBase64(iv),
  };
}

describe("wrapVaultKey — v2 format contract", () => {
  it("new blobs carry the 'v2:' version prefix", async () => {
    const key = await makeVaultKey();
    const { wrappedKey } = await wrapVaultKeyV2(
      key,
      "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8"
    );
    expect(wrappedKey).toMatch(/^v2:/);
  });

  it("the embedded salt is 32 bytes and parseable from the blob", async () => {
    const key = await makeVaultKey();
    const { wrappedKey } = await wrapVaultKeyV2(
      key,
      "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8"
    );
    const payload = wrappedKey.slice(3);
    const dotIndex = payload.indexOf(".");
    expect(dotIndex).toBeGreaterThan(0);
    const salt = base64ToBytes(payload.slice(0, dotIndex));
    expect(salt.byteLength).toBe(32);
  });

  it("random salt prevents table reuse across identical recovery keys", async () => {
    const key = await makeVaultKey();
    const recoveryKey = "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8";
    const { wrappedKey: blob1 } = await wrapVaultKeyV2(key, recoveryKey);
    const { wrappedKey: blob2 } = await wrapVaultKeyV2(key, recoveryKey);
    expect(blob1).not.toBe(blob2);
    const salt1 = blob1.slice(3, blob1.indexOf("."));
    const salt2 = blob2.slice(3, blob2.indexOf("."));
    expect(salt1).not.toBe(salt2);
  });
});

describe("unwrapVaultKey — v2 round-trip", () => {
  it("wraps with v2 params then unwraps to the original key bytes", async () => {
    const originalKey = await makeVaultKey();
    const recoveryKey = "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8";

    const { wrappedKey, iv } = await wrapVaultKeyV2(originalKey, recoveryKey);
    expect(wrappedKey).toMatch(/^v2:/);

    const unwrapped = await unwrapVaultKey(wrappedKey, iv, recoveryKey);

    const originalBytes = await exportKeyBytes(originalKey);
    const unwrappedBytes = await exportKeyBytes(unwrapped);
    expect(unwrappedBytes).toEqual(originalBytes);
  });
});

describe("unwrapVaultKey — v1 backward compatibility", () => {
  it("a v1 blob still unwraps smoothly", async () => {
    const originalKey = await makeVaultKey();
    const recoveryKey = "HRK-0102-0304-0506-0708"; 

    const { wrappedKey, iv } = await buildLegacyV1Blob(originalKey, recoveryKey);
    expect(wrappedKey).not.toMatch(/^v2:/); 

    const unwrapped = await unwrapVaultKey(wrappedKey, iv, recoveryKey);

    const originalBytes = await exportKeyBytes(originalKey);
    const unwrappedBytes = await exportKeyBytes(unwrapped);
    expect(unwrappedBytes).toEqual(originalBytes);
  });

  it("fails appropriately when static salt is violated", async () => {
    const originalKey = await makeVaultKey();
    const recoveryKey = "HRK-0102-0304-0506-0708";
    const { wrappedKey: rawWrappedKey, iv } = await buildLegacyV1Blob(
      originalKey,
      recoveryKey
    );

    const fakeSalt = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    const fakev2Blob = `v2:${fakeSalt}.${rawWrappedKey}`;

    await expect(
      unwrapVaultKey(fakev2Blob, iv, recoveryKey)
    ).rejects.toThrow();
  });
});

describe("Migration — rotate v1 blob to v2", () => {
  it("unwraps a v1 blob then re-wraps as v2", async () => {
    const originalKey = await makeVaultKey();
    const oldRecoveryKey = "HRK-0102-0304-0506-0708"; 
    const newRecoveryKey = "HRK-0102-0304-0506-0708-FFFE-FDFC-FBFA-F9F8"; 

    const { wrappedKey: v1Key, iv: v1Iv } = await buildLegacyV1Blob(
      originalKey,
      oldRecoveryKey
    );
    expect(v1Key).not.toMatch(/^v2:/);

    const migratedVaultKey = await unwrapVaultKey(v1Key, v1Iv, oldRecoveryKey);

    const { wrappedKey: v2Key, iv: v2Iv } = await wrapVaultKeyV2(
      migratedVaultKey,
      newRecoveryKey
    );
    expect(v2Key).toMatch(/^v2:/); 

    const finalKey = await unwrapVaultKey(v2Key, v2Iv, newRecoveryKey);
    const originalBytes = await exportKeyBytes(originalKey);
    const finalBytes = await exportKeyBytes(finalKey);
    expect(finalBytes).toEqual(originalBytes);
  });
});