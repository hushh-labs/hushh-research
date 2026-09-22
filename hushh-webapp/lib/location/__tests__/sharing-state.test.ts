import { describe, expect, it, vi } from "vitest";

// The pure composition is what is under test; the hooks' I/O modules are
// stubbed so importing the module graph stays cheap and network-free.
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: null }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: null }),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: () => ({}), apiFetch: vi.fn() },
  getApiBaseUrl: () => "http://localhost:8000",
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { getPermissionState: vi.fn(), getState: vi.fn() },
}));
vi.mock("@/lib/one-location/location-bus", () => ({
  LocationBus: {
    subscribe: () => () => undefined,
    getState: () => ({ permission: null }),
    syncPermission: vi.fn(),
  },
}));

import { normalizeLocationAccountSettings } from "@/lib/location/account-settings";
import {
  activeOwnerGrants,
  composeLocationSharingState,
  countActiveOwnerGrants,
  deriveEffectiveSharing,
  type LocationOsPermission,
} from "@/lib/location/sharing-state";
import type { OneLocationGrant } from "@/lib/one-location/types";

const OS_STATES: LocationOsPermission[] = [
  "granted",
  "denied",
  "prompt",
  "restricted",
  "unavailable",
  "unknown",
];

function settings(
  sharingState: "unset" | "on" | "off",
  precision: "precise" | "approximate" = "precise",
) {
  return normalizeLocationAccountSettings({
    sharing_state: sharingState,
    precision,
    os_permission_reported: "unknown",
  });
}

describe("deriveEffectiveSharing", () => {
  it('is "sharing" only when the server says on AND the OS granted AND not paused', () => {
    for (const os of OS_STATES) {
      for (const sharingState of ["unset", "on", "off"] as const) {
        for (const paused of [false, true]) {
          const effective = deriveEffectiveSharing({
            os,
            sharingState,
            paused,
          });
          const expectSharing =
            sharingState === "on" && os === "granted" && !paused;
          expect(effective === "sharing").toBe(expectSharing);
        }
      }
    }
  });

  it("names the reason it is not sharing", () => {
    expect(
      deriveEffectiveSharing({
        os: "granted",
        sharingState: "unset",
        paused: false,
      }),
    ).toBe("unset");
    expect(
      deriveEffectiveSharing({
        os: "granted",
        sharingState: "off",
        paused: false,
      }),
    ).toBe("off");
    expect(
      deriveEffectiveSharing({
        os: "denied",
        sharingState: "on",
        paused: false,
      }),
    ).toBe("blocked_by_os");
    expect(
      deriveEffectiveSharing({
        os: "prompt",
        sharingState: "on",
        paused: false,
      }),
    ).toBe("blocked_by_os");
    expect(
      deriveEffectiveSharing({
        os: "unknown",
        sharingState: "on",
        paused: false,
      }),
    ).toBe("blocked_by_os");
    expect(
      deriveEffectiveSharing({
        os: "granted",
        sharingState: "on",
        paused: true,
      }),
    ).toBe("paused");
    // OS block outranks a pause: the pause can be lifted here, the block cannot.
    expect(
      deriveEffectiveSharing({
        os: "denied",
        sharingState: "on",
        paused: true,
      }),
    ).toBe("blocked_by_os");
  });
});

describe("composeLocationSharingState", () => {
  it("keeps device permission, app sharing, and precision as three distinct facts", () => {
    const view = composeLocationSharingState({
      os: "denied",
      osPrecise: false,
      settings: settings("on", "approximate"),
      paused: false,
      activeShareCount: 2,
    });
    expect(view.os).toBe("denied");
    expect(view.osPermission).toBe("denied");
    expect(view.osPrecise).toBe(false);
    expect(view.appSharing).toBe(true);
    expect(view.sharingState).toBe("on");
    expect(view.precision).toBe("approximate");
    expect(view.effective).toBe("blocked_by_os");
    expect(view.activeShareCount).toBe(2);
  });

  it("never reports appSharing or sharing when settings are missing", () => {
    const view = composeLocationSharingState({
      os: "granted",
      osPrecise: true,
      settings: null,
      paused: false,
      activeShareCount: 0,
      resolving: true,
    });
    expect(view.appSharing).toBe(false);
    expect(view.sharingState).toBe("unset");
    expect(view.effective).toBe("unset");
    expect(view.resolving).toBe(true);
  });

  it("appSharing mirrors the persisted sharing_state only", () => {
    expect(
      composeLocationSharingState({
        os: "granted",
        osPrecise: null,
        settings: settings("off"),
        paused: false,
        activeShareCount: 0,
      }).appSharing,
    ).toBe(false);
    expect(
      composeLocationSharingState({
        os: "prompt",
        osPrecise: null,
        settings: settings("on"),
        paused: false,
        activeShareCount: 0,
      }).appSharing,
    ).toBe(true);
  });

  it("is sharing with the OS granted, sharing on and no pause", () => {
    const view = composeLocationSharingState({
      os: "granted",
      osPrecise: true,
      settings: settings("on"),
      paused: false,
      activeShareCount: 1,
    });
    expect(view.effective).toBe("sharing");
  });
});

describe("activeOwnerGrants", () => {
  const now = Date.parse("2026-09-15T10:00:00.000Z");
  const base: Omit<OneLocationGrant, "id" | "status" | "expiresAt"> = {
    ownerUserId: "owner",
    recipientUserId: "r",
    recipientKeyId: "k",
    consentScope: "location.live",
    capabilityScopes: [],
    durationHours: 1,
  };

  it("counts only active, unexpired grants", () => {
    const state = {
      ownerGrants: [
        {
          ...base,
          id: "a",
          status: "active",
          expiresAt: "2026-09-15T11:00:00.000Z",
        },
        {
          ...base,
          id: "b",
          status: "active",
          expiresAt: "2026-09-15T09:00:00.000Z",
        },
        { ...base, id: "c", status: "revoked", expiresAt: null },
        { ...base, id: "d", status: "active", expiresAt: null },
      ],
    };
    expect(activeOwnerGrants(state, now).map((grant) => grant.id)).toEqual([
      "a",
      "d",
    ]);
    expect(countActiveOwnerGrants(state, now)).toBe(2);
    expect(countActiveOwnerGrants(null, now)).toBe(0);
  });
});
