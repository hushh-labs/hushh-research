// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  addListener: vi.fn(),
  remove: vi.fn(),
  getPermissionState: vi.fn(),
  openAppSettings: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  syncSignals: vi.fn(),
  requestContactCheck: vi.fn(() => true),
  consentDialogOpenChange: vi.fn(),
  consentDialogChoose: vi.fn(),
  consentDialogRetry: vi.fn(),
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: mocks.isNative,
  getPlatform: () => "ios",
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: mocks.addListener },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    getPermissionState: mocks.getPermissionState,
    openAppSettings: mocks.openAppSettings,
    readContacts: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    error: mocks.toastError,
    message: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/contact-signals", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/one-location/contact-signals")
  >("@/lib/one-location/contact-signals");
  return {
    ...actual,
    syncOneLocationContactSignals: mocks.syncSignals,
    openContactPermissionSettings: async () => {
      const result = await mocks.openAppSettings();
      return Boolean(result?.opened);
    },
  };
});

vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConnectionGraphMutated: vi.fn() },
}));
vi.mock("@/lib/contacts/use-contact-discoverability-consent", () => ({
  useContactDiscoverabilityConsent: () => ({
    requestContactCheck: mocks.requestContactCheck,
    preference: { status: "decided", enabled: true, ruleVersion: 1 },
    dialogProps: {
      open: false,
      ready: false,
      loading: false,
      savingChoice: null,
      error: null,
      actionLabel: "Sync contacts",
      onOpenChange: mocks.consentDialogOpenChange,
      onChoose: mocks.consentDialogChoose,
      onRetry: mocks.consentDialogRetry,
    },
  }),
}));

import { useContactSync } from "@/lib/contacts/use-contact-sync";

/**
 * Reported after an iOS build:
 *
 *   "settings ios wali jab bhi open ho rahin, either for syncing contacts or
 *    this settings, ek back tap mein app par switch nahi karwa rha"
 *
 *   "baaki ke apps ... settings mein desired operation enable/disable karne ke
 *    baad entry ka path bhi dete hain"
 *
 * Whether iOS draws its "‹ Back to Hushh" pill is iOS's call. What was ours is
 * everything after the person gets back, and it did nothing: the toast that
 * sent them was gone, no permission was re-read, and the only way forward was
 * to find the same button and press it again. This asserts the app now
 * finishes the job they left to enable.
 */

type Handle = { current: ReturnType<typeof useContactSync> | null };

/** Publishes the hook's value through a callback rather than by writing to a
 *  prop, which the compiler rules forbid. */
function Harness({ onReady }: { onReady: (api: Handle["current"]) => void }) {
  const api = useContactSync({
    routeId: "one_location",
    getIdToken: async () => "token",
    accountPhoneNumber: "+919876543210",
    userId: "user_a",
  });
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

function foreground() {
  const call = mocks.addListener.mock.calls.find(
    ([event]) => event === "appStateChange",
  );
  (call?.[1] as ((state: { isActive: boolean }) => void) | undefined)?.({
    isActive: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNative.mockReturnValue(true);
  mocks.requestContactCheck.mockReturnValue(true);
  mocks.addListener.mockResolvedValue({ remove: mocks.remove });
  mocks.openAppSettings.mockResolvedValue({ opened: true });
  mocks.getPermissionState.mockResolvedValue({ state: "denied" });
  mocks.syncSignals.mockResolvedValue({
    matchedUserIds: [],
    totalContacts: 0,
    autoConnectedCount: 0,
    alreadyConnectedCount: 0,
    requestRequiredCount: 0,
    suppressedCount: 0,
    inviteCandidates: [],
    sourcePlatform: "ios",
    limited: false,
    truncated: false,
    partial: false,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("coming back from the OS settings app", () => {
  it("watches nothing until somebody has actually been sent there", async () => {
    const handle: Handle = { current: null };
    render(<Harness onReady={(api) => (handle.current = api)} />);

    await waitFor(() => expect(handle.current).not.toBeNull());
    foreground();

    // An ordinary foreground is not a return from Settings, and must not kick
    // off a scan of the address book behind the person's back.
    await waitFor(() => expect(mocks.syncSignals).not.toHaveBeenCalled());
  });

  it("names the switch and the way back before handing them over", async () => {
    // "settings mein desired operation enable/disable karne ke baad entry ka
    // path bhi dete hain" -- said before they leave, because after they leave
    // there is no surface of ours to say it on.
    const handle: Handle = { current: null };
    render(<Harness onReady={(api) => (handle.current = api)} />);
    await waitFor(() => expect(handle.current).not.toBeNull());

    await handle.current!.openContactSettings();

    expect(mocks.openAppSettings).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("come back"),
    );
  });

  it("finishes the sync they left to enable, without a second tap", async () => {
    const handle: Handle = { current: null };
    render(<Harness onReady={(api) => (handle.current = api)} />);
    await waitFor(() => expect(handle.current).not.toBeNull());

    await handle.current!.openContactSettings();
    await waitFor(() =>
      expect(
        mocks.addListener.mock.calls.some(([e]) => e === "appStateChange"),
      ).toBe(true),
    );

    // They switched Contacts on and came back.
    mocks.getPermissionState.mockResolvedValue({ state: "granted" });
    foreground();

    await waitFor(() => expect(mocks.syncSignals).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Contact access is on"),
    );
  });

  it("counts iOS limited access as a grant worth resuming on", async () => {
    // Limited access is a real grant over a hand-picked subset, and syncing
    // that subset is exactly what somebody who chose it asked for. Refusing to
    // resume until they widen it answers their decision by ignoring it.
    const handle: Handle = { current: null };
    render(<Harness onReady={(api) => (handle.current = api)} />);
    await waitFor(() => expect(handle.current).not.toBeNull());

    await handle.current!.openContactSettings();
    // The native listener is attached through a dynamic import, so it is not
    // there the instant the jump resolves.
    await waitFor(() =>
      expect(
        mocks.addListener.mock.calls.some(([e]) => e === "appStateChange"),
      ).toBe(true),
    );

    mocks.getPermissionState.mockResolvedValue({ state: "limited" });
    foreground();

    await waitFor(() => expect(mocks.syncSignals).toHaveBeenCalledTimes(1));
  });

  it("stays put when they come back having changed nothing", async () => {
    const handle: Handle = { current: null };
    render(<Harness onReady={(api) => (handle.current = api)} />);
    await waitFor(() => expect(handle.current).not.toBeNull());

    await handle.current!.openContactSettings();
    foreground();

    // Still denied. Resuming here would run a sync that can only fail again,
    // and report it as a second failure the person did not ask for.
    await waitFor(() => expect(mocks.syncSignals).not.toHaveBeenCalled());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("does not arm the watcher when nothing actually opened", async () => {
    // A browser, or an OS that refused. Watching for a return from a place
    // nobody went to would leave the watcher armed for the session.
    mocks.openAppSettings.mockResolvedValue({ opened: false });
    const handle: Handle = { current: null };
    render(<Harness onReady={(api) => (handle.current = api)} />);
    await waitFor(() => expect(handle.current).not.toBeNull());

    await handle.current!.openContactSettings();

    expect(mocks.toastInfo).not.toHaveBeenCalled();
    mocks.getPermissionState.mockResolvedValue({ state: "granted" });
    foreground();
    await waitFor(() => expect(mocks.syncSignals).not.toHaveBeenCalled());
  });
});
