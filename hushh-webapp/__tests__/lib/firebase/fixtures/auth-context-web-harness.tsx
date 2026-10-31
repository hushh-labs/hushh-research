import { render } from "@testing-library/react";
import type { User } from "firebase/auth";
import { useRef, useState } from "react";
import { vi } from "vitest";
import { clearAccountDeletionActive } from "@/lib/auth/account-deletion-activity";

const mocks = vi.hoisted(() => ({
  authStateListener: null as ((user: unknown) => void) | null,
  firebaseUser: null as unknown,
  lifecycleListeners: new Set<() => void>(),
  lifecycleState: "active" as "active" | "background",
  routerReplace: vi.fn(),
  authServiceGetIdToken: vi.fn(),
  authServiceGetCurrentUser: vi.fn(),
  authServiceRestoreNativeSession: vi.fn(),
  authServiceSignOut: vi.fn(),
  apiGetAccountSessionStatus: vi.fn(),
  apiGetAccountRegistrationStatus: vi.fn(),
  apiStartFreshAccount: vi.fn(),
  apiGetAccountDeletionStatus: vi.fn(),
  apiGetAccountCleanupStatus: vi.fn(),
  apiContinueAccountCleanup: vi.fn(),
  apiDeleteSession: vi.fn(),
  cacheSignedOut: vi.fn(),
  clearForUser: vi.fn(),
  clearDeviceSecretsForDeletedAccount: vi.fn(),
  identityRefresh: vi.fn(),
  identityPeek: vi.fn(),
  identityClaim: vi.fn(),
  phoneClaimToken: vi.fn(),
  phoneTestStart: vi.fn(),
  phoneLinkStart: vi.fn(),
  phoneReplacementConfirm: vi.fn(),
  phoneReplacementStart: vi.fn(),
  phoneFinalize: vi.fn(),
  clearMarketingSeen: vi.fn(),
  markForceIntroOnce: vi.fn(),
  clearLocalChatNotificationState: vi.fn().mockResolvedValue(undefined),
  deleteFCMToken: vi.fn(),
  replaceDocument: vi.fn(),
}));

vi.mock("@/lib/notifications/fcm-service", () => ({
  clearLocalChatNotificationState: vi.fn().mockResolvedValue(undefined),
  deleteFCMToken: mocks.deleteFCMToken,
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  replaceWindowLocation: mocks.replaceDocument,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("firebase/auth", () => ({
  getAuth: () => ({ settings: {} }),
  RecaptchaVerifier: class {
    render() { return Promise.resolve(1); }
    clear() { return undefined; }
  },
  onAuthStateChanged: vi.fn(
    (_auth: unknown, listener: (user: unknown) => void) => {
      mocks.authStateListener = listener;
      listener(mocks.firebaseUser);
      return vi.fn();
    },
  ),
}));

vi.mock("@capacitor/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@capacitor/core")>(),
  Capacitor: {
    getPlatform: () => "web",
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/capacitor/session-privacy", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/capacitor/session-privacy")>(),
  subscribeNativeProfilePreparation: () => () => undefined,
  nativeProfilePreparationRevision: () => 0,
  getNativeSessionPrivacyState: vi.fn().mockResolvedValue({
    shielded: false,
    generation: 0,
  }),
  completeNativeSessionPrivacyValidation: vi.fn().mockResolvedValue({
    released: true,
    shielded: false,
    generation: 0,
  }),
}));

vi.mock("@/lib/firebase/config", () => ({
  auth: { currentUser: null },
  prepareRecaptchaVerifier: vi.fn(),
  resetRecaptcha: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: mocks.authServiceGetIdToken,
    getCurrentUser: mocks.authServiceGetCurrentUser,
    restoreNativeSession: mocks.authServiceRestoreNativeSession,
    signOut: mocks.authServiceSignOut,
    shouldUseLocalDevPhoneVerification: () => false,
    startPhoneLinkVerification: mocks.phoneLinkStart,
    startPhoneReplacementVerification: mocks.phoneReplacementStart,
    confirmPhoneReplacementVerification: mocks.phoneReplacementConfirm,
    isLocalDevPhoneVerificationId: () => false,
    isUatPhoneTestVerificationId: () => false,
    getPhoneClaimIdToken: mocks.phoneClaimToken,
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: mocks.identityPeek,
    refreshCurrentUserIdentity: mocks.identityRefresh,
    claimCurrentUserPhone: mocks.identityClaim,
    finalizeNativePhoneVerification: mocks.phoneFinalize,
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null) =>
      identity?.phone_verified === true,
    startUatTestPhoneVerification: mocks.phoneTestStart,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onAuthSignedOut: mocks.cacheSignedOut, onAccountDeleted: vi.fn() },
}));

vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    clearMarketingSeen: mocks.clearMarketingSeen,
    markForceIntroOnce: mocks.markForceIntroOnce,
  },
}));

vi.mock("@/lib/services/onboarding-route-cookie", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/onboarding-route-cookie")>(),
  setOnboardingFlowActiveCookie: vi.fn(),
  setOnboardingRequiredCookie: vi.fn(),
}));

vi.mock("@/lib/services/user-local-state-service", () => ({
  UserLocalStateService: {
    clearForUser: mocks.clearForUser,
    clearDeviceSecretsForDeletedAccount:
      mocks.clearDeviceSecretsForDeletedAccount,
  },
}));

vi.mock("@/lib/utils/session-storage", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/utils/session-storage")>(),
  clearSessionStorage: vi.fn(),
  removeLocalItem: vi.fn(),
  removeSessionItem: vi.fn(),
}));

vi.mock("@/lib/interaction/interaction-intent-coordinator", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/interaction/interaction-intent-coordinator")>(),
  appInteractionCoordinator: {
    getLifecycleSnapshot: () => ({ state: mocks.lifecycleState }),
    subscribeLifecycle: (listener: () => void) => {
      mocks.lifecycleListeners.add(listener);
      return () => mocks.lifecycleListeners.delete(listener);
    },
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getAccountSessionStatus: mocks.apiGetAccountSessionStatus,
    getAccountRegistrationStatus: mocks.apiGetAccountRegistrationStatus,
    startFreshAccount: mocks.apiStartFreshAccount,
    getAccountDeletionStatus: mocks.apiGetAccountDeletionStatus,
    getAccountCleanupStatus: mocks.apiGetAccountCleanupStatus,
    continueAccountCleanup: mocks.apiContinueAccountCleanup,
    deleteSession: mocks.apiDeleteSession,
  },
}));

vi.mock("@/lib/observability/identity", () => ({
  setObservabilityUserId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/connected-systems/crm-product-availability", () => ({
  isLocalCrmBuildEnabled: () => false,
}));

import { AuthProvider, useAuth } from "@/lib/firebase/auth-context";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { AUTH_SESSION_INVALIDATED_EVENT, type AuthSessionInvalidationDetail } from "@/lib/auth/session-invalidation";
import { AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeUser(uid = "account-owner", phoneNumber = "+14155550100"): User {
  return {
    uid,
    displayName: "Account Owner",
    email: "owner@example.test",
    phoneNumber,
    photoURL: null,
    getIdToken: vi.fn().mockResolvedValue("persisted-token"),
  } as unknown as User;
}

function activeSessionResponse(firebaseUid = (mocks.firebaseUser as User)?.uid ?? "account-owner", ownerId = firebaseUid, generation = 0): Response {
  return Response.json({ active: true, firebase_uid: firebaseUid, owner_id: ownerId, account_generation: generation }, { status: 200 });
}

function cleanupStatusResponse(state: "cleaning_up" | "action_required" | "complete" = "cleaning_up", localErasure = false): Response {
  return Response.json({ operation: {
    id: "b99efb85-c1f2-4714-8a63-614d774a25a3", state, credential_count: 1,
    local_erasure_confirmation_required: localErasure, external_validity_unconfirmed_count: localErasure ? 1 : 0,
    inventory_sha256: "a".repeat(64), retry_after_seconds: state === "cleaning_up" ? 3 : null,
  } });
}

function deletionInProgressResponse(): Response {
  return Response.json({ detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" } },
    { status: 423, headers: { "Retry-After": "0" } });
}

function emitLifecycle(state: "active" | "background") {
  mocks.lifecycleState = state;
  for (const listener of mocks.lifecycleListeners) listener();
}

function requestExplicitSessionVerification() {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner) throw new Error("Expected a published auth session owner.");
  window.dispatchEvent(
    new CustomEvent(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, {
      detail: { ...owner, reason: "test_explicit_verification" },
    }),
  );
}

function dispatchInvalidation(detail: AuthSessionInvalidationDetail) {
  window.dispatchEvent(
    new CustomEvent<AuthSessionInvalidationDetail>(
      AUTH_SESSION_INVALIDATED_EVENT,
      { detail },
    ),
  );
}

function dispatchAccountNotFoundInvalidation() {
  window.dispatchEvent(
    new CustomEvent<AuthSessionInvalidationDetail>(
      AUTH_SESSION_INVALIDATED_EVENT,
      {
        detail: { code: "account_not_found", path: "test_duplicate" },
      },
    ),
  );
}

function SessionProbe() {
  const {
    loading,
    retrySessionVerification,
    sessionVerificationRequired,
    accountCleanup,
    signOut,
    user,
  } = useAuth();

  if (loading) return <p>Checking session</p>;
  if (sessionVerificationRequired) {
    return (
      <>
        <p>Verification required</p>
        {accountCleanup && <p>Cleanup: {accountCleanup.state}</p>}
        <button type="button" onClick={() => void retrySessionVerification()}>
          Retry verification
        </button>
      </>
    );
  }
  if (!user) return <p>Signed out</p>;
  return (
    <>
      <p>Vault content for {user.uid}</p>
      <button type="button" onClick={() => void signOut()}>Sign out</button>
      <button
        type="button"
        onClick={() =>
          void signOut({
            expectedUserId: "account-owner",
            skipFcmCleanup: true,
          })
        }
      >
        Finish account-A deletion
      </button>
    </>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <SessionProbe />
    </AuthProvider>,
  );
}

function CleanupInterfaceProbe() {
  const { sessionVerificationRequired,retrySessionVerification,signOut }=useAuth();
  return sessionVerificationRequired
    ? <SessionVerificationRecovery onRetry={retrySessionVerification} onSignOut={() => void signOut()} />
    : <SessionProbe />;
}

function ScopedSignOutRaceProbe() {
  const { signOut } = useAuth();
  return (
    <button
      type="button"
      onClick={() =>
        void signOut({
          redirectTo: "/login?auth_notice=account_deleted",
          expectedUserId: "account-owner",
          skipFcmCleanup: true,
        })
      }
    >
      Complete delayed deletion cleanup
    </button>
  );
}

function OrdinarySignOutProbe() {
  const { signOut } = useAuth();
  return <button onClick={() => void signOut()}>Leave profile</button>;
}

function InteractiveSettlementProbe() {
  const { beginPostAuthSettlement, admitPostAuthSettlement, completePostAuthSettlement } = useAuth();
  return <button onClick={() => {
    const settlement = beginPostAuthSettlement(mocks.firebaseUser as User);
    void admitPostAuthSettlement(settlement).finally(() => completePostAuthSettlement(settlement));
  }}>Complete interactive sign-in</button>;
}

function VerifiedPhoneProbe({ transport }: { transport?: "sms" } = {}) {
  const { phoneNumber, phoneNumberStatus, resolveVerifiedPhoneNumber, startPhoneVerification, confirmPhoneVerification } = useAuth();
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState("");
  return <>
    <p data-testid="verified-phone">{phoneNumber ?? "missing"}</p>
    <p data-testid="phone-status">{phoneNumberStatus}</p>
    <p data-testid="phone-error">{error}</p>
    <p data-testid="resolved-phone">{resolved}</p>
    <button onClick={() => void resolveVerifiedPhoneNumber().then((phone) => setResolved(phone ?? "missing"))}>Resolve saved phone</button>
    <button onClick={() => void startPhoneVerification("+12025550101", transport ? { transport } : undefined).catch((failure: Error) => setError(failure.message))}>Send phone OTP</button>
    <button onClick={() => void confirmPhoneVerification("123456").catch((failure: Error) => setError(failure.message))}>Confirm phone OTP</button>
  </>;
}

function RetainedPhoneProbe({ replacement }: { replacement: boolean }) {
  const { startPhoneVerification, confirmPhoneVerification, startPhoneReplacement, confirmPhoneReplacement } = useAuth();
  const [error, setError] = useState("");
  const retained = useRef<((otp: string) => Promise<User>) | null>(null);
  const start = replacement ? startPhoneReplacement : startPhoneVerification;
  const confirm = replacement ? confirmPhoneReplacement : confirmPhoneVerification;
  return <>
    <button onClick={() => void start("+12025550101")}>Start retained phone</button>
    <button onClick={() => { retained.current = confirm; }}>Retain confirmation</button>
    <button onClick={() => void confirm("123456").then(() => setError("Saved"), (failure: Error) => setError(failure.message))}>Confirm current phone</button>
    <button onClick={() => void retained.current?.("123456").catch((failure: Error) => setError(failure.message))}>Invoke retained confirmation</button>
    <p data-testid="retained-phone-error">{error}</p>
  </>;
}

function resetWebAuthMocks() {
    clearAccountDeletionActive("account-owner");
    vi.clearAllMocks();
    mocks.authStateListener = null;
    mocks.firebaseUser = makeUser();
    mocks.lifecycleListeners.clear();
    mocks.lifecycleState = "active";
    mocks.authServiceGetIdToken.mockResolvedValue("wrong-global-token");
    mocks.authServiceGetCurrentUser.mockImplementation(
      () => mocks.firebaseUser,
    );
    mocks.authServiceRestoreNativeSession.mockResolvedValue(null);
    mocks.authServiceSignOut.mockResolvedValue(undefined);
    mocks.apiGetAccountSessionStatus.mockReset().mockImplementation(async () => activeSessionResponse());
    mocks.apiGetAccountRegistrationStatus.mockReset().mockImplementation(async () => new Response(null, { status: 404 }));
    mocks.apiStartFreshAccount.mockReset();
    mocks.apiGetAccountCleanupStatus.mockReset().mockImplementation(async () => new Response(null, { status: 503 }));
    mocks.apiContinueAccountCleanup.mockReset().mockImplementation(async () => Response.json({}));
    mocks.apiDeleteSession.mockResolvedValue(undefined);
    mocks.identityRefresh.mockResolvedValue(null);
    mocks.identityPeek.mockReturnValue(null);
    mocks.identityClaim.mockReset();
    mocks.phoneFinalize.mockReset().mockResolvedValue(undefined);
    mocks.phoneReplacementConfirm.mockReset();
    mocks.phoneReplacementStart.mockReset().mockResolvedValue({ autoVerified: false, verificationId: "replacement-verification" });
    mocks.phoneTestStart.mockReset().mockResolvedValue({ success: true, eligible: false, reason: "uat_phone_test_not_configured_or_not_allowlisted" });
    mocks.phoneClaimToken.mockReset().mockResolvedValue("phone-id-token");
    mocks.phoneLinkStart.mockReset().mockResolvedValue({ autoVerified: false, verificationId: "web-otp-verification" });
    mocks.clearForUser.mockResolvedValue(undefined);
    mocks.clearMarketingSeen.mockResolvedValue(undefined);
    mocks.markForceIntroOnce.mockResolvedValue(undefined);
    mocks.deleteFCMToken.mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
}

function cleanupWebAuthMocks() {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete window.__HUSHH_NATIVE_TEST__;
}

export { mocks, deferred, makeUser, activeSessionResponse, cleanupStatusResponse, deletionInProgressResponse, emitLifecycle, requestExplicitSessionVerification, dispatchInvalidation, dispatchAccountNotFoundInvalidation, SessionProbe, renderProvider, CleanupInterfaceProbe, ScopedSignOutRaceProbe, OrdinarySignOutProbe, InteractiveSettlementProbe, VerifiedPhoneProbe, RetainedPhoneProbe, resetWebAuthMocks, cleanupWebAuthMocks };
