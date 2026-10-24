import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { User } from "firebase/auth";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountDeletionActive, isAccountDeletionActive, markAccountDeletionActive } from "@/lib/auth/account-deletion-activity";

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
  apiDeleteSession: vi.fn(),
  cacheSignedOut: vi.fn(),
  clearForUser: vi.fn(),
  clearDeviceSecretsForDeletedAccount: vi.fn(),
  identityRefresh: vi.fn(),
  identityPeek: vi.fn(),
  identityClaim: vi.fn(),
  phoneClaimToken: vi.fn(),
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
}));

vi.mock("firebase/auth", () => ({
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

vi.mock("@/lib/capacitor/session-privacy", () => ({
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
    startPhoneLinkVerification: vi.fn().mockResolvedValue({
      autoVerified: false,
      verificationId: "web-otp-verification",
    }),
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
    startUatTestPhoneVerification: vi.fn().mockResolvedValue({ success: true, eligible: false, reason: "uat_phone_test_not_configured_or_not_allowlisted" }),
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onAuthSignedOut: mocks.cacheSignedOut },
}));

vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    clearMarketingSeen: mocks.clearMarketingSeen,
    markForceIntroOnce: mocks.markForceIntroOnce,
  },
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
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

vi.mock("@/lib/utils/session-storage", () => ({
  clearSessionStorage: vi.fn(),
  removeLocalItem: vi.fn(),
  removeSessionItem: vi.fn(),
}));

vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
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
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
  publishAccountDeletionToSiblingTabs,
  type AuthSessionInvalidationDetail,
} from "@/lib/auth/session-invalidation";
import {
  AUTH_SESSION_VERIFICATION_REQUIRED_EVENT,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { ACCOUNT_SESSION_VALIDATION_BUDGET_MS } from "@/lib/auth/account-session-policy";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";

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

function activeSessionResponse(): Response {
  return Response.json({ active: true }, { status: 200 });
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
    signOut,
    user,
  } = useAuth();

  if (loading) return <p>Checking session</p>;
  if (sessionVerificationRequired) {
    return (
      <>
        <p>Verification required</p>
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
  const { beginPostAuthSettlement, completePostAuthSettlement } = useAuth();
  return <button onClick={() => {
    const settlement = beginPostAuthSettlement(mocks.firebaseUser as User);
    completePostAuthSettlement(settlement);
  }}>Complete interactive sign-in</button>;
}

function VerifiedPhoneProbe() {
  const { phoneNumber, phoneNumberStatus, resolveVerifiedPhoneNumber, startPhoneVerification, confirmPhoneVerification } = useAuth();
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState("");
  return <>
    <p data-testid="verified-phone">{phoneNumber ?? "missing"}</p>
    <p data-testid="phone-status">{phoneNumberStatus}</p>
    <p data-testid="phone-error">{error}</p>
    <p data-testid="resolved-phone">{resolved}</p>
    <button onClick={() => void resolveVerifiedPhoneNumber().then((phone) => setResolved(phone ?? "missing"))}>Resolve saved phone</button>
    <button onClick={() => void startPhoneVerification("+12025550101").catch((failure: Error) => setError(failure.message))}>Send phone OTP</button>
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

describe("@feature_account_deletion @trace_loop AuthProvider terminal session invalidation", () => {
  beforeEach(() => {
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
    mocks.apiGetAccountSessionStatus.mockResolvedValue(
      activeSessionResponse(),
    );
    mocks.apiDeleteSession.mockResolvedValue(undefined);
    mocks.identityRefresh.mockResolvedValue(null);
    mocks.identityPeek.mockReturnValue(null);
    mocks.identityClaim.mockReset();
    mocks.phoneFinalize.mockReset().mockResolvedValue(undefined);
    mocks.phoneReplacementConfirm.mockReset();
    mocks.phoneReplacementStart.mockReset().mockResolvedValue({ autoVerified: false, verificationId: "replacement-verification" });
    mocks.phoneClaimToken.mockReset().mockResolvedValue("phone-id-token");
    mocks.clearForUser.mockResolvedValue(undefined);
    mocks.clearMarketingSeen.mockResolvedValue(undefined);
    mocks.markForceIntroOnce.mockResolvedValue(undefined);
    mocks.deleteFCMToken.mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.__HUSHH_NATIVE_TEST__;
  });

  it("does not restart a confirmed-missing phone lookup when returning to an active OTP attempt", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const identity = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      mocks.authStateListener?.(mocks.firebaseUser);
    });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.identityRefresh).not.toHaveBeenCalled();
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneClaimToken).toHaveBeenCalledTimes(1);
  });

  it("bounds automatic retries and stops them while offline or unmounted", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const view = render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    vi.useFakeTimers();
    // The first timer was scheduled before switching clocks; restart the
    // episode through the real lifecycle wake so the clock owns its timers.
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const startCount = mocks.identityRefresh.mock.calls.length;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(startCount);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const exhaustedCount = mocks.identityRefresh.mock.calls.length;
    expect(exhaustedCount).toBeLessThanOrEqual(startCount + 4);
    expect(exhaustedCount).toBeGreaterThan(startCount + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(exhaustedCount);
    view.unmount();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      emitLifecycle("active");
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(exhaustedCount);
  });

  it.each(["missing", "stale", "bootstrap hint"])("revalidates a restored provider phone against %s canonical evidence", async evidence => {
    const previous = "+14155550100";
    const identity = { user_id: "account-owner", phone_number: "+919000000001", phone_verified: true };
    mocks.firebaseUser = makeUser("account-owner", previous);
    mocks.identityPeek.mockReturnValue(evidence === "missing" ? null : {
      data: { ...identity, phone_number: evidence === "stale" ? previous : null, source: evidence === "stale" ? "firebase_auth" : "vault_bootstrap_hint" },
      isStale: evidence === "stale",
    });
    mocks.identityRefresh.mockImplementationOnce(async () => {
      mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
      return identity;
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it("retains the restored number through failed canonical reads, then recovers on foreground", async () => {
    const previous = "+14155550100";
    mocks.firebaseUser = makeUser("account-owner", previous);
    mocks.identityRefresh.mockRejectedValueOnce(new Error("Temporary outage"));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(previous);
    expect(screen.getByTestId("phone-status")).toHaveTextContent("verified");
    const identity = { user_id: "account-owner", phone_number: "+919000000001", phone_verified: true };
    mocks.identityRefresh.mockImplementationOnce(async () => {
      mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
      return identity;
    });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
  });

  it.each(["empty response", "network failure"])("recovers the saved phone after an initial %s without another OTP", async (failure) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    mocks.identityRefresh.mockReset();
    if (failure === "network failure") mocks.identityRefresh.mockRejectedValueOnce(new Error("temporary outage"));
    else mocks.identityRefresh.mockResolvedValueOnce(null);
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    mocks.identityRefresh.mockResolvedValue(identity);
    act(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it("publishes later verified same-owner cache updates without a reload", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalled());
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
  });

  it.each([
    { restored: false, removed: false },
    { restored: true, removed: false },
    { restored: false, removed: true },
    { restored: true, removed: true },
  ])("keeps newer committed phone evidence after a read returns (restored: $restored, removed: $removed)", async ({ restored, removed }) => {
    mocks.firebaseUser = makeUser("account-owner", restored ? "+14155550100" : "");
    const previous = { user_id: "account-owner", phone_number: "+14155550101", phone_verified: true };
    const latest = { user_id: "account-owner", phone_number: removed ? null : "+919000000001", phone_verified: !removed };
    const publish = (identity: typeof latest) => {
      mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
      CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity);
    };
    mocks.identityRefresh.mockImplementationOnce(async () => {
      publish(previous);
      // The read is already accepted by the service. A later claim publishes
      // before its awaiting AuthProvider consumer resumes.
      queueMicrotask(() => publish(latest));
      return previous;
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(latest.phone_number ?? "missing");
    expect(screen.getByTestId("phone-status")).toHaveTextContent(removed ? "missing" : "verified");
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it.each(["foreign", "stale", "unverified", "bootstrap hint"])("ignores %s phone evidence in cache notifications", async (kind) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    const identity = {
      user_id: kind === "foreign" ? "another-owner" : "account-owner",
      phone_number: "+12025550101",
      phone_verified: kind !== "unverified",
      source: kind === "bootstrap hint" ? "vault_bootstrap_hint" : "firebase",
    };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: kind === "stale" });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
  });

  it("resolves a later full negative cache claim without leaving profile recovery stuck", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    const identity = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    const count = mocks.identityRefresh.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(count);
  });

  it("honors a real phone binding removal without resurrecting the old provider phone after cache expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("+12025550101");
    const identity = { user_id: "account-owner", phone_number: null, phone_verified: false, source: "firebase_phone_claim" };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolve saved phone" })); });
    expect(screen.getByTestId("resolved-phone")).toHaveTextContent("missing");
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: true });
    await act(async () => {
      mocks.authStateListener?.(mocks.firebaseUser);
      fireEvent.click(screen.getByRole("button", { name: "Resolve saved phone" }));
    });
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
    expect(screen.getByTestId("resolved-phone")).toHaveTextContent("missing");
  });

  it("preserves a known phone across a degraded legacy identity projection", async () => {
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const knownPhone = screen.getByTestId("verified-phone").textContent;
    const identity = { user_id: "account-owner", phone_number: null, phone_verified: false, source: "legacy_fallback" };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    await act(async () => {
      CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity);
      mocks.authStateListener?.(mocks.firebaseUser);
    });
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(knownPhone!);
    expect(screen.getByTestId("phone-status")).toHaveTextContent("verified");
  });

  it("revalidates expired absence on foreground and discovers a phone saved on another device", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const missing = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: missing, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    mocks.identityPeek.mockReturnValue({ data: missing, isStale: true });
    const verified = { user_id: "account-owner", phone_verified: true, phone_number: "+12025550102" };
    mocks.identityRefresh.mockResolvedValue(verified);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(verified.phone_number));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it("does not overwrite a later confirmed absence when an older lookup returns empty", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    let finish!: (identity: null) => void;
    mocks.identityRefresh.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    const identity = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    await act(async () => {
      CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity);
      finish(null);
    });
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
  });

  it("retains the verified phone when the same Firebase user is republished after cache expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: true });
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number);
  });

  it("prefers the committed app phone over an older primary provider phone, including after cache expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "+12025550100");
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number);
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: true });
    await act(async () => { mocks.authStateListener?.(mocks.firebaseUser); });
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number);
  });

  it("publishes the committed backend phone after web OTP even when Firebase republishes the same phone-less user", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    let snapshot: object | null = null;
    mocks.identityPeek.mockImplementation((uid: string) => uid === "account-owner" ? snapshot : null);
    mocks.identityClaim.mockImplementation(async () => {
      const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
      snapshot = { data: identity, isStale: false };
      return identity;
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalled());
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent("+12025550101"));
    expect(mocks.identityClaim).toHaveBeenCalledWith(mocks.firebaseUser, "phone-id-token");
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("+12025550101");
    const otherUser = makeUser("other-owner", "");
    act(() => mocks.authStateListener?.(otherUser));
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing"));
  });

  it.each([true, false])("requires backend persistence for a web phone replacement (available: %s)", async available => {
    mocks.firebaseUser = makeUser("account-owner", "+919000000001");
    const verified = makeUser("account-owner", "+12025550101");
    mocks.phoneReplacementConfirm.mockResolvedValue(verified);
    if (!available) mocks.phoneFinalize.mockRejectedValue(new Error("Phone verification could not be saved"));
    render(<AuthProvider><SessionProbe /><RetainedPhoneProbe replacement /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    fireEvent.click(screen.getByRole("button", { name: "Confirm current phone" }));
    await waitFor(() => expect(mocks.phoneFinalize).toHaveBeenCalledWith(verified, "+12025550101"));
    await waitFor(() => expect(screen.getByTestId("retained-phone-error")).toHaveTextContent(available ? "Saved" : "could not be saved"));
  });

  it("repairs a provider-linked replacement after a backend outage without sending another OTP", async () => {
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    mocks.identityPeek.mockReturnValue({ data: { user_id: "account-owner", phone_number: "+919000000001", phone_verified: true }, isStale: false });
    render(<AuthProvider><SessionProbe /><RetainedPhoneProbe replacement /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    expect(mocks.phoneFinalize).toHaveBeenCalledWith(mocks.firebaseUser, "+12025550101");
    expect(mocks.phoneReplacementStart).not.toHaveBeenCalled();
  });

  it.each([
    { stale: true, verified: true },
    { stale: false, verified: false },
  ])("does not publish stale or unverified cached phone evidence: %j", async ({ stale, verified }) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    mocks.identityPeek.mockReturnValue({ data: { user_id: "account-owner", phone_number: "+12025550101", phone_verified: verified }, isStale: stale });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
  });

  it.each(["account switch", "same-user resend"])("does not submit an old OTP after %s while phone proof is pending", async (change) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const token = deferred<string>();
    mocks.phoneClaimToken.mockReturnValueOnce(token.promise);
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" }));
    await waitFor(() => expect(mocks.phoneClaimToken).toHaveBeenCalled());
    if (change === "account switch") {
      mocks.firebaseUser = makeUser("other-owner", "");
      act(() => mocks.authStateListener?.(mocks.firebaseUser));
    } else {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    }
    await act(async () => { token.resolve("old-phone-proof"); });
    await waitFor(() => expect(screen.getByTestId("phone-error")).toHaveTextContent("account changed"));
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it.each([
    { replacement: false, switchAccount: true },
    { replacement: false, switchAccount: false },
    { replacement: true, switchAccount: true },
    { replacement: true, switchAccount: false },
  ])("rejects retained confirmation after another challenge starts: %j", async ({ replacement, switchAccount }) => {
    render(<AuthProvider><SessionProbe /><RetainedPhoneProbe replacement={replacement} /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    fireEvent.click(screen.getByRole("button", { name: "Retain confirmation" }));
    if (switchAccount) {
      mocks.firebaseUser = makeUser("other-owner", "");
      act(() => mocks.authStateListener?.(mocks.firebaseUser));
      await screen.findByText("Vault content for other-owner");
    }
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    fireEvent.click(screen.getByRole("button", { name: "Invoke retained confirmation" }));
    await waitFor(() => expect(screen.getByTestId("retained-phone-error")).toHaveTextContent("account changed"));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.phoneReplacementConfirm).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it("withdraws the live identity immediately and leaves profile when push cleanup stalls", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    const cleanup = deferred<void>();
    mocks.deleteFCMToken.mockReturnValueOnce(cleanup.promise);

    fireEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await act(async () => { await Promise.resolve(); });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(mocks.authServiceSignOut).toHaveBeenCalledOnce();
    expect(mocks.apiDeleteSession).toHaveBeenCalledOnce();
    expect(mocks.replaceDocument).toHaveBeenCalledWith("/");
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    const signal = mocks.deleteFCMToken.mock.calls[0]?.[2]?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    cleanup.resolve();
  });

  it("finishes ordinary sign-out when the optional notification token never resolves", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const token = deferred<string>();
    vi.mocked((mocks.firebaseUser as User).getIdToken).mockReturnValue(token.promise);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.authServiceSignOut).toHaveBeenCalledOnce();
    expect(mocks.replaceDocument).toHaveBeenCalledWith("/");
    await act(async () => { token.resolve("late-token"); await token.promise; });
    expect(mocks.deleteFCMToken).not.toHaveBeenCalled();
  });

  it("allows verification after interactive sign-in overlaps an auth snapshot", async () => {
    render(<AuthProvider><SessionProbe /><InteractiveSettlementProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const validation = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(validation.promise);
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await waitFor(() => expect(screen.getByText("Checking session")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Complete interactive sign-in" }));
    await act(async () => {
      validation.resolve(activeSessionResponse());
      await validation.promise;
    });
    act(() => requestExplicitSessionVerification());
    await screen.findByText("Vault content for account-owner");
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
  });

  it("does not republish a pre-sign-out auth snapshot after its validation finishes", async () => {
    render(<AuthProvider><SessionProbe /><OrdinarySignOutProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const validation = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(validation.promise);
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    fireEvent.click(screen.getByRole("button", { name: "Leave profile" }));
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/"));
    await act(async () => {
      validation.resolve(activeSessionResponse());
      await validation.promise;
    });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
    expect(screen.queryByText("Vault content for account-owner")).not.toBeInTheDocument();
  });

  it("does not refresh the identity shadow during automated reviewer bootstrap", async () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
    };
    mocks.firebaseUser = makeUser("account-owner", null);

    renderProvider();

    await screen.findByText("Vault content for account-owner");
    await act(async () => Promise.resolve());

    expect(mocks.identityRefresh).not.toHaveBeenCalled();
  });

  it("can leave recovery without waiting on token-dependent notification cleanup", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const currentUser = mocks.firebaseUser as User;
    const stalledToken = deferred<string>();
    vi.mocked(currentUser.getIdToken)
      .mockClear()
      .mockReturnValue(stalledToken.promise);

    fireEvent.click(screen.getByRole("button", { name: "Finish account-A deletion" }));

    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/"));
    // The loading gate stays held until the document unloads; releasing it
    // lets route guards race a client-side /login replace against this one.
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(screen.queryByText("Signed out")).not.toBeInTheDocument();
    expect(currentUser.getIdToken).not.toHaveBeenCalled();
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.apiDeleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.clearForUser).toHaveBeenCalledWith("account-owner");
    expect(mocks.replaceDocument).toHaveBeenCalledWith("/");
  });

  it.each(["fresh", "missing"])("preserves an already-published session on foreground with %s phone evidence", async (evidence) => {
    if (evidence === "fresh") {
      mocks.identityPeek.mockReturnValue({ data: {
        user_id: "account-owner", phone_number: "+14155550100", phone_verified: true,
      }, isStale: false });
    }
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);

    await screen.findByText("Vault content for account-owner");
    await act(async () => Promise.resolve());
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockClear();
    mocks.apiGetAccountSessionStatus.mockClear();
    mocks.identityRefresh.mockClear();

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    await act(async () => Promise.resolve());
    expect(currentUser.getIdToken).not.toHaveBeenCalled();
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(evidence === "fresh" ? 0 : 1);
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("+14155550100");
    expect(screen.getByTestId("phone-status")).toHaveTextContent("verified");
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
  });

  it("does not remount protected UI for duplicate focus events", async () => {
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await act(async () => Promise.resolve());
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    await act(async () => Promise.resolve());

    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(screen.getByText("Vault content for account-owner")).toBeInTheDocument();
  });

  it("coalesces account-not-found invalidation into one sign-out and login redirect", async () => {
    const signOut = deferred<void>();
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: {
            code: "AUTH_ACCOUNT_NOT_FOUND",
            message: "Account not found",
          },
        }),
        { status: 401 },
      ),
    );
    mocks.authServiceSignOut.mockReturnValueOnce(signOut.promise);

    act(() => requestExplicitSessionVerification());

    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    act(() => dispatchAccountNotFoundInvalidation());
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      signOut.resolve();
      await signOut.promise;
    });

    await waitFor(() => {
      expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);
    });
    expect(mocks.replaceDocument).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
    expect(mocks.cacheSignedOut).toHaveBeenCalledWith("account-owner");
  });

  it.each(["commit", "rollback"] as const)("settles an in-flight deletion as %s after foreground validation", async (outcome) => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(outcome === "commit"
        ? Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 })
        : activeSessionResponse());
    act(() => requestExplicitSessionVerification());
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(screen.queryByText("Vault content for account-owner")).not.toBeInTheDocument();
    if (outcome === "commit") {
      await waitFor(() => expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1));
      expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=account_not_found");
    } else {
      expect(await screen.findByText("Vault content for account-owner")).toBeInTheDocument();
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
      expect(mocks.replaceDocument).not.toHaveBeenCalled();
    }
  });

  it("@feature_account_deletion @trace_loop seals the session while deletion remains pending, then observes rollback", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(activeSessionResponse());

    act(() => requestExplicitSessionVerification());

    expect(screen.getByText("Checking session")).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    });
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
    expect(isAccountDeletionActive("account-owner")).toBe(true);
    expect(await screen.findByText("Vault content for account-owner", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(isAccountDeletionActive("account-owner")).toBe(false);
  });

  it("clears a pending deletion handoff when rollback precedes the first owner re-probe", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    markAccountDeletionActive("account-owner");
    const owner = snapshotValidatedAuthSessionOwner();
    act(() => window.dispatchEvent(new CustomEvent(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, {
      detail: { ...owner, reason: "account_deletion_in_progress" },
    })));
    await waitFor(() => expect(isAccountDeletionActive("account-owner")).toBe(false));
    expect(await screen.findByText("Vault content for account-owner")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("retains the deleted notice through real apiFetch before the provider sign-out latch", async () => {
    const { ApiService } = await vi.importActual<typeof import("@/lib/services/api-service")>("@/lib/services/api-service");
    vi.mocked(global.fetch).mockResolvedValueOnce(Response.json({ detail: {
      code: "AUTH_ACCOUNT_NOT_FOUND", account_lifecycle: "deleted",
    } }, { status: 401 }));
    const token = [btoa("{}"), btoa(JSON.stringify({ sub: "account-owner", user_id: "account-owner" })), "synthetic"].join(".");
    vi.mocked((mocks.firebaseUser as User).getIdToken).mockResolvedValue(token);
    mocks.apiGetAccountSessionStatus.mockImplementationOnce(ApiService.getAccountSessionStatus);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=account_deleted"));
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.replaceDocument).not.toHaveBeenCalledWith("/login?auth_notice=account_not_found");
  });

  it.each(["account_deleted", "account_deletion_identity_retained"] as const)("does not let delayed cleanup replace terminal navigation: %s", async code => {
    render(
      <AuthProvider>
        <ScopedSignOutRaceProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AuthSessionInvalidationDetail>(
          AUTH_SESSION_INVALIDATED_EVENT,
          {
            detail: {
              code,
              path: "account_delete_confirmed",
              userId: "account-owner",
            },
          },
        ),
      );
    });
    await waitFor(() => {
      expect(mocks.replaceDocument).toHaveBeenCalledWith(
        `/login?auth_notice=${code}`,
      );
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Complete delayed deletion cleanup",
      }),
    );
    await act(async () => Promise.resolve());

    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.apiDeleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);
  });

  it("rejects a late terminal event after sign-out until a new UID is established", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);
    });

    act(() => dispatchAccountNotFoundInvalidation());
    await act(async () => Promise.resolve());
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);

    const nextUser = makeUser("next-account-owner");
    mocks.firebaseUser = nextUser;
    act(() => mocks.authStateListener?.(nextUser));
    expect(
      await screen.findByText("Vault content for next-account-owner"),
    ).toBeInTheDocument();

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(2);
      expect(mocks.replaceDocument).toHaveBeenCalledTimes(2);
    });
  });

  it("consumes a UID-scoped account-deletion signal from a sibling tab", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const storagePrototype = Object.getPrototypeOf(
      window.localStorage,
    ) as Storage;
    const setItem = vi.spyOn(storagePrototype, "setItem");

    try {
      expect(publishAccountDeletionToSiblingTabs("previous-account")).toBe(
        true,
      );
      const [, stalePayload] = setItem.mock.calls[0]!;
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
            newValue: stalePayload,
          }),
        );
      });
      await act(async () => Promise.resolve());
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
      expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();

      expect(publishAccountDeletionToSiblingTabs("account-owner")).toBe(true);
      const [, payload] = setItem.mock.calls[1]!;

      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
            newValue: payload,
          }),
        );
      });

      await waitFor(() => {
        expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
        expect(mocks.replaceDocument).toHaveBeenCalledWith(
          "/login?auth_notice=account_not_found",
        );
      });
      expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith(
        "account-owner",
      );
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps device key material when the account is not confirmed deleted", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() =>
      dispatchInvalidation({
        code: "account_deletion_uncertain",
        path: "test_uncertain",
        userId: "account-owner",
      }),
    );
    act(() =>
      dispatchInvalidation({
        code: "session_invalid",
        path: "test_disabled",
        userId: "account-owner",
      }),
    );
    await act(async () => Promise.resolve());

    expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();
  });

  it.each(["account_deleted", "account_deletion_identity_retained"] as const)("clears device secrets for confirmed erasure after teardown: %s", async code => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() =>
      dispatchInvalidation({
        code: "session_invalid",
        path: "test_first",
        userId: "account-owner",
      }),
    );
    act(() =>
      dispatchInvalidation({
        code,
        path: "account_delete_confirmed",
        userId: "account-owner",
      }),
    );

    expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledTimes(1);
    expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith(
      "account-owner",
    );
  });

  it("does not let the initial auth watchdog interrupt a later web validation", async () => {
    vi.useFakeTimers();
    const refresh = deferred<string | null>();
    renderProvider();

    await act(async () => Promise.resolve());
    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh ? refresh.promise : Promise.resolve("persisted-token"),
    );
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid Firebase ID token" }), {
        status: 401,
      }),
    );

    act(() => requestExplicitSessionVerification());
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(10_001));
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    await act(async () => {
      refresh.resolve("fresh-token");
      await refresh.promise;
    });
    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
  });

  it("preserves the identity but blocks protected UI when foreground validation has a network failure", async () => {
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh
        ? Promise.reject({
            code: "auth/network-request-failed",
            message: "The network is unavailable.",
          })
        : Promise.resolve("persisted-token"),
    );

    act(() => requestExplicitSessionVerification());

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();

    vi.mocked(currentUser.getIdToken).mockResolvedValue("persisted-token");
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(
      await screen.findByText("Vault content for account-owner"),
    ).toBeInTheDocument();
  });

  it("automatically recovers a fail-closed session after a transient outage", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    mocks.apiGetAccountSessionStatus.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    act(() => requestExplicitSessionVerification());
    await act(async () => Promise.resolve());

    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "HTML with a 200 status",
      response: () =>
        new Response("<html>not the account API</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    },
    {
      name: "an empty JSON object",
      response: () => Response.json({}, { status: 200 }),
    },
    {
      name: "an empty 204 response",
      response: () => new Response(null, { status: 204 }),
    },
    {
      name: "malformed JSON",
      response: () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      name: "an oversized JSON body",
      response: () =>
        Response.json(
          { active: true, padding: "x".repeat(4_096) },
          { status: 200 },
        ),
    },
    {
      name: "a missing backend route",
      response: () => Response.json({ detail: "Not Found" }, { status: 404 }),
    },
  ])("keeps protected UI sealed for $name", async ({ response }) => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(response());

    act(() => requestExplicitSessionVerification());

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("keeps account B when a delayed account-A status response becomes terminal", async () => {
    const accountAStatus = deferred<Response>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    mocks.apiGetAccountSessionStatus
      .mockReturnValueOnce(accountAStatus.promise)
      .mockResolvedValueOnce(
        activeSessionResponse(),
      );
    act(() => requestExplicitSessionVerification());
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    });

    const accountB = makeUser("account-b");
    mocks.firebaseUser = accountB;
    act(() => mocks.authStateListener?.(accountB));
    expect(
      await screen.findByText("Vault content for account-b"),
    ).toBeInTheDocument();

    await act(async () => {
      accountAStatus.resolve(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          }),
          { status: 401 },
        ),
      );
      await accountAStatus.promise;
    });

    expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });

  it("keeps the auth gate closed while account B validation overlaps account A foreground validation", async () => {
    const accountAStatus = deferred<Response>();
    const accountBStatus = deferred<Response>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    mocks.apiGetAccountSessionStatus
      .mockReturnValueOnce(accountAStatus.promise)
      .mockReturnValueOnce(accountBStatus.promise);
    act(() => requestExplicitSessionVerification());
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    });

    const accountB = makeUser("account-b");
    mocks.firebaseUser = accountB;
    act(() => mocks.authStateListener?.(accountB));
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    await act(async () => {
      accountAStatus.resolve(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          }),
          { status: 401 },
        ),
      );
      await accountAStatus.promise;
    });

    // Account A's older validation does not own the gate. Releasing it here
    // would briefly reveal A's in-memory Vault while B is still unverified.
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();

    await act(async () => {
      accountBStatus.resolve(
        activeSessionResponse(),
      );
      await accountBStatus.promise;
    });

    expect(
      await screen.findByText("Vault content for account-b"),
    ).toBeInTheDocument();
  });

  it("does not let a delayed account-A deletion callback sign out account B", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    const accountB = makeUser("account-b");
    mocks.firebaseUser = accountB;
    act(() => mocks.authStateListener?.(accountB));
    await screen.findByText("Vault content for account-b");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Finish account-A deletion",
      }),
    );
    await act(async () => Promise.resolve());

    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.apiDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });

  it("does not republish a latched UID or reopen its vault while sign-out is pending", async () => {
    const signOut = deferred<void>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.authServiceSignOut.mockReturnValueOnce(signOut.promise);

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    act(() => mocks.authStateListener?.(makeUser("account-owner")));
    await act(async () => Promise.resolve());
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();

    await act(async () => {
      signOut.resolve();
      await signOut.promise;
    });
  });

  it("blocks protected UI for a generic cached-token 401 plus network refresh failure", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid Firebase ID token" }), {
        status: 401,
      }),
    );
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh
        ? Promise.reject({
            code: "auth/network-request-failed",
            message: "offline",
          })
        : Promise.resolve("persisted-token"),
    );

    act(() => requestExplicitSessionVerification());

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });

  it("refreshes the candidate user instead of accepting a different global Firebase identity", async () => {
    const accountB = makeUser("account-b");
    vi.mocked(accountB.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh
        ? Promise.reject({
            code: "auth/user-not-found",
            message: "Account B was deleted.",
          })
        : Promise.resolve("account-b-cached-token"),
    );
    mocks.firebaseUser = accountB;
    mocks.authServiceGetCurrentUser.mockReturnValue(accountB);
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid Firebase ID token" }), {
        status: 401,
      }),
    );

    renderProvider();

    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(accountB.getIdToken).toHaveBeenCalledWith(false);
    expect(accountB.getIdToken).toHaveBeenCalledWith(true);
    expect(mocks.authServiceGetIdToken).not.toHaveBeenCalled();
    expect(mocks.clearForUser).toHaveBeenCalledWith("account-b");
    expect(mocks.replaceDocument).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
  });

  it("clears local state for a terminal native restore UID that was never published", async () => {
    mocks.firebaseUser = null;
    mocks.authServiceGetCurrentUser.mockReturnValue(null);
    renderProvider();
    await screen.findByText("Signed out");

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AuthSessionInvalidationDetail>(
          AUTH_SESSION_INVALIDATED_EVENT,
          {
            detail: {
              code: "account_not_found",
              path: "native_restore",
              userId: "cold-restored-deleted-user",
            },
          },
        ),
      );
    });

    await waitFor(() => {
      expect(mocks.clearForUser).toHaveBeenCalledWith(
        "cold-restored-deleted-user",
      );
    });
    expect(mocks.cacheSignedOut).toHaveBeenCalledWith(
      "cold-restored-deleted-user",
    );
    expect(mocks.replaceDocument).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
  });

  it("ignores a UID-scoped sibling deletion signal while anonymous", async () => {
    mocks.firebaseUser = null;
    renderProvider();
    await screen.findByText("Signed out");
    const storagePrototype = Object.getPrototypeOf(
      window.localStorage,
    ) as Storage;
    const setItem = vi.spyOn(storagePrototype, "setItem");

    try {
      expect(publishAccountDeletionToSiblingTabs("account-a")).toBe(true);
      const [, payload] = setItem.mock.calls[0]!;
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
            newValue: payload,
          }),
        );
      });
      await act(async () => Promise.resolve());
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();

      const accountB = makeUser("account-b");
      mocks.firebaseUser = accountB;
      act(() => mocks.authStateListener?.(accountB));
      expect(
        await screen.findByText("Vault content for account-b"),
      ).toBeInTheDocument();
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not enter recovery for a hung status request that lifecycle cannot start", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    mocks.apiGetAccountSessionStatus.mockClear();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(
      new Promise<Response>(() => undefined),
    );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_SESSION_VALIDATION_BUDGET_MS + 1);
    });
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.getByText("Vault content for account-owner")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });
});
