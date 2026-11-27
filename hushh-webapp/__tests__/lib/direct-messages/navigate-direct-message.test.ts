import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheService } from "@/lib/services/cache-service";
import { DirectMessagesResourceService } from "@/lib/services/direct-messages-resource-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  routeSelection: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/firebase/config", () => ({ auth: { currentUser: null } }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdTokenWithRetry: mocks.token },
}));
vi.mock("@/lib/services/direct-messages-service", () => ({
  DirectMessagesService: { routeSelection: mocks.routeSelection },
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { error: mocks.toastError },
}));

import {
  navigateDirectMessage,
  resolveDirectMessageHref,
} from "@/lib/direct-messages/navigate-direct-message";

describe("direct message navigation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("native-owner");
    mocks.token.mockResolvedValue("owner-bound-token");
    mocks.routeSelection.mockResolvedValue({ token: "dm1.opaque", kind: "conversation", ref: "conversation-ref" });
  });
  afterEach(() => publishValidatedAuthSessionOwner(null));

  it.each([
    { personRef: "public-person" },
    { conversationId: "conversation-ref" },
  ])("uses an owner-bound native token without a Firebase JS user for %j", async (selection) => {
    await expect(resolveDirectMessageHref(selection)).resolves.toBe("/one/messages?token=dm1.opaque");
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ expectedUserId: "native-owner" });
    expect(mocks.routeSelection).toHaveBeenCalledExactlyOnceWith({ idToken: "owner-bound-token", ...selection });
    expect(DirectMessagesResourceService.readRoute("native-owner", "dm1.opaque")).toEqual({ kind: "conversation", ref: "conversation-ref" });
  });

  it("does not acquire a token or mint a route without a validated owner", async () => {
    publishValidatedAuthSessionOwner(null);
    await expect(resolveDirectMessageHref({ personRef: "public-person" })).rejects.toThrow("Sign in required");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.routeSelection).not.toHaveBeenCalled();
  });

  it("stays in place when a token is unavailable and opens on a later retry", async () => {
    mocks.token.mockResolvedValueOnce(null);
    const router = { push: vi.fn() };
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(mocks.routeSelection).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("This conversation could not be opened. Try again.");
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/one/messages?token=dm1.opaque");
  });

  it("does not mint a route when the account changes during token acquisition", async () => {
    mocks.token.mockImplementationOnce(async () => {
      publishValidatedAuthSessionOwner("other-owner");
      return "obsolete-token";
    });
    await expect(resolveDirectMessageHref({ personRef: "public-person" })).resolves.toBeNull();
    expect(mocks.routeSelection).not.toHaveBeenCalled();
  });

  it.each(["other-owner", "native-owner"])("discards a minted route after a session transition to %s", async (nextOwner) => {
    mocks.routeSelection.mockImplementationOnce(async () => {
      publishValidatedAuthSessionOwner(null);
      publishValidatedAuthSessionOwner(nextOwner);
      return { token: "dm1.obsolete", kind: "conversation", ref: "obsolete" };
    });
    const router = { push: vi.fn() };
    await navigateDirectMessage(router, { conversationId: "conversation-ref" });
    expect(router.push).not.toHaveBeenCalled();
    expect(DirectMessagesResourceService.readRoute("native-owner", "dm1.obsolete")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each(["token", "routeSelection"] as const)("keeps %s failures private and permits retry", async (stage) => {
    mocks[stage].mockRejectedValueOnce(new Error("private provider detail"));
    const router = { push: vi.fn() };
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(router.push).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith("This conversation could not be opened. Try again.");
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/one/messages?token=dm1.opaque");
  });
  it("cannot republish a verified mapping after its cache session was purged", async () => {
    mocks.routeSelection.mockImplementationOnce(async () => {
      CacheService.getInstance().invalidateUser("native-owner");
      DirectMessagesResourceService.beginRequest("native-owner");
      return { token: "dm1.purged", kind: "conversation", ref: "conversation-ref" };
    });
    await resolveDirectMessageHref({ conversationId: "conversation-ref" });
    expect(DirectMessagesResourceService.readRoute("native-owner", "dm1.purged")).toBeNull();
  });

});
