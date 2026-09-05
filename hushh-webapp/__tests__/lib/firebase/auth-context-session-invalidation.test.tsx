import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  clearMarketingSeen: vi.fn(),
  markForceIntroOnce: vi.fn(),
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

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "web",
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/capacitor/session-privacy", () => ({
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
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: vi.fn(() => null),
    refreshCurrentUserIdentity: vi.fn().mockResolvedValue(null),
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
  UserLocalStateService: { clearForUser: mocks.clearForUser },
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
  AUTH_SESSION_INVALIDATED_EVENT,
  AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
  publishAccountDeletionToSiblingTabs,
  type AuthSessionInvalidationDetail,
} from "@/lib/auth/session-invalidation";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeUser(uid = "account-owner"): User {
  return {
    uid,
    displayName: "Account Owner",
    email: "owner@example.test",
    phoneNumber: "+14155550100",
    photoURL: null,
    getIdToken: vi.fn().mockResolvedValue("persisted-token"),
  } as unknown as User;
}

function activeSessionResponse(): Response {
  return Response.json({ active: true }, { status: 200 });
}

function emitLifecycle(state: "active" | "background") {
  mocks.lifecycleState = state;
  for (const listener of mocks.lifecycleListeners) listener();
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

describe("AuthProvider terminal session invalidation", () => {
  beforeEach(() => {
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
    mocks.clearForUser.mockResolvedValue(undefined);
    mocks.clearMarketingSeen.mockResolvedValue(undefined);
    mocks.markForceIntroOnce.mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(currentUser.getIdToken).not.toHaveBeenCalled();
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.apiDeleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.clearForUser).toHaveBeenCalledWith("account-owner");
    expect(mocks.routerReplace).toHaveBeenCalledWith("/");
  });

  it("force-refreshes an existing session on foreground and gates stale children while checking", async () => {
    const refresh = deferred<string | null>();
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh ? refresh.promise : Promise.resolve("persisted-token"),
    );
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Service unavailable" }), {
        status: 503,
      }),
    );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    await waitFor(() => {
      expect(currentUser.getIdToken).toHaveBeenCalledWith(true);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();

    await act(async () => {
      refresh.resolve("fresh-token");
      await refresh.promise;
    });

    expect(
      await screen.findByText("Vault content for account-owner"),
    ).toBeInTheDocument();
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

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

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
      expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
    });
    expect(mocks.routerReplace).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
    expect(mocks.cacheSignedOut).toHaveBeenCalledWith("account-owner");
  });

  it("keeps Vault sealed while an in-flight deletion commits, then reports account not found", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" },
          }),
          { status: 423, headers: { "Retry-After": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          }),
          { status: 401 },
        ),
      );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(mocks.routerReplace).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
  });

  it("releases the gate only when the deletion transaction authoritatively rolls back", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" },
          }),
          { status: 423, headers: { "Retry-After": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        activeSessionResponse(),
      );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      await screen.findByText("Vault content for account-owner"),
    ).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("fails closed when an in-flight deletion remains unresolved after one bounded re-probe", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const deletionInProgress = () =>
      new Response(
        JSON.stringify({
          detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" },
        }),
        { status: 423, headers: { "Retry-After": "0" } },
      );
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgress())
      .mockResolvedValueOnce(deletionInProgress());

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(screen.getByText("Checking session")).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(mocks.routerReplace).toHaveBeenCalledWith(
      "/login?auth_notice=account_deletion_uncertain",
    );
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
  });

  it("does not let a delayed deletion fallback replace or repeat the completed terminal navigation", async () => {
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
              code: "account_deleted",
              path: "account_delete_confirmed",
              userId: "account-owner",
            },
          },
        ),
      );
    });
    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith(
        "/login?auth_notice=account_deleted",
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
    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
  });

  it("rejects a late terminal event after sign-out until a new UID is established", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
    });

    act(() => dispatchAccountNotFoundInvalidation());
    await act(async () => Promise.resolve());
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);

    const nextUser = makeUser("next-account-owner");
    mocks.firebaseUser = nextUser;
    act(() => mocks.authStateListener?.(nextUser));
    expect(
      await screen.findByText("Vault content for next-account-owner"),
    ).toBeInTheDocument();

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(2);
      expect(mocks.routerReplace).toHaveBeenCalledTimes(2);
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
        expect(mocks.routerReplace).toHaveBeenCalledWith(
          "/login?auth_notice=account_not_found",
        );
      });
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not let the initial auth watchdog release a later validation gate", async () => {
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
      new Response(JSON.stringify({ detail: "Service unavailable" }), {
        status: 503,
      }),
    );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });
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

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();

    vi.mocked(currentUser.getIdToken).mockResolvedValue("persisted-token");
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(
      await screen.findByText("Vault content for account-owner"),
    ).toBeInTheDocument();
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
  ])("keeps protected UI sealed for $name", async ({ response }) => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
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
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });
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
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("keeps the auth gate closed while account B validation overlaps account A foreground validation", async () => {
    const accountAStatus = deferred<Response>();
    const accountBStatus = deferred<Response>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    mocks.apiGetAccountSessionStatus
      .mockReturnValueOnce(accountAStatus.promise)
      .mockReturnValueOnce(accountBStatus.promise);
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });
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
    expect(mocks.routerReplace).not.toHaveBeenCalled();
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

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
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
    expect(mocks.routerReplace).toHaveBeenCalledWith(
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
    expect(mocks.routerReplace).toHaveBeenCalledWith(
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

  it("bounds a hung foreground status check and keeps protected UI blocked", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(
      new Promise<Response>(() => undefined),
    );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });
});
