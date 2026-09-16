import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "u1" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vot" }),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getAuthHeaders: (token?: string) =>
      token ? { Authorization: `Bearer ${token}` } : {},
  },
  getApiBaseUrl: () => "http://localhost:8000",
}));
vi.mock("@/lib/services/api-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/api-client")>();
  return { ...actual, apiJson: mocks.apiJson };
});

import {
  LocationAccountSettingsResource,
  getLocationAccountSettings,
  locationSettingsErrorCode,
  normalizeLocationAccountSettings,
  updateLocationAccountSettings,
} from "@/lib/location/account-settings";
import {
  LOCATION_SHARING_CONSENT_VERSION,
  LocationSetupProgressResource,
  advanceSetupProgress,
  currentLocationSetupStep,
  getSetupProgress,
  hasAcceptedLocationConsent,
  normalizeLocationSetupProgress,
} from "@/lib/location/setup-progress";
import { ApiError } from "@/lib/services/api-client";

beforeEach(() => {
  mocks.apiJson.mockReset();
  LocationAccountSettingsResource.__resetForTests();
  LocationSetupProgressResource.__resetForTests();
});

describe("account settings client", () => {
  it("GETs with the vault-owner bearer and normalizes the wire shape", async () => {
    mocks.apiJson.mockResolvedValueOnce({
      settings: {
        user_id: "u1",
        sharing_state: "on",
        precision: "approximate",
        os_permission_reported: "granted",
        sharing_consent_accepted_at: "2026-09-15T09:00:00Z",
      },
    });
    const settings = await getLocationAccountSettings("vot");
    expect(mocks.apiJson).toHaveBeenCalledWith(
      "/api/one/location/account-settings",
      {
        headers: { Authorization: "Bearer vot" },
      },
    );
    expect(settings.sharing_state).toBe("on");
    expect(settings.sharing_enabled).toBe(true);
    expect(settings.sharingState).toBe("on");
    expect(settings.sharingEnabled).toBe(true);
    expect(settings.precision).toBe("approximate");
    expect(settings.os_permission_reported).toBe("granted");
    expect(settings.osPermissionReported).toBe("granted");
    expect(settings.sharingConsentAcceptedAt).toBe("2026-09-15T09:00:00Z");
  });

  it("never normalizes an unknown sharing state to on", () => {
    expect(
      normalizeLocationAccountSettings({ sharing_state: "enabled" })
        .sharing_state,
    ).toBe("unset");
    expect(normalizeLocationAccountSettings({}).sharing_enabled).toBe(false);
    expect(normalizeLocationAccountSettings(null).precision).toBe("precise");
    expect(
      normalizeLocationAccountSettings({ sharingState: "off" }).sharing_state,
    ).toBe("off");
  });

  it("PATCHes only the fields given and returns the transition", async () => {
    mocks.apiJson.mockResolvedValueOnce({
      settings: { sharing_state: "off", precision: "precise" },
      transition: {
        settings: { sharing_state: "off" },
        changed: true,
        revoked_grant_ids: ["g1"],
        revoked_link_ids: [],
        notified_recipients: 1,
      },
    });
    const result = await updateLocationAccountSettings("vot", {
      sharingState: "off",
      includeSos: true,
    });
    const [path, init] = mocks.apiJson.mock.calls[0]!;
    expect(path).toBe("/api/one/location/account-settings");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({
      Authorization: "Bearer vot",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      sharingState: "off",
      includeSos: true,
    });
    expect(result.settings.sharing_state).toBe("off");
    expect(result.transition).toEqual({
      settings: expect.objectContaining({ sharing_state: "off" }),
      changed: true,
      revoked_grant_ids: ["g1"],
      revoked_link_ids: [],
      notified_recipients: 1,
    });
  });

  it("reads the stable error code from detail.code", () => {
    const error = new ApiError("nope", 409, {
      detail: { code: "LOCATION_SOS_ACTIVE", message: "SOS is active" },
    });
    expect(locationSettingsErrorCode(error)).toBe("LOCATION_SOS_ACTIVE");
    expect(locationSettingsErrorCode(new Error("x"))).toBeNull();
  });

  it("resource: shares one value, coalesces loads, and merge keeps aliases in step", async () => {
    mocks.apiJson.mockResolvedValue({
      settings: { sharing_state: "on", precision: "precise" },
    });
    const seen: string[] = [];
    const unsubscribe = LocationAccountSettingsResource.subscribe(
      "u1",
      (snapshot) => {
        seen.push(
          `${snapshot.status}:${snapshot.settings?.sharing_state ?? "-"}`,
        );
      },
    );
    await Promise.all([
      LocationAccountSettingsResource.load("u1", "vot"),
      LocationAccountSettingsResource.load("u1", "vot"),
    ]);
    expect(mocks.apiJson).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["loading:-", "ready:on"]);

    LocationAccountSettingsResource.merge("u1", { sharingState: "off" });
    const merged = LocationAccountSettingsResource.peek("u1").settings!;
    expect(merged.sharing_state).toBe("off");
    expect(merged.sharingState).toBe("off");
    expect(merged.sharing_enabled).toBe(false);

    LocationAccountSettingsResource.merge("u1", { sharing_state: "on" });
    expect(
      LocationAccountSettingsResource.peek("u1").settings!.sharingState,
    ).toBe("on");

    LocationAccountSettingsResource.invalidate("u1");
    expect(LocationAccountSettingsResource.peek("u1").status).toBe("idle");
    unsubscribe();
  });
});

describe("setup progress client", () => {
  it("GETs progress and derives the screen to show", async () => {
    mocks.apiJson.mockResolvedValueOnce({
      progress: {
        step: "consent",
        next_step: "os_permission",
        started: true,
        completed: false,
        consent_version: LOCATION_SHARING_CONSENT_VERSION,
        consent_accepted_at: "2026-09-15T09:00:00Z",
        os_permission_state: "unknown",
        precision: null,
        started_at: "2026-09-15T08:59:00Z",
        completed_at: null,
        steps: [
          "intro",
          "consent",
          "os_permission",
          "precision",
          "recipient_key",
          "done",
        ],
      },
    });
    const progress = await getSetupProgress("vot");
    expect(mocks.apiJson).toHaveBeenCalledWith(
      "/api/one/location/setup-progress",
      {
        headers: { Authorization: "Bearer vot" },
      },
    );
    expect(currentLocationSetupStep(progress)).toBe("os_permission");
    expect(hasAcceptedLocationConsent(progress)).toBe(true);
  });

  it("maps every persisted row to the right screen", () => {
    expect(currentLocationSetupStep(null)).toBe("intro");
    expect(
      currentLocationSetupStep(
        normalizeLocationSetupProgress({ step: "intro" }),
      ),
    ).toBe("intro");
    expect(
      currentLocationSetupStep(
        normalizeLocationSetupProgress({
          step: "intro",
          started_at: "2026-09-15T08:59:00Z",
        }),
      ),
    ).toBe("consent");
    expect(
      currentLocationSetupStep(
        normalizeLocationSetupProgress({
          step: "os_permission",
          started_at: "x",
          consent_accepted_at: "y",
        }),
      ),
    ).toBe("precision");
    expect(
      currentLocationSetupStep(
        normalizeLocationSetupProgress({
          step: "recipient_key",
          started_at: "x",
        }),
      ),
    ).toBe("done");
    expect(
      currentLocationSetupStep(
        normalizeLocationSetupProgress({
          step: "done",
          started_at: "x",
          completed_at: "z",
        }),
      ),
    ).toBe("done");
    expect(
      normalizeLocationSetupProgress({
        step: "done",
        started_at: "x",
        completed_at: "z",
      }).completed,
    ).toBe(true);
    expect(normalizeLocationSetupProgress({ step: "bogus" }).step).toBe(
      "intro",
    );
  });

  it("PATCHes one action with its camelCase fields", async () => {
    mocks.apiJson.mockResolvedValue({
      progress: { step: "consent", started_at: "x", consent_accepted_at: "y" },
    });
    await advanceSetupProgress("vot", {
      action: "accept_consent",
      consentVersion: LOCATION_SHARING_CONSENT_VERSION,
    });
    await advanceSetupProgress("vot", {
      action: "record_os_permission",
      osPermissionState: "granted",
    });
    await advanceSetupProgress("vot", {
      action: "set_precision",
      precision: "approximate",
    });
    await advanceSetupProgress("vot", { action: "complete" });
    const bodies = mocks.apiJson.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    expect(bodies).toEqual([
      {
        action: "accept_consent",
        consentVersion: LOCATION_SHARING_CONSENT_VERSION,
      },
      { action: "record_os_permission", osPermissionState: "granted" },
      { action: "set_precision", precision: "approximate" },
      { action: "complete" },
    ]);
    for (const [path, init] of mocks.apiJson.mock.calls) {
      expect(path).toBe("/api/one/location/setup-progress");
      expect(init.method).toBe("PATCH");
      expect(init.headers).toEqual({
        Authorization: "Bearer vot",
        "Content-Type": "application/json",
      });
    }
  });

  it("resource: write publishes, invalidate re-reads", async () => {
    mocks.apiJson.mockResolvedValue({
      progress: { step: "intro", started_at: "x" },
    });
    const first = await LocationSetupProgressResource.load("u1", "vot");
    expect(first.step).toBe("intro");
    expect(LocationSetupProgressResource.peek("u1").status).toBe("ready");
    LocationSetupProgressResource.write(
      "u1",
      normalizeLocationSetupProgress({
        step: "consent",
        started_at: "x",
        consent_accepted_at: "y",
      }),
    );
    expect(LocationSetupProgressResource.peek("u1").progress?.step).toBe(
      "consent",
    );
    // Held value is returned without a network round-trip...
    await LocationSetupProgressResource.load("u1", "vot");
    expect(mocks.apiJson).toHaveBeenCalledTimes(1);
    // ...until invalidated.
    LocationSetupProgressResource.invalidate("u1");
    await LocationSetupProgressResource.load("u1", "vot");
    expect(mocks.apiJson).toHaveBeenCalledTimes(2);
  });
});
