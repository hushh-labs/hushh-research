import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly payload?: unknown
    ) {
      super(message);
      this.name = "ApiError";
    }
  }

  return {
    apiJson: vi.fn(),
    ApiError: MockApiError,
  };
});

vi.mock("@/lib/services/api-client", () => ({
  apiJson: mocks.apiJson,
  ApiError: mocks.ApiError,
}));

import { storeUserData } from "@/lib/db";

describe("storeUserData", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("forwards the vault-owner token to the PKM store-domain proxy", async () => {
    mocks.apiJson.mockResolvedValueOnce({ success: true });

    const stored = await storeUserData(
      "firebase-user-123",
      "preferences",
      "ciphertext",
      "iv",
      "tag",
      { vaultOwnerToken: "HCT:vault-owner-token" }
    );

    expect(stored).toBe(true);
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/pkm/store-domain", {
      method: "POST",
      headers: {
        Authorization: "Bearer HCT:vault-owner-token",
      },
      body: JSON.stringify({
        user_id: "firebase-user-123",
        domain: "preferences",
        encrypted_blob: {
          ciphertext: "ciphertext",
          iv: "iv",
          tag: "tag",
          algorithm: "aes-256-gcm",
        },
        summary: {},
      }),
    });
  });

  it("fails closed when no vault-owner token is available", async () => {
    const stored = await storeUserData(
      "firebase-user-123",
      "preferences",
      "ciphertext",
      "iv",
      "tag"
    );

    expect(stored).toBe(false);
    expect(mocks.apiJson).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[db] storeUserData failed: missing vault-owner token"
    );
  });

  it("does not log user ids, domains, or ciphertext on API failure", async () => {
    mocks.apiJson.mockRejectedValueOnce(
      new mocks.ApiError("Forbidden", 403, { detail: "nope" })
    );

    const stored = await storeUserData(
      "firebase-user-123",
      "preferences",
      "ciphertext",
      "iv",
      "tag",
      { vaultOwnerToken: "HCT:vault-owner-token" }
    );

    expect(stored).toBe(false);
    const renderedLogs = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(renderedLogs).toContain("[db] storeUserData failed:");
    expect(renderedLogs).not.toContain("firebase-user-123");
    expect(renderedLogs).not.toContain("preferences");
    expect(renderedLogs).not.toContain("ciphertext");
  });
});
