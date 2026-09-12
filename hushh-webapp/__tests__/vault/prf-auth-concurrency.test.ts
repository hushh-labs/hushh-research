import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateWithPrf,
  cancelPendingPrfAuthentication,
  WebAuthnCeremonyInProgressError,
} from "@/lib/vault/prf-auth";

// Node's WebCrypto implementation rejects the JSDOM realm's ArrayBuffer in
// newer Node releases. Use a realm-compatible BufferSource for the simulated
// authenticator PRF output; production browsers still return ArrayBuffer.
function nodeWebCryptoArrayBuffer(length = 32): ArrayBuffer {
  const bytes = Buffer.alloc(length);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("PRF passkey ceremony coordination", () => {
  const originalCredentials = navigator.credentials;

  beforeEach(() => {
    // These tests exercise ceremony ownership, not HKDF. Mock the primitive
    // operations so JSDOM's typed-array realm cannot leak into Node WebCrypto.
    vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, "deriveKey").mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, "exportKey").mockResolvedValue(
      nodeWebCryptoArrayBuffer(),
    );
  });

  afterEach(() => {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: originalCredentials,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not abort or replace an active passkey prompt", async () => {
    let resolveCredential: ((credential: PublicKeyCredential) => void) | null =
      null;
    const credentialPromise = new Promise<PublicKeyCredential>((resolve) => {
      resolveCredential = resolve;
    });
    const get = vi.fn(() => credentialPromise);

    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get },
    });

    const firstAttempt = authenticateWithPrf("user-1", "c2FsdA==");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    await expect(
      authenticateWithPrf("user-1", "c2FsdA=="),
    ).rejects.toBeInstanceOf(WebAuthnCeremonyInProgressError);
    expect(get).toHaveBeenCalledTimes(1);

    const credential = {
      rawId: new Uint8Array([1]).buffer,
      getClientExtensionResults: () => ({
        prf: { results: { first: nodeWebCryptoArrayBuffer() } },
      }),
    } as unknown as PublicKeyCredential;
    resolveCredential?.(credential);

    await expect(firstAttempt).resolves.toMatchObject({
      credentialId: "AQ==",
    });
  });

  it("releases an abandoned prompt after the timeout so an explicit retry can run", async () => {
    vi.useFakeTimers();
    const get = vi.fn((options: CredentialRequestOptions) =>
      new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
    );
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get },
    });

    const firstAttempt = authenticateWithPrf("user-1", "c2FsdA==");
    const firstRejection = expect(firstAttempt).rejects.toThrow(
      "Passkey prompt timed out",
    );
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await firstRejection;

    const credential = {
      rawId: new Uint8Array([1]).buffer,
      getClientExtensionResults: () => ({
        prf: { results: { first: nodeWebCryptoArrayBuffer() } },
      }),
    } as unknown as PublicKeyCredential;
    get.mockResolvedValueOnce(credential);

    await expect(authenticateWithPrf("user-1", "c2FsdA==")).resolves.toMatchObject({
      credentialId: "AQ==",
    });
  });

  it("keeps the ceremony lease until a cancelled prompt settles", async () => {
    let rejectCredential: ((error: unknown) => void) | null = null;
    let signal: AbortSignal | undefined;
    const get = vi.fn((options: CredentialRequestOptions) => {
      signal = options.signal;
      return new Promise<PublicKeyCredential>((_resolve, reject) => {
        rejectCredential = reject;
      });
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get },
    });

    const firstAttempt = authenticateWithPrf("user-1", "c2FsdA==");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    expect(cancelPendingPrfAuthentication()).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(cancelPendingPrfAuthentication()).toBe(false);

    await expect(
      authenticateWithPrf("user-1", "c2FsdA=="),
    ).rejects.toBeInstanceOf(WebAuthnCeremonyInProgressError);

    rejectCredential?.(new DOMException("Aborted", "AbortError"));
    await expect(firstAttempt).rejects.toMatchObject({ name: "AbortError" });
  });
});
