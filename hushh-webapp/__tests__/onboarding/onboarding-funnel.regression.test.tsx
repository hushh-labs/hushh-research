/**
 * The first-run funnel, driven end to end through the real provider and the
 * real guards.
 *
 * Nothing here mocks a guard. The only things replaced are the edges the app
 * cannot have in jsdom — the backend record, the browser host, Firebase, the
 * in-memory lock, and the leaf screens. Everything between those edges is the
 * shipping code, so a regression in the decision or in any guard that consumes
 * it fails here.
 *
 * Screens record themselves during RENDER, not in an effect. A screen that
 * renders and is replaced before paint still lands in the log, which is what
 * makes "never appears, not even for one frame" a claim this file can actually
 * check rather than assert loosely.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => {
  type Record = {
    hasVault: boolean;
    phoneVerified: boolean | null;
    setupCompleted: boolean | null;
    onboardingJourneyVersion: number | null;
    onboardingPhase: string | null;
    onboardingActiveCapability: string | null;
    setupCapabilityIds: string[];
  };
  return {
    // ---- simulated durable + session state -------------------------------
    record: null as Record | null,
    latch: false,
    nativeLatch: false,
    isNative: false,
    hostname: "uat.one.hushh.ai" as string | null,
    authLoading: true,
    user: null as { uid: string } | null,
    phoneNumber: null as string | null,
    vaultUnlocked: false,
    vaultPresence: null as boolean | null,
    bootstrapCalls: 0,
    cacheWarm: false,
    cacheSubscribers: new Set<(event: { type: string; key: string }) => void>(),
    // ---- navigation ------------------------------------------------------
    history: ["/"] as string[],
    listeners: new Set<() => void>(),
    // ---- observation -----------------------------------------------------
    renderPass: 0,
    log: [] as { screen: string; pass: number }[],
  };
});

function notify() {
  harness.listeners.forEach((listener) => listener());
}

const router = {
  push(path: string) {
    harness.history.push(path);
    notify();
  },
  replace(path: string) {
    harness.history[harness.history.length - 1] = path;
    notify();
  },
  back() {
    if (harness.history.length > 1) harness.history.pop();
    notify();
  },
};

function currentPath(): string {
  return harness.history[harness.history.length - 1];
}

function pathname(): string {
  return currentPath().split("?")[0];
}

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(currentPath().split("?")[1] ?? ""),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => harness.isNative },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async () => ({ value: harness.nativeLatch ? "1" : null }),
    set: async () => undefined,
    remove: async () => undefined,
  },
}));

vi.mock("@/lib/hooks/use-hostname", () => ({
  useHostname: () => harness.hostname,
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: harness.user,
    loading: harness.authLoading,
    phoneNumber: harness.phoneNumber,
    signOut: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: harness.user,
    loading: harness.authLoading,
    phoneNumber: harness.phoneNumber,
    signOut: vi.fn(),
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: harness.vaultUnlocked,
    unlockVault: vi.fn(),
  }),
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    // Mirrors the real service: the first read warms a session cache, and every
    // later read comes from it until something writes a new value.
    getCachedBootstrapState: () => (harness.cacheWarm ? harness.record : null),
    bootstrapState: async () => {
      harness.bootstrapCalls += 1;
      if (!harness.record) throw new Error("no record");
      harness.cacheWarm = true;
      return harness.record;
    },
    isSetupResolved: (state: { setupCompleted?: boolean | null } | null) =>
      state?.setupCompleted === true,
  },
}));

vi.mock("@/lib/services/one-setup-completion-hint-service", () => ({
  OneSetupCompletionHintService: {
    isResolved: () => harness.latch,
    hydrateFromNative: async () => {
      if (harness.nativeLatch) harness.latch = true;
      return harness.latch;
    },
    markResolved: () => {
      harness.latch = true;
    },
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: () => null,
    hasVerifiedPhone: () => false,
    getIdentitySwr: async () => ({ identity: null }),
    primeVerifiedPhoneHint: () => undefined,
  },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultAuthSessionNotReadyError: class extends Error {},
  VaultService: {
    peekVaultPresence: () => harness.vaultPresence,
    checkVault: async () => harness.record?.hasVault ?? false,
    refreshVaultPresence: async () => harness.record?.hasVault ?? false,
  },
}));

vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({
      subscribe: (listener: (event: { type: string; key: string }) => void) => {
        harness.cacheSubscribers.add(listener);
        return () => harness.cacheSubscribers.delete(listener);
      },
    }),
  },
  CACHE_KEYS: { PRE_VAULT_BOOTSTRAP: (id: string) => `pre_vault_${id}` },
}));

vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    beginTask: vi.fn(),
    completeTaskStep: vi.fn(),
    endTask: vi.fn(),
  }),
}));

vi.mock("@/lib/testing/native-test", () => ({
  hasIncompleteNativeUiFlowSession: () => false,
  isNativeTestVaultBootstrapManaged: () => false,
  preferPassphraseUnlockForAutomation: () => false,
  useNativeTestConfig: () => null,
}));

vi.mock("@/lib/auth/use-session-chrome-suppression", () => ({
  useSessionChromeSuppression: () => undefined,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label?: string }) => (
    <p data-testid="boot-loader">{label}</p>
  ),
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

// The lock surface. In the app this is a portal over an opaque backdrop, which
// is exactly why it has to be kept out of the wrong step by the decision rather
// than by where it sits in the tree.
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => {
    harness.log.push({ screen: "lock", pass: harness.renderPass });
    return <div data-testid="lock-screen" />;
  },
}));

vi.mock("@/components/observability/location-funnel-observer", () => ({
  LocationFunnelObserver: () => null,
  LocationVaultUnlockedObserver: () => null,
}));

import { OnboardingEntryProvider } from "@/lib/onboarding/onboarding-entry-context";
import { OnboardingJourneyGuard } from "@/components/onboarding/onboarding-journey-guard";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

function Screen({ name }: { name: string }) {
  harness.log.push({ screen: name, pass: harness.renderPass });
  return <div data-testid={`${name}-screen`}>{name}</div>;
}

/** Mirrors app/one/one-auth-gate.tsx: setup surfaces get no lock gate. */
function RouteSwitch() {
  const path = pathname();
  if (path === "/login") return <Screen name="auth" />;
  if (path === "/register-phone") return <Screen name="phone" />;
  if (path === "/getting-started") return <Screen name="intro" />;
  if (path === "/one/setup") {
    return (
      <PhoneMandateGuard>
        <Screen name="setup" />
      </PhoneMandateGuard>
    );
  }
  return (
    <PhoneMandateGuard>
      <VaultLockGuard>
        <Screen name="app" />
      </VaultLockGuard>
    </PhoneMandateGuard>
  );
}

function App() {
  const [, force] = require("react").useState(0);
  const react = require("react");
  react.useEffect(() => {
    const listener = () => force((n: number) => n + 1);
    harness.listeners.add(listener);
    return () => {
      harness.listeners.delete(listener);
    };
  }, []);
  harness.renderPass += 1;
  return (
    <OnboardingEntryProvider>
      <OnboardingJourneyGuard>
        <RouteSwitch />
      </OnboardingJourneyGuard>
    </OnboardingEntryProvider>
  );
}

/**
 * Flush everything the app would do on its own: re-render for whatever changed
 * in the harness, then drain the promise and timer work the provider does.
 */
function publishRecord() {
  if (!harness.user) return;
  const key = `pre_vault_${harness.user.uid}`;
  harness.cacheSubscribers.forEach((listener) =>
    listener({ type: "set", key }),
  );
}

async function settle() {
  await act(async () => {
    notify();
    publishRecord();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    notify();
    await new Promise((resolve) => setTimeout(resolve, 400));
    publishRecord();
    notify();
    await Promise.resolve();
  });
}

function completedRecord() {
  return {
    hasVault: true,
    phoneVerified: true,
    setupCompleted: true,
    onboardingJourneyVersion: 1,
    onboardingPhase: "root_completion",
    onboardingActiveCapability: null,
    setupCapabilityIds: [],
  };
}

function screensSeen(): string[] {
  const seen: string[] = [];
  for (const entry of harness.log) {
    if (seen[seen.length - 1] !== entry.screen) seen.push(entry.screen);
  }
  return seen;
}

function surfacesShown(): string[] {
  return Array.from(new Set(harness.log.map((entry) => entry.screen)));
}

/** Screens that rendered together in one pass of the tree. */
function simultaneousSurfaces(): string[][] {
  const byPass = new Map<number, Set<string>>();
  for (const entry of harness.log) {
    if (!byPass.has(entry.pass)) byPass.set(entry.pass, new Set());
    byPass.get(entry.pass)!.add(entry.screen);
  }
  return Array.from(byPass.values())
    .map((set) => Array.from(set))
    .filter((names) => names.length > 1);
}

function goTo(path: string) {
  harness.history = [path];
  notify();
}

describe("the first-run funnel", () => {
  beforeEach(() => {
    harness.record = null;
    harness.latch = false;
    harness.nativeLatch = false;
    harness.isNative = false;
    harness.hostname = "uat.one.hushh.ai";
    harness.authLoading = true;
    harness.user = null;
    harness.phoneNumber = null;
    harness.vaultUnlocked = false;
    harness.vaultPresence = null;
    harness.bootstrapCalls = 0;
    harness.cacheWarm = false;
    harness.cacheSubscribers.clear();
    harness.history = ["/one"];
    harness.renderPass = 0;
    harness.log = [];
  });

  afterEach(() => {
    harness.listeners.clear();
  });

  // Test 1 ------------------------------------------------------------------
  it("walks a brand new person through every step, once, in order", async () => {
    harness.authLoading = false;
    goTo("/getting-started");
    render(<App />);
    await settle();
    expect(screen.getByTestId("intro-screen")).toBeTruthy();

    // Sign-in lands, and the phone is the next thing that is missing.
    act(() => {
      harness.user = { uid: "new-user" };
      harness.record = {
        hasVault: false,
        phoneVerified: false,
        setupCompleted: false,
        onboardingJourneyVersion: 1,
        onboardingPhase: "phone_required",
        onboardingActiveCapability: null,
        setupCapabilityIds: [],
      };
      router.replace("/login");
    });
    await settle();
    expect(await screen.findByTestId("phone-screen")).toBeTruthy();

    // The code is confirmed.
    await act(async () => {
      harness.phoneNumber = "+911234567890";
      harness.record = { ...harness.record!, phoneVerified: true };
      router.replace("/one/setup");
    });
    await settle();
    expect(screen.getByTestId("setup-screen")).toBeTruthy();

    // The lock is created on the setup hub, and Finish ends the funnel.
    await act(async () => {
      harness.vaultUnlocked = true;
      harness.record = {
        ...harness.record!,
        hasVault: true,
        setupCompleted: true,
        onboardingPhase: "root_completion",
      };
      harness.latch = true;
      router.replace("/one");
    });
    await settle();
    expect(screen.getByTestId("app-screen")).toBeTruthy();

    expect(screensSeen()).toEqual(["intro", "phone", "setup", "app"]);
  });

  // Test 2 ------------------------------------------------------------------
  it("shows no lock screen anywhere between the code and the app", async () => {
    harness.authLoading = false;
    harness.user = { uid: "new-user" };
    harness.phoneNumber = "+911234567890";
    harness.record = {
      hasVault: false,
      phoneVerified: true,
      setupCompleted: false,
      onboardingJourneyVersion: 1,
      onboardingPhase: "setup_hub",
      onboardingActiveCapability: null,
      setupCapabilityIds: [],
    };
    goTo("/one/setup");
    render(<App />);
    await settle();

    await act(async () => {
      harness.vaultUnlocked = true;
      harness.record = { ...harness.record!, hasVault: true, setupCompleted: true };
      harness.latch = true;
      router.replace("/one");
    });
    await settle();

    expect(screen.getByTestId("app-screen")).toBeTruthy();
    expect(surfacesShown()).not.toContain("lock");
  });

  // Test 3 ------------------------------------------------------------------
  it("cannot be re-entered by pressing Back", async () => {
    harness.authLoading = false;
    harness.user = { uid: "done-user" };
    harness.phoneNumber = "+911234567890";
    harness.vaultUnlocked = true;
    harness.latch = true;
    harness.record = completedRecord();
    // A history stack that still carries the funnel — a redirect chain, a
    // provider's own page load, an orphaned setup entry. All of it is exactly
    // what people were pressing Back into.
    harness.history = ["/getting-started", "/login", "/register-phone", "/one/setup", "/one"];
    render(<App />);
    await settle();
    expect(screen.getByTestId("app-screen")).toBeTruthy();

    harness.log = [];
    for (let press = 0; press < 3; press += 1) {
      await act(async () => {
        router.back();
      });
      await settle();
    }

    for (const forbidden of ["phone", "auth", "setup", "lock"]) {
      expect(surfacesShown()).not.toContain(forbidden);
    }
    expect(screen.getByTestId("app-screen")).toBeTruthy();
    expect(pathname()).toBe("/one");
  });

  // Test 4 ------------------------------------------------------------------
  it("does not send a finished person back through it on a refresh", async () => {
    harness.authLoading = false;
    harness.user = { uid: "done-user" };
    harness.phoneNumber = "+911234567890";
    harness.vaultUnlocked = true;
    harness.latch = true;
    harness.record = completedRecord();
    goTo("/one");
    render(<App />);
    await settle();

    expect(screen.getByTestId("app-screen")).toBeTruthy();
    expect(surfacesShown()).toEqual(["app"]);
  });

  // Test 5 ------------------------------------------------------------------
  it("opens straight into the app on a cold start, with nothing flashing first", async () => {
    // Cold: Firebase has not restored yet and no record is cached.
    harness.authLoading = true;
    harness.latch = false;
    harness.record = completedRecord();
    goTo("/one");
    render(<App />);
    await settle();

    // Firebase restores the session.
    await act(async () => {
      harness.authLoading = false;
      harness.user = { uid: "done-user" };
      harness.phoneNumber = "+911234567890";
      harness.vaultUnlocked = true;
    });
    await settle();

    expect(screen.getByTestId("app-screen")).toBeTruthy();
    expect(surfacesShown()).toEqual(["app"]);
  });

  it("holds a loader rather than guessing while the session is restoring", async () => {
    harness.authLoading = true;
    harness.record = completedRecord();
    goTo("/one");
    render(<App />);
    await settle();

    expect(screen.getByTestId("boot-loader")).toBeTruthy();
    expect(harness.log).toEqual([]);
  });

  // Test 6 ------------------------------------------------------------------
  describe("a half-finished person resumes at the first thing still missing", () => {
    async function relaunchAt(record: NonNullable<typeof harness.record>) {
      harness.authLoading = false;
      harness.user = { uid: "resume-user" };
      harness.phoneNumber = record.phoneVerified ? "+911234567890" : null;
      harness.vaultUnlocked = false;
      harness.record = record;
      goTo("/one");
      render(<App />);
      await settle();
    }

    it("resumes at phone verification when only sign-in is done", async () => {
      await relaunchAt({
        hasVault: false,
        phoneVerified: false,
        setupCompleted: false,
        onboardingJourneyVersion: 1,
        onboardingPhase: "phone_required",
        onboardingActiveCapability: null,
        setupCapabilityIds: [],
      });
      expect(pathname()).toBe("/register-phone");
      expect(surfacesShown()).not.toContain("app");
    });

    it("resumes at setup when the phone is done but the funnel is not", async () => {
      await relaunchAt({
        hasVault: false,
        phoneVerified: true,
        setupCompleted: false,
        onboardingJourneyVersion: 1,
        onboardingPhase: "setup_hub",
        onboardingActiveCapability: null,
        setupCapabilityIds: [],
      });
      expect(currentPath()).toContain("/one/setup");
      expect(surfacesShown()).not.toContain("app");
    });

    it("resumes in the app once the funnel is genuinely finished", async () => {
      await relaunchAt(completedRecord());
      expect(pathname()).toBe("/one");
    });

    it("restores the completion latch from native storage before deciding", async () => {
      // WKWebView drops localStorage between launches under the custom scheme,
      // so the latch is cold on every native cold start. Reading it as "not
      // finished" is what used to re-trap people on the setup hub.
      harness.isNative = true;
      harness.latch = false;
      harness.nativeLatch = true;
      harness.authLoading = false;
      harness.user = { uid: "native-user" };
      harness.phoneNumber = "+911234567890";
      harness.vaultUnlocked = true;
      harness.record = { ...completedRecord(), setupCompleted: false };
      goTo("/one");
      render(<App />);
      await settle();

      expect(screen.getByTestId("app-screen")).toBeTruthy();
      expect(surfacesShown()).not.toContain("setup");
    });
  });

  // Test 7 ------------------------------------------------------------------
  describe("the lock and the phone screen are mutually exclusive", () => {
    it("never renders both in the same pass, in any of these states", async () => {
      const states = [
        { phoneVerified: false, hasVault: true, setupCompleted: true },
        { phoneVerified: false, hasVault: false, setupCompleted: false },
        { phoneVerified: false, hasVault: true, setupCompleted: false },
        { phoneVerified: true, hasVault: true, setupCompleted: true },
        { phoneVerified: null, hasVault: true, setupCompleted: true },
      ];

      for (const state of states) {
        harness.log = [];
        harness.authLoading = false;
        harness.user = { uid: "collision-user" };
        harness.phoneNumber = null;
        harness.vaultUnlocked = false;
        harness.vaultPresence = state.hasVault;
        harness.latch = false;
        harness.record = {
          ...completedRecord(),
          ...state,
        } as NonNullable<typeof harness.record>;
        goTo("/one");
        const view = render(<App />);
        await settle();

        const together = simultaneousSurfaces();
        expect(together).toEqual([]);
        expect(
          Boolean(
            view.queryByTestId("phone-screen") &&
              view.queryByTestId("lock-screen"),
          ),
        ).toBe(false);
        view.unmount();
      }
    });

    it("sends an unverified phone to verification instead of showing the lock", async () => {
      harness.authLoading = false;
      harness.user = { uid: "collision-user" };
      harness.phoneNumber = null;
      harness.vaultUnlocked = false;
      harness.vaultPresence = true;
      harness.latch = true;
      harness.record = { ...completedRecord(), phoneVerified: false };
      goTo("/one");
      render(<App />);
      await settle();

      expect(currentPath()).toContain("/register-phone");
      expect(surfacesShown()).not.toContain("lock");
    });
  });
});
