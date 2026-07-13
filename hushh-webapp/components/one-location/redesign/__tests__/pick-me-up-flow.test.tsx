import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: "loading" }),
}));

import { PickMeUpFlow } from "@/components/one-location/redesign/pick-me-up-flow";
import { OneLocationService } from "@/lib/one-location/service";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const point: PlainLocationPoint = {
  latitude: 28.6562,
  longitude: 77.241,
  capturedAt: "2026-07-12T00:00:00Z",
  sourcePlatform: "web",
};

function makeVm(overrides: Partial<LocationHubViewModel> = {}): LocationHubViewModel {
  return {
    vaultOwnerToken: "token",
    onPickMeUp: vi.fn(),
    sosRecipients: [
      { userId: "a", displayName: "Ankit", keyId: "k1", publicKeyJwk: {} as JsonWebKey, canReceiveLocation: true },
      { userId: "b", displayName: "Akshat", keyId: "k2", publicKeyJwk: {} as JsonWebKey, canReceiveLocation: true },
    ],
    isRecipientShareReady: () => true,
    recipientLabel: (r) => r.displayName ?? r.userId,
    recipientSubtitle: () => "Trusted",
    recipientLivePoint: () => null,
    myLocationPoint: point,
    myLocationError: null,
    onShowMyLocation: vi.fn(),
    formatDateTime: () => "now",
    busy: null,
    ...overrides,
  } as unknown as LocationHubViewModel;
}

describe("PickMeUpFlow", () => {
  it("single-selects a recipient and labels the button with their name", async () => {
    vi.spyOn(OneLocationService, "reverseGeocode").mockResolvedValue({
      name: "Central Library",
      formattedAddress: "476 5th Ave",
    });
    const vm = makeVm();
    render(<PickMeUpFlow vm={vm} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /Ankit/i }));
    const ask = await screen.findByRole("button", { name: /ask ankit to pick me up/i });
    await waitFor(() => expect(ask).not.toBeDisabled());
    fireEvent.click(ask);
    await waitFor(() =>
      // No note typed → message is undefined; no fixed spot → pickupPoint undefined.
      expect(vm.onPickMeUp).toHaveBeenCalledWith(["a"], "4", undefined, undefined),
    );
  });

  it("switching selection replaces the prior one (radio, not multi)", async () => {
    const vm = makeVm();
    render(<PickMeUpFlow vm={vm} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Ankit/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Akshat/i }));
    expect(
      await screen.findByRole("button", { name: /ask akshat to pick me up/i }),
    ).toBeInTheDocument();
  });

  it("shows distance only for a contact that is sharing", async () => {
    const vm = makeVm({
      recipientLivePoint: (id) =>
        id === "a"
          ? { latitude: 28.60, longitude: 77.20, capturedAt: "x", sourcePlatform: "web" }
          : null,
    });
    render(<PickMeUpFlow vm={vm} onClose={vi.fn()} />);
    expect(await screen.findByText(/km away/i)).toBeInTheDocument();
  });

  it("reverse-geocodes the pickup spot label", async () => {
    vi.spyOn(OneLocationService, "reverseGeocode").mockResolvedValue({
      name: "Central Library",
      formattedAddress: "476 5th Ave",
    });
    const vm = makeVm();
    render(<PickMeUpFlow vm={vm} onClose={vi.fn()} />);
    expect(await screen.findByText(/Central Library/)).toBeInTheDocument();
  });
});
