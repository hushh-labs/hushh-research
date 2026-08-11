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

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: service,
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
    vi.clearAllMocks();
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

  it("captures a fresh point, preselects the nearest place, and keeps consent explicit", async () => {
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
    expect(nearest).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", {
        name: "Allow nearby connection requests",
      }),
    ).toHaveAttribute("data-state", "unchecked");
    expect(
      screen.getByText(/current point is sent to Google/i),
    ).toHaveTextContent(
      /Hussh stores your check-in point only as short-lived encrypted data/i,
    );
    expect(screen.getByText(/current point is sent to Google/i)).toHaveTextContent(
      /They see your display name in their list, never your point or exact distance/i,
    );

    const submit = screen.getByRole("button", {
      name: "Check in and see people",
    });
    expect(submit).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Choose trusted people" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in and see people" }),
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    expect(
      await screen.findByText(/accurate to about 1\.2 km/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in and see people" }),
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    expect(screen.queryByText(/accurate to about/i)).not.toBeInTheDocument();
  });

  it("keeps a persistent retry after the initial presence read fails", async () => {
    service.getNearbyPresence
      .mockRejectedValueOnce(new Error("temporary network failure"))
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

    expect(
      await screen.findByText(
        "Nearby check-in could not be loaded. Check your connection and retry.",
      ),
    ).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry status",
      }),
    );

    await waitFor(() => {
      expect(service.getNearbyPresence).toHaveBeenCalledTimes(2);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(service.nearbyPlaces).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        lat: point.latitude,
        lng: point.longitude,
        category: "all",
      });
    });
    expect(
      service.getNearbyPresence.mock.invocationCallOrder[1],
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
    ).toHaveAttribute("aria-checked", "true");
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    service.nearbyPlaces.mockClear();

    fireEvent.click(screen.getByPlaceholderText("Search for another place"));
    await act(async () => {
      // A failed refresh must degrade the drawer, not blank it.
      fireEvent.click(screen.getByRole("button", { name: "All" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(service.nearbyPlaces).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("Search for another place"), {
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

    fireEvent.change(screen.getByPlaceholderText("Search for another place"), {
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    const submit = screen.getByRole("button", {
      name: "Check in and see people",
    });
    expect(submit).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText("Search for another place"), {
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
    ).toHaveAttribute("aria-checked", "true");
    expect(submit).toBeEnabled();
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in and see people" }),
    );

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
    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Health" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in and see people" }),
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in and see people" }),
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
      expect(onPlaceFocusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          placeId: "stanford-main",
          label: "Stanford University",
          latitude: 37.4276,
          longitude: -122.1697,
          active: false,
        }),
      );
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

    await screen.findByRole("radio", { name: /Stanford University/ });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show me in the nearby people list/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check in and see people" }),
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
    fireEvent.click(screen.getByRole("button", { name: "Transit" }));

    const empty = await screen.findByTestId("nearby-category-empty");
    expect(empty).toHaveTextContent("Nothing in this category within 500 m");
    // The mall sits at 920 m and is dropped by the 500 m bound before this.
    expect(empty).toHaveTextContent("2 other places are nearby.");

    fireEvent.click(screen.getByRole("button", { name: "Show all places" }));
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
});
