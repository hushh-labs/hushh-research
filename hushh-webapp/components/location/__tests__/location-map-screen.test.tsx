// @vitest-environment jsdom
/**
 * Your Map: composes the existing LiveMap renderer (never rewrites it), gates
 * coordinates behind the renderer consent the server records, offers a
 * self-locate control that takes one device fix, and lists people by the
 * names on their grants after decrypting on this device.
 */

import fs from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  getMapState: vi.fn(),
  updateMapPreferences: vi.fn(),
}));
const encryption = vi.hoisted(() => ({ decryptLocationEnvelope: vi.fn() }));
const device = vi.hoisted(() => ({
  status: "idle" as string,
  permission: null as string | null,
  snapshot: null as null | {
    latitude: number;
    longitude: number;
    accuracyM: number | null;
    capturedAt: string;
    sourcePlatform?: string;
  },
  error: null as string | null,
  snapshotOrigin: null as "fresh" | "restored" | null,
  request: vi.fn(),
  refresh: vi.fn(),
}));
const liveMap = vi.hoisted(() => ({
  renders: [] as Array<{ lat: number; lng: number }>,
  avatarUrls: [] as Array<string | null | undefined>,
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/one/location/map",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "user-1",
    user: { uid: "user-1" },
    isAuthenticated: true,
    loading: false,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "owner-token", vaultKey: "vault-key" }),
}));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: service }));
vi.mock("@/lib/one-location/encryption", () => encryption);
vi.mock("@/lib/one-location/use-current-location", () => ({
  useCurrentLocation: () => device,
}));
vi.mock("@/components/one-location/live-map", () => ({
  LiveMap: ({
    point,
    avatarUrl,
  }: {
    point: { latitude: number; longitude: number };
    avatarUrl?: string | null;
  }) => {
    liveMap.renders.push({ lat: point.latitude, lng: point.longitude });
    liveMap.avatarUrls.push(avatarUrl);
    return (
      <div
        data-testid="live-map"
        data-lat={point.latitude}
        data-lng={point.longitude}
      />
    );
  },
}));
vi.mock("@/hooks/use-effective-avatar-url", () => ({
  useEffectiveAvatarUrl: () => "https://example.com/avatar.jpg",
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: toast }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));

import {
  LocationMapScreen,
  rendererConsentCurrent,
} from "@/components/location/map/location-map-screen";
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";
import { readLocationWorkspaceMemory } from "@/lib/one-location/location-workspace-memory";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../map/location-map-screen.tsx"),
  "utf8",
);

function envelope(id: string) {
  return {
    id,
    recipientKeyId: "key-1",
    algorithm: "ECDH-P256-AES256-GCM",
    ciphertext: "c",
    iv: "i",
    senderEphemeralPublicKeyJwk: { kty: "EC" },
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web",
  };
}

function grant(id: string, ownerDisplayName: string) {
  return {
    id,
    ownerUserId: `owner-${id}`,
    recipientUserId: "user-1",
    ownerDisplayName,
    recipientKeyId: "key-1",
    status: "active",
    consentScope: "location",
    capabilityScopes: [],
    durationHours: 1,
  };
}

describe("rendererConsentCurrent", () => {
  it("is true only for the current consent version", () => {
    expect(rendererConsentCurrent(null)).toBe(false);
    expect(rendererConsentCurrent({ rendererConsentVersion: "old" })).toBe(
      false,
    );
    expect(
      rendererConsentCurrent({
        rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      }),
    ).toBe(true);
  });
});

describe("LocationMapScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    liveMap.renders.length = 0;
    liveMap.avatarUrls.length = 0;
    device.snapshot = null;
    device.snapshotOrigin = null;
    device.request.mockImplementation(async () => {
      device.snapshot = {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracyM: 10,
        capturedAt: new Date().toISOString(),
        sourcePlatform: "web",
      };
      device.snapshotOrigin = "fresh";
      return device.snapshot;
    });
    service.getMapState.mockResolvedValue({
      preferences: {
        presenceMode: "ghost",
        rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      },
      freshnessSeconds: 120,
      markers: [
        { grant: grant("grant-1", "Priya Nair"), envelope: envelope("env-1") },
      ],
    });
    encryption.decryptLocationEnvelope.mockResolvedValue({
      latitude: 13.0827,
      longitude: 80.2707,
      accuracyM: 20,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "ios",
    });
  });

  it("composes LiveMap with the decrypted share and lists people by name only", async () => {
    render(<LocationMapScreen />);
    const map = await screen.findByTestId("live-map");
    expect(map).toHaveAttribute("data-lat", "13.0827");
    expect(screen.getByTestId("one-location-map-people")).toHaveTextContent(
      "Priya Nair",
    );
    expect(document.body.textContent).not.toContain("owner-grant-1");
    expect(document.body.textContent).not.toContain("grant-1");
    expect(encryption.decryptLocationEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
    // Decrypted points live in memory only, keyed by grant.
    expect(
      readLocationWorkspaceMemory("user-1").decryptedPoints["grant-1"]
        ?.latitude,
    ).toBe(13.0827);
  });

  it("offers a self-locate control that takes one device fix and centres on it", async () => {
    render(<LocationMapScreen />);
    await screen.findByTestId("live-map");
    expect(screen.getByTestId("live-map")).toHaveAttribute(
      "data-lat",
      "13.0827",
    );
    fireEvent.click(screen.getByTestId("one-location-map-locate"));
    await waitFor(() => expect(device.request).toHaveBeenCalledTimes(1));
    // Focus moves to the device fix; the map re-centres on it.
    await waitFor(() =>
      expect(screen.getByTestId("live-map")).toHaveAttribute(
        "data-lat",
        "12.9716",
      ),
    );
    expect(screen.getByRole("button", { name: /You/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Tapping a person in the tray refocuses the map on their share.
    fireEvent.click(screen.getByRole("button", { name: /Priya Nair/ }));
    await waitFor(() =>
      expect(screen.getByTestId("live-map")).toHaveAttribute(
        "data-lat",
        "13.0827",
      ),
    );
  });

  it("keeps coordinates away from the renderer until the server records renderer consent", async () => {
    service.getMapState.mockResolvedValue({
      preferences: { presenceMode: "ghost", rendererConsentVersion: null },
      freshnessSeconds: 120,
      markers: [
        { grant: grant("grant-1", "Priya Nair"), envelope: envelope("env-1") },
      ],
    });
    service.updateMapPreferences.mockResolvedValue({
      presenceMode: "ghost",
      rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
    });
    render(<LocationMapScreen />);
    expect(
      await screen.findByTestId("map-renderer-consent"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("live-map")).toBeNull();
    expect(screen.queryByTestId("one-location-map-locate")).toBeNull();
    expect(screen.getByTestId("map-renderer-consent")).toHaveTextContent(
      "1 person is sharing with you.",
    );
    expect(encryption.decryptLocationEnvelope).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Show the map/ }));
    await waitFor(() =>
      expect(service.updateMapPreferences).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      }),
    );
    expect(await screen.findByTestId("live-map")).toBeInTheDocument();
    expect(encryption.decryptLocationEnvelope).toHaveBeenCalled();
  });

  it("passes the viewer's own avatar to LiveMap so the pin is a face, not a pin", async () => {
    render(<LocationMapScreen />);
    await screen.findByTestId("live-map");
    expect(liveMap.avatarUrls).toContain("https://example.com/avatar.jpg");
  });

  it("draws its own way back to Location because the route hides the chrome", async () => {
    render(<LocationMapScreen />);
    await screen.findByTestId("live-map");
    fireEvent.click(screen.getByTestId("one-location-map-close"));
    expect(router.replace).toHaveBeenCalledWith("/one/location", {
      scroll: false,
    });
  });

  it("never covers the app shell and titles itself Your Map", () => {
    expect(SOURCE).toContain('title="Your Map"');
    expect(SOURCE).not.toContain("eyebrow=");
    expect(SOURCE).toContain("<LiveMap");
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("new google.maps.Map");
  });
});
