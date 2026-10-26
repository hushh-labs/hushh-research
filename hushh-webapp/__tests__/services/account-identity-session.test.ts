import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";

const { refreshShadow, writeIdentity, claimPhone, uploadAvatar } = vi.hoisted(() => ({ refreshShadow: vi.fn(), writeIdentity: vi.fn(), claimPhone: vi.fn(), uploadAvatar: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { refreshAccountIdentityShadow: refreshShadow, claimAccountPhone: claimPhone, uploadAvatar, createSession: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/lib/services/api-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/api-client")>(),
  apiJson: writeIdentity,
}));

import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

function publishValidatedAuthSessionOwner(owner: string | null) {
  publishValidatedAuthSessionPrincipal(owner ? { firebaseUid: owner, ownerId: owner, accountGeneration: 0 } : null);
}

// Exercise the actual response/cache boundary used by post-Google admission.
describe("account identity session admission", () => {
  beforeEach(() => {
    publishValidatedAuthSessionOwner("owner-a");
    refreshShadow.mockReset();
    writeIdentity.mockReset();
    claimPhone.mockReset();
    uploadAvatar.mockReset();
    AccountIdentityService.invalidateCachedIdentity("owner-a");
    AccountIdentityService.invalidateCachedIdentity("owner-b");
  });
  afterEach(() => publishValidatedAuthSessionOwner(null));

  it("keeps an avatar save eligible during token refresh and reconciles its delayed old phone snapshot", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let finishToken!: (token: string) => void;
    let finishAvatar!: (payload: object) => void;
    const user = { uid: "owner-a", getIdToken: vi.fn()
      .mockReturnValueOnce(new Promise<string>((resolve) => { finishToken = resolve; }))
      .mockResolvedValue("token") } as unknown as User;
    uploadAvatar.mockReturnValueOnce(new Promise((resolve) => { finishAvatar = resolve; }));
    const avatarSave = AccountIdentityService.uploadAvatar(user, "data:image/png;base64,fixture");
    const previous = { user_id: "owner-a", phone_verified: true, phone_number: "+12025550101" };
    refreshShadow.mockResolvedValueOnce(Response.json({ identity: previous }));
    await AccountIdentityService.refreshIdentityForSession("owner-a", "ambient-token");
    finishToken("token");
    await vi.waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(1));
    const current = { ...previous, phone_number: "+12025550102", photo_url: "https://example.test/new.png" };
    claimPhone.mockResolvedValue({ identity: current });
    await AccountIdentityService.claimCurrentUserPhone(user, "phone-token");
    refreshShadow.mockResolvedValueOnce(Response.json({ identity: current }));
    finishAvatar({ identity: { ...previous, photo_url: current.photo_url } });
    await expect(avatarSave).resolves.toEqual(current);
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(current);
  });

  it.each(["refresh", "phone save"])("a delayed identity read cannot overwrite a newer %s in the same session", async (kind) => {
    publishValidatedAuthSessionOwner("owner-a");
    let finish!: (response: Response) => void;
    refreshShadow.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const oldRead = AccountIdentityService.refreshIdentityForSession("owner-a", "old-token");
    const current = { user_id: "owner-a", phone_verified: true, phone_number: "+12025550102" };
    if (kind === "phone save") {
      claimPhone.mockResolvedValue({ identity: current });
      const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token") } as unknown as User;
      await expect(AccountIdentityService.claimCurrentUserPhone(user, "phone-token")).resolves.toEqual(current);
    } else {
      refreshShadow.mockResolvedValueOnce(Response.json({ identity: current }));
      await expect(AccountIdentityService.refreshIdentityForSession("owner-a", "new-token")).resolves.toEqual(current);
    }
    finish(Response.json({ identity: { ...current, phone_number: "+12025550101" } }));
    await expect(oldRead).resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(current);
  });

  it("a committed phone save outranks a read started while that save was pending", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let finishClaim!: (payload: object) => void;
    let finishRead!: (response: Response) => void;
    claimPhone.mockReturnValueOnce(new Promise((resolve) => { finishClaim = resolve; }));
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token") } as unknown as User;
    const save = AccountIdentityService.claimCurrentUserPhone(user, "phone-token");
    await vi.waitFor(() => expect(claimPhone).toHaveBeenCalledTimes(1));
    refreshShadow.mockReturnValueOnce(new Promise<Response>((resolve) => { finishRead = resolve; }));
    const read = AccountIdentityService.refreshIdentityForSession("owner-a", "read-token");
    const current = { user_id: "owner-a", phone_verified: true, phone_number: "+12025550102" };
    finishClaim({ identity: current });
    await expect(save).resolves.toEqual(current);
    finishRead(Response.json({ identity: { ...current, phone_number: "+12025550101" } }));
    await expect(read).resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(current);
  });

  it("rejects a late identity response after logout and login as the same owner", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let finish!: (response: Response) => void;
    refreshShadow.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = AccountIdentityService.refreshIdentityForSession("owner-a", "old-token");
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner-a");
    finish(Response.json({ identity: { user_id: "owner-a", phone_verified: true, phone_number: "+12025550101" } }));
    await expect(pending).resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
  });

  it("does not join an older session's identity request after same-owner login", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let finishOld!: (response: Response) => void;
    refreshShadow.mockReturnValueOnce(new Promise<Response>((resolve) => { finishOld = resolve; }));
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token") } as unknown as User;
    const oldRequest = AccountIdentityService.refreshCurrentUserIdentity(user);
    await vi.waitFor(() => expect(refreshShadow).toHaveBeenCalledTimes(1));
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner-a");
    const current = { user_id: "owner-a", phone_verified: true, phone_number: "+12025550102" };
    refreshShadow.mockResolvedValueOnce(Response.json({ identity: current }));
    const newRequest = AccountIdentityService.refreshCurrentUserIdentity(user);
    finishOld(Response.json({ identity: { ...current, phone_number: "+12025550101" } }));
    await expect(newRequest).resolves.toEqual(current);
    await expect(oldRequest).resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(current);
  });

  it("does not publish another owner's identity through profile synchronization", async () => {
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token") } as unknown as User;
    refreshShadow.mockResolvedValue(Response.json({ identity: { user_id: "owner-b", phone_verified: true, phone_number: "+12025550101" } }));
    await expect(AccountIdentityService.syncCurrentUser(user)).resolves.toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
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

  it.each([
    { success: true, user_id: "owner-b", identity: { user_id: "owner-a", display_name: "Wrong response" } },
    { success: true, user_id: "owner-a", identity: { user_id: "owner-b", display_name: "Wrong identity" } },
    { success: false, user_id: "owner-a", identity: { user_id: "owner-a", display_name: "Unconfirmed" } },
    { success: true, identity: { user_id: "owner-a", display_name: "Unknown subject" } },
  ])("refuses an unconfirmed or mismatched name write before caching: %j", async payload => {
    writeIdentity.mockResolvedValue(payload);
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token-a"), reload: vi.fn() } as unknown as User;
    await expect(AccountIdentityService.updateDisplayName(user, "Requested Name")).rejects.toThrow("verify the name change");
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
    expect(AccountIdentityService.peekCachedIdentity("owner-b")).toBeNull();
    expect(user.reload).not.toHaveBeenCalled();
  });

  it("caches a complete name result only for the confirmed request owner", async () => {
    const identity = { user_id: "owner-a", display_name: "Stored Name", phone_verified: true };
    writeIdentity.mockResolvedValue({ success: true, user_id: "owner-a", identity });
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token-a"), reload: vi.fn().mockResolvedValue(undefined) } as unknown as User;
    await expect(AccountIdentityService.updateDisplayName(user, "Requested Name")).resolves.toEqual(identity);
    expect(AccountIdentityService.peekCachedIdentity("owner-a")?.data).toEqual(identity);
    expect(AccountIdentityService.peekCachedIdentity("owner-b")).toBeNull();
    expect(refreshShadow).not.toHaveBeenCalled();
  });

  it("returns the provider-confirmed name without caching a partial identity", async () => {
    writeIdentity.mockResolvedValue({ success: true, user_id: "owner-a", identity: null,
      display_name: "Committed Name", shadow_sync: "pending" });
    refreshShadow.mockResolvedValue(new Response(null, { status: 503 }));
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token-a"), reload: vi.fn().mockResolvedValue(undefined) } as unknown as User;
    await expect(AccountIdentityService.updateDisplayName(user, "Requested Name"))
      .resolves.toEqual({ user_id: "owner-a", display_name: "Committed Name" });
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
    expect(writeIdentity).toHaveBeenCalledTimes(1);
    expect(user.reload).toHaveBeenCalledTimes(1);
  });

  it("does not leave an older shadow cached after a provider-committed name write", async () => {
    writeIdentity.mockResolvedValue({ success: true, user_id: "owner-a", identity: null,
      display_name: "Committed Name", shadow_sync: "pending" });
    refreshShadow.mockResolvedValue(Response.json({ identity: {
      user_id: "owner-a", display_name: "Old Shadow", phone_verified: true,
    } }));
    const user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("token-a"), reload: vi.fn().mockResolvedValue(undefined) } as unknown as User;
    await expect(AccountIdentityService.updateDisplayName(user, "Requested Name"))
      .resolves.toEqual({ user_id: "owner-a", display_name: "Committed Name" });
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
    expect(refreshShadow).toHaveBeenCalledWith("token-a", { force: true, requireSuccess: true });
    expect(writeIdentity).toHaveBeenCalledTimes(1);
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
    expect(refreshShadow).toHaveBeenCalledWith("native-token", { force: true, requireSuccess: true, verifiedPhoneNumber: user.phoneNumber });
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

  it.each([
    { status: 409, code: "PHONE_ALREADY_VERIFIED", message: "Sign in to that account or use a different phone number" },
    { status: 409, code: "PHONE_VERIFICATION_CHANGED", message: "Request a new code" },
    { status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "Wait a moment and retry" },
  ])("preserves strict phone finalization status $status and code $code without publishing a rejected claim", async ({ status, code, message }) => {
    const user = { uid: "owner-a", phoneNumber: "+12025550101", getIdToken: vi.fn().mockResolvedValue("token-a") } as unknown as User;
    refreshShadow.mockResolvedValue(Response.json({ detail: { code, message: "untrusted server diagnostic" } }, { status }));
    const error = await AccountIdentityService.finalizeNativePhoneVerification(user, user.phoneNumber).catch(failure => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(status);
    expect(apiErrorCode(error)).toBe(code);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("untrusted server diagnostic");
    expect(AccountIdentityService.peekCachedIdentity("owner-a")).toBeNull();
  });
});
