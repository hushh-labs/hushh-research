import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  auth: { currentUser: null as any },
  capacitor: { isNativePlatform: vi.fn(), getPlatform: () => "ios" },
  phoneProvider: vi.fn(),
  native: { addListener: vi.fn(), linkWithPhoneNumber: vi.fn(),
    confirmVerificationCode: vi.fn(), unlink: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: state.capacitor }));
vi.mock("@/lib/firebase/config", () => ({ auth: state.auth, app: { options: {} } }));
vi.mock("@/lib/capacitor", () => ({ HushhAuth: {} }));
vi.mock("@capacitor-firebase/authentication", () => ({
  FirebaseAuthentication: state.native, ProviderId: { PHONE: "phone" },
}));
vi.mock("firebase/auth", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/auth")>(),
  PhoneAuthProvider: Object.assign(state.phoneProvider, { credential: vi.fn() }),
  linkWithCredential: vi.fn(),
}));
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import { linkWithCredential } from "firebase/auth";
import { AuthService } from "@/lib/services/auth-service";
const mockAuth = state.auth;
const mockCapacitor = state.capacitor;
const mockPhoneAuthProvider = state.phoneProvider;
describe("AuthService phone proof integration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mockCapacitor.isNativePlatform.mockReturnValue(true);
    state.native.confirmVerificationCode.mockResolvedValue({});
  });
  it("@feature_auth_reliability @trace_loop keeps a native verification challenge available after three minutes without a local expiry", async () => {
    vi.useFakeTimers();
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    mockAuth.currentUser = { uid: "native-user", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        return { remove: vi.fn().mockResolvedValue(undefined) } as any;
      },
    );
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockImplementationOnce(async () => {
      await listeners.phoneCodeSent({ verificationId: "fresh-request" });
    });
    const verifiedUser = { uid: "native-user", phoneNumber: "+16505550101" } as any;
    const restore = vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValueOnce(verifiedUser);
    try {
      const start = await AuthService.startPhoneLinkVerification("+16505550101");
      await vi.advanceTimersByTimeAsync(180_000);
      await expect(AuthService.confirmPhoneLinkVerification({
        verificationId: start.verificationId,
        verificationCode: "123456",
      })).resolves.toBe(verifiedUser);
      expect(FirebaseAuthentication.confirmVerificationCode).toHaveBeenCalledWith({
        verificationId: "fresh-request", verificationCode: "123456",
      });
      expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(1);
    } finally {
      restore.mockRestore();
      vi.useRealTimers();
    }
  });

  it("@feature_auth_reliability @trace_loop allows a fresh web proof for the linked phone only when explicitly requested and enabled", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    mockAuth.currentUser = { uid: "web-user", phoneNumber: "+16505550101" } as any;
    const verifyPhoneNumber = vi.fn().mockResolvedValue("fresh-linked-phone-proof");
    mockPhoneAuthProvider.mockImplementation(function () { return { verifyPhoneNumber }; });
    await expect(AuthService.startPhoneLinkVerification("+16505550101")).rejects.toMatchObject({
      code: "phone-already-linked-to-current-user",
    });
    await expect(AuthService.startPhoneLinkVerification("+16505550101", {
      recaptchaVerifier: {} as any, allowLinkedPhoneProof: true,
    })).resolves.toEqual({ autoVerified: false, verificationId: "fresh-linked-phone-proof" });
    vi.stubEnv("NEXT_PUBLIC_AUTH_PHONE_RECOVERY_ENABLED", "false");
    await expect(AuthService.startPhoneLinkVerification("+16505550101", {
      recaptchaVerifier: {} as any, allowLinkedPhoneProof: true,
    })).rejects.toMatchObject({ code: "phone-already-linked-to-current-user" });
    expect(verifyPhoneNumber).toHaveBeenCalledTimes(1);
    expect(FirebaseAuthentication.linkWithPhoneNumber).not.toHaveBeenCalled();
    expect(linkWithCredential).not.toHaveBeenCalled();
  });

  it("@feature_auth_reliability @trace_loop keeps the same-phone native provider guard even when web recovery is requested", async () => {
    mockAuth.currentUser = { uid: "native-user", phoneNumber: "+16505550101" } as any;
    await expect(AuthService.startPhoneLinkVerification("+16505550101", {
      allowLinkedPhoneProof: true,
    })).rejects.toMatchObject({ code: "phone-already-linked-to-current-user" });
    expect(FirebaseAuthentication.linkWithPhoneNumber).not.toHaveBeenCalled();
    expect(FirebaseAuthentication.unlink).not.toHaveBeenCalled();
  });

});
