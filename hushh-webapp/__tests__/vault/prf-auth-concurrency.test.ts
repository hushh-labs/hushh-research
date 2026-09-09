import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateWithPrf,
  WebAuthnCeremonyInProgressError,
} from "@/lib/vault/prf-auth";

describe("PRF passkey ceremony coordination", () => {
  const originalCredentials = navigator.credentials;

  afterEach(() => {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: originalCredentials,
    });
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
        prf: { results: { first: new Uint8Array(32).buffer } },
      }),
    } as unknown as PublicKeyCredential;
    resolveCredential?.(credential);

    await expect(firstAttempt).resolves.toMatchObject({
      credentialId: "AQ==",
    });
  });
});
