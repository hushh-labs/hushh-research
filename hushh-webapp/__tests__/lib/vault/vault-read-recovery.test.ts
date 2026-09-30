import { describe, expect, it } from "vitest";
import { isRetryableVaultReadError } from "@/lib/vault/vault-read-recovery";

describe("Vault read availability classification", () => {
  it.each([408, 429, 500, 503, 504])("retries HTTP %s on both transports", (status) => {
    expect(isRetryableVaultReadError({ status })).toBe(true);
    expect(isRetryableVaultReadError(new Error(`HTTP ${status}: unavailable`))).toBe(true);
    expect(isRetryableVaultReadError(new Error(`HTTP ${status}`))).toBe(true);
    expect(isRetryableVaultReadError(new Error(`Failed to check vault: HTTP ${status}: unavailable`))).toBe(true);
  });
  it.each([400, 401, 403, 404])("does not retry HTTP %s", (status) => {
    expect(isRetryableVaultReadError({ status })).toBe(false);
    expect(isRetryableVaultReadError(new Error(`HTTP ${status}: rejected`))).toBe(false);
  });
  it("preserves terminal authentication and invalid metadata failures", () => {
    expect(isRetryableVaultReadError({ code: "AUTH_ACCOUNT_NOT_FOUND", status: 503 })).toBe(false);
    expect(isRetryableVaultReadError(new Error("invalid wrapper"))).toBe(false);
    expect(isRetryableVaultReadError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableVaultReadError({ name: "TimeoutError" })).toBe(true);
    expect(isRetryableVaultReadError({ code: "DATABASE_UNAVAILABLE" })).toBe(true);
  });
});
