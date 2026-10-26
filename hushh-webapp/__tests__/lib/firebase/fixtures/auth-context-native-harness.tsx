
import type { User } from "firebase/auth";
import { useRef, useState } from "react";
import { vi } from "vitest";

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
    isManualPhoneProof: (id?: string) => String(id ?? "").startsWith("native-phone-proof:"),
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

import { useAuth } from "@/lib/firebase/auth-context";

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

function NativePhoneProbe({ transport }: { transport?: "sms" } = {}) {
  const { phoneNumber, startPhoneVerification, confirmPhoneVerification, startPhoneReplacement, confirmPhoneReplacement } = useAuth();
  const [status, setStatus] = useState("idle");
  const start = async (replace: boolean) => {
    try {
      const result = await (replace ? startPhoneReplacement : startPhoneVerification)("+12025550101", transport ? { transport } : undefined);
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

function resetNativeAuthMocks() {
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
}

function cleanupNativeAuthMocks() {
    vi.useRealTimers();
}

export { mocks, deferred, makeUser, NativePhoneProbe, SessionProbe, emitPrivacy, activeSessionResponse, resetNativeAuthMocks, cleanupNativeAuthMocks };
