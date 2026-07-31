// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authUser: { uid: "user-123" } as { uid: string } | null,
  vault: {
    isVaultUnlocked: true,
    vaultKey: "vault-key" as string | null,
    vaultOwnerToken: "vault-owner-token" as string | null,
  },
  loadSavedLocations: vi.fn(),
  addSavedLocation: vi.fn(),
  removeSavedLocation: vi.fn(),
  updateSavedLocationAddress: vi.fn(),
  captureCurrentPosition: vi.fn(),
  reverseGeocode: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: mocks.authUser }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mocks.vault,
}));

vi.mock("@/lib/one-location/saved-locations", () => ({
  DuplicateSavedLocationError: class DuplicateSavedLocationError extends Error {},
  duplicateSavedLocationMessage: (location: {
    category: string;
    label: string;
  }) => {
    const label =
      location.category === "other" && location.label !== "Other"
        ? `${location.label} (Other)`
        : location.label;
    return `This place is already saved as ${label}. Choose a different place or remove it first.`;
  },
  findDuplicateSavedLocation: (
    locations: Array<{ latitude: number; longitude: number }>,
    candidate: { latitude: number; longitude: number },
  ) =>
    locations.find(
      (location) =>
        location.latitude === candidate.latitude &&
        location.longitude === candidate.longitude,
    ) ?? null,
  loadSavedLocations: mocks.loadSavedLocations,
  addSavedLocation: mocks.addSavedLocation,
  removeSavedLocation: mocks.removeSavedLocation,
  updateSavedLocationAddress: mocks.updateSavedLocationAddress,
  sortSavedLocationsForDisplay: (
    locations: Array<Record<string, unknown>>,
  ) => locations,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    captureCurrentPosition: mocks.captureCurrentPosition,
    reverseGeocode: mocks.reverseGeocode,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: mocks.toastError,
  },
}));

import { SavedLocationsSection } from "@/components/one-location/saved-locations-section";
import {
  forgetOneLocationControlPreference,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { DuplicateSavedLocationError } from "@/lib/one-location/saved-locations";

const HOME = {
  id: "home",
  category: "home",
  label: "Home",
  latitude: 12.9763,
  longitude: 77.5929,
  address: "Kasturba Road, Bengaluru",
  savedAt: "2026-07-26T00:00:00.000Z",
};

describe("SavedLocationsSection", () => {
  beforeEach(() => {
    forgetOneLocationControlPreference("user-123");
    mocks.authUser = { uid: "user-123" };
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key";
    mocks.vault.vaultOwnerToken = "vault-owner-token";
    mocks.loadSavedLocations.mockReset().mockResolvedValue([HOME]);
    mocks.addSavedLocation.mockReset().mockResolvedValue([HOME]);
    mocks.removeSavedLocation.mockReset().mockResolvedValue([]);
    mocks.updateSavedLocationAddress.mockReset().mockResolvedValue([HOME]);
    mocks.captureCurrentPosition.mockReset().mockResolvedValue({
      latitude: 12.9763,
      longitude: 77.5929,
      accuracy: 8,
      capturedAt: "2026-07-26T00:00:00.000Z",
    });
    mocks.reverseGeocode.mockReset().mockResolvedValue({
      formattedAddress: "Kasturba Road, Bengaluru",
      name: null,
      countryCode: "IN",
    });
    mocks.toastError.mockReset();
  });

  afterEach(() => {
    forgetOneLocationControlPreference("user-123");
  });

  it("loads the encrypted saved place into Settings without exposing coordinates", async () => {
    render(<SavedLocationsSection />);

    expect(await screen.findByText("Kasturba Road, Bengaluru")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.queryByText(/12\.9763|77\.5929/)).not.toBeInTheDocument();
    expect(mocks.loadSavedLocations).toHaveBeenCalledWith({
      userId: "user-123",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner-token",
    });
  });

  it("fails closed while the vault is locked", async () => {
    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;

    render(<SavedLocationsSection />);

    expect(
      await screen.findByText(/unlock your vault to view saved places/i),
    ).toBeInTheDocument();
    expect(mocks.loadSavedLocations).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /add place/i })).toBeDisabled();
  });

  it("does not request device location while Location is paused", async () => {
    updateOneLocationControlState("user-123", (current) => ({
      ...current,
      paused: true,
    }));

    render(<SavedLocationsSection />);

    await screen.findByText("Kasturba Road, Bengaluru");
    expect(screen.getByRole("button", { name: /add place/i })).toBeDisabled();
    expect(
      screen.getByText(/resume location before capturing another saved place/i),
    ).toBeInTheDocument();
    expect(mocks.captureCurrentPosition).not.toHaveBeenCalled();
  });

  it("discards a saved-place capture when Location is paused in flight", async () => {
    let resolveCapture: (point: {
      latitude: number;
      longitude: number;
      accuracy: number;
      capturedAt: string;
    }) => void = () => undefined;
    mocks.captureCurrentPosition.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    );

    render(<SavedLocationsSection />);
    await screen.findByText("Kasturba Road, Bengaluru");
    fireEvent.click(screen.getByRole("button", { name: /add place/i }));
    await waitFor(() => expect(mocks.captureCurrentPosition).toHaveBeenCalled());

    await act(async () => {
      updateOneLocationControlState("user-123", (current) => ({
        ...current,
        paused: true,
      }));
      resolveCapture({
        latitude: 12.9763,
        longitude: 77.5929,
        accuracy: 8,
        capturedAt: "2026-07-26T00:00:00.000Z",
      });
      await Promise.resolve();
    });

    expect(
      screen.queryByRole("dialog", { name: /save this place/i }),
    ).not.toBeInTheDocument();
    expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  });

  it("does not rehydrate decrypted places when a pending load settles after lock", async () => {
    let resolveLoad: (locations: (typeof HOME)[]) => void = () => undefined;
    mocks.loadSavedLocations.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { rerender } = render(<SavedLocationsSection />);

    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;
    rerender(<SavedLocationsSection />);
    resolveLoad([HOME]);

    expect(
      await screen.findByText(/unlock your vault to view saved places/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("Kasturba Road, Bengaluru"),
      ).not.toBeInTheDocument(),
    );
  });

  it("captures, resolves, and saves a new place through encrypted PKM", async () => {
    mocks.loadSavedLocations.mockResolvedValueOnce([]);
    render(<SavedLocationsSection />);
    await screen.findByText(/no saved places yet/i);

    fireEvent.click(screen.getByRole("button", { name: /add place/i }));
    expect(
      await screen.findByRole("dialog", { name: /save this place/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.reverseGeocode).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-owner-token",
        lat: 12.9763,
        lng: 77.5929,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: /save location/i }));

    await waitFor(() =>
      expect(mocks.addSavedLocation).toHaveBeenCalledWith({
        context: {
          userId: "user-123",
          vaultKey: "vault-key",
          vaultOwnerToken: "vault-owner-token",
        },
        input: {
          category: "home",
          label: "",
          latitude: 12.9763,
          longitude: 77.5929,
          address: "Kasturba Road, Bengaluru",
        },
      }),
    );
  });

  it("reminds the owner and blocks a duplicate category before persistence", async () => {
    render(<SavedLocationsSection />);
    await screen.findByText("Kasturba Road, Bengaluru");

    fireEvent.click(screen.getByRole("button", { name: /add place/i }));
    expect(
      await screen.findByRole("dialog", { name: /save this place/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: /save location/i }));

    expect(mocks.addSavedLocation).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This place is already saved as Home. Choose a different place or remove it first.",
    );
    expect(
      screen.getByRole("dialog", { name: /save this place/i }),
    ).toBeInTheDocument();
  });

  it("surfaces a duplicate discovered from a newer encrypted state", async () => {
    mocks.loadSavedLocations.mockResolvedValueOnce([]);
    mocks.addSavedLocation.mockRejectedValueOnce(
      new DuplicateSavedLocationError(
        "This place is already saved as Home. Choose a different place or remove it first.",
      ),
    );
    render(<SavedLocationsSection />);
    await screen.findByText(/no saved places yet/i);

    fireEvent.click(screen.getByRole("button", { name: /add place/i }));
    await screen.findByRole("dialog", { name: /save this place/i });
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: /save location/i }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "This place is already saved as Home. Choose a different place or remove it first.",
      ),
    );
    expect(
      screen.getByRole("dialog", { name: /save this place/i }),
    ).toBeInTheDocument();
  });

  it("removes the encrypted place from Settings", async () => {
    render(<SavedLocationsSection />);
    await screen.findByText("Kasturba Road, Bengaluru");

    fireEvent.click(screen.getByRole("button", { name: "Remove Home" }));

    await waitFor(() =>
      expect(mocks.removeSavedLocation).toHaveBeenCalledWith({
        context: {
          userId: "user-123",
          vaultKey: "vault-key",
          vaultOwnerToken: "vault-owner-token",
        },
        id: "home",
      }),
    );
  });
});
