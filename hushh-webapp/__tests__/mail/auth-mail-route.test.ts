import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validateFirebaseToken = vi.fn();
const getUser = vi.fn();
const getUserByPhoneNumber = vi.fn();
const setCustomUserClaims = vi.fn();
const sendSignInMail = vi.fn();
const sendPhoneConflictMail = vi.fn();

vi.mock("@/lib/auth/validate", () => ({
  validateFirebaseToken: (...args: unknown[]) => validateFirebaseToken(...args),
}));

vi.mock("@/lib/firebase/admin", () => ({
  auth: {
    getUser: (...args: unknown[]) => getUser(...args),
    getUserByPhoneNumber: (...args: unknown[]) => getUserByPhoneNumber(...args),
    setCustomUserClaims: (...args: unknown[]) => setCustomUserClaims(...args),
  },
}));

vi.mock("@/lib/mail/auth-mail-service", () => ({
  WELCOME_MAIL_CLAIM: "hushhWelcomeMailAt",
  sendSignInMail: (...args: unknown[]) => sendSignInMail(...args),
  sendPhoneConflictMail: (...args: unknown[]) => sendPhoneConflictMail(...args),
}));

const ROUTE = "@/app/api/auth/mail/route";
const CONFLICT_NUMBER = "+919876543210";

function request(body: unknown, authorization = "Bearer good-token") {
  return new Request("https://uat.one.hushh.ai/api/auth/mail", {
    method: "POST",
    headers: { Authorization: authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

// A fresh module per test: the duplicate and quota guards are module state.
async function loadRoute() {
  vi.resetModules();
  return (await import(ROUTE)) as typeof import("@/app/api/auth/mail/route");
}

describe("POST /api/auth/mail", () => {
  beforeEach(() => {
    validateFirebaseToken.mockReset().mockResolvedValue({ valid: true, userId: "uid-1" });
    getUser.mockReset().mockResolvedValue({
      uid: "uid-1",
      email: "ankit@hushh.ai",
      displayName: "Ankit",
      customClaims: {},
      metadata: { creationTime: "", lastSignInTime: "Wed, 05 Aug 2026 09:12:00 GMT" },
    });
    getUserByPhoneNumber.mockReset();
    setCustomUserClaims.mockReset().mockResolvedValue(undefined);
    sendSignInMail.mockReset().mockResolvedValue({ status: "sent", kind: "welcome", messageId: "<a>" });
    sendPhoneConflictMail.mockReset().mockResolvedValue({
      status: "sent",
      kind: "phone_conflict",
      messageId: "<b>",
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("rejects an unauthenticated caller before touching anything", async () => {
    validateFirebaseToken.mockResolvedValue({ valid: false });
    const { POST } = await loadRoute();

    const response = await POST(request({ event: "signed_in" }));

    expect(response.status).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
    expect(sendSignInMail).not.toHaveBeenCalled();
  });

  it("rejects an event it does not know", async () => {
    const { POST } = await loadRoute();
    const response = await POST(request({ event: "password_reset" }));
    expect(response.status).toBe(400);
    expect(sendSignInMail).not.toHaveBeenCalled();
  });

  it("collapses a repeated request for the same sign-in", async () => {
    const { POST } = await loadRoute();

    await POST(request({ event: "signed_in" }));
    const second = await POST(request({ event: "signed_in" }));

    expect(await second.json()).toEqual({ status: "skipped", reason: "duplicate_request" });
    expect(sendSignInMail).toHaveBeenCalledTimes(1);
  });

  it("rejects a phone number that is not E.164", async () => {
    const { POST } = await loadRoute();
    const response = await POST(request({ event: "phone_conflict", phoneNumber: "9876543210" }));
    expect(response.status).toBe(400);
    expect(getUserByPhoneNumber).not.toHaveBeenCalled();
  });

  it("does not mail when no other account holds the number", async () => {
    getUserByPhoneNumber.mockRejectedValue(new Error("user not found"));
    const { POST } = await loadRoute();

    const response = await POST(request({ event: "phone_conflict", phoneNumber: CONFLICT_NUMBER }));

    expect(await response.json()).toEqual({ status: "skipped", reason: "no_conflicting_account" });
    expect(sendPhoneConflictMail).not.toHaveBeenCalled();
  });

  it("does not mail when the number is already the caller's own", async () => {
    getUserByPhoneNumber.mockResolvedValue({ uid: "uid-1", email: "ankit@hushh.ai" });
    const { POST } = await loadRoute();

    const response = await POST(request({ event: "phone_conflict", phoneNumber: CONFLICT_NUMBER }));

    expect(await response.json()).toEqual({ status: "skipped", reason: "no_conflicting_account" });
    expect(sendPhoneConflictMail).not.toHaveBeenCalled();
  });

  it("mails a genuine conflict and passes the owner's address for masking", async () => {
    getUserByPhoneNumber.mockResolvedValue({ uid: "uid-2", email: "ankit.old@gmail.com" });
    const { POST } = await loadRoute();

    const response = await POST(request({ event: "phone_conflict", phoneNumber: CONFLICT_NUMBER }));

    expect(await response.json()).toMatchObject({ status: "sent", kind: "phone_conflict" });
    expect(sendPhoneConflictMail.mock.calls[0][1]).toMatchObject({
      attemptedPhoneNumber: CONFLICT_NUMBER,
      linkedAccountEmail: "ankit.old@gmail.com",
    });
  });

  it("still mails a phone-only owner, with no address to hint at", async () => {
    getUserByPhoneNumber.mockResolvedValue({ uid: "uid-2", email: undefined });
    const { POST } = await loadRoute();

    await POST(request({ event: "phone_conflict", phoneNumber: CONFLICT_NUMBER }));

    expect(sendPhoneConflictMail.mock.calls[0][1]).toMatchObject({ linkedAccountEmail: null });
  });

  it("caps conflict mail per account so it cannot be walked or used to burn quota", async () => {
    getUserByPhoneNumber.mockResolvedValue({ uid: "uid-2", email: "other@gmail.com" });
    const { POST } = await loadRoute();

    // Distinct numbers, so the duplicate guard is not what stops this.
    const numbers = ["+919876543210", "+919876543211", "+919876543212", "+919876543213"];
    const outcomes = [];
    for (const phoneNumber of numbers) {
      outcomes.push(await (await POST(request({ event: "phone_conflict", phoneNumber }))).json());
    }

    expect(sendPhoneConflictMail).toHaveBeenCalledTimes(3);
    expect(outcomes[3]).toEqual({ status: "skipped", reason: "rate_limited" });
  });

  it("merges the welcome marker into existing claims rather than replacing them", async () => {
    getUser.mockResolvedValue({
      uid: "uid-1",
      email: "ankit@hushh.ai",
      displayName: "Ankit",
      customClaims: { somethingElse: true },
      metadata: { creationTime: "", lastSignInTime: "Wed, 05 Aug 2026 09:12:00 GMT" },
    });
    sendSignInMail.mockImplementation(async (_user, _ctx, deps) => {
      await deps.markWelcomeSent("uid-1", 1_754_000_000);
      return { status: "sent", kind: "welcome", messageId: "<a>" };
    });
    const { POST } = await loadRoute();

    await POST(request({ event: "signed_in" }));

    expect(setCustomUserClaims).toHaveBeenCalledWith("uid-1", {
      somethingElse: true,
      hushhWelcomeMailAt: 1_754_000_000,
    });
  });

  it("reports a dispatch failure instead of throwing at the caller", async () => {
    getUser.mockRejectedValue(new Error("admin unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await loadRoute();

    const response = await POST(request({ event: "signed_in" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "failed", reason: "dispatch_error" });
    warn.mockRestore();
  });
});
