import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTrustedDevices: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    listTrustedDevices: mocks.listTrustedDevices,
  },
}));

import {
  derivePuppyLink,
  fetchPuppyLink,
} from "@/lib/services/puppy-one-service";
import { HEARTBEAT_FRESH_MS } from "@/lib/trusted-device/sync-display";

/**
 * The link to Hussh One, read from One's own record of the owner's devices.
 *
 * This is what every deployed viewer sees instead of the loopback bridge, so
 * the two things that matter are: it says "live" only on the same evidence
 * the devices page calls "Active now", and it never turns a failed read into
 * advice ("install Puppy One") that a person with a working machine would
 * follow to their cost.
 */

const NOW = Date.parse("2026-09-03T10:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    device_id: "dev-1",
    device_name: "Kushal's Mac",
    platform: "macos",
    status: "active",
    created_at: NOW - 86_400_000,
    last_used_at: null,
    last_synced_at: null,
    last_heartbeat_at: null,
    heartbeat: null,
    ...overrides,
  };
}

describe("derivePuppyLink", () => {
  it("is live for an active device that reported inside the window", () => {
    const link = derivePuppyLink(
      [
        row({
          last_heartbeat_at: NOW - 60_000,
          heartbeat: { current_model: "gemma-4-26b-a4b-qat", busy: false },
        }),
      ],
      NOW,
    );
    expect(link.state).toBe("live");
    expect(link.activeCount).toBe(1);
    expect(link.checkedAt).toBe(NOW);
    expect(link.device).toEqual({
      id: "dev-1",
      name: "Kushal's Mac",
      lastHeartbeatAt: NOW - 60_000,
      lastSyncedAt: null,
      heartbeat: { current_model: "gemma-4-26b-a4b-qat", busy: false },
    });
  });

  it("is quiet for an active device whose last report is stale", () => {
    const link = derivePuppyLink(
      [row({ last_heartbeat_at: NOW - 3 * 60 * 60 * 1000 })],
      NOW,
    );
    expect(link.state).toBe("quiet");
    expect(link.device?.lastHeartbeatAt).toBe(NOW - 3 * 60 * 60 * 1000);
  });

  it("is quiet for an active device that has never reported", () => {
    const link = derivePuppyLink([row()], NOW);
    expect(link.state).toBe("quiet");
    expect(link.device?.name).toBe("Kushal's Mac");
    expect(link.device?.lastHeartbeatAt).toBeNull();
    expect(link.device?.heartbeat).toBeNull();
  });

  it("is unlinked when there are no devices at all", () => {
    const link = derivePuppyLink([], NOW);
    expect(link).toEqual({
      state: "unlinked",
      device: null,
      activeCount: 0,
      checkedAt: NOW,
    });
  });

  it("is revoked when every device was unlinked", () => {
    const link = derivePuppyLink(
      [
        row({ status: "revoked", revoked_at: NOW - 1000 }),
        row({ device_id: "dev-2", status: "revoked" }),
      ],
      NOW,
    );
    expect(link.state).toBe("revoked");
    expect(link.device).toBeNull();
    expect(link.activeCount).toBe(0);
  });

  it("is unavailable, not unlinked, for input that is not a list", () => {
    for (const bad of [null, undefined, {}, "devices", 42]) {
      expect(derivePuppyLink(bad, NOW).state).toBe("unavailable");
    }
  });

  it("does not throw on malformed rows and reads the well-formed one beside them", () => {
    const link = derivePuppyLink(
      [
        null,
        "not a row",
        { device_name: "no id" },
        { device_id: "   " },
        row({
          device_id: "dev-ok",
          last_heartbeat_at: "yesterday",
          heartbeat: "not an object",
          created_at: "x",
        }),
      ],
      NOW,
    );
    // The bad timestamps read as "never", the bad snapshot as "none".
    expect(link.state).toBe("quiet");
    expect(link.device?.id).toBe("dev-ok");
    expect(link.device?.lastHeartbeatAt).toBeNull();
    expect(link.device?.heartbeat).toBeNull();
  });

  it("names a device with a blank name rather than rendering nothing", () => {
    const link = derivePuppyLink([row({ device_name: "  " })], NOW);
    expect(link.device?.name).toBe("your Mac");
  });

  it("picks the active device with the freshest heartbeat", () => {
    const link = derivePuppyLink(
      [
        row({ device_id: "older-beat", last_heartbeat_at: NOW - 10 * 60_000 }),
        row({
          device_id: "fresh",
          device_name: "Studio",
          last_heartbeat_at: NOW - 60_000,
        }),
        row({ device_id: "never", created_at: NOW }),
        row({ device_id: "gone", status: "revoked", last_heartbeat_at: NOW }),
      ],
      NOW,
    );
    expect(link.state).toBe("live");
    expect(link.device?.id).toBe("fresh");
    expect(link.device?.name).toBe("Studio");
    expect(link.activeCount).toBe(3);
  });

  it("falls back to the newest enrolment when no active device has reported", () => {
    const link = derivePuppyLink(
      [
        row({ device_id: "old", created_at: NOW - 5_000_000 }),
        row({ device_id: "new", created_at: NOW - 1_000 }),
      ],
      NOW,
    );
    expect(link.state).toBe("quiet");
    expect(link.device?.id).toBe("new");
  });

  it("is live at exactly HEARTBEAT_FRESH_MS and quiet one millisecond past it", () => {
    // The same inclusive boundary the devices page uses for "Active now", so
    // the two surfaces can never disagree about one machine.
    expect(
      derivePuppyLink([row({ last_heartbeat_at: NOW - HEARTBEAT_FRESH_MS })], NOW)
        .state,
    ).toBe("live");
    expect(
      derivePuppyLink(
        [row({ last_heartbeat_at: NOW - HEARTBEAT_FRESH_MS - 1 })],
        NOW,
      ).state,
    ).toBe("quiet");
  });

  it("ignores a revoked device's heartbeat when deciding liveness", () => {
    const link = derivePuppyLink(
      [
        row({ status: "revoked", last_heartbeat_at: NOW }),
        row({ device_id: "dev-2", last_heartbeat_at: NOW - HEARTBEAT_FRESH_MS * 2 }),
      ],
      NOW,
    );
    expect(link.state).toBe("quiet");
    expect(link.device?.id).toBe("dev-2");
  });
});

describe("fetchPuppyLink", () => {
  beforeEach(() => {
    mocks.listTrustedDevices.mockReset();
  });

  it("derives the link from the backend's device list", async () => {
    mocks.listTrustedDevices.mockResolvedValue({
      ok: true,
      json: async () => ({
        devices: [row({ last_heartbeat_at: Date.now() - 1_000 })],
      }),
    });
    const link = await fetchPuppyLink();
    expect(link.state).toBe("live");
    expect(link.device?.name).toBe("Kushal's Mac");
  });

  it("is unavailable when the backend rejects", async () => {
    mocks.listTrustedDevices.mockRejectedValue(new Error("network down"));
    await expect(fetchPuppyLink()).resolves.toMatchObject({
      state: "unavailable",
      device: null,
    });
  });

  it("is unavailable, never unlinked, on a non-OK response", async () => {
    mocks.listTrustedDevices.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "Missing Firebase ID token" }),
    });
    await expect(fetchPuppyLink()).resolves.toMatchObject({
      state: "unavailable",
    });
  });

  it("is unavailable when the body cannot be read", async () => {
    mocks.listTrustedDevices.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    await expect(fetchPuppyLink()).resolves.toMatchObject({
      state: "unavailable",
    });
  });
});
