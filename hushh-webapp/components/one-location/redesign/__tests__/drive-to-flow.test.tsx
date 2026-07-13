import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// DriveRouteMap uses the Maps loader; force the iframe fallback in tests.
vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: "loading" }),
}));

// The destination search is exercised in place-search-dialog.test.tsx; here we
// stub it to a one-click selector so the flow tests stay focused.
vi.mock("@/components/one-location/redesign/place-search-dialog", () => ({
  PlaceSearchDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (d: { placeId: string; label: string; latitude: number; longitude: number }) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSelect({
            placeId: "p1",
            label: "Starbucks, Market St",
            latitude: 37.79,
            longitude: -122.4,
          })
        }
      >
        stub-pick-place
      </button>
    ) : null,
}));

import { DriveToFlow } from "@/components/one-location/redesign/drive-to-flow";
import { OneLocationService } from "@/lib/one-location/service";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const point: PlainLocationPoint = {
  latitude: 37.7,
  longitude: -122.4,
  capturedAt: new Date("2026-07-07T00:00:00Z").toISOString(),
  sourcePlatform: "web",
};

function makeVm(overrides: Partial<LocationHubViewModel> = {}): LocationHubViewModel {
  return {
    vaultOwnerToken: "token",
    onDriveTo: vi.fn(),
    driveBusy: false,
    recentDestinations: [],
    sosRecipients: [
      {
        userId: "r1",
        displayName: "Carol",
        keyId: "k1",
        publicKeyJwk: {} as JsonWebKey,
        canReceiveLocation: true,
      },
    ],
    isRecipientShareReady: () => true,
    recipientLabel: (r) => r.displayName ?? r.userId,
    recipientSubtitle: () => "Trusted",
    myLocationPoint: point,
    myLocationError: null,
    onShowMyLocation: vi.fn(),
    renderMapPreview: () => <div data-testid="map" />,
    formatDateTime: () => "now",
    busy: null,
    ...overrides,
  } as unknown as LocationHubViewModel;
}

async function pickDestination() {
  // Open the (stubbed) place-search dialog, then pick the stub result.
  fireEvent.click(screen.getByRole("button", { name: /where are you headed/i }));
  fireEvent.click(await screen.findByText("stub-pick-place"));
}

describe("DriveToFlow", () => {
  it("searches destinations and starts a drive share with a 2h default", async () => {
    vi.spyOn(OneLocationService, "routeEta").mockResolvedValue({
      etaSeconds: 1080,
      distanceMeters: 7200,
      trafficLevel: "light",
    });
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    await pickDestination();

    fireEvent.click(await screen.findByRole("button", { name: /Carol/i }));
    const startBtn = await screen.findByRole("button", { name: /start sharing/i });
    await waitFor(() => expect(startBtn).not.toBeDisabled());
    fireEvent.click(startBtn);

    await waitFor(() =>
      expect(vm.onDriveTo).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: "p1", latitude: 37.79 }),
        ["r1"],
        "2",
      ),
    );
  });

  it("disables start until a destination is chosen", () => {
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /start sharing drive/i }),
    ).toBeDisabled();
  });

  it("prompts to capture location when there is no live fix", () => {
    const vm = makeVm({ myLocationPoint: null });
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /^capture location$/i }),
    ).toBeInTheDocument();
  });

  it("does not render duration chips", () => {
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    expect(screen.queryByText(/share for/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^1 hour$/i })).toBeNull();
  });

  it("shows the route map + ETA badge once a destination is chosen", async () => {
    vi.spyOn(OneLocationService, "routeEta").mockResolvedValue({
      etaSeconds: 1080,
      distanceMeters: 7200,
      trafficLevel: "light",
    });
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    await pickDestination();

    expect(
      await screen.findByTitle("Drive route map preview"),
    ).toBeInTheDocument();
    expect(await screen.findByText("18 min")).toBeInTheDocument();
    expect(
      await screen.findByText("7.2 km · light traffic"),
    ).toBeInTheDocument();
  });
});
