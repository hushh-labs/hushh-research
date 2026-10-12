import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";

const { refreshShadow } = vi.hoisted(() => ({ refreshShadow: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { refreshAccountIdentityShadow: refreshShadow },
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

  it.each([
    { user_id: "owner-a", phone_verified: true, phone_number: "+12025550101" },
    { user_id: "owner-a", phone_verified: false, phone_number: "+12025550101" },
    { user_id: "owner-a", phone_verified: true, phone_number: "+12025550102" },
    { user_id: "owner-b", phone_verified: true, phone_number: "+12025550101" },
    null,
  ])("native completion requires the exact saved owner and linked phone: %j", async (identity) => {
    const user = { uid: "owner-a", phoneNumber: "+12025550101", getIdToken: vi.fn().mockResolvedValue("native-token") } as unknown as User;
    refreshShadow.mockResolvedValue(Response.json({ identity }));
    const result = AccountIdentityService.finalizeNativePhoneVerification(user, "+12025550101");
    if (identity?.user_id === "owner-a" && identity.phone_verified === true && identity.phone_number === user.phoneNumber) {
      await expect(result).resolves.toBeUndefined();
    } else {
      await expect(result).rejects.toThrow("could not be saved");
    }
    expect(refreshShadow).toHaveBeenCalledWith("native-token", { force: true, requireSuccess: true });
  });

  it("rejects an old linked phone returned for a new verification attempt", async () => {
    const user = { uid: "owner-a", phoneNumber: "+12025550101", getIdToken: vi.fn().mockResolvedValue("native-token") } as unknown as User;
    refreshShadow.mockResolvedValue(Response.json({ identity: { user_id: user.uid, phone_number: user.phoneNumber, phone_verified: true } }));
    await expect(AccountIdentityService.finalizeNativePhoneVerification(user, "+12025550102"))
      .rejects.toThrow("linked phone could not be confirmed");
    expect(refreshShadow).not.toHaveBeenCalled();
  });

  it("does not complete verification from cached identity when strict refresh fails", async () => {
    const identity = { user_id: "owner-a", phone_verified: true, phone_number: "+12025550101" };
    refreshShadow.mockResolvedValueOnce(Response.json({ identity }));
    await AccountIdentityService.refreshIdentityForSession("owner-a", "token-a");
    refreshShadow.mockResolvedValue(new Response(null, { status: 503 }));
    const user = { uid: "owner-a", phoneNumber: identity.phone_number, getIdToken: vi.fn().mockResolvedValue("token-a") } as unknown as User;
    await expect(AccountIdentityService.finalizeNativePhoneVerification(user, identity.phone_number))
      .rejects.toThrow("could not be saved");
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(identity);
  });
});
