import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  checkInNearby: vi.fn(),
  checkoutNearby: vi.fn(),
  extendNearbyPresence: vi.fn(),
  getPermissionState: vi.fn(),
  getNearbyPresence: vi.fn(),
  nearbyPlaces: vi.fn(),
  nearbyCheckInErrorDetails: vi.fn(() => ({
    message: "Check-in didn't complete. Your location is not visible.",
    retryLocation: false,
    openAppSettings: false,
  })),
  openAppSettings: vi.fn(),
  openLocationSettings: vi.fn(),
  placeDetails: vi.fn(),
  placesAutocomplete: vi.fn(),
  placesSearchErrorMessage: vi.fn(() => "Place search failed."),
  requestNearbyConnection: vi.fn(),
  ratePlace: vi.fn(),
  listPlaceRatingSummaries: vi.fn(),
}));

// `listPlaceRatingSummaries` resolves empty by default: the averages are an
// ornament on the place list, and no test here is about them.
const visitNotes = vi.hoisted(() => ({
  recordVisitNote: vi.fn(),
}));

vi.mock("@/lib/one-location/visit-notes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/one-location/visit-notes")>();
  return { ...actual, recordVisitNote: visitNotes.recordVisitNote };
});

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
}));

const locationMemory = vi.hoisted(() => ({
  readLastKnownFix: vi.fn(),
  rememberLastKnownFix: vi.fn(),
  rememberLocationGrant: vi.fn(),
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: service,
}));

vi.mock("@/lib/one-location/location-grant-memory", () => ({
  readLastKnownFix: locationMemory.readLastKnownFix,
  rememberLastKnownFix: locationMemory.rememberLastKnownFix,
  rememberLocationGrant: locationMemory.rememberLocationGrant,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const savedPlaces = vi.hoisted(() => ({
  loadSavedLocations: vi.fn(),
  addSavedLocation: vi.fn(),
}));

// Only the two vault-backed calls are stubbed. `findDuplicateSavedLocation`
// stays REAL so the suppression test exercises the actual 25 m radius rule
// rather than a mock that agrees with whatever the component asks it.
vi.mock("@/lib/one-location/saved-locations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/one-location/saved-locations")>();
  return {
    ...actual,
    loadSavedLocations: savedPlaces.loadSavedLocations,
    addSavedLocation: savedPlaces.addSavedLocation,
  };
});

import { NearbyCheckInSheet } from "@/components/one-location/nearby-check-in/nearby-check-in-sheet";
import { toast } from "sonner";

const point = {
  latitude: 37.4275,
  longitude: -122.1697,
  accuracyM: 9,
  capturedAt: new Date().toISOString(),
  sourcePlatform: "web" as const,
};

describe("NearbyCheckInSheet", () => {
  beforeEach(() => {
    Object.values(service).forEach((mock) => mock.mockReset());
    // Reset wipes the implementation too, and the place list awaits this on
    // every render. An undefined return would reject inside the effect.
    service.listPlaceRatingSummaries.mockResolvedValue([]);
    navigation.push.mockReset();
    locationMemory.readLastKnownFix.mockReset();
    locationMemory.rememberLastKnownFix.mockReset();
    locationMemory.rememberLocationGrant.mockReset();
    // Default: nothing carried over, which is what every pre-existing test in
    // this file assumed before durable memory existed.
    locationMemory.readLastKnownFix.mockResolvedValue(null);
    locationMemory.rememberLastKnownFix.mockResolvedValue(undefined);
    service.nearbyCheckInErrorDetails.mockReturnValue({
      message: "Check-in didn't complete. Your location is not visible.",
      retryLocation: false,
      openAppSettings: false,
    });
    service.placesSearchErrorMessage.mockReturnValue("Place search failed.");
    service.getNearbyPresence.mockResolvedValue({
      presence: null,
      attendees: [],
    });
    service.getPermissionState.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
      locationServicesEnabled: true,
    });
    service.placeDetails.mockRejectedValue(new Error("no details in tests"));
    service.nearbyPlaces.mockResolvedValue([
      {
        placeId: "stanford-main",
        text: "Stanford University",
        name: "Stanford University",
        address: "450 Jane Stanford Way",
        category: "University",
        categories: ["education"],
        distanceMeters: 48,
        latitude: 37.4276,
        longitude: -122.1697,
      },
      {
        placeId: "campus-clinic",
        text: "Campus Health Centre",
        name: "Campus Health Centre",
        category: "Medical Clinic",
        categories: ["health"],
        distanceMeters: 130,
        latitude: 37.4281,
        longitude: -122.1699,
      },
      {
        placeId: "stanford-mall",
        text: "Stanford Shopping Center",
        distanceMeters: 920,
      },
    ]);
    service.checkInNearby.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [],
    });
    service.checkoutNearby.mockResolvedValue({
      presence: null,
      attendees: [],
      checkedOut: true,
    });
  });

  it("uses the compact nearby check-in header and a count-aware place expansion", async () => {
    service.nearbyPlaces.mockResolvedValue([
      {
        placeId: "long-name-cafe",
        text: "An exceptionally long nearby cafe name that should stay on one line",
        name: "An exceptionally long nearby cafe name that should stay on one line",
        address: "1 Main Street",
        category: "Cafe",
        distanceMeters: 42,
        latitude: 37.4276,
        longitude: -122.1697,
      },
      {
        placeId: "place-two",
        text: "Place Two",
        distanceMeters: 80,
        latitude: 37.4277,
        longitude: -122.1698,
      },
      {
        placeId: "place-three",
        text: "Place Three",
        distanceMeters: 110,
        latitude: 37.4278,
        longitude: -122.1699,
      },
      {
        placeId: "place-four",
        text: "Place Four",
        distanceMeters: 140,
        latitude: 37.4279,
        longitude: -122.17,
      },
    ]);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Check in nearby" }),
    ).toBeInTheDocument();
    // The build-stage badge is gone: it reported how finished the feature is,
    // which is a fact about the roadmap, not about the person's decision.
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Choose a real place within 500 m of your current location.",
      ),
    ).not.toBeInTheDocument();

    const longName = await screen.findByText(
      "An exceptionally long nearby cafe name that should stay on one line",
    );
    expect(longName).toHaveClass("truncate");
    // The heading names the list; the radius it used to restate is drawn on
    // the map directly behind this panel.
    expect(
      screen.getByRole("heading", { name: "Nearby places" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Places within 500 m")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Visible for" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Stay visible for")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "See all places" }),
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Food" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See all places" }));
    expect(
      await screen.findByRole("radio", { name: /Place Four/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Food" })).toBeInTheDocument();
    // Attribution only. The place count that used to lead this line is
    // already on the expansion control and in the list itself.
    expect(screen.getByText("Google Maps")).toBeInTheDocument();
    expect(screen.queryByText(/places · Google Maps/)).not.toBeInTheDocument();
  });

  it("withdraws a stale average when the server no longer publishes it", async () => {
    service.listPlaceRatingSummaries
      .mockResolvedValueOnce([
        { placeId: "stanford-main", average: 4.8, countBucket: "5+" },
      ])
      .mockResolvedValueOnce([]);
    const props = {
      open: true,
      ownerId: "user-1",
      vaultOwnerToken: "owner-token",
      captureCurrentPosition: vi.fn().mockResolvedValue(point),
      onOpenChange: vi.fn(),
    };
    const { rerender } = render(<NearbyCheckInSheet {...props} />);

    expect(await screen.findByText(/4\.8 · 5\+/)).toBeInTheDocument();
    rerender(
      <NearbyCheckInSheet {...props} vaultOwnerToken="refreshed-owner-token" />,
    );

    await waitFor(() =>
      expect(service.listPlaceRatingSummaries).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByText(/4\.8 · 5\+/)).not.toBeInTheDocument(),
    );
  });

  it("is a bottom sheet a phone can put away", async () => {
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    // The panel used to pass `dragDismiss={false}`, which switched the gesture
    // off AND removed the grab handle with it — a phone bottom sheet with no
    // affordance to put it away. `contentDragDismiss={false}` keeps the handle
    // while leaving body drag off, which this sheet genuinely needs: it owns
    // an inner scroller, so its own scrollTop never leaves 0 and a body-drag
    // rule would read every downward swipe over the place list as a dismissal.
    const handle = document.querySelector('[data-slot="sheet-drag-handle"]');
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-label", "Drag down to close");

    // The list still owns its own scrolling.
    const scroller = document
      .querySelector('[data-testid="one-location-nearby-check-in-sheet"]')
      ?.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
  });

  it("keeps the pre-check-in panel to where, how long, and check in", async () => {
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    const panel = screen.getByTestId("nearby-presence-setup");

    // Every heading the panel is allowed to carry, and nothing else. A new
    // section added here has to be a deliberate decision, not a drift.
    expect(
      within(panel)
        .getAllByRole("heading")
        .map((heading) => heading.textContent?.trim()),
    ).toEqual(["Nearby places", "Visible for", "Visibility"]);

    // Compact setup keeps categories out of the first decision. They appear
    // only after the person asks for the full chooser.
    expect(
      screen.queryByRole("button", { name: "Food" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Shops" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Food & drink" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Shops & services" }),
    ).not.toBeInTheDocument();
  });

  it("puts the three visible-for lengths on one row, abbreviated to match", async () => {
    /**
     * Reported: "Visible for ke jo times hain inko one row mai dikhao ...
     * looking scattered."
     *
     * They were. The shared `DURATION_GRID_CLASS` is two columns because the
     * ladders that use it carry FOUR cells and land as an even 2x2. This
     * control has three, so the same class stranded one on a row of its own,
     * under a heading that reads as a single choice.
     *
     * The labels are abbreviated for consistency rather than for width --
     * "30 min" beside "1 hour" and "2 hours" mixes two registers in one row.
     */
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    const panel = screen.getByTestId("nearby-presence-setup");
    const heading = within(panel).getByRole("heading", { name: "Visible for" });
    const ladder = heading.nextElementSibling as HTMLElement;

    expect(
      within(ladder)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["30 min", "1 hour", "2 hours"]);

    // Three across on a phone, so nothing wraps to a half-empty second row.
    // Asserted on the class because JSDOM lays nothing out -- the browser
    // layout spec is where geometry is proved.
    expect(ladder.className).toContain("grid-cols-3");
    expect(ladder.className).not.toContain("grid-cols-2");

    // Still a working ladder, not just a tidier one.
    fireEvent.click(within(ladder).getByRole("button", { name: "2 hours" }));
    expect(
      within(ladder).getByRole("button", { name: "2 hours" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(ladder).getByRole("button", { name: "1 hour" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the required consent and connection preference visible", async () => {
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    // Consent gates the Check in button, so hiding it would leave a disabled
    // primary action with no visible reason. It stays in the open.
    await screen.findByRole("checkbox", { name: /Show my name here/ });
    expect(
      screen.getByText("Only people checked in at this place can see it."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("People see your name only."),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Options" }),
    ).not.toBeInTheDocument();
    // Same control, same default, now readable without a disclosure detour.
    expect(
      screen.getByRole("switch", {
        name: "Allow nearby connection requests",
      }),
    ).toHaveAttribute("data-state", "unchecked");
  });

  it("captures a fresh point, requires a place choice, and keeps consent explicit", async () => {
    const confirmationPoint = {
      ...point,
      latitude: 37.4277,
      capturedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    const capture = vi
      .fn()
      .mockResolvedValueOnce(point)
      .mockResolvedValueOnce(confirmationPoint);
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    const nearest = await screen.findByRole("radio", {
      name: /Stanford University/,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(service.nearbyPlaces).toHaveBeenCalledWith({
      vaultOwnerToken: "owner-token",
      lat: point.latitude,
      lng: point.longitude,
      category: "all",
    });
    expect(
      screen.queryByText("Stanford Shopping Center"),
    ).not.toBeInTheDocument();
    // One supporting line: what kind of place it is. The postal address always
    // truncated, and the tail it cut was the disambiguating half — so it cost
    // a line and answered nothing. It survives in the title attribute.
    expect(screen.getByText("University")).toBeInTheDocument();
    expect(
      screen.queryByText("University · 450 Jane Stanford Way"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("University")).toHaveAttribute(
      "title",
      "University · 450 Jane Stanford Way",
    );
    // "away" is the same word on every row of an aligned distance column.
    expect(screen.getByText("48 m")).toBeInTheDocument();
    expect(screen.queryByText("48 m away")).not.toBeInTheDocument();
    expect(nearest).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("How sharing works")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/current point is sent to Google/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Off by default.")).not.toBeInTheDocument();

    const submit = screen.getByRole("button", {
      name: "Check in",
    });
    expect(submit).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Choose trusted people" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    expect(submit).toBeDisabled();
    fireEvent.click(nearest);
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(service.checkInNearby).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        placeId: "stanford-main",
        point: confirmationPoint,
        durationMinutes: 60,
        consentAccepted: true,
        allowConnectionRequests: false,
      });
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("blocks check-in when the final confirmation point is too approximate", async () => {
    // Above the 5 km ceiling: a reading this broad cannot place anyone. Browser
    // fixes in the hundreds of metres are usable and must NOT land here.
    const approximatePoint = { ...point, accuracyM: 5_001 };
    const capture = vi
      .fn()
      .mockResolvedValueOnce(point)
      .mockResolvedValueOnce(approximatePoint);
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    expect(
      await screen.findByText(/couldn't confirm where you are/i),
    ).toBeInTheDocument();
    // Recoverable, so it is presented as a state to retry rather than an alarm.
    expect(screen.getByTestId("nearby-location-fallback")).toHaveAttribute(
      "role",
      "status",
    );
    expect(service.checkInNearby).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("still lists nearby places on a browser-grade coarse fix", async () => {
    // Regression: a wifi/IP fix (routinely 250 m - 5 km) used to fail the 100 m
    // gate, which returned before loadPlaces ever ran. The owner saw the
    // "too approximate" error AND an empty picker -- no hotels, no restaurants,
    // no clinics -- so the flow was unreachable on desktop web and indoors.
    const coarsePoint = { ...point, accuracyM: 850 };
    const capture = vi.fn().mockResolvedValue(coarsePoint);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    ).toBeInTheDocument();
    expect(service.nearbyPlaces).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: coarsePoint.latitude,
        lng: coarsePoint.longitude,
      }),
    );
    expect(
      screen.queryByTestId("nearby-location-fallback"),
    ).not.toBeInTheDocument();
  });

  it("tells the owner the fix is broad without blocking check-in", async () => {
    const coarsePoint = { ...point, accuracyM: 1_200 };
    const capture = vi.fn().mockResolvedValue(coarsePoint);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    expect(
      await screen.findByText(/accurate to about 1\.2 km/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    await waitFor(() => {
      expect(service.checkInNearby).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: "stanford-main" }),
      );
    });
  });

  it("stays quiet about accuracy when the fix is precise", async () => {
    const capture = vi.fn().mockResolvedValue(point);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    expect(screen.queryByText(/accurate to about/i)).not.toBeInTheDocument();
  });

  it("keeps a persistent retry after the initial presence read fails", async () => {
    service.getNearbyPresence.mockRejectedValue(
      new Error("temporary network failure"),
    );
    const capture = vi.fn().mockResolvedValue(point);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        "Nearby check-in could not be loaded. Check your connection and retry.",
      ),
    ).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
    const callsBeforeRetry = service.getNearbyPresence.mock.calls.length;
    service.getNearbyPresence.mockResolvedValue({
      presence: null,
      attendees: [],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry status",
      }),
    );

    await waitFor(() => {
      expect(service.getNearbyPresence.mock.calls.length).toBeGreaterThan(
        callsBeforeRetry,
      );
      expect(capture).toHaveBeenCalledTimes(1);
      expect(service.nearbyPlaces).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        lat: point.latitude,
        lng: point.longitude,
        category: "all",
      });
    });
    expect(
      service.getNearbyPresence.mock.invocationCallOrder[callsBeforeRetry],
    ).toBeLessThan(capture.mock.invocationCallOrder[0]);
    expect(
      screen.queryByText(
        "Nearby check-in could not be loaded. Check your connection and retry.",
      ),
    ).not.toBeInTheDocument();
  });

  it("renders active nearby users as a roster and connects by rotating alias", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: true,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [
        {
          participantAlias: "rotating-alias",
          displayName: "Maya Chen",
          relationship: "none",
          canConnect: true,
        },
      ],
    });
    service.requestNearbyConnection.mockResolvedValue({
      relationship: "pending_outgoing",
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getByTestId("nearby-attendee-roster")).toBeInTheDocument();
    expect(screen.queryByText("At this place")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("nearby-private-share-card"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Choose trusted people" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with Maya Chen" }),
    );

    await waitFor(() => {
      expect(service.requestNearbyConnection).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        participantAlias: "rotating-alias",
      });
    });
    expect(
      await screen.findByRole("button", { name: "Requested with Maya Chen" }),
    ).toBeDisabled();
  });

  it("keeps a clear completed state when an active presence ends while open", async () => {
    service.getNearbyPresence
      .mockResolvedValueOnce({
        presence: {
          status: "active",
          audience: "all_opted_in",
          radiusMeters: 500,
          allowConnectionRequests: false,
          consentVersion: "one-location-nearby-presence-v3",
          checkedInAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          placeLabel: "Stanford University",
        },
        attendees: [],
      })
      .mockResolvedValueOnce({ presence: null, attendees: [] });
    const capture = vi.fn().mockResolvedValue(point);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByTestId("nearby-presence-active");
    document.dispatchEvent(new Event("visibilitychange"));

    const completed = await screen.findByTestId("nearby-presence-completed");
    expect(completed).toHaveTextContent("Check-in ended");
    expect(completed).toHaveTextContent("Stanford University");
    expect(completed).toHaveTextContent(
      "You're no longer visible at Stanford University.",
    );
    expect(
      screen.queryByTestId("nearby-presence-setup"),
    ).not.toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
    expect(service.nearbyPlaces).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("radio", { name: /Stanford University/ }),
    ).not.toBeInTheDocument();
  });

  it("states the checked-in fact in three lines and nothing more", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        // 1h 58m, so the label is the interesting two-part form.
        expiresAt: new Date(Date.now() + 118 * 60_000).toISOString(),
        placeLabel: "Stanford University",
        placeLat: 37.4276,
        placeLng: -122.1697,
      },
      attendees: [],
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    const active = await screen.findByTestId("nearby-presence-active");
    expect(screen.getByText("Checked in")).toBeInTheDocument();
    expect(screen.getByText("Stanford University")).toBeInTheDocument();
    expect(screen.getByText("1h 58m left")).toBeInTheDocument();

    // The radius is drawn on the map behind this card; restating it here, plus
    // the postal address and the current distance, was four facts where the
    // person needed three.
    expect(active).not.toHaveTextContent("You’re visible nearby");
    expect(active).not.toHaveTextContent("500 m radius");
    expect(active).not.toHaveTextContent("450 Jane Stanford Way");

    // The privacy mechanism is unchanged and is no longer narrated twice on a
    // screen whose subject is a roster of names.
    expect(screen.queryByText(/not as map pins/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/never pinned on your map/i),
    ).not.toBeInTheDocument();

    // One line, not two. The list refreshes on its timer whether or not that
    // is advertised.
    expect(screen.getByText("Nobody nearby yet")).toBeInTheDocument();
    expect(
      screen.queryByText(/refresh automatically/i),
    ).not.toBeInTheDocument();
    // A "0" beside an empty state that already says "nobody" is the same word
    // twice.
    expect(within(active).queryByText("0")).not.toBeInTheDocument();
  });

  /**
   * The drift line, at both ends of its threshold.
   *
   * `activeDriftMeters` only exists once a point has been captured against a
   * live presence, and the only routine way that happens is the check-in
   * itself: the confirmation fix is deliberately kept afterwards so the panel
   * can say how far the owner has since moved.
   *
   * Under the nudge distance the gap is receiver noise and a building
   * footprint, and "you are 37 m from it" is a fact nobody acts on. Past it,
   * the owner is somewhere else while still discoverable at the place, which
   * is a privacy statement and earns its line.
   */
  const checkInFrom = async (confirmationLatitude: number) => {
    const confirmationPoint = {
      ...point,
      latitude: confirmationLatitude,
      capturedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    service.checkInNearby.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
        placeLat: 37.4276,
        placeLng: -122.1697,
      },
      attendees: [],
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi
          .fn()
          .mockResolvedValueOnce(point)
          .mockResolvedValue(confirmationPoint)}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Show my name here/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    await screen.findByTestId("nearby-presence-active");
  };

  it("says nothing about a gap the owner cannot act on", async () => {
    // ~11 m north of the place: inside the building, not a different one.
    await checkInFrom(37.4277);
    expect(screen.queryByTestId("nearby-active-drift")).not.toBeInTheDocument();
  });

  it("says so plainly once the owner has actually left the place", async () => {
    // ~445 m north of the place, comfortably past the 250 m nudge distance.
    await checkInFrom(37.4316);
    const drift = await screen.findByTestId("nearby-active-drift");
    expect(drift).toHaveTextContent("You’ve moved away.");
    expect(drift).toHaveTextContent("People still see you here.");
    // The mechanism ("people here still match against the place, not you")
    // is unchanged and no longer narrated on the card.
    expect(drift).not.toHaveTextContent(/match against the place/i);
  });

  it("keeps leaving prominent without using destructive red", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
        placeLat: 37.4276,
        placeLng: -122.1697,
      },
      attendees: [],
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByTestId("nearby-presence-active");
    const checkout = screen.getByRole("button", { name: "I'm leaving" });
    // "now" adds nothing a person could act on.
    expect(
      screen.queryByRole("button", { name: "Check out now" }),
    ).not.toBeInTheDocument();

    expect(checkout.className).toContain("w-full");
    expect(checkout.className).toContain("h-[52px]");
    expect(checkout.className).not.toContain(
      "bg-[color:var(--app-destructive)]",
    );
    expect(checkout.className).toContain("bg-[color:var(--app-neutral-fill)]");

    const addTime = screen.getByRole("button", { name: "Add time" });
    expect(addTime.className).toContain("text-[color:var(--app-accent)]");

    // Behaviour is untouched: the same one call, with no arguments of its own.
    fireEvent.click(checkout);
    await waitFor(() => {
      expect(service.checkoutNearby).toHaveBeenCalledTimes(1);
    });
    expect(service.checkoutNearby).toHaveBeenCalledWith({
      vaultOwnerToken: "owner-token",
    });
  });

  it("does not restore a checked-out presence when an older poll resolves late", async () => {
    const activeState = {
      presence: {
        status: "active" as const,
        audience: "all_opted_in" as const,
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [],
    };
    let resolveOldPoll: ((value: typeof activeState) => void) | null = null;
    service.getNearbyPresence
      .mockResolvedValueOnce(activeState)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldPoll = resolve;
          }),
      );
    service.checkoutNearby.mockResolvedValue({
      presence: null,
      attendees: [],
      checkedOut: true,
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByTestId("nearby-presence-active");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(service.getNearbyPresence).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "I'm leaving" }));
    await screen.findByTestId("nearby-presence-completed");

    resolveOldPoll?.(activeState);
    await Promise.resolve();
    expect(
      screen.queryByTestId("nearby-presence-active"),
    ).not.toBeInTheDocument();
  });

  it("does not let a poll started after checkout invalidate the mutation response", async () => {
    const activeState = {
      presence: {
        status: "active" as const,
        audience: "all_opted_in" as const,
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [],
    };
    const checkedOutState = {
      presence: null,
      attendees: [],
      checkedOut: true,
    };
    let resolveCheckout: ((value: typeof checkedOutState) => void) | null =
      null;
    service.getNearbyPresence.mockResolvedValue(activeState);
    service.checkoutNearby.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheckout = resolve;
        }),
    );

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByTestId("nearby-presence-active");
    fireEvent.click(screen.getByRole("button", { name: "I'm leaving" }));
    await waitFor(() => {
      expect(service.checkoutNearby).toHaveBeenCalledTimes(1);
    });

    // The visible-state refresh arrives after checkout began. It must not start
    // a competing read or take ownership of the mutation's busy lifecycle.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(service.getNearbyPresence).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCheckout?.(checkedOutState);
    });
    expect(
      await screen.findByTestId("nearby-presence-completed"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "I'm leaving" }),
    ).not.toBeInTheDocument();
    expect(service.getNearbyPresence).toHaveBeenCalledTimes(1);
  });

  it("adds time from the active check-in without reopening the setup flow", async () => {
    const activeState = {
      presence: {
        status: "active" as const,
        audience: "all_opted_in" as const,
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [
        {
          participantAlias: "alias-1",
          displayName: "Neelesh Meena",
          relationship: "connected" as const,
          canConnect: false,
          checkedInAt: new Date().toISOString(),
        },
      ],
    };
    service.getNearbyPresence.mockResolvedValue(activeState);
    service.extendNearbyPresence.mockResolvedValue({
      ...activeState,
      presence: {
        ...activeState.presence,
        expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      },
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    const active = await screen.findByTestId("nearby-presence-active");
    expect(active.textContent).toContain("1 person nearby");
    fireEvent.click(screen.getByRole("button", { name: "Add time" }));
    fireEvent.click(screen.getByRole("button", { name: "30 min more" }));

    await waitFor(() => {
      expect(service.extendNearbyPresence).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        incrementMinutes: 30,
      });
    });
    expect(
      screen.queryByTestId("nearby-presence-setup"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("nearby-presence-active")).toBeInTheDocument();
  });

  it("does not request location or Places for an already-active check-in", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [],
    });
    const capture = vi.fn().mockResolvedValue(point);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByTestId("nearby-presence-active");
    expect(capture).not.toHaveBeenCalled();
    expect(service.nearbyPlaces).not.toHaveBeenCalled();
  });

  it("blocks approximate native-style permission before capturing", async () => {
    service.getPermissionState.mockResolvedValue({
      state: "granted",
      precise: false,
      background: "foreground-only",
      locationServicesEnabled: true,
    });
    const capture = vi.fn().mockResolvedValue(point);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        "Precise location is off, so we can't see what's around you yet. Turn it on and we'll pick this up automatically.",
      ),
    ).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
    expect(service.nearbyPlaces).not.toHaveBeenCalled();
    // The owner has done nothing wrong and can fix this in one tap, so the
    // state is presented as recoverable rather than as a destructive alert.
    const fallback = screen.getByTestId("nearby-location-fallback");
    expect(fallback).toHaveAttribute("role", "status");
    expect(fallback.className).not.toContain("destructive");
    expect(
      screen.getByRole("button", { name: /Try again/ }),
    ).toBeInTheDocument();
  });

  it("falls back to the last known point instead of emptying the picker", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(point)
      .mockRejectedValueOnce(new Error("receiver hiccup"));

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    service.nearbyPlaces.mockClear();

    fireEvent.click(screen.getByPlaceholderText("Search places"));
    fireEvent.click(screen.getByRole("button", { name: "See all places" }));
    const allPlaces = await screen.findByRole("button", { name: "All" });
    await act(async () => {
      // A failed refresh must degrade the drawer, not blank it.
      fireEvent.click(allPlaces);
    });

    // Force the failing refresh through the recovery button.
    const active = screen.queryByRole("button", { name: /Try again/ });
    if (active) {
      await act(async () => {
        fireEvent.click(active);
      });
    }

    expect(
      screen.queryByText(/we can't see what's around you/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Stanford University/ }),
    ).toBeInTheDocument();
  });

  it("keeps Respond enabled and routes incoming requests to Consent Center", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [
        {
          participantAlias: "incoming-alias",
          displayName: "Jordan Lee",
          relationship: "pending_incoming",
          canConnect: false,
        },
      ],
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    const respond = await screen.findByRole("button", {
      name: "Respond to Jordan Lee's connection request",
    });
    expect(respond).toBeEnabled();
    fireEvent.click(respond);
    expect(navigation.push).toHaveBeenCalledWith(
      expect.stringMatching(/^\/one\/consent\?tab=pending&from=/),
    );
  });

  it("explains when a nearby person is not accepting connection requests", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: true,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [
        {
          participantAlias: "private-alias",
          displayName: "Taylor Kim",
          relationship: "none",
          canConnect: false,
        },
      ],
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: "Taylor Kim is not accepting connection requests",
      }),
    ).toBeDisabled();
    expect(screen.getByText("Not accepting requests")).toBeInTheDocument();
  });

  it("clears the previous owner's roster before loading a new owner", async () => {
    service.getNearbyPresence
      .mockResolvedValueOnce({
        presence: {
          status: "active",
          audience: "all_opted_in",
          radiusMeters: 500,
          allowConnectionRequests: false,
          consentVersion: "one-location-nearby-presence-v3",
          checkedInAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          placeLabel: "Stanford University",
        },
        attendees: [
          {
            participantAlias: "old-owner-alias",
            displayName: "Previous Owner Person",
            relationship: "none",
            canConnect: true,
          },
        ],
      })
      .mockResolvedValueOnce({ presence: null, attendees: [] });
    const capture = vi.fn().mockResolvedValue(point);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token-1"
        captureCurrentPosition={capture}
        onOpenChange={onOpenChange}
      />,
    );

    expect(
      await screen.findByText("Previous Owner Person"),
    ).toBeInTheDocument();

    rerender(
      <NearbyCheckInSheet
        open
        ownerId="user-2"
        vaultOwnerToken="owner-token-2"
        captureCurrentPosition={capture}
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Previous Owner Person"),
      ).not.toBeInTheDocument();
    });
    expect(service.getNearbyPresence).toHaveBeenLastCalledWith({
      vaultOwnerToken: "owner-token-2",
    });
  });

  it("keeps category and typed discovery inside the same 500 m search area", async () => {
    const onSearchAreaChange = vi.fn();
    service.placesAutocomplete.mockResolvedValue([
      {
        placeId: "clinic-1",
        text: "Campus Medical Clinic",
        distanceMeters: 71,
      },
    ]);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
        onSearchAreaChange={onSearchAreaChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    expect(onSearchAreaChange).toHaveBeenLastCalledWith(point);

    // One merged sweep serves every chip. Re-querying per chip re-applied the
    // provider's 20-result cap, which is how places went missing behind a chip.
    expect(service.nearbyPlaces).toHaveBeenCalledTimes(1);
    expect(service.nearbyPlaces).toHaveBeenLastCalledWith({
      vaultOwnerToken: "owner-token",
      lat: point.latitude,
      lng: point.longitude,
      category: "all",
    });

    fireEvent.click(screen.getByRole("button", { name: "See all places" }));
    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(service.nearbyPlaces).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("Search places"), {
      target: { value: "clinic" },
    });
    await waitFor(() => {
      expect(service.placesAutocomplete).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        input: "clinic",
        lat: point.latitude,
        lng: point.longitude,
        nearbyOnly: true,
      });
    });
    expect(
      await screen.findByRole("radio", { name: /Campus Medical Clinic/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Search results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Health" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText(/sorted by distance/)).not.toBeInTheDocument();
    expect(screen.getByText("Google Maps")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search places"), {
      target: { value: "" },
    });
    expect(
      await screen.findByRole("button", { name: "Health" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("cannot submit an old place while typed search is unresolved", async () => {
    let resolveSearch:
      ((value: Array<{ placeId: string; text: string }>) => void) | null = null;
    service.placesAutocomplete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    const submit = screen.getByRole("button", {
      name: "Check in",
    });
    expect(submit).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText("Search places"), {
      target: { value: "clinic" },
    });
    expect(
      screen.queryByRole("radio", { name: /Stanford University/ }),
    ).not.toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(service.checkInNearby).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(service.placesAutocomplete).toHaveBeenCalled();
    });
    await act(async () => {
      resolveSearch?.([{ placeId: "clinic-1", text: "Campus Clinic" }]);
    });
    expect(
      await screen.findByRole("radio", { name: /Campus Clinic/ }),
    ).toHaveAttribute("aria-checked", "false");
    expect(submit).toBeDisabled();
    expect(service.checkInNearby).not.toHaveBeenCalled();
  });

  it("keeps the chip and the list in agreement through location recovery", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(point)
      .mockResolvedValueOnce({ ...point, accuracyM: 5_001 })
      .mockResolvedValueOnce(point);

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "See all places" }));
    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    fireEvent.click(
      await screen.findByRole("radio", { name: /Campus Health Centre/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(service.nearbyPlaces).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: "all" }),
      );
    });
    // Recovery always re-sweeps the whole area, but the chip the owner was
    // browsing is preserved and still describes the rows on screen. The chip
    // can no longer disagree with the list: it filters the sweep locally
    // instead of standing for a separate, separately-truncated query.
    expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await screen.findByRole("radio", { name: /Campus Health Centre/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /Stanford University/ }),
    ).not.toBeInTheDocument();
  });

  it("clears stale discovery state before a moved user reopens the sheet", async () => {
    const movedPoint = {
      ...point,
      latitude: 37.431,
      longitude: -122.165,
      capturedAt: new Date(Date.now() + 5_000).toISOString(),
    };
    const capture = vi
      .fn()
      .mockResolvedValueOnce(point)
      .mockResolvedValueOnce(movedPoint);
    const onSearchAreaChange = vi.fn();
    const { rerender } = render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
        onSearchAreaChange={onSearchAreaChange}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    rerender(
      <NearbyCheckInSheet
        open={false}
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
        onSearchAreaChange={onSearchAreaChange}
      />,
    );
    await waitFor(() => {
      expect(onSearchAreaChange).toHaveBeenLastCalledWith(null);
    });
    onSearchAreaChange.mockClear();
    service.nearbyPlaces.mockResolvedValueOnce([
      {
        placeId: "moved-cafe",
        text: "Moved Cafe",
        name: "Moved Cafe",
        category: "Cafe",
        distanceMeters: 35,
      },
    ]);

    rerender(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
        onSearchAreaChange={onSearchAreaChange}
      />,
    );

    expect(screen.queryByText("Stanford University")).not.toBeInTheDocument();
    expect(await screen.findByText("Moved Cafe")).toBeInTheDocument();
    expect(onSearchAreaChange.mock.calls).not.toContainEqual([point]);
    expect(onSearchAreaChange).toHaveBeenLastCalledWith(movedPoint);
  });

  it("reloads the selected category when a place becomes unavailable", async () => {
    const capture = vi.fn().mockResolvedValue(point);
    service.checkInNearby.mockRejectedValueOnce(new Error("invalid place"));
    service.nearbyCheckInErrorDetails.mockReturnValueOnce({
      message:
        "This place is no longer available. Choose another nearby place.",
      retryLocation: false,
      openAppSettings: false,
      retryPlaces: true,
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(screen.getByRole("button", { name: "See all places" }));
    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    fireEvent.click(
      await screen.findByRole("radio", { name: /Campus Health Centre/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    // The area is re-swept once when the chosen place turns out to be
    // unavailable; the chip the owner was browsing is preserved.
    await waitFor(() => {
      expect(service.nearbyPlaces).toHaveBeenCalledTimes(2);
    });
    expect(service.nearbyPlaces).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "all" }),
    );
    expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reloads recommendations around the fresh confirmation point after moving", async () => {
    const movedPoint = {
      ...point,
      latitude: 37.435,
      longitude: -122.16,
      capturedAt: new Date(Date.now() + 5_000).toISOString(),
    };
    const capture = vi
      .fn()
      .mockResolvedValueOnce(point)
      .mockResolvedValueOnce(movedPoint);
    service.checkInNearby.mockRejectedValueOnce(new Error("outside radius"));
    service.nearbyCheckInErrorDetails.mockReturnValueOnce({
      message:
        "You moved outside that place's range. Choose a nearby place again.",
      retryLocation: false,
      openAppSettings: false,
      retryPlaces: true,
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={capture}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    await waitFor(() => {
      expect(service.nearbyPlaces).toHaveBeenLastCalledWith({
        vaultOwnerToken: "owner-token",
        lat: movedPoint.latitude,
        lng: movedPoint.longitude,
        category: "all",
      });
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("publishes the place being chosen so the map can pin it apart from the owner", async () => {
    const onPlaceFocusChange = vi.fn();

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
        onPlaceFocusChange={onPlaceFocusChange}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    await waitFor(() => {
      expect(onPlaceFocusChange).toHaveBeenLastCalledWith(null);
    });

    // Choosing a different row moves the pin with it.
    fireEvent.click(
      screen.getByRole("radio", { name: /Campus Health Centre/ }),
    );
    await waitFor(() => {
      expect(onPlaceFocusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          placeId: "campus-clinic",
          latitude: 37.4281,
          distanceMeters: 130,
          active: false,
        }),
      );
    });
  });

  it("publishes the live anchor once checked in, not the owner's position", async () => {
    const onPlaceFocusChange = vi.fn();
    service.checkInNearby.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
        placeLat: 37.4276,
        placeLng: -122.1697,
      },
      attendees: [],
    });

    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
        onPlaceFocusChange={onPlaceFocusChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show my name here/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    await waitFor(() => {
      expect(onPlaceFocusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          label: "Stanford University",
          latitude: 37.4276,
          longitude: -122.1697,
          active: true,
        }),
      );
    });
  });

  it("names the gap between the owner and the place they picked", async () => {
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    // 48 m is close enough that saying so would be noise.
    expect(
      screen.queryByTestId("nearby-selected-place-offset"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("radio", { name: /Campus Health Centre/ }),
    );
    expect(
      await screen.findByTestId("nearby-selected-place-offset"),
    ).toHaveTextContent(/about 130 m from here/i);
  });

  it("offers a way back when a chip has nothing in it", async () => {
    render(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(point)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(screen.getByRole("button", { name: "See all places" }));
    fireEvent.click(screen.getByRole("button", { name: "Transit" }));

    const empty = await screen.findByTestId("nearby-category-empty");
    expect(empty).toHaveTextContent("Nothing here");
    // The mall sits at 920 m and is dropped by the 500 m bound before this.
    expect(empty).not.toHaveTextContent("other places are nearby");

    fireEvent.click(screen.getByRole("button", { name: "See all 2" }));
    expect(
      await screen.findByRole("radio", { name: /Stanford University/ }),
    ).toBeInTheDocument();
    // Never a second provider call: the sweep already held every category.
    expect(service.nearbyPlaces).toHaveBeenCalledTimes(1);
  });

  it("warns when the owner has drifted away from their check-in place", async () => {
    // ~1.1 km north of the anchored place.
    const driftedPoint = { ...point, latitude: 37.4376 };
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
        placeLat: 37.4276,
        placeLng: -122.1697,
      },
      attendees: [],
    });

    const { rerender } = render(
      <NearbyCheckInSheet
        open={false}
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(driftedPoint)}
        onOpenChange={vi.fn()}
      />,
    );
    rerender(
      <NearbyCheckInSheet
        open
        ownerId="user-1"
        vaultOwnerToken="owner-token"
        captureCurrentPosition={vi.fn().mockResolvedValue(driftedPoint)}
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByTestId("nearby-presence-active");
    // No point captured while a check-in is already live, so there is nothing
    // to compare against and the sheet stays silent rather than guessing.
    expect(screen.queryByTestId("nearby-active-drift")).not.toBeInTheDocument();
  });

  /**
   * The reported failure, on a cold start.
   *
   * Opening the drawer after a reload used to mean: nothing in the in-session
   * ref, a first GPS read that fails with `kCLErrorLocationUnknown` (routine on
   * any machine without a GPS radio), and therefore "Still finding you" with an
   * empty list — on a device that knew exactly where it was minutes earlier.
   */
  describe("on a cold start", () => {
    /**
     * Built per test, never once at module load: the age label is relative to
     * `Date.now()` at render, so a fixture frozen when the file was imported
     * drifts by however long the rest of the suite took to reach this test.
     */
    function carriedOver(ageMs = 4 * 60_000) {
      return {
        ...point,
        latitude: 37.4279,
        capturedAt: new Date(Date.now() - ageMs).toISOString(),
      };
    }

    function unavailable() {
      return new Error(
        "Could not get your location. Turn on Location for your device/browser and try again.",
      );
    }

    it("lists places around the carried-over fix instead of dead-ending", async () => {
      const carriedOverPoint = carriedOver();
      locationMemory.readLastKnownFix.mockResolvedValue(carriedOverPoint);

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockRejectedValue(unavailable())}
          onOpenChange={vi.fn()}
        />,
      );

      await screen.findByRole("radio", { name: /Stanford University/ });
      expect(
        screen.queryByTestId("nearby-location-fallback"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Still finding you")).not.toBeInTheDocument();
      expect(service.nearbyPlaces).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        lat: carriedOverPoint.latitude,
        lng: carriedOverPoint.longitude,
        category: "all",
      });
    });

    it("says the position is carried over, and how old it is", async () => {
      const carriedOverPoint = carriedOver();
      locationMemory.readLastKnownFix.mockResolvedValue(carriedOverPoint);

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockRejectedValue(unavailable())}
          onOpenChange={vi.fn()}
        />,
      );

      const notice = await screen.findByTestId("nearby-last-known-notice");
      // Silently drawing an old position as the current one would be the wrong
      // trade. The drawer keeps working AND says what it is showing.
      expect(notice).toHaveTextContent(/last known position/i);
      expect(notice).toHaveTextContent(/about 4 minutes ago/i);
    });

    it("still says so plainly when there is nothing carried over", async () => {
      locationMemory.readLastKnownFix.mockResolvedValue(null);

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockRejectedValue(unavailable())}
          onOpenChange={vi.fn()}
        />,
      );

      // A first-ever open with no fix genuinely has nothing to show. Inventing
      // a position here would be worse than the error.
      await screen.findByTestId("nearby-location-fallback");
      expect(screen.getByText("Still finding you")).toBeInTheDocument();
    });

    it("reads the carried-over fix for the account that asked for it", async () => {
      const carriedOverPoint = carriedOver();
      locationMemory.readLastKnownFix.mockResolvedValue(carriedOverPoint);

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-9"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockRejectedValue(unavailable())}
          onOpenChange={vi.fn()}
        />,
      );

      await screen.findByRole("radio", { name: /Stanford University/ });
      expect(locationMemory.readLastKnownFix).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-9" }),
      );
    });

    it("records the account's location grant, not just the position", async () => {
      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockResolvedValue(point)}
          onOpenChange={vi.fn()}
        />,
      );

      await screen.findByRole("radio", { name: /Stanford University/ });
      // This drawer talks to the device directly and is often the first place
      // an account ever produces a coordinate. A live UAT run proved the sealed
      // fix was being written here while the grant was not, because the grant
      // was only recorded by the bus, which this surface never attaches.
      await waitFor(() => {
        expect(locationMemory.rememberLocationGrant).toHaveBeenCalledWith(
          "user-1",
        );
      });
    });

    it("records no grant when the device never produces a fix", async () => {
      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockRejectedValue(unavailable())}
          onOpenChange={vi.fn()}
        />,
      );

      await screen.findByTestId("nearby-location-fallback");
      // A grant is a record that location genuinely worked for this account.
      // A failed attempt is not that, and recording one would let the app claim
      // a capability it has never actually observed.
      expect(locationMemory.rememberLocationGrant).not.toHaveBeenCalled();
    });

    it("carries a successful fix forward for the next one", async () => {
      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockResolvedValue(point)}
          onOpenChange={vi.fn()}
        />,
      );

      await screen.findByRole("radio", { name: /Stanford University/ });
      await waitFor(() => {
        expect(locationMemory.rememberLastKnownFix).toHaveBeenCalledWith({
          userId: "user-1",
          point,
        });
      });
    });
  });

  /**
   * The presence poller and the server's 8-requests-per-minute budget.
   *
   * The poller's guard is `state.presence`, not `open`, and the sheet is
   * mounted by every map surface. A checked-in owner therefore had a CLOSED
   * drawer polling every 15 seconds -- 4 reads a minute each, against a limit
   * of 8 a minute keyed per ACCOUNT, not per tab. Two mounted-but-closed
   * sheets spent the whole allowance on nobody looking at anything, and the
   * Location hub's own read came back 429.
   */
  describe("presence polling and the request budget", () => {
    const activePresence = {
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [],
    };

    it("does not poll on a timer while the drawer is closed", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        service.getNearbyPresence.mockResolvedValue(activePresence);

        render(
          <NearbyCheckInSheet
            open={false}
            ownerId="user-1"
            vaultOwnerToken="owner-token"
            captureCurrentPosition={vi.fn().mockResolvedValue(point)}
            onOpenChange={vi.fn()}
          />,
        );

        await waitFor(() =>
          expect(service.getNearbyPresence).toHaveBeenCalled(),
        );
        const afterMount = service.getNearbyPresence.mock.calls.length;

        // Two full minutes. At the old cadence this is 8 reads - the entire
        // per-account budget - burned by a drawer nobody opened.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });

        expect(service.getNearbyPresence.mock.calls.length).toBe(afterMount);
      } finally {
        vi.useRealTimers();
      }
    });

    it("still polls while the drawer is open", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        service.getNearbyPresence.mockResolvedValue(activePresence);

        render(
          <NearbyCheckInSheet
            open
            ownerId="user-1"
            vaultOwnerToken="owner-token"
            captureCurrentPosition={vi.fn().mockResolvedValue(point)}
            onOpenChange={vi.fn()}
          />,
        );

        await screen.findByTestId("nearby-presence-active");
        const afterMount = service.getNearbyPresence.mock.calls.length;

        // Someone watching the attendee list needs it live; that is what the
        // budget is for.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(35_000);
        });

        expect(service.getNearbyPresence.mock.calls.length).toBeGreaterThan(
          afterMount,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("still refreshes a closed drawer when the tab becomes visible", async () => {
      service.getNearbyPresence.mockResolvedValue(activePresence);

      render(
        <NearbyCheckInSheet
          open={false}
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockResolvedValue(point)}
          onOpenChange={vi.fn()}
        />,
      );

      await waitFor(() => expect(service.getNearbyPresence).toHaveBeenCalled());
      const afterMount = service.getNearbyPresence.mock.calls.length;

      // Dispatched inside the retry loop on purpose: `poll()` declines while
      // the mount read is still in flight, so a single dispatch races the
      // fixture and fails only under load. Re-dispatching until the count
      // moves tests the behaviour rather than the timing.
      //
      // Dropping the timer must not mean a stale presence survives a return to
      // the tab - that is the moment staleness actually matters.
      await waitFor(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        expect(service.getNearbyPresence.mock.calls.length).toBeGreaterThan(
          afterMount,
        );
      });
    });
  });

  describe("post-checkout completion", () => {
    const anchoredPresence = {
      presence: {
        status: "active" as const,
        audience: "all_opted_in" as const,
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Blue Bottle Coffee",
        placeLat: 37.4275,
        placeLng: -122.1697,
      },
      attendees: [],
    };

    const renderAndCheckOut = async (
      vaultKey: string | null = "vault-key",
      onOpenChange = vi.fn(),
    ) => {
      service.getNearbyPresence.mockResolvedValue(anchoredPresence);
      service.checkoutNearby.mockResolvedValue({
        presence: null,
        attendees: [],
        checkedOut: true,
      });

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          vaultKey={vaultKey}
          captureCurrentPosition={vi.fn().mockResolvedValue(point)}
          onOpenChange={onOpenChange}
        />,
      );

      await screen.findByTestId("nearby-presence-active");
      fireEvent.click(screen.getByRole("button", { name: "I'm leaving" }));
      await screen.findByTestId("nearby-presence-completed");
      return onOpenChange;
    };

    it("ends in a simple completed state instead of reopening setup", async () => {
      savedPlaces.loadSavedLocations.mockResolvedValue([]);

      await renderAndCheckOut();

      const completed = await screen.findByTestId("nearby-presence-completed");
      expect(completed.textContent).toContain("Check-in ended");
      expect(completed.textContent).toContain(
        "You're no longer visible at Blue Bottle Coffee.",
      );
      expect(
        screen.queryByTestId("nearby-presence-setup"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Checked out from")).not.toBeInTheDocument();
      expect(
        await screen.findByRole("button", {
          name: "Save for faster check-ins",
        }),
      ).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalledWith("Check-in ended.");
    });

    it("suppresses the save action when that venue is already saved", async () => {
      // 37.42755/-122.16975 is a few metres from the anchor, inside the 25 m
      // duplicate radius, so this must read as the same place.
      savedPlaces.loadSavedLocations.mockResolvedValue([
        {
          id: "other-1",
          category: "other" as const,
          label: "Blue Bottle",
          latitude: 37.42755,
          longitude: -122.16975,
          savedAt: new Date().toISOString(),
        },
      ]);

      await renderAndCheckOut();

      await waitFor(() => {
        expect(savedPlaces.loadSavedLocations).toHaveBeenCalled();
      });
      expect(
        screen.queryByRole("button", { name: "Save for faster check-ins" }),
      ).not.toBeInTheDocument();
    });

    it("does not show the save action when the vault is locked", async () => {
      await renderAndCheckOut(null);

      expect(savedPlaces.loadSavedLocations).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "Save for faster check-ins" }),
      ).not.toBeInTheDocument();
    });

    it("saves a checked-out venue as 'other', never as home", async () => {
      savedPlaces.loadSavedLocations.mockResolvedValue([]);
      savedPlaces.addSavedLocation.mockResolvedValue([]);

      await renderAndCheckOut();
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Save for faster check-ins",
        }),
      );

      await waitFor(() => {
        expect(savedPlaces.addSavedLocation).toHaveBeenCalledTimes(1);
      });
      // An empty Saved Places would make `defaultSavedLocationCategory` return
      // "home"; a venue you checked out of must never be filed as home.
      expect(savedPlaces.addSavedLocation.mock.calls[0]?.[0]).toMatchObject({
        input: {
          category: "other",
          label: "Blue Bottle Coffee",
          latitude: 37.4275,
          longitude: -122.1697,
        },
      });
      expect(
        await screen.findByText("Saved for next time."),
      ).toBeInTheDocument();
    });

    it("finishes without saving", async () => {
      savedPlaces.loadSavedLocations.mockResolvedValue([]);
      const onOpenChange = await renderAndCheckOut("vault-key", vi.fn());

      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(savedPlaces.addSavedLocation).not.toHaveBeenCalled();
    });

    it("keeps leaving styled as a neutral action, not a destructive one", async () => {
      service.getNearbyPresence.mockResolvedValue(anchoredPresence);

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          captureCurrentPosition={vi.fn().mockResolvedValue(point)}
          onOpenChange={vi.fn()}
        />,
      );

      await screen.findByTestId("nearby-presence-active");
      const checkOut = screen.getByRole("button", { name: "I'm leaving" });
      // Red is reserved for dangerous and irreversible actions. Checking out is
      // neither — you can check back in.
      expect(checkOut.className).not.toContain("app-destructive");
    });

    /** Checkout, with the server offering a rateable visit for the place. */
    const renderAndCheckOutRateable = async (
      overrides: Record<string, unknown> = {},
      onOpenChange = vi.fn(),
    ) => {
      service.getNearbyPresence.mockResolvedValue(anchoredPresence);
      service.checkoutNearby.mockResolvedValue({
        presence: null,
        attendees: [],
        checkedOut: true,
        reviewPrompt: {
          visitId: "visit-1",
          placeId: "ChIJbagmaker",
          placeLabel: "Bag Maker",
          visitedAt: "2026-08-31T10:00:00.000Z",
          expiresAt: "2026-09-07T10:00:00.000Z",
          googleReviewUrl:
            "https://search.google.com/local/writereview?placeid=ChIJbagmaker",
          consentVersion: "one-location-place-rating-v1",
          ...overrides,
        },
      });
      savedPlaces.loadSavedLocations.mockResolvedValue([]);

      render(
        <NearbyCheckInSheet
          open
          ownerId="user-1"
          vaultOwnerToken="owner-token"
          vaultKey="vault-key"
          captureCurrentPosition={vi.fn().mockResolvedValue(point)}
          onOpenChange={onOpenChange}
        />,
      );

      await screen.findByTestId("nearby-presence-active");
      fireEvent.click(screen.getByRole("button", { name: "I'm leaving" }));
      await screen.findByTestId("nearby-presence-completed");
      return onOpenChange;
    };

    it("asks how the visit went, by name", async () => {
      await renderAndCheckOutRateable();

      expect(await screen.findByTestId("nearby-visit-rating")).toBeTruthy();
      expect(screen.getByText("How was Bag Maker?")).toBeTruthy();
      // The one sentence that stops a star row above a Google button reading
      // as though it publishes somewhere.
      expect(screen.getByText(/Only you see this\./)).toBeTruthy();
    });

    it("cannot be saved until a star is chosen", async () => {
      await renderAndCheckOutRateable();

      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

      fireEvent.click(await screen.findByRole("radio", { name: "4 stars" }));

      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });

    it("sends the star to the server and keeps the note in the vault", async () => {
      // The split is the whole design: an average cannot be computed on a
      // device, and free text about a named business must not sit in plaintext
      // on ours.
      service.ratePlace.mockResolvedValue({ id: "r1", rating: 4 });
      visitNotes.recordVisitNote.mockResolvedValue([]);
      await renderAndCheckOutRateable();

      fireEvent.click(await screen.findByRole("radio", { name: "4 stars" }));
      fireEvent.change(
        screen.getByPlaceholderText("Anything worth remembering"),
        { target: { value: "  Quick and friendly.  " } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(service.ratePlace).toHaveBeenCalledWith({
          vaultOwnerToken: "owner-token",
          placeId: "ChIJbagmaker",
          rating: 4,
          consentVersion: "one-location-place-rating-v1",
        }),
      );
      // No note field reaches the request at all.
      expect(Object.keys(service.ratePlace.mock.calls[0][0])).not.toContain(
        "note",
      );
      await waitFor(() =>
        expect(visitNotes.recordVisitNote).toHaveBeenCalledWith(
          expect.objectContaining({
            entry: expect.objectContaining({
              placeId: "ChIJbagmaker",
              rating: 4,
              note: "Quick and friendly.",
            }),
          }),
        ),
      );
    });

    it("offers the Google hand-off only after the local save succeeds", async () => {
      service.ratePlace.mockResolvedValue({ id: "r1", rating: 5 });
      await renderAndCheckOutRateable();

      // The order is the mitigation for "why did I write it twice": your
      // rating is safe with us first, Google is extra.
      expect(
        screen.queryByRole("link", { name: "Also post on Google" }),
      ).toBeNull();

      fireEvent.click(await screen.findByRole("radio", { name: "5 stars" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      const handoff = await screen.findByRole("link", {
        name: "Also post on Google",
      });
      expect(handoff).toHaveAttribute(
        "href",
        "https://search.google.com/local/writereview?placeid=ChIJbagmaker",
      );
      expect(handoff).toHaveAttribute("rel", "noopener noreferrer");
      // Honest about what happens next: nothing can be prefilled on Google.
      expect(
        screen.getByText("Opens Google Maps — you'll type it there."),
      ).toBeTruthy();
    });

    it("says nothing about Google when there is no place id to link to", async () => {
      // No disabled button and no explanation. The rating succeeded; the
      // hand-off was only ever a bonus.
      service.ratePlace.mockResolvedValue({ id: "r1", rating: 3 });
      await renderAndCheckOutRateable({ googleReviewUrl: null });

      fireEvent.click(await screen.findByRole("radio", { name: "3 stars" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await screen.findByText("Saved to your places.");
      expect(screen.queryByText(/Google/)).toBeNull();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    });

    it("keeps the stars set when the save fails", async () => {
      // Clearing somebody's input because the network failed turns a retry
      // into a re-decision.
      service.ratePlace.mockRejectedValue(new Error("offline"));
      await renderAndCheckOutRateable();

      fireEvent.click(await screen.findByRole("radio", { name: "2 stars" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(
        await screen.findByText("Couldn't save your rating."),
      ).toBeTruthy();
      expect(screen.getByRole("radio", { name: "2 stars" })).toBeChecked();
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });

    it("lets someone leave without rating, and writes nothing when they do", async () => {
      const onOpenChange = await renderAndCheckOutRateable();

      fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

      expect(service.ratePlace).not.toHaveBeenCalled();
      expect(visitNotes.recordVisitNote).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("does not ask at all when the server offers nothing rateable", async () => {
      // An expired presence produces no visit, and a backend that predates
      // ratings sends no reviewPrompt. Both land here, and both must leave the
      // pane exactly as it was.
      savedPlaces.loadSavedLocations.mockResolvedValue([]);
      await renderAndCheckOut();

      expect(screen.queryByTestId("nearby-visit-rating")).toBeNull();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    });

    it("offers no bookmark control, because rating is the save", async () => {
      await renderAndCheckOutRateable();

      expect(screen.queryByRole("button", { name: /bookmark/i })).toBeNull();
    });
  });
});

/**
 * The chip row, and the two ways it can quietly stop being true.
 *
 * Reported from Prayagraj: tapping "Hotels" listed a lounge, a construction firm
 * and two lodges. Most of that fix is server-side, but two client properties
 * decide whether it is visible at all.
 */
describe("the nearby place chips", () => {
  const sheetSource = readFileSync(
    path.resolve(__dirname, "..", "nearby-check-in-sheet.tsx"),
    "utf8",
  );
  const layoutSpecSource = readFileSync(
    path.resolve(
      __dirname,
      "../../../..",
      "e2e/one-location-check-in-panel.layout.spec.ts",
    ),
    "utf8",
  );

  /** The labels the component actually ships, read out of its own table. */
  function shippedLabels(): string[] {
    const table = sheetSource.slice(
      sheetSource.indexOf("const PLACE_CATEGORIES"),
      sheetSource.indexOf("const NEARBY_RADIUS_METERS"),
    );
    return [...table.matchAll(/label:\s*"([^"]+)"/g)].map((match) => match[1]);
  }

  it("offers a chip for every category the backend can return", () => {
    // The backend classifies exhaustively over Google's Table A and can answer
    // with any of these. A category with no chip is a set of places that shows
    // under "All" and is unreachable the moment anything is tapped — which is
    // how temples, mosques and police stations were invisible.
    const table = sheetSource.slice(
      sheetSource.indexOf("const PLACE_CATEGORIES"),
      sheetSource.indexOf("const NEARBY_RADIUS_METERS"),
    );
    const values = [...table.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      "all",
      "food_drink",
      "health",
      "shopping_services",
      "hotels_stays",
      "education",
      "outdoors_landmarks",
      "transit",
      "worship",
      "civic",
      "other",
    ]);
  });

  it("keeps the layout spec's replica of the labels honest", () => {
    // `one-location-check-in-panel.layout.spec.ts` cannot import a React module,
    // so it hand-copies these labels to measure the row. A copy that falls
    // behind does not fail — it passes, having measured a row the app no longer
    // ships. This is the only thing that notices.
    const replica = layoutSpecSource.slice(
      layoutSpecSource.indexOf("const CATEGORY_LABELS"),
      layoutSpecSource.indexOf("const LONGEST_PLACE"),
    );
    const replicated = [...replica.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(replicated).toEqual(shippedLabels());
  });

  it("never says 'Outdoors' about a cinema", () => {
    // The chip owns entertainment, culture, sport and nature. Half of that is
    // indoors, so the label says what the chip is for rather than where it is.
    expect(shippedLabels()).toContain("Leisure");
    expect(shippedLabels()).not.toContain("Outdoors");
  });
});
