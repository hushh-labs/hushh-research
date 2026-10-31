import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: (...args: unknown[]) => apiFetch(...args) },
}));

import {
  PlaidVaultError,
  createVaultLinkToken,
  exchangeVaultPublicToken,
  fetchVaultSnapshot,
  redactTokens,
  removeVaultItem,
} from "@/lib/kai/plaid-vault/vault-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("plaid vault client", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("posts each endpoint under /api/kai/plaid/vault with the vault-owner token", async () => {
    apiFetch.mockImplementation(async () => jsonResponse(200, { ok: true }));
    await createVaultLinkToken({ vaultOwnerToken: "HCT:owner", request: { platform: "web", redirect_uri: "https://app/cb" } });
    await exchangeVaultPublicToken({ vaultOwnerToken: "HCT:owner", publicToken: "public-sandbox-abc" });
    await fetchVaultSnapshot({ vaultOwnerToken: "HCT:owner", accessToken: "access-sandbox-abc", transactionsCursor: "c1" });
    await removeVaultItem({ vaultOwnerToken: "HCT:owner", accessToken: "access-sandbox-abc" });

    const calls = apiFetch.mock.calls.map(([path, init]) => ({
      path,
      auth: (init as RequestInit & { headers: Record<string, string> }).headers.Authorization,
      body: JSON.parse(String((init as RequestInit).body)),
    }));
    expect(calls).toEqual([
      { path: "/api/kai/plaid/vault/link-token", auth: "Bearer HCT:owner", body: { platform: "web", redirect_uri: "https://app/cb" } },
      { path: "/api/kai/plaid/vault/exchange", auth: "Bearer HCT:owner", body: { public_token: "public-sandbox-abc" } },
      { path: "/api/kai/plaid/vault/snapshot", auth: "Bearer HCT:owner", body: { access_token: "access-sandbox-abc", transactions_cursor: "c1" } },
      { path: "/api/kai/plaid/vault/remove", auth: "Bearer HCT:owner", body: { access_token: "access-sandbox-abc" } },
    ]);
  });

  it("never sends a redirect URI for Android", async () => {
    apiFetch.mockResolvedValue(jsonResponse(200, { link_token: "link-sandbox-1", expiration: "x" }));
    await createVaultLinkToken({ vaultOwnerToken: "HCT:owner", request: { platform: "android", redirect_uri: "https://app/cb" } });
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body))).toEqual({ platform: "android", redirect_uri: null });
  });

  it("sends the local-proof marker only when explicitly requested", async () => {
    apiFetch.mockResolvedValue(jsonResponse(200, { link_token: "link-sandbox-1", expiration: "x" }));
    await createVaultLinkToken({
      vaultOwnerToken: "HCT:owner",
      request: { platform: "ios", redirect_uri: "https://app/cb", sandbox_proof: true },
    });
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body))).toEqual({
      platform: "ios",
      redirect_uri: "https://app/cb",
      sandbox_proof: true,
    });
  });

  it("exchanges exactly once, even when the exchange fails", async () => {
    apiFetch.mockResolvedValue(jsonResponse(502, { detail: "upstream failed for public-sandbox-abc" }));
    const error = await exchangeVaultPublicToken({ vaultOwnerToken: "HCT:owner", publicToken: "public-sandbox-abc" }).catch((e) => e);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(PlaidVaultError);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("public-sandbox-abc");
  });

  it("refuses to call without a vault-owner token", async () => {
    await expect(fetchVaultSnapshot({ vaultOwnerToken: "", accessToken: "access-sandbox-abc" })).rejects.toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("redacts Plaid and vault tokens", () => {
    expect(redactTokens("bad access-production-1234-abcd and HCT:xyz.abc and Bearer abc.def")).toBe(
      "bad [redacted] and [redacted] and [redacted]"
    );
  });
});
