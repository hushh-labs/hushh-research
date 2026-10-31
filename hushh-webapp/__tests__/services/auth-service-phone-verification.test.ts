import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  auth: { currentUser: null as any },
  capacitor: { isNativePlatform: vi.fn(), getPlatform: () => "ios" },
  phoneProvider: vi.fn(),
  proof: { startPhoneVerificationProof: vi.fn(), confirmPhoneVerificationProof: vi.fn(), cancelPhoneVerificationProof: vi.fn(), reauthenticateAppleIdentity: vi.fn(), signIn: vi.fn() },
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
describe("AuthService phone proof integration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mockCapacitor.isNativePlatform.mockReturnValue(true);
    state.native.confirmVerificationCode.mockResolvedValue({});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("uses fresh native Apple reauthentication only for the captured current owner", async () => {
    state.proof.reauthenticateAppleIdentity.mockResolvedValue({ userId: "owner", idToken: "fresh-apple-proof" });
    await expect(AuthService.reauthenticateIdentity("owner", "apple.com", () => true)).resolves.toBe("fresh-apple-proof");
    expect(state.proof.reauthenticateAppleIdentity).toHaveBeenCalledWith({ expectedUserId: "owner" });
    state.proof.reauthenticateAppleIdentity.mockResolvedValue({ userId: "other", idToken: "foreign-proof" });
    await expect(AuthService.reauthenticateIdentity("owner", "apple.com", () => true)).rejects.toThrow("identity_mismatch");
    const late = deferred<any>();
    state.proof.reauthenticateAppleIdentity.mockReturnValue(late.promise);
    let current = true;
    const pending = AuthService.reauthenticateIdentity("owner", "apple.com", () => current);
    current = false;
    late.resolve({ userId: "owner", idToken: "retired-proof" });
    await expect(pending).rejects.toThrow("session_changed");
    expect(state.proof.signIn).not.toHaveBeenCalled();
  });

  it("bounds a missing native Apple callback and safely classifies unsupported wrappers", async () => {
    vi.useFakeTimers();
    state.proof.reauthenticateAppleIdentity.mockReturnValue(new Promise(() => {}));
    const pending = AuthService.reauthenticateIdentity("owner", "apple.com", () => true);
    const rejected = expect(pending).rejects.toThrow("identity_timeout");
    await vi.advanceTimersByTimeAsync(125_000);
    await rejected;
    state.proof.reauthenticateAppleIdentity.mockRejectedValue({ code: "UNIMPLEMENTED", credential: "private-provider-payload" });
    await expect(AuthService.reauthenticateIdentity("owner", "apple.com", () => true)).rejects.toThrow("native_identity_unavailable");
    state.proof.reauthenticateAppleIdentity.mockRejectedValue(new Error("private-provider-payload"));
    await expect(AuthService.reauthenticateIdentity("owner", "apple.com", () => true)).rejects.toThrow("identity_verification_failed");
    expect(state.proof.signIn).not.toHaveBeenCalled();
  });

  it("bounds native restore before dispatch and refuses its late result after another owner retries", async () => {
    vi.useFakeTimers();
    const oldRestore = deferred<any>();
    const owner = { uid: "new-native-owner", phoneNumber: null };
    const restore = vi.spyOn(AuthService, "restoreNativeSession").mockReturnValueOnce(oldRestore.promise).mockResolvedValue(owner as any);
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    state.proof.startPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, verificationId: attemptId }));
    mockAuth.currentUser = owner;
    let failure: any;
    const pending = AuthService.startPhoneLinkVerification("+16505550101").catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failure).toMatchObject({ code: "phone-verification-start-timeout" });
    await pending;
    expect(state.proof.startPhoneVerificationProof).not.toHaveBeenCalled();
    const controller = new AbortController();
    await expect(AuthService.startPhoneLinkVerification("+16505550101", { signal: controller.signal })).resolves.toMatchObject({ autoVerified: false });
    oldRestore.resolve({ uid: "retired-native-owner" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.proof.startPhoneVerificationProof).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  it("uses one send deadline across restore and a stalled previous cancellation", async () => {
    vi.useFakeTimers();
    const owner = { uid: "native-owner", phoneNumber: null } as any;
    mockAuth.currentUser = owner;
    const restore = vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(owner);
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    state.proof.startPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, verificationId: attemptId }));
    await AuthService.startPhoneLinkVerification("+16505550101");
    const restoring = deferred<any>(), cancelling = deferred<void>();
    restore.mockReturnValueOnce(restoring.promise);
    state.proof.cancelPhoneVerificationProof.mockReturnValueOnce(cancelling.promise);
    let failure: any;
    const pending = AuthService.startPhoneLinkVerification("+16505550101", { resendCode: true }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(100_000);
    restoring.resolve(owner);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(failure).toMatchObject({ code: "phone-verification-start-timeout" });
    await pending;
    expect(state.proof.startPhoneVerificationProof).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    await AuthService.startPhoneLinkVerification("+16505550101", { signal: controller.signal });
    cancelling.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.proof.startPhoneVerificationProof).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  it("aborts a pending SDK send promptly without letting its callback replace a resent challenge", async () => {
    const owner = { uid: "native-owner", phoneNumber: null } as any;
    mockAuth.currentUser = owner;
    vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(owner);
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    const late = deferred<any>();
    let oldAttempt = "";
    state.proof.startPhoneVerificationProof.mockImplementationOnce(({ attemptId }) => { oldAttempt = attemptId; return late.promise; });
    const retired = new AbortController();
    const pending = AuthService.startPhoneLinkVerification("+16505550101", { signal: retired.signal });
    await vi.waitFor(() => expect(oldAttempt).not.toBe(""));
    const rejected = expect(pending).rejects.toMatchObject({ code: "session_changed" });
    retired.abort();
    await rejected;
    state.proof.startPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, verificationId: attemptId }));
    const current = new AbortController();
    const fresh = await AuthService.startPhoneLinkVerification("+16505550101", { resendCode: true, signal: current.signal });
    expect(state.proof.startPhoneVerificationProof).toHaveBeenLastCalledWith(expect.objectContaining({ resendCode: true }));
    late.resolve({ attemptId: oldAttempt, verificationId: oldAttempt });
    await Promise.resolve();
    state.proof.confirmPhoneVerificationProof.mockImplementation(async ({ attemptId }) => ({ attemptId, phoneIdToken: "current-proof" }));
    await expect(AuthService.getPhoneClaimIdToken({ verificationId: fresh.verificationId, verificationCode: "123456" })).resolves.toBe("current-proof");
    current.abort();
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
