// @vitest-environment jsdom
/**
 * Links: every row shows the persisted state (live / expired / revoked),
 * Revoke goes through the service and the row reflects the server's answer,
 * and a new link carries a position coarsened to the account's precision.
 */

import fs from "node:fs";
import path from "node:path";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  getState: vi.fn(),
  createPublicInvite: vi.fn(),
  revokePublicInvite: vi.fn(),
  captureCurrentPosition: vi.fn(),
}));
const sharing = vi.hoisted(() => ({
  os: "granted",
  osPrecise: true,
  appSharing: true,
  sharingState: "on",
  precision: "precise" as "precise" | "approximate",
  paused: false,
  effective: "sharing",
  activeShareCount: 0,
  resolving: false,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const resource = vi.hoisted(() => ({
  readPresentation: vi.fn(() => null),
  invalidate: vi.fn(),
  load: vi.fn(async (_uid: string, loader: () => Promise<unknown>) => loader()),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/one/location",
  useSearchParams: () => new URLSearchParams("view=links"),
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
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: resource,
}));
vi.mock("@/lib/location/sharing-state", () => ({
  useLocationSharingState: () => sharing,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: toast }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));

import {
  LocationLinks,
  publicLinkStatus,
} from "@/components/location/links/location-links";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../links/location-links.tsx"),
  "utf8",
);

function invite(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "invite-live",
    ownerUserId: "user-1",
    status: "active",
    durationHours: 1,
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    publicUrl: "/one/location/view/tok-live",
    ...overrides,
  };
}

function stateWith(publicInvites: Array<Record<string, unknown>>) {
  return {
    recipients: [],
    ownerGrants: [],
    receivedGrants: [],
    requests: [],
    referrals: [],
    publicInvites,
    publicInviteSubmissions: [],
    capabilityScopes: [],
  };
}

describe("publicLinkStatus", () => {
  it("trusts revoked and expired, and shows an active link past its window as expired", () => {
    const now = Date.now();
    expect(publicLinkStatus({ status: "revoked", expiresAt: null }, now)).toBe(
      "revoked",
    );
    expect(publicLinkStatus({ status: "expired", expiresAt: null }, now)).toBe(
      "expired",
    );
    expect(
      publicLinkStatus(
        { status: "active", expiresAt: new Date(now + 1_000).toISOString() },
        now,
      ),
    ).toBe("active");
    expect(
      publicLinkStatus(
        { status: "active", expiresAt: new Date(now - 1_000).toISOString() },
        now,
      ),
    ).toBe("expired");
  });
});

describe("LocationLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceSessionStore.getState().reset();
    sharing.precision = "precise";
    service.getState.mockResolvedValue(
      stateWith([
        invite(),
        invite({
          id: "invite-old",
          status: "expired",
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
        invite({
          id: "invite-gone",
          status: "revoked",
          createdAt: new Date(Date.now() - 180_000).toISOString(),
          revokedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ]),
    );
    service.captureCurrentPosition.mockResolvedValue({
      latitude: 12.97194,
      longitude: 77.59456,
      accuracyM: 12,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web",
    });
    service.createPublicInvite.mockResolvedValue({
      invite: invite({ id: "invite-new" }),
      publicToken: "tok-new",
      publicUrl: "/one/location/view/tok-new",
    });
  });

  it("renders live, expired and revoked links with real states and a Revoke only on the live one", async () => {
    render(<LocationLinks />);
    const rows = await screen.findAllByTestId("link-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("data-link-status"))).toEqual([
      "active",
      "expired",
      "revoked",
    ]);
    expect(screen.getAllByTestId("link-revoke")).toHaveLength(1);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("revokes through the service and reflects the server's answer", async () => {
    const revoked = invite({
      status: "revoked",
      revokedAt: new Date().toISOString(),
    });
    service.revokePublicInvite.mockImplementation(async () => {
      // The server's next read reports the persisted state.
      service.getState.mockResolvedValue(stateWith([revoked]));
      return revoked;
    });
    render(<LocationLinks />);
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByTestId("link-revoke"));
    await waitFor(() =>
      expect(service.revokePublicInvite).toHaveBeenCalledWith({
        vaultOwnerToken: "owner-token",
        inviteId: "invite-live",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("link-revoke")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(
      "Link revoked. It no longer opens.",
    );
  });

  it("creates a link with a position coarsened to the account precision, at most two hours", async () => {
    sharing.precision = "approximate";
    render(<LocationLinks />);
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("radio", { name: "15 min" }));
    fireEvent.click(screen.getByTestId("links-create-button"));
    await waitFor(() =>
      expect(service.createPublicInvite).toHaveBeenCalledTimes(1),
    );
    const call = service.createPublicInvite.mock.calls[0]?.[0] as {
      durationHours: number;
      locationSnapshot: {
        latitude: number;
        longitude: number;
        precision?: string;
        accuracyM?: number;
      };
    };
    expect(call.durationHours).toBe(0.25);
    expect(call.locationSnapshot.precision).toBe("approximate");
    expect(call.locationSnapshot.latitude).toBe(12.97);
    expect(call.locationSnapshot.longitude).toBe(77.59);
    expect(call.locationSnapshot.accuracyM).toBeGreaterThanOrEqual(1000);
  });

  it("offers the requested 15-minute, 1-hour and 2-hour durations", () => {
    render(<LocationLinks />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "15 min",
      "1 hour",
      "2 hours",
    ]);
  });

  it("refetches when a link tool result succeeds and ignores a rejected one", async () => {
    render(<LocationLinks />);
    await screen.findAllByTestId("link-row");
    expect(service.getState).toHaveBeenCalledTimes(1);
    act(() => {
      useVoiceSessionStore.getState().emitToolResult("revoke_public_link", {
        status: "rejected",
        ui_refresh: ["location_links"],
      });
    });
    expect(service.getState).toHaveBeenCalledTimes(1);
    act(() => {
      useVoiceSessionStore.getState().emitToolResult("create_public_link", {
        status: "created",
        invite_id: "invite-new",
        url: "https://one.example/one/location/view/tok-new",
        ui_refresh: ["location_links"],
      });
    });
    await waitFor(() => expect(service.getState).toHaveBeenCalledTimes(2));
  });

  it("keeps the Location header contract", () => {
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Links"');
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
  });
});
