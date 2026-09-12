import { act, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authStateListener: null as ((user: unknown) => void) | null,
  lifecycleListeners: new Set<() => void>(),
  lifecycleState: "active" as "active" | "background",
  privacyState: { shielded: false, generation: 0, cause: "inactive" as "inactive" | "background" | "restart", appIsActive: true },
  privacyListener: null as ((state: unknown) => void) | null,
  routerReplace: vi.fn(),
  restoreNativeSession: vi.fn(),
  authServiceSignOut: vi.fn(),
  apiGetAccountSessionStatus: vi.fn(),
  completePrivacyValidation: vi.fn(),
  getPrivacyState: vi.fn(),
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
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: vi.fn(() => null),
    refreshCurrentUserIdentity: vi.fn().mockResolvedValue(null),
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
    deleteSession: vi.fn().mockResolvedValue(undefined),
    notifyAuthMail: vi.fn().mockResolvedValue(undefined),
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

function SessionProbe() {
  const {
    beginPostAuthSettlement,
    completePostAuthSettlement,
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
          if (settlementIdRef.current !== null) {
            completePostAuthSettlement(settlementIdRef.current);
          }
        }}
      >
        Complete account B settlement
      </button>
    </>
  );
}

function emitLifecycle(state: "active" | "background") {
  mocks.lifecycleState = state;
  for (const listener of mocks.lifecycleListeners) listener();
}

function emitPrivacy(overrides: Partial<typeof mocks.privacyState>, action = "state") {
  mocks.privacyState = { ...mocks.privacyState, ...overrides };
  mocks.privacyListener?.({ ...mocks.privacyState, action });
}

function activeSessionResponse(): Response {
  return Response.json({ active: true }, { status: 200 });
}

describe("AuthProvider native privacy generations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGetAccountSessionStatus.mockReset();
    mocks.restoreNativeSession.mockReset();
    mocks.getPrivacyState.mockReset();
    mocks.completePrivacyValidation.mockReset();
    mocks.lifecycleListeners.clear();
    mocks.lifecycleState = "active";
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

  it("exits a stalled native restore and retries without publishing its late result", async () => {
    vi.useFakeTimers();
    const stalledRestore = deferred<User | null>();
    mocks.restoreNativeSession.mockReturnValueOnce(stalledRestore.promise);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_001); });
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

  it("keeps private native content hidden after an unavailable resume check", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(activeSessionResponse())
      .mockResolvedValueOnce(
        Response.json({ detail: "temporarily unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ detail: "temporarily unavailable" }, { status: 503 }),
      );

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    await screen.findByText("Native content for native-account-owner");

    mocks.privacyState = { shielded: true, generation: 1, cause: "background", appIsActive: true };
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(await screen.findByText("Verification required")).toBeInTheDocument();
    expect(
      screen.queryByText("Native content for native-account-owner"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1);
    });
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("queues a fresh validation before releasing a newer resume generation", async () => {
    const firstResumeStatus = deferred<Response>();
    const secondResumeStatus = deferred<Response>();
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(
        activeSessionResponse(),
      )
      .mockReturnValueOnce(firstResumeStatus.promise)
      .mockReturnValueOnce(secondResumeStatus.promise);

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    );
    await screen.findByText("Native content for native-account-owner");

    mocks.privacyState = { shielded: true, generation: 1, cause: "background", appIsActive: true };
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    });

    mocks.privacyState = { shielded: true, generation: 2, cause: "background", appIsActive: true };
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });
    await act(async () => Promise.resolve());
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalledWith(2);

    await act(async () => {
      firstResumeStatus.resolve(
        activeSessionResponse(),
      );
      await firstResumeStatus.promise;
    });
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    });
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalledWith(2);
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    await act(async () => {
      secondResumeStatus.resolve(
        activeSessionResponse(),
      );
      await secondResumeStatus.promise;
    });
    await waitFor(() => {
      expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(2);
    });
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

    act(() => {
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
    act(() => {
      emitPrivacy({ shielded: true, generation: 1, cause: "background", appIsActive: false });
      emitLifecycle("background");
      emitLifecycle("active");
    });
    await act(async () => Promise.resolve());
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    act(() => emitPrivacy({ appIsActive: true }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
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
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
  });

  it("does not reuse transient validation when the same generation gains background debt", async () => {
    const revalidation = deferred<Response>();
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(activeSessionResponse())
      .mockReturnValueOnce(revalidation.promise);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "inactive" }));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    mocks.completePrivacyValidation.mockClear();
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background" }));
    await waitFor(() => expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2));
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    await act(async () => revalidation.resolve(activeSessionResponse()));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
  });

  it("keeps an unknown resume covered and reconciles a later native state", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Native content for native-account-owner");
    mocks.getPrivacyState.mockRejectedValue(new Error("bridge unavailable"));
    act(() => { emitLifecycle("background"); emitLifecycle("active"); });
    await screen.findByText("Verification required");
    expect(mocks.completePrivacyValidation).not.toHaveBeenCalled();
    act(() => emitPrivacy({ shielded: true, generation: 1, cause: "background" }, "retry"));
    await waitFor(() => expect(mocks.completePrivacyValidation).toHaveBeenCalledWith(1));
    expect(screen.getByText("Native content for native-account-owner")).toBeInTheDocument();
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
      .mockReturnValueOnce(unavailable.promise)
      .mockResolvedValueOnce(Response.json({}, { status: 503 }));
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
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
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
