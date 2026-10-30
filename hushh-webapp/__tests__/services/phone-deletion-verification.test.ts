import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const {
  mockAuth, mockCapacitor, mockHushhAuth, mockPhoneAuthProvider,
  mockUpdatePhoneNumber, mockLinkWithCredential, mockSignInWithCredential, mockFirebaseAuthentication,
} = vi.hoisted(() => ({
  mockAuth: { currentUser: null as { uid: string; phoneNumber?: string } | null },
  mockCapacitor: { isNativePlatform: vi.fn(() => true), getPlatform: () => "android" },
  mockHushhAuth: {
    startPhoneDeletionVerification: vi.fn(), confirmPhoneDeletionVerification: vi.fn(),
    cancelPhoneDeletionVerification: vi.fn(), signIn: vi.fn(), getCurrentUser: vi.fn(), getIdToken: vi.fn(),
  },
  mockPhoneAuthProvider: vi.fn(), mockUpdatePhoneNumber: vi.fn(),
  mockLinkWithCredential: vi.fn(), mockSignInWithCredential: vi.fn(),
  mockFirebaseAuthentication: { linkWithPhoneNumber: vi.fn(), unlink: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: mockCapacitor }));
vi.mock("@/lib/capacitor", () => ({ HushhAuth: mockHushhAuth }));
vi.mock("@/lib/firebase/config", () => ({ auth: mockAuth, app: { options: {} } }));
vi.mock("@capacitor-firebase/authentication", () => ({ FirebaseAuthentication: mockFirebaseAuthentication, ProviderId: {} }));
vi.mock("firebase/auth", async (original) => ({
  ...await original<typeof import("firebase/auth")>(),
  PhoneAuthProvider: mockPhoneAuthProvider, updatePhoneNumber: mockUpdatePhoneNumber,
  linkWithCredential: mockLinkWithCredential, signInWithCredential: mockSignInWithCredential,
}));
import { AuthService } from "@/lib/services/auth-service";

describe("AuthService deletion-only phone proof", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCapacitor.isNativePlatform.mockReturnValue(true);
    mockAuth.currentUser = null;
    mockHushhAuth.cancelPhoneDeletionVerification.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("preserves the native SDK startup timeout code without calling it an expired OTP", async () => {
    mockHushhAuth.startPhoneDeletionVerification.mockRejectedValue({ code: "phone-verification-start-timeout" });
    await expect(AuthService.startPhoneDeletionVerification("+16505550100", undefined, {
      expectedUserId: "owner", attemptId: "sdk-timeout",
    })).rejects.toMatchObject({ code: "phone-verification-start-timeout" });
  });

  it("bounds a stalled deletion send and cancels its owned attempt without declaring the OTP expired", async () => {
    vi.useFakeTimers();
    mockHushhAuth.startPhoneDeletionVerification.mockReturnValueOnce(new Promise(() => {}));
    const pending = AuthService.startPhoneDeletionVerification("+16505550100", undefined, {
      expectedUserId: "owner", attemptId: "stalled-attempt",
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "phone-verification-start-timeout" });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(mockHushhAuth.cancelPhoneDeletionVerification).toHaveBeenCalledWith({ attemptId: "stalled-attempt" });
    mockHushhAuth.startPhoneDeletionVerification.mockResolvedValue({ attemptId: "next-attempt", verificationId: "next-attempt" });
    await expect(AuthService.startPhoneDeletionVerification("+16505550100", undefined, {
      expectedUserId: "owner", attemptId: "next-attempt", resendCode: true,
    })).resolves.toEqual({ verificationId: "next-attempt" });
    expect(mockHushhAuth.startPhoneDeletionVerification).toHaveBeenLastCalledWith({
      expectedUserId: "owner", attemptId: "next-attempt", resendCode: true, phoneNumber: "+16505550100",
    });
    await AuthService.cancelPhoneDeletionVerification("next-attempt");
  });

  it("aborts a deletion send before codeSent and fences its late callback from the next attempt", async () => {
    let resolve!: (value: any) => void;
    mockHushhAuth.startPhoneDeletionVerification.mockReturnValueOnce(new Promise(value => { resolve = value; }));
    const controller = new AbortController();
    const pending = AuthService.startPhoneDeletionVerification("+16505550100", undefined, {
      expectedUserId: "owner", attemptId: "retired-attempt", signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "session_changed" });
    controller.abort();
    await rejected;
    expect(mockHushhAuth.cancelPhoneDeletionVerification).toHaveBeenCalledWith({ attemptId: "retired-attempt" });
    mockHushhAuth.startPhoneDeletionVerification.mockResolvedValue({ attemptId: "current-attempt", verificationId: "current-attempt" });
    await expect(AuthService.startPhoneDeletionVerification("+16505550100", undefined, {
      expectedUserId: "owner", attemptId: "current-attempt",
    })).resolves.toEqual({ verificationId: "current-attempt" });
    resolve({ attemptId: "retired-attempt", phoneIdToken: "stale-proof" });
    await Promise.resolve();
    mockHushhAuth.confirmPhoneDeletionVerification.mockResolvedValue({ attemptId: "current-attempt", phoneIdToken: "current-proof" });
    await expect(AuthService.confirmPhoneDeletionVerification({ expectedUserId: "owner", attemptId: "current-attempt", verificationId: "current-attempt", verificationCode: "123456" })).resolves.toBe("current-proof");
    expect(mockHushhAuth.startPhoneDeletionVerification.mock.calls[0][0]).not.toHaveProperty("signal");
  });
  it("sends deletion proof to an already-linked phone without changing its binding", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const verifyPhoneNumber = vi.fn().mockResolvedValue("delete-verification-id");
    mockPhoneAuthProvider.mockImplementation(function () {
      return { verifyPhoneNumber };
    });
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: "+16505550100",
    } as any;
    const verifier = {} as any;

    const verificationId = await AuthService.startPhoneDeletionVerification(
      "+16505550100",
      verifier,
      { expectedUserId: "web-user", attemptId: "attempt-1" },
    );

    expect(verificationId).toEqual({ verificationId: "delete-verification-id" });
    expect(verifyPhoneNumber).toHaveBeenCalledWith("+16505550100", verifier);
    expect(mockUpdatePhoneNumber).not.toHaveBeenCalled();
    expect(mockLinkWithCredential).not.toHaveBeenCalled();
    expect(mockFirebaseAuthentication.unlink).not.toHaveBeenCalled();
  });

  it.each([false, true])("routes native deletion proof without replacing the primary user (instant=%s)", async (instant) => {
    const user = { uid: "native-owner", phoneNumber: "+16505550100" };
    // Native Firebase is authoritative even before the JS SDK publishes a user.
    mockAuth.currentUser = null;
    const context = { expectedUserId: user.uid, attemptId: "native-attempt" };
    mockHushhAuth.startPhoneDeletionVerification.mockResolvedValue(instant
      ? { attemptId: context.attemptId, phoneIdToken: "instant-proof" }
      : { attemptId: context.attemptId, verificationId: context.attemptId });
    mockHushhAuth.confirmPhoneDeletionVerification.mockResolvedValue({ attemptId: context.attemptId, phoneIdToken: "manual-proof" });

    const result = await AuthService.startPhoneDeletionVerification("+16505550100", undefined, context);
    expect(result).toEqual(instant ? { phoneIdToken: "instant-proof" } : { verificationId: context.attemptId });
    if (!instant) {
      await expect(AuthService.confirmPhoneDeletionVerification({ ...context, verificationId: context.attemptId, verificationCode: "123456" })).resolves.toBe("manual-proof");
    }
    expect(mockAuth.currentUser).toBeNull();
    expect(mockFirebaseAuthentication.linkWithPhoneNumber).not.toHaveBeenCalled();
    expect(mockFirebaseAuthentication.unlink).not.toHaveBeenCalled();
    expect(mockSignInWithCredential).not.toHaveBeenCalled();
    expect(mockHushhAuth.signIn).not.toHaveBeenCalled();
    expect(mockHushhAuth.getCurrentUser).not.toHaveBeenCalled();
    expect(mockHushhAuth.getIdToken).not.toHaveBeenCalled();
  });

  it("rejects stale native proof results and cancels only the requested attempt", async () => {
    mockAuth.currentUser = { uid: "owner" };
    mockHushhAuth.startPhoneDeletionVerification.mockResolvedValue({ attemptId: "old-attempt", phoneIdToken: "stale-proof" });
    await expect(AuthService.startPhoneDeletionVerification("+16505550100", undefined, {
      expectedUserId: "owner", attemptId: "current-attempt",
    })).rejects.toThrow();
    mockHushhAuth.cancelPhoneDeletionVerification.mockResolvedValue(undefined);
    await AuthService.cancelPhoneDeletionVerification("old-attempt");
    expect(mockHushhAuth.cancelPhoneDeletionVerification).toHaveBeenCalledWith({ attemptId: "old-attempt" });
  });

});
