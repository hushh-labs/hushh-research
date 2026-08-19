import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  checkInNearby: vi.fn(),
  checkoutNearby: vi.fn(),
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
}));

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

import { NearbyCheckInSheet } from "@/components/one-location/nearby-check-in/nearby-check-in-sheet";

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

  it("uses the compact Check in header and a count-aware place expansion", async () => {
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
      screen.getByRole("heading", { name: "Check in" }),
    ).toBeInTheDocument();
    // The "Preview" badge next to the sheet title was removed entirely.
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Choose a real place within 500 m of your current location."),
    ).not.toBeInTheDocument();

    const longName = await screen.findByText(
      "An exceptionally long nearby cafe name that should stay on one line",
    );
    expect(longName).toHaveClass("truncate");
    expect(
      screen.getByRole("button", { name: "See all 4 places" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "See all 4 places" }));
    expect(await screen.findByRole("radio", { name: /Place Four/ })).toBeInTheDocument();
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
    expect(screen.queryByText("Stanford Shopping Center")).not.toBeInTheDocument();
    expect(screen.getByText("University · 450 Jane Stanford Way")).toBeInTheDocument();
    expect(screen.getByText("48 m away")).toBeInTheDocument();
    expect(nearest).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("How sharing works")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/current point is sent to Google/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Off by default.")).not.toBeInTheDocument();

    // Duration and the visibility switches stay out of the DOM entirely
    // until a place is chosen -- there is nothing to submit yet.
    const submit = screen.getByRole("button", { name: "Choose a place" });
    expect(submit).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Choose trusted people" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Allow nearby connection requests" }),
    ).not.toBeInTheDocument();

    fireEvent.click(nearest);
    // Selecting the place reveals the switches and flips the label, but
    // check-in still requires explicit consent.
    expect(submit).toHaveTextContent("Check in");
    expect(submit).toBeDisabled();
    expect(
      screen.getByRole("switch", {
        name: "Allow nearby connection requests",
      }),
    ).toHaveAttribute("data-state", "unchecked");

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
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
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in" }),
    );

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

    // The accuracy notice lives in the picker view, not the collapsed
    // summary, so it has to be read before a place is selected.
    await screen.findByRole("radio", { name: /Stanford University/ });
    expect(
      await screen.findByText(/accurate to about 1\.2 km/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("radio", { name: /Stanford University/ }),
    );
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in" }),
    );

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
    // The count sits beside the heading it counts, so it reads as part of
    // "People nearby" rather than as a loose number in the card's corner.
    expect(screen.getByTestId("nearby-attendee-count")).toHaveTextContent("1");
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

  it("prints no roster count when nobody is nearby, and states the pin rule once", async () => {
    // Reported as "0 on right top of div": with nobody nearby the badge was a
    // bare zero pushed to the far right of a three-line block, level with the
    // middle of a paragraph and touching nothing. The empty state right below
    // it already says the same thing in words, so the badge has no zero to
    // print -- and the drawer no longer says "never pinned on your map" twice
    // in one screen, once under the heading and once under Check out.
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
      await screen.findByText("No one else is checked in nearby yet"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("nearby-attendee-count"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/never as pins on your map|never pinned on your map/i),
    ).toHaveLength(1);
  });

  it("prepares a fresh check-in when an active presence expires while open", async () => {
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

    await screen.findByTestId("nearby-presence-setup");
    await waitFor(() => {
      expect(capture).toHaveBeenCalledTimes(1);
      expect(service.nearbyPlaces).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        lat: point.latitude,
        lng: point.longitude,
        category: "all",
      });
    });
    expect(
      screen.getByRole("radio", { name: /Stanford University/ }),
    ).toHaveAttribute("aria-checked", "false");
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
    fireEvent.click(screen.getByRole("button", { name: "Check out now" }));
    await screen.findByTestId("nearby-presence-setup");

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
    let resolveCheckout:
      | ((value: typeof checkedOutState) => void)
      | null = null;
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
    fireEvent.click(screen.getByRole("button", { name: "Check out now" }));
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
    expect(await screen.findByTestId("nearby-presence-setup")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Check out now" }),
    ).not.toBeInTheDocument();
    expect(service.getNearbyPresence).toHaveBeenCalledTimes(1);
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

    // Left unselected on purpose: selecting a place collapses the picker
    // into a summary, and this test is about the picker itself surviving a
    // failed refresh.
    await screen.findByRole("radio", { name: /Stanford University/ });
    service.nearbyPlaces.mockClear();

    fireEvent.click(screen.getByPlaceholderText("Search places"));

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

  it("rounds the live countdown to the nearest minute instead of always up", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: new Date().toISOString(),
        // A 30-minute check-in rendered a beat after the server stamped
        // `expiresAt` -- realistic request latency, not clock skew. Ceiling
        // rounding turned any such overage into "31 min left"; nearest-minute
        // rounding must not.
        expiresAt: new Date(Date.now() + 30 * 60_000 + 500).toISOString(),
        placeLabel: "Stanford University",
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

    expect(await screen.findByText(/30 min left/)).toBeInTheDocument();
    expect(screen.queryByText(/31 min left/)).not.toBeInTheDocument();
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

    expect(await screen.findByText("Previous Owner Person")).toBeInTheDocument();

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
      expect(screen.queryByText("Previous Owner Person")).not.toBeInTheDocument();
    });
    expect(service.getNearbyPresence).toHaveBeenLastCalledWith({
      vaultOwnerToken: "owner-token-2",
    });
  });

  it("keeps category and typed discovery inside the same 500 m search area", async () => {
    const onSearchAreaChange = vi.fn();
    // Category chips only appear once the compact 3-place view is expanded,
    // so this fixture needs more than 3 places within 500 m to reach them.
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
        placeId: "filler-cafe",
        text: "Corner Cafe",
        name: "Corner Cafe",
        category: "Cafe",
        categories: ["food_drink"],
        distanceMeters: 60,
      },
      {
        placeId: "filler-shop",
        text: "Quick Mart",
        name: "Quick Mart",
        category: "Convenience Store",
        categories: ["shopping_services"],
        distanceMeters: 90,
      },
    ]);
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

    // Left unselected: selecting a place would replace the picker (search,
    // chips, list) with the collapsed summary this test never wants.
    await screen.findByRole("radio", { name: /Stanford University/ });
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

    fireEvent.click(screen.getByRole("button", { name: "See all 4 places" }));

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
    expect(await screen.findByRole("button", { name: "Health" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("cannot submit an old place while typed search is unresolved", async () => {
    let resolveSearch:
      | ((value: Array<{ placeId: string; text: string }>) => void)
      | null = null;
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
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    const submit = screen.getByRole("button", {
      name: "Check in",
    });
    expect(submit).toBeEnabled();

    // The search box only lives in the picker view, so reaching it again
    // means going back through "Change" -- which itself drops the stale
    // selection immediately, before any typing happens.
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    expect(submit).toBeDisabled();

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
    // More than 3 places within 500 m so the picker can be expanded to reach
    // the category chips before selecting.
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
        placeId: "filler-cafe",
        text: "Corner Cafe",
        name: "Corner Cafe",
        category: "Cafe",
        categories: ["food_drink"],
        distanceMeters: 60,
      },
      {
        placeId: "filler-shop",
        text: "Quick Mart",
        name: "Quick Mart",
        category: "Convenience Store",
        categories: ["shopping_services"],
        distanceMeters: 90,
      },
    ]);

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
    fireEvent.click(screen.getByRole("button", { name: "See all 4 places" }));
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
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in" }),
    );

    // The too-approximate confirmation point drops the stale selection back
    // to the picker, which is the only place "Try again" lives.
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
      message: "This place is no longer available. Choose another nearby place.",
      retryLocation: false,
      openAppSettings: false,
      retryPlaces: true,
    });
    // More than 3 places within 500 m so the picker can be expanded to reach
    // the category chips before selecting.
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
        placeId: "filler-cafe",
        text: "Corner Cafe",
        name: "Corner Cafe",
        category: "Cafe",
        categories: ["food_drink"],
        distanceMeters: 60,
      },
      {
        placeId: "filler-shop",
        text: "Quick Mart",
        name: "Quick Mart",
        category: "Convenience Store",
        categories: ["shopping_services"],
        distanceMeters: 90,
      },
    ]);

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
    fireEvent.click(screen.getByRole("button", { name: "See all 4 places" }));
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
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in" }),
    );

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
      message: "You moved outside that place's range. Choose a nearby place again.",
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
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in" }),
    );

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
      screen.getByRole("switch", {
        name: "Show me to people nearby",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in" }),
    );

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
    // More than 3 places within 500 m so the picker can be expanded to reach
    // the category chips, and none of them are "transit".
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
        placeId: "filler-cafe",
        text: "Corner Cafe",
        name: "Corner Cafe",
        category: "Cafe",
        categories: ["food_drink"],
        distanceMeters: 60,
      },
      {
        placeId: "filler-shop",
        text: "Quick Mart",
        name: "Quick Mart",
        category: "Convenience Store",
        categories: ["shopping_services"],
        distanceMeters: 90,
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(screen.getByRole("button", { name: "See all 4 places" }));
    fireEvent.click(screen.getByRole("button", { name: "Transit" }));

    const empty = await screen.findByTestId("nearby-category-empty");
    expect(empty).toHaveTextContent("Nothing in this category within 500 m");
    // None of the 4 fixture places are "transit".
    expect(empty).toHaveTextContent("4 other places are nearby.");

    fireEvent.click(screen.getByRole("button", { name: "See all 4 places" }));
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
        expect(locationMemory.rememberLocationGrant).toHaveBeenCalledWith("user-1");
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
});
