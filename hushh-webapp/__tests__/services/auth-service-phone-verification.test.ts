import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  auth: { currentUser: null as any, app: { options: { apiKey: "selected-auth-key", projectId: "selected-auth-project" } } },
  capacitor: { isNativePlatform: vi.fn(), getPlatform: () => "ios" },
  phoneProvider: vi.fn(),
  proof: { startPhoneVerificationProof: vi.fn(), startPhoneLinkVerification: vi.fn(), confirmPhoneVerificationProof: vi.fn(), cancelPhoneVerificationProof: vi.fn(), reauthenticateAppleIdentity: vi.fn(), signIn: vi.fn() },
  native: { addListener: vi.fn(), linkWithPhoneNumber: vi.fn(),
    confirmVerificationCode: vi.fn(), reload: vi.fn(), unlink: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: state.capacitor }));
vi.mock("@/lib/firebase/config", () => ({ auth: state.auth, app: { options: { apiKey: "demo-key" } } }));
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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    state.proof.startPhoneLinkVerification.mockImplementation(async ({ attemptId, linkIntent }) => ({ attemptId, verificationId: attemptId, providerVerificationId: "native-provider-challenge", linkIntent }));
    mockAuth.currentUser = owner;
    let failure: any;
    const pending = AuthService.startPhoneLinkVerification("+16505550101").catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failure).toMatchObject({ code: "phone-verification-start-timeout" });
    await pending;
    expect(state.proof.startPhoneLinkVerification).not.toHaveBeenCalled();
    const controller = new AbortController();
    await expect(AuthService.startPhoneLinkVerification("+16505550101", { signal: controller.signal })).resolves.toMatchObject({ autoVerified: false });
    oldRestore.resolve({ uid: "retired-native-owner" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.proof.startPhoneLinkVerification).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  it("uses one send deadline across restore and a stalled previous cancellation", async () => {
    vi.useFakeTimers();
    const owner = { uid: "native-owner", phoneNumber: null, getIdToken: vi.fn().mockResolvedValue("native-email-session") } as any;
    mockAuth.currentUser = owner;
    const restore = vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(owner);
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    state.proof.startPhoneLinkVerification.mockImplementation(async ({ attemptId, linkIntent }) => ({ attemptId, verificationId: attemptId, providerVerificationId: "native-provider-challenge", linkIntent }));
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
    expect(state.proof.startPhoneLinkVerification).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    await AuthService.startPhoneLinkVerification("+16505550101", { signal: controller.signal });
    cancelling.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.proof.startPhoneLinkVerification).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  it("aborts a pending SDK send promptly without letting its callback replace a resent challenge", async () => {
    const owner = { uid: "native-owner", phoneNumber: null, getIdToken: vi.fn().mockResolvedValue("native-email-session") } as any;
    mockAuth.currentUser = owner;
    vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(owner);
    state.proof.cancelPhoneVerificationProof.mockResolvedValue(undefined);
    const late = deferred<any>();
    let oldAttempt = "";
    state.proof.startPhoneLinkVerification.mockImplementationOnce(({ attemptId }) => { oldAttempt = attemptId; return late.promise; });
    const retired = new AbortController();
    const pending = AuthService.startPhoneLinkVerification("+16505550101", { signal: retired.signal });
    await vi.waitFor(() => expect(oldAttempt).not.toBe(""));
    const rejected = expect(pending).rejects.toMatchObject({ code: "session_changed" });
    retired.abort();
    await rejected;
    state.proof.startPhoneLinkVerification.mockImplementation(async ({ attemptId, linkIntent }) => ({ attemptId, verificationId: attemptId, providerVerificationId: "native-provider-challenge", linkIntent }));
    const current = new AbortController();
    const fresh = await AuthService.startPhoneLinkVerification("+16505550101", { resendCode: true, signal: current.signal });
    expect(state.proof.startPhoneLinkVerification).toHaveBeenLastCalledWith(expect.objectContaining({ resendCode: true }));
    late.resolve({ attemptId: oldAttempt, verificationId: oldAttempt });
    await Promise.resolve();
    const linked = { ...owner, phoneNumber: "+16505550101" };
    vi.spyOn(AuthService, "reloadPhoneVerificationUser").mockResolvedValue(linked);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ localId: owner.uid, phoneNumber: linked.phoneNumber })));
    await expect(AuthService.confirmPhoneLinkVerification({
      verificationId: fresh.verificationId, verificationCode: "123456", expectedUserId: owner.uid,
      phoneNumber: linked.phoneNumber,
    })).resolves.toBe(linked);
    current.abort();
  });
  it.each(["link", "replace"] as const)("confirms a native %s on the captured Firebase UID", async intent => {
    vi.useFakeTimers();
    const primary = { uid: "native-user", phoneNumber: intent === "replace" ? "+16505550100" : null, getIdToken: vi.fn().mockResolvedValue("native-email-session") } as any;
    const linked = { ...primary, phoneNumber: "+16505550101" };
    mockAuth.currentUser = primary;
    state.proof.startPhoneLinkVerification.mockImplementation(async ({ attemptId, linkIntent }) => ({
      attemptId, verificationId: attemptId, providerVerificationId: "native-provider-challenge", linkIntent,
    }));
    vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue(primary);
    const start = intent === "replace"
      ? await AuthService.startPhoneReplacementVerification(linked.phoneNumber, { expectedUserId: primary.uid })
      : await AuthService.startPhoneLinkVerification(linked.phoneNumber, { expectedUserId: primary.uid });
    await vi.advanceTimersByTimeAsync(180_000);
    vi.spyOn(AuthService, "reloadPhoneVerificationUser").mockResolvedValue(linked);
    const exchange = vi.fn().mockResolvedValue(Response.json({
      localId: primary.uid, phoneNumber: linked.phoneNumber,
      idToken: "unadopted-phone-id-token", refreshToken: "unadopted-phone-refresh-token",
    }));
    vi.stubGlobal("fetch", exchange);
    const params = {
      verificationId: start.verificationId, verificationCode: "123456", expectedUserId: primary.uid,
      phoneNumber: linked.phoneNumber,
    };
    const result = intent === "replace"
      ? await AuthService.confirmPhoneReplacementVerification(params)
      : await AuthService.confirmPhoneLinkVerification(params);
    expect(result).toBe(linked);
    expect(exchange.mock.calls[0][0]).toContain("key=selected-auth-key");
    expect(state.proof.startPhoneLinkVerification).toHaveBeenCalledWith(expect.objectContaining({
      linkIntent: intent, expectedUserId: primary.uid,
    }));
    expect(JSON.parse(exchange.mock.calls[0][1].body)).toEqual({
      idToken: "native-email-session", code: "123456", sessionInfo: "native-provider-challenge",
    });
    expect(state.proof.confirmPhoneVerificationProof).not.toHaveBeenCalled();
    expect(state.proof.signIn).not.toHaveBeenCalled();
    expect(FirebaseAuthentication.confirmVerificationCode).not.toHaveBeenCalled();
    expect(FirebaseAuthentication.unlink).not.toHaveBeenCalled();
  });

  it("refuses to confirm on an older native bridge that can only mint a separate phone session", async () => {
    vi.spyOn(AuthService, "restoreNativeSession").mockResolvedValue({ uid: "native-user", phoneNumber: null } as any);
    state.proof.startPhoneLinkVerification.mockRejectedValue({ code: "UNIMPLEMENTED" });
    await expect(AuthService.startPhoneLinkVerification("+16505550101")).rejects.toMatchObject({
      code: "phone-link-upgrade-required",
    });
    expect(state.proof.startPhoneVerificationProof).not.toHaveBeenCalled();
    expect(state.proof.cancelPhoneVerificationProof).toHaveBeenCalled();
    expect(state.proof.confirmPhoneVerificationProof).not.toHaveBeenCalled();
  });

  it("does not request a new web OTP for the same already-linked provider phone", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    mockAuth.currentUser = { uid: "web-user", phoneNumber: "+16505550101" };
    await expect(AuthService.startPhoneLinkVerification("+16505550101")).rejects.toMatchObject({
      code: "phone-already-linked-to-current-user",
    });
    expect(mockPhoneAuthProvider).not.toHaveBeenCalled();
    expect(linkWithCredential).not.toHaveBeenCalled();
  });
});
