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
    service.nearbyPlaces.mockResolvedValue([
      {
        placeId: "stanford-main",
        text: "Stanford University",
        distanceMeters: 48,
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
        consentVersion: "one-location-nearby-presence-v1",
        checkedInAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        placeLabel: "Stanford University",
      },
      attendees: [],
    });
  });

  it("captures a fresh point, preselects the nearest place, and keeps consent explicit", async () => {
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

    const nearest = await screen.findByRole("radio", {
      name: /Stanford University/,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(service.nearbyPlaces).toHaveBeenCalledWith({
      vaultOwnerToken: "owner-token",
      lat: point.latitude,
      lng: point.longitude,
    });
    expect(nearest).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", {
        name: "Allow nearby connection requests",
      }),
    ).toHaveAttribute("data-state", "unchecked");
    expect(
      screen.getByText(/current point is sent once to Google/i),
    ).toHaveTextContent(
      /Hussh does not store the raw GPS fix, and nearby people never receive it/i,
    );

    const submit = screen.getByRole("button", {
      name: "Check in and see people",
    });
    expect(submit).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Let nearby checked-in users see me/,
      }),
    );
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(service.checkInNearby).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        placeId: "stanford-main",
        point,
        durationMinutes: 60,
        consentAccepted: true,
        allowConnectionRequests: false,
      });
    });
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
        consentVersion: "one-location-nearby-presence-v1",
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
          consentVersion: "one-location-nearby-presence-v1",
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
        consentVersion: "one-location-nearby-presence-v1",
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
        consentVersion: "one-location-nearby-presence-v1",
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
        consentVersion: "one-location-nearby-presence-v1",
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
        "Precise location is off. Enable it before checking in nearby.",
      ),
    ).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
    expect(service.nearbyPlaces).not.toHaveBeenCalled();
  });

  it("keeps Respond enabled and routes incoming requests to Consent Center", async () => {
    service.getNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: false,
        consentVersion: "one-location-nearby-presence-v1",
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
        consentVersion: "one-location-nearby-presence-v1",
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
          consentVersion: "one-location-nearby-presence-v1",
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
});
