import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  auth: { currentUser: null as any },
  capacitor: { isNativePlatform: vi.fn(), getPlatform: () => "ios" },
  phoneProvider: vi.fn(),
  proof: { startPhoneVerificationProof: vi.fn(), confirmPhoneVerificationProof: vi.fn(), cancelPhoneVerificationProof: vi.fn() },
  native: { addListener: vi.fn(), linkWithPhoneNumber: vi.fn(),
    confirmVerificationCode: vi.fn(), unlink: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: state.capacitor }));
vi.mock("@/lib/firebase/config", () => ({ auth: state.auth, app: { options: {} } }));
vi.mock("@/lib/capacitor", () => ({ HushhAuth: state.proof }));
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
    const primary = { uid: "native-user", phoneNumber: null } as any;
    mockAuth.currentUser = primary;
    state.proof.startPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, verificationId: attemptId }));
    state.proof.confirmPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, phoneIdToken: "isolated-phone-proof" }));
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    const restore = vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(primary);
    try {
      const start = await AuthService.startPhoneLinkVerification("+16505550101");
      await vi.advanceTimersByTimeAsync(180_000);
      await expect(AuthService.getPhoneClaimIdToken({ verificationId: start.verificationId, verificationCode: "123456" })).resolves.toBe("isolated-phone-proof");
      // Persistence may be temporarily unavailable after the provider proof is
      // minted; retry uses that proof without consuming another native code.
      await expect(AuthService.getPhoneClaimIdToken({ verificationId: start.verificationId, verificationCode: "123456" })).resolves.toBe("isolated-phone-proof");
      expect(state.proof.confirmPhoneVerificationProof).toHaveBeenCalledTimes(1);
      expect(state.proof.startPhoneVerificationProof).toHaveBeenCalledTimes(1);
      expect(mockAuth.currentUser).toBe(primary);
      expect(FirebaseAuthentication.linkWithPhoneNumber).not.toHaveBeenCalled();
      expect(FirebaseAuthentication.unlink).not.toHaveBeenCalled();
    } finally { restore.mockRestore(); vi.useRealTimers(); }
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

  it("allows an explicitly requested isolated native proof for the same phone", async () => {
    const primary = { uid: "native-user", phoneNumber: "+16505550101" } as any;
    mockAuth.currentUser = primary;
    state.proof.startPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, verificationId: attemptId }));
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    const restore = vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(primary);
    try {
      await expect(AuthService.startPhoneLinkVerification("+16505550101", { allowLinkedPhoneProof: true })).resolves.toMatchObject({ autoVerified: false });
      expect(FirebaseAuthentication.linkWithPhoneNumber).not.toHaveBeenCalled();
      expect(FirebaseAuthentication.unlink).not.toHaveBeenCalled();
    } finally { restore.mockRestore(); }
  });
});
