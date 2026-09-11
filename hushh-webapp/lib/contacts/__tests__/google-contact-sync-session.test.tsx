// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useContext, useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactInvitationSessionProvider } from "@/components/connections/contact-invitation-session-provider";
import { useContactSync } from "@/lib/contacts/use-contact-sync";
import { ContactSyncResultsSheet } from "@/components/one-location/contact-sync-results-sheet";
import { googleContactSyncSummary } from "../google-contact-sync-summary";
import {
  GoogleContactSyncSessionContext,
  type GoogleContactSyncController,
} from "../use-google-contact-sync-session";
const mocks = vi.hoisted(() => ({
  owner: "owner-a" as string | null,
  pathname: "/connect",
  token: vi.fn(),
  source: vi.fn(),
  sync: vi.fn(),
  refresh: vi.fn(),
  graph: vi.fn(),
  track: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.owner ? { uid: mocks.owner } : null }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/capacitor", () => ({
  HushhContacts: { getPermissionState: mocks.probe },
}));
vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => false }));
vi.mock("@/lib/contacts/google-people-source", () => ({
  googleContactsAvailability: () => "connectable",
  googlePeopleContactSource: mocks.source,
}));
vi.mock("@/lib/contacts/google-contacts-token", () => ({
  requestGoogleContactsToken: mocks.token,
  preloadGoogleContactsAuth: async () => {},
  isGoogleContactsConsentCancelled: (error: Error) =>
    error.name === "AbortError",
}));
vi.mock("@/lib/contacts/use-contact-discoverability-consent", () => ({
  useContactDiscoverabilityConsent: () => ({
    requestContactCheck: () => true,
    dialogProps: {},
  }),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConnectionGraphMutated: mocks.graph },
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: mocks.track }));
vi.mock("@/lib/one-location/contact-signals", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/one-location/contact-signals")
  >()),
  syncOneLocationContactSignals: mocks.sync,
}));
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
  sourcePlatform: "google" as const,
  limited: false,
  truncated: false,
  partial: false,
  region: null,
};

let controller: GoogleContactSyncController;
function Observe() {
  const session = useContext(GoogleContactSyncSessionContext)!;
  useLayoutEffect(() => {
    controller = session.controller;
  });
  return null;
}
function Route() {
  const sync = useContactSync({
    routeId: "connect",
    userId: mocks.owner,
    getIdToken: async () => "id-token",
    accountPhoneNumber: "+14155550199",
    onConnectionGraphChanged: mocks.refresh,
  });
  return (
    <>
      <button disabled={!sync.available} onClick={() => void sync.sync()}>
        Find contacts
      </button>
      <ContactSyncResultsSheet {...sync.resultsSheetProps} />
    </>
  );
}
function App({ blocked = false }: { blocked?: boolean }) {
  return (
    <ContactInvitationSessionProvider>
      <Observe />
      {blocked ? <p>Checking session</p> : <Route />}
    </ContactInvitationSessionProvider>
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
async function start() {
  await waitFor(() => expect(screen.getByText("Find contacts")).toBeEnabled());
  fireEvent.click(screen.getByText("Find contacts"));
  await waitFor(() => expect(mocks.token).toHaveBeenCalled());
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sync.mockReset();
  mocks.token.mockReset();
  mocks.graph.mockReset();
  mocks.track.mockReset();
  mocks.probe.mockReset();
  mocks.probe.mockResolvedValue({ state: "unavailable" });
  mocks.owner = "owner-a";
  mocks.pathname = "/connect";
  mocks.source.mockReturnValue(vi.fn());
  mocks.token.mockResolvedValue("google-token");
  mocks.sync.mockResolvedValue(EMPTY_RESULT);
  mocks.refresh.mockResolvedValue(undefined);
});
describe("web Google sync across auth gate remounts", () => {
  it("retries the retained Google source before the remounted availability probe resolves", async () => {
    const app = render(<App />);
    await start();
    await screen.findByRole("dialog", { name: "Contact sync results" });
    app.rerender(<App blocked />);
    const probe = deferred<{ state: string }>();
    mocks.probe.mockReturnValueOnce(probe.promise);
    app.rerender(<App />);
    expect(
      screen.getByRole("button", { name: "Find contacts" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose Google account" }),
    );
    await waitFor(() => expect(mocks.token).toHaveBeenCalledTimes(2));
    await screen.findByRole("dialog", { name: "Contact sync results" });
    expect(mocks.source).toHaveBeenCalledTimes(2);
    await act(async () => probe.resolve({ state: "unavailable" }));
  });

  it.each(["owner", "route"])(
    "rejects an old entry callback after %s changes",
    async (reason) => {
      const app = render(<App blocked />);
      const oldRun = controller.run;
      if (reason === "owner") mocks.owner = "owner-b";
      else mocks.pathname = "/one/location";
      app.rerender(<App blocked />);
      const beginInvites = vi.fn();
      await act(async () => {
        expect(await oldRun({ routeId: "connect", beginInvites })).toBeNull();
      });
      expect(beginInvites).not.toHaveBeenCalled();
      expect(mocks.token).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
    },
  );

  it("keeps successful results even if cache and analytics fail", async () => {
    mocks.graph.mockImplementation(() => {
      throw new Error("cache failure");
    });
    mocks.track.mockImplementation(() => {
      throw new Error("analytics failure");
    });
    mocks.sync.mockResolvedValue({ ...EMPTY_RESULT, alreadyConnectedCount: 1 });
    render(<App />);
    await start();
    expect(
      await screen.findByRole("dialog", { name: "Contact sync results" }),
    ).toBeVisible();
    expect(controller.phase).toBe("complete");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("drops late results and invite candidates after logout during matching", async () => {
    const pending = deferred<typeof EMPTY_RESULT>();
    mocks.sync.mockReturnValue(pending.promise);
    const app = render(<App blocked />);
    const candidates = vi.fn();
    let run!: ReturnType<typeof controller.run>;
    act(() => {
      run = controller.run({
        routeId: "connect",
        onInviteCandidates: candidates,
      });
    });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalled());
    const options = mocks.sync.mock.calls[0][0];
    mocks.owner = null;
    app.rerender(<App blocked />);
    expect(options.signal.aborted).toBe(true);
    await act(async () => {
      options.onInviteCandidates([{ displayName: "Private contact" }]);
      pending.resolve(EMPTY_RESULT);
      await run;
    });
    expect(candidates).not.toHaveBeenCalled();
    expect(controller.result).toBeNull();
    expect(mocks.graph).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });
  it.each(["consent", "matching"])(
    "restores results when gate unmounts the route during %s",
    async (phase) => {
      const token = deferred<string>();
      const result = deferred<typeof EMPTY_RESULT>();
      mocks.token.mockReturnValue(token.promise);
      mocks.sync.mockReturnValue(result.promise);
      const app = render(<App />);
      await start();
      expect(screen.getByText(/Waiting for Google/)).toBeInTheDocument();
      if (phase === "matching")
        await act(async () => token.resolve("google-token"));
      app.rerender(<App blocked />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => {
        token.resolve("google-token");
        result.resolve(EMPTY_RESULT);
      });
      await waitFor(() => expect(controller.phase).toBe("complete"));
      app.rerender(<App />);
      expect(
        await screen.findByText("No saved Google contacts found"),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Choose Google account" }),
      ).toBeEnabled();
      expect(mocks.token).toHaveBeenCalledTimes(1);
      expect(mocks.sync).toHaveBeenCalledTimes(1);
    },
  );
  it("rehydrates pending progress and refreshes connected people in the new route", async () => {
    const result = deferred<typeof EMPTY_RESULT>();
    mocks.sync.mockReturnValue(result.promise);
    const app = render(<App />);
    await start();
    await waitFor(() => expect(controller.phase).toBe("syncing"));
    app.rerender(<App blocked />);
    app.rerender(<App />);
    expect(screen.getByText(/Syncing contacts/)).toBeVisible();
    await act(async () =>
      result.resolve({ ...EMPTY_RESULT, autoConnectedCount: 1 }),
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.graph).toHaveBeenCalledWith("owner-a");
  });
  it.each(["owner", "route", "finish"])(
    "invalidates the pending read on %s without dispatching it later",
    async (reason) => {
      const token = deferred<string>();
      mocks.token.mockReturnValue(token.promise);
      const app = render(<App />);
      await start();
      const signal = mocks.token.mock.calls[0][0] as AbortSignal;
      app.rerender(<App blocked />);
      if (reason === "owner") mocks.owner = "owner-b";
      if (reason === "route") mocks.pathname = "/one/location";
      if (reason === "finish") act(() => controller.clear());
      else app.rerender(<App blocked />);
      expect(signal.aborted).toBe(true);
      await act(async () => token.resolve("old-token"));
      expect(mocks.sync).not.toHaveBeenCalled();
      app.rerender(<App />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );
  it("does not duplicate OAuth or clear recipients twice on a double tap", async () => {
    const token = deferred<string>();
    mocks.token.mockReturnValue(token.promise);
    render(<App />);
    await start();
    const beginInvites = vi.fn();
    await act(async () => {
      await controller.run({ routeId: "connect", beginInvites });
    });
    expect(beginInvites).not.toHaveBeenCalled();
    expect(mocks.token).toHaveBeenCalledTimes(1);
    act(() => controller.clear());
  });
  it("keeps cancellation visible and allows a fresh explicit retry", async () => {
    mocks.token.mockRejectedValueOnce(new DOMException("closed", "AbortError"));
    render(<App />);
    await start();
    expect(await screen.findByText("Contact sync cancelled")).toBeVisible();
    expect(mocks.sync).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose Google account" }),
    );
    expect(
      await screen.findByText("No saved Google contacts found"),
    ).toBeVisible();
  });
  it("retains an actionable error after remount", async () => {
    const token = deferred<string>();
    mocks.token.mockReturnValue(token.promise);
    mocks.sync.mockRejectedValue(
      new Error("Google contact access expired. Connect again to keep going."),
    );
    const app = render(<App />);
    await start();
    app.rerender(<App blocked />);
    await act(async () => token.resolve("expired-token"));
    app.rerender(<App />);
    expect(
      await screen.findByText(
        "Google contact access expired. Connect again to keep going.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Choose Google account" }),
    ).toBeEnabled();
  });
});

describe("Google result explanations", () => {
  it("distinguishes an empty saved address book from no matching accounts", () => {
    expect(googleContactSyncSummary(EMPTY_RESULT)?.title).toBe(
      "No saved Google contacts found",
    );
    expect(
      googleContactSyncSummary({
        ...EMPTY_RESULT,
        totalContacts: 2,
        readContactCount: 2,
        checkedContactCount: 2,
        unmatchedContactCount: 2,
      })?.title,
    ).toBe("No matching One accounts found");
  });
  it("explains email-only or unusable-phone books without treating emails as matched", () => {
    expect(
      googleContactSyncSummary({
        ...EMPTY_RESULT,
        totalContacts: 2,
        readContactCount: 2,
        uncheckableContactCount: 2,
      })?.title,
    ).toBe("No phone numbers to match");
  });
  it("leaves partial, unknown and native explanations with their existing owner", () => {
    expect(
      googleContactSyncSummary({
        ...EMPTY_RESULT,
        partial: true,
        mutationOutcomeUnknown: true,
      }),
    ).toBeNull();
    expect(
      googleContactSyncSummary({ ...EMPTY_RESULT, sourcePlatform: "ios" }),
    ).toBeNull();
  });
});
