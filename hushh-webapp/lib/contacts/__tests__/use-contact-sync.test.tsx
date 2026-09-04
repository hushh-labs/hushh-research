// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permissionState: "prompt" as "prompt" | "granted" | "unavailable",
  getPermissionState: vi.fn(),
  googleAvailability: "unconfigured" as "connectable" | "unconfigured",
  requestGoogleToken: vi.fn(),
  preloadGoogle: vi.fn(),
  googleSource: vi.fn(),
  syncSignals: vi.fn(),
  isNative: vi.fn(() => false),
  trackEvent: vi.fn(),
  onGraphMutated: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    getPermissionState: mocks.getPermissionState,
  },
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: mocks.isNative,
}));

vi.mock("@/lib/contacts/google-people-source", () => ({
  googleContactsAvailability: () => mocks.googleAvailability,
  googlePeopleContactSource: mocks.googleSource,
}));

vi.mock("@/lib/contacts/google-contacts-token", () => ({
  requestGoogleContactsToken: mocks.requestGoogleToken,
  preloadGoogleContactsAuth: mocks.preloadGoogle,
  isGoogleContactsConsentCancelled: (error: unknown) =>
    (error as { name?: string })?.name === "AbortError",
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mocks.trackEvent,
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConnectionGraphMutated: vi.fn(),
    onConnectionCapabilityMutated: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/contact-signals", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/one-location/contact-signals")
  >()),
  syncOneLocationContactSignals: mocks.syncSignals,
  openContactPermissionSettings: vi.fn(),
}));

import { OneLocationContactSyncError } from "@/lib/one-location/contact-signals";
import { useContactSync } from "@/lib/contacts/use-contact-sync";

/**
 * The branches the Connect page cannot reach.
 *
 * The page-level suite proves placement, tab gating and re-entrancy. What it
 * cannot show is what this hook does once a read has actually been attempted:
 * which source it chose, what it told the person when the read failed, and
 * whether it asked the surface to refresh. Those are the parts a lift is most
 * likely to have dropped, and until this file existed nothing exercised them
 * on either surface -- the Location suite mocks the same call.
 */

const EMPTY_RESULT = {
  matches: [],
  matchedUserIds: [],
  totalContacts: 0,
  readContactCount: 0,
  checkedContactCount: 0,
  matchedContactCount: 0,
  unmatchedContactCount: 0,
  uncheckedContactCount: 0,
  uncheckableContactCount: 0,
  excludedSelfContactCount: 0,
  lookupLimitedContactCount: 0,
  lookupLimitExceeded: false,
  inviteCandidateCount: 0,
  autoConnectedCount: 0,
  alreadyConnectedCount: 0,
  requestRequiredCount: 0,
  suppressedCount: 0,
  unknownContactCount: 0,
  completedBatchCount: 1,
  totalBatchCount: 1,
  mutationOutcomeUnknown: false,
  sourcePlatform: "web" as const,
  limited: false,
  truncated: false,
  partial: false,
  region: null,
};

function setup(overrides: Record<string, unknown> = {}) {
  return renderHook(() =>
    useContactSync({
      routeId: "connect",
      getIdToken: async () => "id-token",
      accountPhoneNumber: "+919000000001",
      userId: "me",
      onConnectionGraphChanged: mocks.onGraphMutated,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissionState = "prompt";
  mocks.googleAvailability = "unconfigured";
  mocks.isNative.mockReturnValue(false);
  mocks.getPermissionState.mockImplementation(async () => ({
    state: mocks.permissionState,
  }));
  mocks.syncSignals.mockResolvedValue(EMPTY_RESULT);
  // The hook calls `.catch()` on this directly. A bare vi.fn() returns
  // undefined and throws inside the mount effect, which vitest reports as an
  // unhandled error while the assertions still pass.
  mocks.preloadGoogle.mockResolvedValue(undefined);
});

describe("useContactSync — which source it reads", () => {
  it("reads the device book and never touches Google when one exists", async () => {
    mocks.googleAvailability = "connectable";
    const { result } = setup();

    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.googleFallback).toBe(false);
    // Google is a fallback, never a second button: a device book is the
    // person's real contacts and needs no consent sheet.
    expect(mocks.preloadGoogle).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.requestGoogleToken).not.toHaveBeenCalled();
    expect(mocks.syncSignals.mock.calls[0][0].source).toBeUndefined();
  });

  it("falls back to Google only where there is no book AND it is configured", async () => {
    mocks.permissionState = "unavailable";
    mocks.googleAvailability = "connectable";
    mocks.requestGoogleToken.mockResolvedValue("google-token");
    mocks.googleSource.mockReturnValue("google-source");

    const { result } = setup();
    await waitFor(() => expect(result.current.googleFallback).toBe(true));
    expect(result.current.available).toBe(true);
    // Warms GIS at mount so the later token request runs inside the tap.
    // Without it Safari blocks the popup, because the script load lands after
    // the gesture that asked for it.
    expect(mocks.preloadGoogle).toHaveBeenCalled();

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.syncSignals.mock.calls[0][0].source).toBe("google-source");
  });

  it("waits for verified phone hydration after Google consent settles", async () => {
    mocks.permissionState = "unavailable";
    mocks.googleAvailability = "connectable";
    mocks.requestGoogleToken.mockResolvedValue("google-token");
    mocks.googleSource.mockReturnValue("google-source");
    let finishPhoneHydration: ((phone: string) => void) | null = null;
    const resolveVerifiedAccountPhoneNumber = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishPhoneHydration = resolve;
        }),
    );
    mocks.syncSignals.mockImplementationOnce(async (options) => {
      await options.resolveAccountPhoneNumber?.();
      await options.resolveIdToken?.();
      return EMPTY_RESULT;
    });

    const { result } = setup({
      accountPhoneNumber: null,
      resolveVerifiedAccountPhoneNumber,
    });
    await waitFor(() => expect(result.current.googleFallback).toBe(true));

    let syncPromise!: Promise<void>;
    act(() => {
      syncPromise = result.current.sync();
    });
    await waitFor(() =>
      expect(resolveVerifiedAccountPhoneNumber).toHaveBeenCalledTimes(1),
    );
    expect(mocks.syncSignals).toHaveBeenCalledTimes(1);
    expect(result.current.resultsOpen).toBe(false);
    await act(async () => {
      finishPhoneHydration?.("+919000000001");
      await syncPromise;
    });

    expect(mocks.syncSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "google-source",
        accountPhoneNumber: null,
        resolveAccountPhoneNumber: expect.any(Function),
        resolveIdToken: expect.any(Function),
      }),
    );
    expect(result.current.resultsOpen).toBe(true);
  });

  it("stops the pipeline after the signed-in account changes", async () => {
    mocks.permissionState = "unavailable";
    mocks.googleAvailability = "connectable";
    let resolveGoogleToken: ((token: string) => void) | null = null;
    mocks.requestGoogleToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveGoogleToken = resolve;
        }),
    );
    mocks.googleSource.mockReturnValue("google-source");
    mocks.syncSignals.mockImplementationOnce(async (options) => {
      await options.resolveAccountPhoneNumber?.();
      return EMPTY_RESULT;
    });

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) =>
        useContactSync({
          routeId: "connect",
          getIdToken: async () => "id-token",
          accountPhoneNumber: "+919000000001",
          userId,
        }),
      { initialProps: { userId: "me" } },
    );
    await waitFor(() => expect(result.current.googleFallback).toBe(true));

    let syncPromise!: Promise<void>;
    act(() => {
      syncPromise = result.current.sync();
    });
    await waitFor(() => expect(mocks.requestGoogleToken).toHaveBeenCalledTimes(1));
    rerender({ userId: "someone-else" });
    await act(async () => {
      resolveGoogleToken?.("google-token");
      await syncPromise;
    });

    expect(mocks.syncSignals).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Your signed-in account changed. Start contact sync again.",
    );
  });

  it("is unavailable where there is neither", async () => {
    mocks.permissionState = "unavailable";
    mocks.googleAvailability = "unconfigured";
    const { result } = setup();

    await waitFor(() => expect(result.current.available).toBe(false));
    expect(result.current.googleFallback).toBe(false);
    expect(mocks.preloadGoogle).not.toHaveBeenCalled();
  });

  it("asks Google for a token before the first await", async () => {
    // The ordering the Safari popup depends on. If a token fetch ran first the
    // tap's transient activation would already be spent.
    mocks.permissionState = "unavailable";
    mocks.googleAvailability = "connectable";
    const order: string[] = [];
    mocks.requestGoogleToken.mockImplementation(() => {
      order.push("google");
      return Promise.resolve("google-token");
    });
    mocks.googleSource.mockReturnValue("google-source");
    mocks.syncSignals.mockImplementationOnce(async (options) => {
      await options.resolveIdToken?.();
      return EMPTY_RESULT;
    });

    const { result } = setup({
      getIdToken: async () => {
        order.push("idToken");
        return "id-token";
      },
    });
    await waitFor(() => expect(result.current.googleFallback).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(order).toEqual(["google", "idToken"]);
  });

  it("clears matched contact identities before a replacement account paints", async () => {
    mocks.syncSignals.mockResolvedValueOnce({
      ...EMPTY_RESULT,
      matches: [
        {
          lookupId: "lookup_a",
          userId: "matched_a",
          displayName: "Local A",
          photoUrl: null,
          outcome: "auto_connected" as const,
        },
      ],
      matchedUserIds: ["matched_a"],
      matchedContactCount: 1,
      autoConnectedCount: 1,
    });
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) =>
        useContactSync({
          routeId: "connect",
          getIdToken: async () => "id-token",
          accountPhoneNumber: "+919000000001",
          userId,
        }),
      { initialProps: { userId: "user_a" } },
    );
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.result?.matchedUserIds).toEqual(["matched_a"]);
    expect(result.current.resultsOpen).toBe(true);

    rerender({ userId: "user_b" });

    expect(result.current.result).toBeNull();
    expect(result.current.resultsOpen).toBe(false);
    expect(result.current.signal).toEqual({
      status: "idle",
      matchedUserIds: [],
      matchedCount: 0,
      totalContacts: 0,
      inviteCandidateCount: 0,
      limited: false,
      truncated: false,
      error: null,
      syncedAt: null,
    });
  });
});

describe("useContactSync — what it says when a read fails", () => {
  it("sends a denied read to Settings, because a retry cannot prompt again", async () => {
    mocks.syncSignals.mockRejectedValue(
      new OneLocationContactSyncError("denied", "Contacts access is off."),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });

    expect(mocks.toastError).toHaveBeenCalled();
    expect(mocks.toastError.mock.calls[0][1]?.action?.label).toBe(
      "Open Settings",
    );
  });

  it("states an unavailable read rather than erroring at the person", async () => {
    // Not a failure they caused or can act on: a browser with no picker.
    mocks.syncSignals.mockRejectedValue(
      new OneLocationContactSyncError(
        "unavailable",
        "Contact sync is available in the app.",
      ),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });

    expect(mocks.toastInfo).toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("treats an unrecognised throw as an error, not as a known failure", async () => {
    mocks.syncSignals.mockRejectedValue(new Error("boom"));
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });

    expect(mocks.toastError).toHaveBeenCalled();
    expect(mocks.trackEvent.mock.calls.at(-1)?.[1]?.failure_reason).toBe(
      "error",
    );
  });

  it("clears busy after a failure, so the control comes back", async () => {
    mocks.syncSignals.mockRejectedValue(new Error("boom"));
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.syncing).toBe(false);
  });
});

describe("useContactSync — what it tells the surface", () => {
  it("does not refresh the list when the graph did not change", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.onGraphMutated).not.toHaveBeenCalled();
  });

  it("refreshes when someone was connected", async () => {
    mocks.syncSignals.mockResolvedValue({
      ...EMPTY_RESULT,
      autoConnectedCount: 1,
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.onGraphMutated).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the mutation outcome is unknown", async () => {
    // The write may have landed. Refusing to refresh would leave the list
    // disagreeing with the server for no better reason than uncertainty.
    mocks.syncSignals.mockResolvedValue({
      ...EMPTY_RESULT,
      mutationOutcomeUnknown: true,
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.onGraphMutated).toHaveBeenCalledTimes(1);
  });

  it("carries the caller's routeId into analytics, not a Location one", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.trackEvent.mock.calls.at(-1)?.[1]?.route_id).toBe("connect");
  });

  it("passes the account number through, so bare numbers are read in its region", async () => {
    // Without it every 10-digit contact is parsed as North American.
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.syncSignals.mock.calls[0][0].accountPhoneNumber).toBe(
      "+919000000001",
    );
  });

  it("refuses to read when nobody is signed in", async () => {
    const { result } = setup({ getIdToken: null });
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.sync();
    });
    expect(mocks.syncSignals).not.toHaveBeenCalled();
    expect(mocks.requestGoogleToken).not.toHaveBeenCalled();
  });
});

describe("useContactSync — the native contract", () => {
  // On a phone the address book is the source, and Google is not merely
  // unused there: `googleContactsAvailability()` returns "unconfigured"
  // whenever `isNative()`, because the shell's page origin is a custom scheme
  // that Google will not accept as an authorised JavaScript origin. These
  // tests hold that line from this side.

  it("keeps the control available when the native probe fails", async () => {
    // The regression this exists for. `googleConfigured` is false on native by
    // construction, so a probe failure used to set `available` to false and
    // the control vanished on the platform the feature is mainly for -- with
    // an address book sitting right there. A failed probe is not evidence that
    // there is nothing to read.
    mocks.isNative.mockReturnValue(true);
    mocks.getPermissionState.mockRejectedValue(new Error("bridge down"));

    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.googleFallback).toBe(false);
    expect(mocks.preloadGoogle).not.toHaveBeenCalled();
  });

  it("hides the control when a WEB probe fails and no Google client exists", async () => {
    // The same failure, inverted: off a device, no plugin answer and no Google
    // client means there genuinely is nothing to read.
    mocks.isNative.mockReturnValue(false);
    mocks.googleAvailability = "unconfigured";
    mocks.getPermissionState.mockRejectedValue(new Error("no plugin"));

    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it("still reads the device book when the OS has not been asked yet", async () => {
    mocks.isNative.mockReturnValue(true);
    mocks.permissionState = "prompt";
    const { result } = setup();

    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.googleFallback).toBe(false);

    await act(async () => {
      await result.current.sync();
    });
    // No source override: the read goes to the native plugin, and the OS
    // permission sheet is raised inside it rather than as a separate step.
    expect(mocks.syncSignals.mock.calls[0][0].source).toBeUndefined();
  });

  it("keeps the control for a denied device, so Settings stays reachable", async () => {
    // Denied is not unavailable. Hiding the control would remove the only
    // route back to the OS setting that turned it off.
    mocks.isNative.mockReturnValue(true);
    mocks.getPermissionState.mockResolvedValue({ state: "denied" });

    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));
  });
});
