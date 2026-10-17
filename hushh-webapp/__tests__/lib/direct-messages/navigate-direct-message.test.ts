import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  routeHref: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/firebase/config", () => ({ auth: { currentUser: null } }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdTokenWithRetry: mocks.token },
}));
vi.mock("@/lib/services/direct-messages-service", () => ({
  DirectMessagesService: { routeHref: mocks.routeHref },
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
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("native-owner");
    mocks.token.mockResolvedValue("owner-bound-token");
    mocks.routeHref.mockResolvedValue("/one/messages?token=dm1.opaque");
  });
  afterEach(() => publishValidatedAuthSessionOwner(null));

  it.each([
    { personRef: "public-person" },
    { conversationId: "conversation-ref" },
  ])("uses an owner-bound native token without a Firebase JS user for %j", async (selection) => {
    await expect(resolveDirectMessageHref(selection)).resolves.toBe("/one/messages?token=dm1.opaque");
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ expectedUserId: "native-owner" });
    expect(mocks.routeHref).toHaveBeenCalledExactlyOnceWith({ idToken: "owner-bound-token", ...selection });
  });

  it("does not acquire a token or mint a route without a validated owner", async () => {
    publishValidatedAuthSessionOwner(null);
    await expect(resolveDirectMessageHref({ personRef: "public-person" })).rejects.toThrow("Sign in required");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.routeHref).not.toHaveBeenCalled();
  });

  it("stays in place when a token is unavailable and opens on a later retry", async () => {
    mocks.token.mockResolvedValueOnce(null);
    const router = { push: vi.fn() };
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(mocks.routeHref).not.toHaveBeenCalled();
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
    expect(mocks.routeHref).not.toHaveBeenCalled();
  });

  it.each(["other-owner", "native-owner"])("discards a minted route after a session transition to %s", async (nextOwner) => {
    mocks.routeHref.mockImplementationOnce(async () => {
      publishValidatedAuthSessionOwner(null);
      publishValidatedAuthSessionOwner(nextOwner);
      return "/one/messages?token=dm1.obsolete";
    });
    const router = { push: vi.fn() };
    await navigateDirectMessage(router, { conversationId: "conversation-ref" });
    expect(router.push).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each(["token", "routeHref"] as const)("keeps %s failures private and permits retry", async (stage) => {
    mocks[stage].mockRejectedValueOnce(new Error("private provider detail"));
    const router = { push: vi.fn() };
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(router.push).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith("This conversation could not be opened. Try again.");
    await navigateDirectMessage(router, { personRef: "public-person" });
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/one/messages?token=dm1.opaque");
  });
});
