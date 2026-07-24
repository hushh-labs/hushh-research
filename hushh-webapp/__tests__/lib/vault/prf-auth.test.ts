import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkBrowserSupport,
  checkPrfSupport,
  exportKeyToHex,
  getRpId,
  unwrapVaultKey,
} from "@/lib/vault/prf-auth";
import { bytesToBase64 } from "@/lib/vault/base64";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ORIGINAL_UA = window.navigator.userAgent;
type WindowWithPKC = Window & { PublicKeyCredential?: unknown };
const win = window as WindowWithPKC;
const ORIGINAL_PKC = win.PublicKeyCredential;

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function restoreUserAgent() {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ORIGINAL_UA,
    configurable: true,
  });
}

function setPublicKeyCredential(value: unknown) {
  win.PublicKeyCredential = value;
}

function restorePublicKeyCredential() {
  if (ORIGINAL_PKC === undefined) {
    delete win.PublicKeyCredential;
  } else {
    win.PublicKeyCredential = ORIGINAL_PKC;
  }
}

const RECOVERY_SALT = "hushh-recovery-salt";
const PBKDF2_ITERATIONS = 100_000;

async function deriveWrappingKey(recoveryKey: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(recoveryKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(RECOVERY_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

async function wrapVaultKeyForTest(
  vaultKey: CryptoKey,
  recoveryKey: string
): Promise<{ wrappedKey: string; iv: string }> {
  const wrappingKey = await deriveWrappingKey(recoveryKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedBuffer = await crypto.subtle.wrapKey(
    "raw",
    vaultKey,
    wrappingKey,
    { name: "AES-GCM", iv }
  );
  return {
    wrappedKey: bytesToBase64(new Uint8Array(wrappedBuffer)),
    iv: bytesToBase64(iv),
  };
}

async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  restoreUserAgent();
  restorePublicKeyCredential();
});

// ---------------------------------------------------------------------------
// checkBrowserSupport
// ---------------------------------------------------------------------------

describe("checkBrowserSupport", () => {
  it("returns supported=true for Chrome with WebAuthn available", () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    setPublicKeyCredential({});
    expect(checkBrowserSupport()).toMatchObject({
      supported: true,
      browser: "Chrome",
    });
  });

  it("identifies Edge ahead of Chrome when both tokens are present", () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
    );
    setPublicKeyCredential({});
    expect(checkBrowserSupport()).toMatchObject({
      supported: true,
      browser: "Edge",
    });
  });

  it("identifies Safari only when no Chrome token is present", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    );
    setPublicKeyCredential({});
    expect(checkBrowserSupport()).toMatchObject({
      supported: true,
      browser: "Safari",
    });
  });

  it("returns supported=false with an explanatory reason for Firefox", () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; rv:121.0) Gecko/20100101 Firefox/121.0"
    );
    setPublicKeyCredential({});
    const result = checkBrowserSupport();
    expect(result.supported).toBe(false);
    expect(result.browser).toBe("Firefox");
    expect(result.reason).toMatch(/Firefox/);
  });

  it("returns supported=false for unrecognized user agents", () => {
    setUserAgent("MysteryBot/1.0");
    setPublicKeyCredential({});
    const result = checkBrowserSupport();
    expect(result.supported).toBe(false);
    expect(result.browser).toBe("Unknown");
  });

  it("returns supported=false when WebAuthn (PublicKeyCredential) is missing", () => {
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    );
    delete win.PublicKeyCredential;
    const result = checkBrowserSupport();
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/WebAuthn/);
  });
});

// ---------------------------------------------------------------------------
// checkPrfSupport
// ---------------------------------------------------------------------------

describe("checkPrfSupport", () => {
  it("returns true when a user-verifying platform authenticator is available", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: vi
        .fn()
        .mockResolvedValue(true),
    });
    await expect(checkPrfSupport()).resolves.toBe(true);
  });

  it("returns false when no platform authenticator is available", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: vi
        .fn()
        .mockResolvedValue(false),
    });
    await expect(checkPrfSupport()).resolves.toBe(false);
  });

  it("returns false when the availability probe rejects", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: vi
        .fn()
        .mockRejectedValue(new Error("blocked")),
    });
    await expect(checkPrfSupport()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRpId
// ---------------------------------------------------------------------------

describe("getRpId", () => {
  const ORIGINAL_RP = process.env.NEXT_PUBLIC_PASSKEY_RP_ID;

  afterEach(() => {
    if (ORIGINAL_RP === undefined) {
      delete process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
    } else {
      process.env.NEXT_PUBLIC_PASSKEY_RP_ID = ORIGINAL_RP;
    }
  });

  it("uses NEXT_PUBLIC_PASSKEY_RP_ID when set", () => {
    process.env.NEXT_PUBLIC_PASSKEY_RP_ID = "test.example.com";
    expect(getRpId()).toBe("test.example.com");
  });

  it("normalizes the env var to lowercase", () => {
    process.env.NEXT_PUBLIC_PASSKEY_RP_ID = "Test.Example.COM";
    expect(getRpId()).toBe("test.example.com");
  });

  it("returns a non-empty fallback when the env var is unset", () => {
    delete process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
    const rp = getRpId();
    expect(typeof rp).toBe("string");
    expect(rp.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// exportKeyToHex
// ---------------------------------------------------------------------------

describe("exportKeyToHex", () => {
  it("encodes a 256-bit AES-GCM key as 64 lowercase hex chars", async () => {
    const key = await generateVaultKey();
    const hex = await exportKeyToHex(key);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for a given CryptoKey", async () => {
    const key = await generateVaultKey();
    const first = await exportKeyToHex(key);
    const second = await exportKeyToHex(key);
    expect(first).toBe(second);
  });

  it("produces different hex for independently generated keys", async () => {
    const a = await exportKeyToHex(await generateVaultKey());
    const b = await exportKeyToHex(await generateVaultKey());
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// unwrapVaultKey (recovery flow)
// ---------------------------------------------------------------------------

describe("unwrapVaultKey", () => {
  it("round-trips a key wrapped with the same recovery key to identical bytes", async () => {
    const original = await generateVaultKey();
    const recoveryKey = "HRK-AAAA-BBBB-CCCC-DDDD";
    const { wrappedKey, iv } = await wrapVaultKeyForTest(original, recoveryKey);

    const unwrapped = await unwrapVaultKey(wrappedKey, iv, recoveryKey);

    expect(await exportKeyToHex(unwrapped)).toBe(
      await exportKeyToHex(original)
    );
  });

  it("rejects when the recovery key is wrong (AES-GCM auth tag mismatch)", async () => {
    const key = await generateVaultKey();
    const { wrappedKey, iv } = await wrapVaultKeyForTest(
      key,
      "HRK-RIGHT-AAAA-BBBB-CCCC"
    );
    await expect(
      unwrapVaultKey(wrappedKey, iv, "HRK-WRONG-AAAA-BBBB-CCCC")
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects when the IV is tampered with", async () => {
    const key = await generateVaultKey();
    const recoveryKey = "HRK-AAAA-BBBB-CCCC-DDDD";
    const { wrappedKey, iv } = await wrapVaultKeyForTest(key, recoveryKey);

    const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
    ivBytes[0] = (ivBytes[0] ?? 0) ^ 0x01;
    const tamperedIv = btoa(String.fromCharCode(...ivBytes));

    await expect(
      unwrapVaultKey(wrappedKey, tamperedIv, recoveryKey)
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects when the wrapped ciphertext is tampered with", async () => {
    const key = await generateVaultKey();
    const recoveryKey = "HRK-AAAA-BBBB-CCCC-DDDD";
    const { wrappedKey, iv } = await wrapVaultKeyForTest(key, recoveryKey);

    const wrapBytes = Uint8Array.from(atob(wrappedKey), (c) => c.charCodeAt(0));
    wrapBytes[0] = (wrapBytes[0] ?? 0) ^ 0x01;
    const tamperedWrapped = btoa(String.fromCharCode(...wrapBytes));

    await expect(
      unwrapVaultKey(tamperedWrapped, iv, recoveryKey)
    ).rejects.toBeInstanceOf(Error);
  });
});