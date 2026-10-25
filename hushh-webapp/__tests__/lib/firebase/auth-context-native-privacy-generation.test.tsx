import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authStateListener: null as ((user: unknown) => void) | null,
  privacyState: { shielded: false, generation: 0, cause: "inactive" as "inactive" | "background" | "restart", appIsActive: true },
  privacyListener: null as ((state: unknown) => void) | null,
  routerReplace: vi.fn(),
  restoreNativeSession: vi.fn(),
  authServiceSignOut: vi.fn(),
  apiGetAccountSessionStatus: vi.fn(),
  completePrivacyValidation: vi.fn(),
  preparePrivacyValidation: vi.fn(async () => undefined),
  getPrivacyState: vi.fn(),
  phoneStart: vi.fn(),
  phoneConfirm: vi.fn(),
  phoneTestStart: vi.fn(),
  phoneFinalize: vi.fn(),
  phoneTestConfirm: vi.fn(),
  identityRefresh: vi.fn(),
  identityPeek: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn(
    (_auth: unknown, listener: (user: unknown) => void) => {
      mocks.authStateListener = listener;
      listener(null);
      return vi.fn();
    },
  ),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
  },
}));

vi.mock("@/lib/capacitor/session-privacy", () => ({
  getNativeSessionPrivacyState: mocks.getPrivacyState,
  completeNativeSessionPrivacyValidation: mocks.completePrivacyValidation,
  prepareNativeSessionPrivacyValidation: mocks.preparePrivacyValidation,
  nativeProfilePreparationExpected: () => null,
  nativeProfilePreparationRevision: () => 0,
  subscribeNativeProfilePreparation: () => () => undefined,
  nativeSessionPreparationRevision: () => 0,
  subscribeNativeSessionPrivacy: vi.fn(async (listener: (state: unknown) => void) => {
    mocks.privacyListener = listener;
    return { remove: async () => { mocks.privacyListener = null; } };
  }),
}));

vi.mock("@/lib/firebase/config", () => ({
  auth: { currentUser: null },
  prepareRecaptchaVerifier: vi.fn(),
  resetRecaptcha: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: vi.fn(() => null),
    restoreNativeSession: mocks.restoreNativeSession,
    signOut: mocks.authServiceSignOut,
    startPhoneLinkVerification: mocks.phoneStart,
    startPhoneReplacementVerification: mocks.phoneStart,
    confirmPhoneLinkVerification: mocks.phoneConfirm,
    confirmPhoneReplacementVerification: mocks.phoneConfirm,
    isUatPhoneTestVerificationId: (id?: string) => String(id ?? "").startsWith("uat-test-phone:"),
    isLocalDevPhoneVerificationId: () => false,
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: mocks.identityPeek,
    refreshCurrentUserIdentity: mocks.identityRefresh,
    startUatTestPhoneVerification: mocks.phoneTestStart,
    finalizeNativePhoneVerification: mocks.phoneFinalize,
    confirmUatTestPhoneVerification: mocks.phoneTestConfirm,
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null) => identity?.phone_verified === true,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onAuthSignedOut: vi.fn() },
}));

vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    clearMarketingSeen: vi.fn().mockResolvedValue(undefined),
    markForceIntroOnce: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingFlowActiveCookie: vi.fn(),
  setOnboardingRequiredCookie: vi.fn(),
}));

vi.mock("@/lib/services/user-local-state-service", () => ({
  UserLocalStateService: { clearForUser: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/lib/utils/session-storage", () => ({
  clearSessionStorage: vi.fn(),
  removeLocalItem: vi.fn(),
  removeSessionItem: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getAccountSessionStatus: mocks.apiGetAccountSessionStatus,
    getAccountRegistrationStatus: vi.fn(async () => new Response(null, { status: 404 })),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/observability/identity", () => ({
  setObservabilityUserId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/connected-systems/crm-product-availability", () => ({
  isLocalCrmBuildEnabled: () => false,
}));

import { AuthProvider, useAuth } from "@/lib/firebase/auth-context";
import {
  AUTH_SESSION_VERIFICATION_REQUIRED_EVENT,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeUser(uid = "native-account-owner"): User {
  return {
    uid,
    displayName: "Native owner",
    email: null,
    phoneNumber: "+14155550100",
    photoURL: null,
    getIdToken: vi.fn().mockResolvedValue("native-owner-token"),
  } as unknown as User;
}

function NativePhoneProbe() {
  const { phoneNumber, startPhoneVerification, confirmPhoneVerification, startPhoneReplacement, confirmPhoneReplacement } = useAuth();
  const [status, setStatus] = useState("idle");
  const start = async (replace: boolean) => {
    try {
      const result = await (replace ? startPhoneReplacement : startPhoneVerification)("+12025550101");
      setStatus(result.autoVerified ? "verified" : "code ready");
    } catch (error) { setStatus((error as Error).message); }
  };
  const confirm = async (replace: boolean) => {
    try {
      await (replace ? confirmPhoneReplacement : confirmPhoneVerification)("123456");
      setStatus("verified");
    } catch (error) { setStatus((error as Error).message); }
  };
  return <>
    <p data-testid="native-phone-status">{status}</p>
    <p data-testid="native-published-phone">{phoneNumber}</p>
    <button onClick={() => void start(false)}>Start native phone</button>
    <button onClick={() => void start(true)}>Start native replacement</button>
    <button onClick={() => void confirm(false)}>Confirm native phone</button>
    <button onClick={() => void confirm(true)}>Confirm native replacement</button>
  </>;
}

function SessionProbe() {
  const {
    beginPostAuthSettlement,
    completePostAuthSettlement,
    admitPostAuthSettlement,
    loading,
    sessionVerificationRequired,
    retrySessionVerification,
    user,
  } = useAuth();
  const settlementIdRef = useRef<number | null>(null);

  return (
    <>
      <p data-testid="published-user">{user?.uid ?? "anonymous"}</p>
      <button onClick={() => void retrySessionVerification()}>Retry session</button>
      {loading ? (
        <p>Checking session</p>
      ) : sessionVerificationRequired ? (
        <p>Verification required</p>
      ) : (
        <p>{user ? `Native content for ${user.uid}` : "Signed out"}</p>
      )}
      <button
        type="button"
        onClick={() => {
          settlementIdRef.current = beginPostAuthSettlement(
            makeUser("interactive-account-b"),
          );
        }}
      >
        Start account B settlement
      </button>
      <button
        type="button"
        onClick={() => {
          const id = settlementIdRef.current;
          if (id !== null) void admitPostAuthSettlement(id).then(owner => {
            if (owner) completePostAuthSettlement(id);
          });
        }}
      >
        Complete account B settlement
      </button>
    </>
  );
}

function emitPrivacy(overrides: Partial<typeof mocks.privacyState>, action = "state") {
  mocks.privacyState = { ...mocks.privacyState, ...overrides };
  mocks.privacyListener?.({ ...mocks.privacyState, action });
}

function activeSessionResponse(uid = "native-account-owner"): Response {
  return Response.json({ active: true, firebase_uid: uid, owner_id: uid, account_generation: 0 }, { status: 200 });
}

describe("AuthProvider native privacy generations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGetAccountSessionStatus.mockReset();
    mocks.restoreNativeSession.mockReset();
    mocks.getPrivacyState.mockReset();
    mocks.completePrivacyValidation.mockReset();
    mocks.phoneStart.mockReset().mockResolvedValue({ autoVerified: false, verificationId: "native-verification" });
    mocks.phoneConfirm.mockReset().mockResolvedValue(makeUser());
    mocks.phoneTestStart.mockReset().mockResolvedValue({ success: true, eligible: false, reason: "uat_phone_test_not_configured_or_not_allowlisted" });
    mocks.phoneFinalize.mockReset().mockResolvedValue(undefined);
    mocks.phoneTestConfirm.mockReset().mockResolvedValue({ user_id: "native-account-owner", phone_verified: true, phone_number: "+12025550101" });
    mocks.identityRefresh.mockReset().mockResolvedValue(null);
    mocks.identityPeek.mockReset().mockReturnValue(null);
    mocks.privacyState = { shielded: false, generation: 0, cause: "inactive", appIsActive: true };
    mocks.privacyListener = null;
    mocks.getPrivacyState.mockImplementation(() => Promise.resolve({ ...mocks.privacyState }));
    mocks.completePrivacyValidation.mockResolvedValue({
      released: true,
      shielded: false,
      generation: 0,
      cause: "inactive",
      appIsActive: true,
    });
  });

  afterEach(() => vi.useRealTimers());

  it.each(["manual", "replacement", "automatic"])("waits for backend persistence before native %s verification succeeds", async (mode) => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    const saved = deferred<void>();
    mocks.phoneFinalize.mockReturnValueOnce(saved.promise);
    if (mode === "automatic") mocks.phoneStart.mockResolvedValue({ autoVerified: true, user: makeUser() });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    fireEvent.click(screen.getByRole("button", { name: mode === "replacement" ? "Start native replacement" : "Start native phone" }));
    if (mode !== "automatic") {
      await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("code ready"));
      fireEvent.click(screen.getByRole("button", { name: mode === "replacement" ? "Confirm native replacement" : "Confirm native phone" }));
    }
    await waitFor(() => expect(mocks.phoneFinalize).toHaveBeenCalledOnce());
    expect(mocks.phoneFinalize).toHaveBeenCalledWith(expect.objectContaining({ uid: "native-account-owner" }), "+12025550101");
    expect(screen.getByTestId("native-phone-status")).not.toHaveTextContent("verified");
    await act(async () => { saved.resolve(); });
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("verified"));
  });

  it("stops an occupied test number before native OTP linking", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneTestStart.mockResolvedValue({ success: true, eligible: false, reason: "phone_test_number_in_use" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    fireEvent.click(screen.getByRole("button", { name: "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("already linked to another account"));
    expect(mocks.phoneStart).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
  });

  it.each([null,
    { success: false, eligible: false, reason: "uat_phone_test_start_503" },
    { success: true, eligible: true },
    { success: true, eligible: false, reason: "unknown" },
  ])("does not link natively after unavailable or malformed test ownership evidence: %j", async (response) => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneTestStart.mockResolvedValue(response);
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    fireEvent.click(screen.getByRole("button", { name: "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("temporarily unavailable"));
    expect(mocks.phoneStart).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
  });

  it.each(["link-confirm", "replacement-confirm", "link-restart", "replacement-restart", "automatic", "automatic-restored"])("retries only persistence after native provider success and a save outage: %s", async (mode) => {
    const linked = { ...makeUser(), phoneNumber: "+12025550101" };
    const replacement = mode.startsWith("replacement");
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneFinalize.mockRejectedValueOnce(new Error("save temporarily unavailable"));
    const providerSucceeded = () => { mocks.restoreNativeSession.mockResolvedValue(linked); return linked; };
    mocks.phoneConfirm.mockImplementation(async () => providerSucceeded());
    if (mode.startsWith("automatic")) mocks.phoneStart.mockImplementation(async () => {
      const user = providerSucceeded();
      return { autoVerified: true, ...(mode === "automatic" ? { user } : {}) };
    });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    const start = screen.getByRole("button", { name: replacement ? "Start native replacement" : "Start native phone" });
    const confirm = screen.getByRole("button", { name: replacement ? "Confirm native replacement" : "Confirm native phone" });
    fireEvent.click(start);
    if (!mode.startsWith("automatic")) {
      await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("code ready"));
      fireEvent.click(confirm);
    }
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("save temporarily unavailable"));
    expect(screen.getByTestId("native-phone-status")).not.toHaveTextContent("verified");
    expect(screen.getByTestId("native-published-phone")).toHaveTextContent("+14155550100");
    fireEvent.click(mode.endsWith("confirm") ? confirm : start);
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("verified"));
    expect(mocks.phoneStart).toHaveBeenCalledTimes(1);
    expect(mocks.phoneConfirm).toHaveBeenCalledTimes(mode.startsWith("automatic") ? 0 : 1);
    expect(mocks.phoneFinalize).toHaveBeenCalledTimes(2);
    expect(mocks.restoreNativeSession).toHaveBeenCalledWith({ nativeOnly: true });
  });

  it("refuses synchronization recovery when the native provider changed accounts", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    mocks.restoreNativeSession.mockResolvedValue({ ...makeUser("another-owner"), phoneNumber: "+12025550101" });
    fireEvent.click(screen.getByRole("button", { name: "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("account changed"));
    expect(mocks.phoneStart).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
    expect(screen.getByTestId("published-user")).toHaveTextContent("native-account-owner");
  });

  it("retains native backend-only test-code verification without linking or replaying an SDK OTP", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneTestStart.mockResolvedValue({ success: true, eligible: true, verification_id: "uat-test-phone:owned-challenge" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    mocks.restoreNativeSession.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("code ready"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("verified"));
    expect(mocks.phoneTestConfirm).toHaveBeenCalledWith(expect.objectContaining({ uid: "native-account-owner" }), { phoneNumber: "+12025550101", verificationCode: "123456", verificationId: "uat-test-phone:owned-challenge" });
    expect(mocks.phoneStart).not.toHaveBeenCalled();
    expect(mocks.phoneConfirm).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
  });

  it.each([false, true])("freshly confirms an existing backend-only native phone without another challenge or SDK operation: replacement=%s", async (replacement) => {
    const user = { ...makeUser(), phoneNumber: null };
    const identity = { user_id: user.uid, phone_verified: true, phone_number: "+12025550101", source: "uat_phone_test" };
    mocks.restoreNativeSession.mockResolvedValue(user);
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    mocks.identityRefresh.mockImplementation(async (_user, options) => options?.requireSuccess ? identity : null);
    mocks.phoneTestStart.mockResolvedValue({ success: true, eligible: true, verification_id: "uat-test-phone:owned-challenge" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(user.uid));
    mocks.restoreNativeSession.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: replacement ? "Start native replacement" : "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).toHaveTextContent("verified"));
    expect(mocks.identityRefresh).toHaveBeenCalledWith(user, { force: true, requireSuccess: true });
    expect(mocks.phoneTestStart).not.toHaveBeenCalled();
    expect(mocks.phoneStart).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
  });

  it.each([null,
    { user_id: "another-owner", phone_verified: true, phone_number: "+12025550101" },
    { user_id: "native-account-owner", phone_verified: false, phone_number: "+12025550101" },
    { user_id: "native-account-owner", phone_verified: true, phone_number: "+12025550102" },
  ])("does not complete a retained native phone from cached hints when fresh evidence differs: %j", async (identity) => {
    const user = { ...makeUser(), phoneNumber: null };
    mocks.restoreNativeSession.mockResolvedValue(user);
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.identityPeek.mockReturnValue({ data: { user_id: user.uid, phone_verified: true, phone_number: "+12025550101", source: "uat_phone_test" }, isStale: false });
    mocks.identityRefresh.mockImplementation(async (_user, options) => options?.requireSuccess ? identity : null);
    mocks.phoneTestStart.mockResolvedValue({ success: true, eligible: true, verification_id: "uat-test-phone:owned-challenge" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(user.uid));
    fireEvent.click(screen.getByRole("button", { name: "Start native phone" }));
    await waitFor(() => expect(screen.getByTestId("native-phone-status")).not.toHaveTextContent("idle"));
    expect(screen.getByTestId("native-phone-status")).not.toHaveTextContent("verified");
    expect(mocks.phoneStart).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
  });

  it("automatically recovers a transient native restore failure before a UID is known", async () => {
    vi.useFakeTimers();
    mocks.restoreNativeSession
      .mockRejectedValueOnce(new Error("bridge temporarily unavailable"))
      .mockResolvedValueOnce(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    const view = render(<AuthProvider><SessionProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(screen.getByTestId("published-user")).toHaveTextContent("anonymous");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_001); });
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Verification required")).not.toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(2);
  });

  it("cancels anonymous native recovery when unmounted before the retry", async () => {
    vi.useFakeTimers();
    mocks.restoreNativeSession.mockRejectedValue(new Error("bridge unavailable"));
    const view = render(<AuthProvider><SessionProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(1);
  });

  it("does not overlap automatic native restoration with manual retries", async () => {
    vi.useFakeTimers();
    const restoration = deferred<User | null>();
    mocks.restoreNativeSession.mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockReturnValueOnce(restoration.promise);
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_001); });
    await act(async () => {
      screen.getByRole("button", { name: "Retry session" }).click();
      screen.getByRole("button", { name: "Retry session" }).click();
    });
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("published-user")).toHaveTextContent("anonymous");
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    await act(async () => { restoration.resolve(makeUser()); });
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Verification required")).not.toBeInTheDocument();
  });

  it("exits a stalled native restore and retries without publishing its late result", async () => {
    vi.useFakeTimers();
    const stalledRestore = deferred<User | null>();
    mocks.restoreNativeSession.mockReturnValueOnce(stalledRestore.promise);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    await act(async () => { stalledRestore.resolve(makeUser("late-account")); });
    expect(screen.getByTestId("published-user")).toHaveTextContent("anonymous");
    mocks.restoreNativeSession.mockResolvedValueOnce(null);
    await act(async () => { screen.getByRole("button", { name: "Retry session" }).click(); });
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(2);
  });

  it("renders recovery when the native privacy read never settles", async () => {
    vi.useFakeTimers();
    mocks.getPrivacyState.mockReturnValue(new Promise(() => {}));
    mocks.restoreNativeSession.mockResolvedValue(null);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_001); });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("releases the native privacy cover without revalidating a restored session", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    await screen.findByText("Native content for native-account-owner");

    mocks.apiGetAccountSessionStatus.mockClear();
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background", appIsActive: true }));

    await waitFor(() => {
      expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1);
    });
    expect(screen.getByText("Native content for native-account-owner")).toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(screen.queryByText("Verification required")).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("catches up after a foreground transition whose native privacy event was missed", async () => {
    mocks.restoreNativeSession.mockResolvedValue(null);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Signed out");

    mocks.getPrivacyState.mockClear();
    mocks.completePrivacyValidation.mockClear();
    mocks.privacyState = {
      shielded: true, generation: 7, cause: "background", appIsActive: true,
    };
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(7));
    expect(mocks.getPrivacyState).toHaveBeenCalled();
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Signed out")).toBeInTheDocument();
  });

  it("catches up when foreground precedes native restoration and the privacy event is missed", async () => {
    const restore = deferred<User | null>();
    mocks.restoreNativeSession.mockReturnValue(restore.promise);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await waitFor(() => expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(1));
    mocks.privacyState = {
      shielded: true, generation: 8, cause: "background", appIsActive: false,
    };
    act(() => window.dispatchEvent(new Event("focus")));
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();

    await act(async () => { restore.resolve(null); });
    await screen.findByText("Signed out");
    mocks.privacyState.appIsActive = true;
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(8));
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(1);
  });

  it("rechecks an initially inactive foreground state without a native event", async () => {
    mocks.restoreNativeSession.mockResolvedValue(null);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Signed out");

    mocks.getPrivacyState.mockClear();
    mocks.privacyState = {
      shielded: true, generation: 9, cause: "background", appIsActive: false,
    };
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(mocks.getPrivacyState).toHaveBeenCalled());
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    mocks.privacyState.appIsActive = true;
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(9));
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(1);
  });

  it("releases successive native privacy generations without account checks", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    await screen.findByText("Native content for native-account-owner");
    mocks.apiGetAccountSessionStatus.mockClear();

    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background", appIsActive: true }));
    await waitFor(() => {
      expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1);
    });

    act(() => emitPrivacy({ shielded: true, generation: 2, cause: "background", appIsActive: true }));
    await waitFor(() => {
      expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(2);
    });
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(
      screen.getByText("Native content for native-account-owner"),
    ).toBeInTheDocument();
  });

  it("does not let an old native restore result sign out an interactive account switch", async () => {
    const oldAccountStatus = deferred<Response>();
    mocks.restoreNativeSession.mockResolvedValue(makeUser("old-account-a"));
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(
      oldAccountStatus.promise,
    );

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    });

    mocks.apiGetAccountSessionStatus.mockImplementation(async () => activeSessionResponse("interactive-account-b"));
    act(() => {
      screen.getByRole("button", {
        name: "Start account B settlement",
      }).click();
    });
    expect(screen.getByTestId("published-user")).toHaveTextContent(
      "interactive-account-b",
    );

    await act(async () => {
      oldAccountStatus.resolve(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          }),
          { status: 401 },
        ),
      );
      await oldAccountStatus.promise;
    });
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole("button", {
        name: "Complete account B settlement",
      }).click();
    });
    expect(
      await screen.findByText("Native content for interactive-account-b"),
    ).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("releases an inactive-only sheet return after render without revalidating settled auth", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    mocks.completePrivacyValidation.mockImplementation(async (generation: number) => {
      expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
      expect(screen.getByText("Native content for native-account-owner")).toBeInTheDocument();
      return { released: true, shielded: false, generation, cause: "inactive", appIsActive: true };
    });
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "inactive", appIsActive: false }));
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    act(() => emitPrivacy({ appIsActive: true }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    expect(mocks.restoreNativeSession).toHaveBeenCalledTimes(1);
  });

  it("waits for actual native activation after an early foreground callback", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    mocks.apiGetAccountSessionStatus.mockClear();
    act(() => {
      emitPrivacy({ shielded: true, generation: 1, cause: "background", appIsActive: false });
    });
    await act(async () => Promise.resolve());
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    act(() => emitPrivacy({ appIsActive: true }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
  });

  it("reconciles a refused acknowledgement without repeating account validation", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.completePrivacyValidation.mockResolvedValueOnce({
      released: false, shielded: true, generation: 1, cause: "background", appIsActive: true,
    });
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background" }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate when a privacy generation changes cause", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    mocks.apiGetAccountSessionStatus.mockClear();
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "inactive", appIsActive: true }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    mocks.completePrivacyValidation.mockClear();
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background", appIsActive: true }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
  });

  it("reconciles a native privacy retry without revalidating the session", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    mocks.apiGetAccountSessionStatus.mockClear();
    mocks.completePrivacyValidation.mockClear();
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background" }, "retry"));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(screen.getByText("Native content for native-account-owner")).toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("restores identity and acknowledges the new document after a native restart", async () => {
    mocks.privacyState = { shielded: true, generation: 9, cause: "restart", appIsActive: true };
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(9));
    expect(screen.getByText("Native content for native-account-owner")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalledWith(8);
  });

  it("revalidates a current transport availability event without signing out", async () => {
    const unavailable = deferred<Response>();
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(activeSessionResponse())
      .mockReturnValueOnce(unavailable.promise);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    const owner = snapshotValidatedAuthSessionOwner();
    act(() => {
      for (let index = 0; index < 2; index += 1) {
        window.dispatchEvent(new CustomEvent(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, {
          detail: { ...owner, reason: "credential_refresh_unavailable" },
        }));
      }
    });
    await waitFor(() => expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    await act(async () => unavailable.resolve(Response.json({}, { status: 503 })));
    await screen.findByText("Verification required");
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("published-user")).toHaveTextContent("native-account-owner");
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("ignores availability events from an obsolete identity generation", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    const owner = snapshotValidatedAuthSessionOwner()!;
    act(() => window.dispatchEvent(new CustomEvent(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, {
      detail: { ...owner, generation: owner.generation - 1, reason: "late_response" },
    })));
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Native content for native-account-owner")).toBeInTheDocument();
  });
});
