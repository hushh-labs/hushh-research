import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSessionMock, refreshAccountIdentityShadowMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  refreshAccountIdentityShadowMock: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    createSession: createSessionMock,
    refreshAccountIdentityShadow: refreshAccountIdentityShadowMock,
  },
}));

import { AccountIdentityService } from "@/lib/services/account-identity-service";

describe("AccountIdentityService", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    refreshAccountIdentityShadowMock.mockReset();
  });

  it("syncs the Firebase phone session before reading backend phone verification", async () => {
    const callOrder: string[] = [];
    createSessionMock.mockImplementation(async () => {
      callOrder.push("createSession");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    refreshAccountIdentityShadowMock.mockImplementation(async () => {
      callOrder.push("refreshIdentity");
      return new Response(
        JSON.stringify({
          identity: {
            user_id: "user_123",
            phone_number: "+919950000000",
            phone_verified: true,
          },
        }),
        { status: 200 },
      );
    });

    const identity = await AccountIdentityService.syncCurrentUser({
      uid: "user_123",
      email: "user@example.com",
      displayName: "User",
      photoURL: "https://example.com/avatar.png",
      emailVerified: true,
      phoneNumber: "+919950000000",
      getIdToken: vi.fn().mockResolvedValue("firebase-id-token"),
    } as any);

    expect(callOrder).toEqual(["createSession", "refreshIdentity"]);
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        phoneNumber: "+919950000000",
      }),
    );
    expect(AccountIdentityService.hasVerifiedPhone(identity)).toBe(true);
  });
});
