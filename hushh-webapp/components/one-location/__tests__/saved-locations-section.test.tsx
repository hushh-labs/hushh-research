// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: mocks.authUser }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mocks.vault,
}));

vi.mock("@/lib/one-location/saved-locations", () => ({
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
    error: vi.fn(),
  },
}));

import { SavedLocationsSection } from "@/components/one-location/saved-locations-section";

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
    });
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
    render(<SavedLocationsSection />);
    await screen.findByText("Kasturba Road, Bengaluru");

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
