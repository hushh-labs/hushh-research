import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshShadow, createdAt } = vi.hoisted(() => ({ refreshShadow: vi.fn(), createdAt: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { refreshAccountIdentityShadow: refreshShadow, getAccountCreatedAt: createdAt },
}));

import { AccountIdentityService } from "@/lib/services/account-identity-service";

// Exercise the actual response/cache boundary used by post-Google admission.
describe("account identity session admission", () => {
  beforeEach(() => {
    refreshShadow.mockReset();
    AccountIdentityService.invalidateCachedIdentity("owner-a");
    AccountIdentityService.invalidateCachedIdentity("owner-b");
  });

  it("resolves and caches the fresh account's explicit unverified claim", async () => {
    const identity = { user_id: "owner-a", phone_verified: false };
    refreshShadow.mockResolvedValue(Response.json({ identity }));
    await expect(AccountIdentityService.refreshIdentityForSession("owner-a", "token-a"))
      .resolves.toEqual(identity);
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(identity);
  });

  it("rejects another owner's response during a token/account switch", async () => {
    refreshShadow.mockResolvedValue(Response.json({
      identity: { user_id: "owner-b", phone_verified: true },
    }));
    await expect(AccountIdentityService.refreshIdentityForSession("owner-a", "token-b"))
      .resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-b")).toBeNull();
  });

  it.each([null, {}, { phone_verified: false }])("keeps a missing or malformed identity unknown: %j", async (identity) => {
    refreshShadow.mockResolvedValue(Response.json({ identity }));
    await expect(AccountIdentityService.refreshIdentityForSession("owner-a", "token-a"))
      .resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
  });

  it("preserves a verified cache record when an identity read fails", async () => {
    AccountIdentityService.primeVerifiedPhoneHint("owner-a", true);
    refreshShadow.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(AccountIdentityService.refreshIdentityForSession("owner-a", "token-a"))
      .resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data.phone_verified).toBe(true);
  });
});

// "Member since" must be Firebase's creation time or unknown, never a guess.
describe("account creation time fallback", () => {
  const user = (uid = "owner-a") => ({ uid, getIdToken: vi.fn(async () => `token-${uid}`) }) as never;

  beforeEach(() => createdAt.mockReset());

  it("returns the backend's Firebase creation time for the signed-in owner", async () => {
    createdAt.mockResolvedValue(Response.json({ user_id: "owner-a", account_created_at: "2024-03-05T10:00:00+00:00" }));
    await expect(AccountIdentityService.getAccountCreatedAt(user())).resolves.toBe("2024-03-05T10:00:00+00:00");
    expect(createdAt).toHaveBeenCalledWith("token-owner-a");
  });

  it.each([
    ["another owner's answer", Response.json({ user_id: "owner-b", account_created_at: "2024-03-05T10:00:00+00:00" })],
    ["a null timestamp", Response.json({ user_id: "owner-a", account_created_at: null })],
    ["an unreadable timestamp", Response.json({ user_id: "owner-a", account_created_at: "yesterday-ish" })],
    ["a failed request", new Response(null, { status: 503 })],
  ])("treats %s as unknown", async (_name, response) => {
    createdAt.mockResolvedValue(response);
    await expect(AccountIdentityService.getAccountCreatedAt(user())).resolves.toBeNull();
  });
});
