// lib/vault/prf-auth.ts

/**
 * PRF-Based Passkey Authentication
 *
 * Uses WebAuthn PRF extension to derive vault encryption keys directly
 * from the passkey/TPM. This provides banking-level security with E2EE.
 *
 * Flow:
 *   Registration: Create passkey → PRF derives secret → Generate vault key
 *   Authentication: Verify passkey → PRF derives same secret → Unlock vault
 *   Fallback: Recovery key unwraps vault key
 *
 * Bible Compliance:
 *   - Zero-knowledge: PRF output never leaves device
 *   - Vault encryption: AES-256-GCM with PRF-derived key
 *   - No localStorage: Vault key only in memory
 */
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { resolvePasskeyRpId } from "@/lib/vault/passkey-rp";

// PRF Support Matrix (as of 2024):
// Chrome + Google Password Manager = ✅ PRF supported
// Edge + Microsoft Password Manager (synced passkeys) = ✅ PRF supported
// Edge/Chrome + Windows Hello = ❌ PRF NOT supported (no hmac-secret)
// Safari + iCloud Keychain (macOS 15+) = ✅ PRF supported
const PRF_SUPPORTED_BROWSERS = ["Chrome", "Edge", "Safari"];

/**
 * Check if current browser supports WebAuthn PRF
 */
export function checkBrowserSupport(): {
  supported: boolean;
  browser: string;
  reason?: string;
  warning?: string;
} {
  const ua = navigator.userAgent;

  // Detect browser
  let browser = "Unknown";
  if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Safari";
  else if (ua.includes("Firefox/")) browser = "Firefox";

  // Check WebAuthn availability
  if (!window.PublicKeyCredential) {
    return { supported: false, browser, reason: "WebAuthn not available" };
  }

  // Check if browser is in supported list
  if (!PRF_SUPPORTED_BROWSERS.includes(browser)) {
    return {
      supported: false,
      browser,
      reason: `${browser} is not supported. Please use Chrome or Edge with synced passkeys.`,
    };
  }

  return { supported: true, browser };
}

/**
 * Check if PRF extension is supported by the authenticator
 */
export async function checkPrfSupport(): Promise<boolean> {
  try {
    // Try to get platform authenticator info
    const available =
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) return false;

    // PRF is supported in Chrome 109+, Edge 109+, Safari 17+
    // We'll verify during registration
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the appropriate RP ID for the current environment
 */
export function getRpId(): string {
  return resolvePasskeyRpId({
    isNative: false,
    hostname: typeof window !== "undefined" ? window.location.hostname : null,
  });
}

/**
 * Generate a random salt for PRF key derivation
 */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Derive vault key from PRF output using HKDF
 */
async function deriveVaultKey(
  prfOutput: ArrayBuffer,
  salt: Uint8Array
): Promise<CryptoKey> {
  // Import PRF output as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  // Derive AES-256-GCM key
  const vaultKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer as ArrayBuffer,
      info: new TextEncoder().encode("hushh-vault-key-v1"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true, // extractable for export to hex
    ["encrypt", "decrypt"]
  );

  return vaultKey;
}

/**
 * Convert CryptoKey to hex string for use in encryption functions
 */
export async function exportKeyToHex(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return Array.from(new Uint8Array(exported))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate recovery key (HRK-XXXX-XXXX-XXXX-XXXX format)
 */
function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Format: HRK-XXXX-XXXX-XXXX-XXXX
  return `HRK-${hex.slice(0, 4).toUpperCase()}-${hex
    .slice(4, 8)
    .toUpperCase()}-${hex.slice(8, 12).toUpperCase()}-${hex
    .slice(12, 16)
    .toUpperCase()}`;
}

/**
 * Wrap vault key with recovery key for backup
 */
async function wrapVaultKey(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{
  wrappedKey: string;
  iv: string;
}> {
  // Derive wrapping key from recovery key
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("hushh-recovery-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"]
  );

  // Wrap the vault key
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKeyBuffer = await crypto.subtle.wrapKey(
    "raw",
    vaultKey,
    wrappingKey,
    { name: "AES-GCM", iv }
  );

  return {
    wrappedKey: bytesToBase64(new Uint8Array(wrappedKeyBuffer)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Unwrap vault key using recovery key
 */
export async function unwrapVaultKey(
  wrappedKey: string,
  iv: string,
  recoveryKey: string
): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  // Derive unwrapping key from recovery key
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const unwrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("hushh-recovery-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["unwrapKey"]
  );

  // Decode wrapped key and IV
  const wrappedKeyBuffer = base64ToBytes(wrappedKey);
  const ivBuffer = base64ToBytes(iv);

  // Unwrap the vault key
  const vaultKey = await crypto.subtle.unwrapKey(
    "raw",
    wrappedKeyBuffer,
    unwrappingKey,
    { name: "AES-GCM", iv: ivBuffer },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  return vaultKey;
}

/**
 * Register a new passkey with PRF extension
 * Returns the vault key and recovery key
 */
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

  // PRF input - used to get deterministic output from passkey
  const prfInput = new TextEncoder().encode(`hushh-vault-prf-${userId}`);

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = getRpId();

  console.log("🔐 Registering passkey with PRF...");
  console.log("  RP ID:", rpId);
  console.log("  User:", displayName);

  const createOptions: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: {
      name: "Hussh",
      id: rpId,
    },
    user: {
      id: new TextEncoder().encode(userId),
      name: displayName,
      displayName: displayName,
    },
    pubKeyCredParams: [
      { alg: -7, type: "public-key" }, // ES256
      { alg: -257, type: "public-key" }, // RS256
    ],
    authenticatorSelection: {
      // Don't specify authenticatorAttachment - let user choose
      // Chrome Password Manager passkeys support PRF (Windows Hello doesn't!)
      userVerification: "required",
      residentKey: "required", // Required for discoverable credentials (passkeys)
    },
    timeout: 120000, // 2 minutes
    extensions: {
      // PRF extension for key derivation
      prf: {
        eval: {
          first: prfInput,
        },
      },
    },
  };

  const credential = (await navigator.credentials.create({
    publicKey: createOptions,
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error("Failed to create passkey");
  }

  // Get PRF output from extension results
   
  const extResults = credential.getClientExtensionResults() as any;
  const prfResult = extResults?.prf?.results?.first;

  if (!prfResult) {
    throw new Error(
      "PRF extension not supported by this authenticator. Please try a different browser or device."
    );
  }

  // Derive vault key from PRF output
  const vaultKey = await deriveVaultKey(prfResult as ArrayBuffer, prfSalt);
  const vaultKeyHex = await exportKeyToHex(vaultKey);

  // Generate recovery key and wrap vault key
  const recoveryKey = generateRecoveryKey();
  const { wrappedKey, iv } = await wrapVaultKey(vaultKey, recoveryKey);

  // Get credential ID
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

/**
 * Authenticate with existing passkey and derive vault key
 */
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

  console.log("🔓 Authenticating with PRF...");
  console.log("  RP ID:", rpId);

  const getOptions: PublicKeyCredentialRequestOptions = {
    challenge,
    rpId: rpId,
    userVerification: "required",
    timeout: 120000, // 2 minutes
    allowCredentials: credentialId
      ? [
          {
            id: base64ToBytes(credentialId),
            type: "public-key",
          },
        ]
      : undefined,
    extensions: {
      // PRF extension for key derivation
      prf: {
        eval: {
          first: prfInput,
        },
      },
    },
  };

  const credential = (await navigator.credentials.get({
    publicKey: getOptions,
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error("Authentication cancelled");
  }

  // Get PRF output
   
  const extResults2 = credential.getClientExtensionResults() as any;
  const prfResult = extResults2?.prf?.results?.first;

  if (!prfResult) {
    throw new Error("PRF extension not available");
  }

  // Derive vault key from PRF output
  const vaultKey = await deriveVaultKey(prfResult as ArrayBuffer, prfSaltBytes);
  const vaultKeyHex = await exportKeyToHex(vaultKey);

  return {
    vaultKeyHex,
    credentialId: bytesToBase64(new Uint8Array(credential.rawId)),
  };
}
