import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { listTrustedDevices: api.list, revokeTrustedDeviceEverywhere: async (...args: unknown[]) => ({ hub: await api.revoke(...args), pod: { delivered: true, pending: null } }) } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: null }) }));
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";
import { useTrustedDevicesModel } from "@/components/profile/use-trusted-devices-model";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

import { formatRelativeTime } from "@/lib/format/relative-time";
import {
  deriveSyncDisplay,
  HEARTBEAT_FRESH_MS,
  SEAL_CONFIRM_WINDOW_MS,
} from "@/lib/trusted-device/sync-display";

const NOW = 1_700_000_000_000;

afterEach(() => { publishValidatedAuthSessionOwner(null); CacheService.getInstance().clear(); vi.clearAllMocks(); });

describe("trusted-device operation owner", () => {
  const device = { device_id: "synthetic-device", device_name: "Test computer", platform: "macos", status: "active" };
  const listed = () => new Response(JSON.stringify({ devices: [device] }), { status: 200 });
  it("rejects stale vault/visit callbacks and late owner responses while preserving a valid unlink", async () => {
    publishValidatedAuthSessionOwner("device-owner");
    api.list.mockImplementation(async () => listed());
    let finish!: (value: Response) => void;
    api.revoke.mockImplementation(async () => new Response(null, { status: 204 }));
    const view = renderHook(({ owner, enabled }) => useTrustedDevicesModel(owner, enabled),
      { initialProps: { owner: "device-owner", enabled: true } });
    await waitFor(() => expect(view.result.current.devices).toHaveLength(1));
    act(() => view.result.current.choose(device.device_id));
    await waitFor(() => expect(view.result.current.confirmation).not.toBeNull());
    const retainedConfirm = view.result.current.confirm;
    act(() => view.result.current.cancel());
    await act(async () => { await retainedConfirm(); });
    expect(api.revoke).not.toHaveBeenCalled();
    act(() => view.result.current.choose(device.device_id));
    const beforeLock = view.result.current.confirm;
    act(() => advanceVaultSessionEpoch());
    await act(async () => { await beforeLock(); });
    expect(api.revoke).not.toHaveBeenCalled();
    view.rerender({ owner: "device-owner", enabled: false });
    view.rerender({ owner: "device-owner", enabled: true });
    await waitFor(() => expect(view.result.current.devices).toHaveLength(1));
    api.revoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => view.result.current.choose(device.device_id));
    let request!: Promise<void>;
    act(() => { request = view.result.current.confirm(); });
    expect(api.revoke).toHaveBeenCalledOnce();
    publishValidatedAuthSessionOwner("other-owner");
    view.rerender({ owner: "other-owner", enabled: true });
    await act(async () => { finish(new Response(null, { status: 204 })); await request; });
    expect(view.result.current.confirmation).toBeNull();
    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.error).toBe("");
    view.unmount();
  });

  it("does not replay an uncertain unlink, and refresh failure cannot undo a committed unlink", async () => {
    publishValidatedAuthSessionOwner("device-owner");
    api.list.mockImplementation(async () => listed());
    api.revoke.mockRejectedValueOnce(new Error("synthetic transport failure"));
    const view = renderHook(() => useTrustedDevicesModel("device-owner", true));
    await waitFor(() => expect(view.result.current.devices).toHaveLength(1));
    act(() => view.result.current.choose(device.device_id));
    const retainedConfirm = view.result.current.confirm;
    await act(async () => { await retainedConfirm(); });
    expect(view.result.current.uncertain).toBe(true);
    await act(async () => { await retainedConfirm(); await view.result.current.confirm(); });
    expect(api.revoke).toHaveBeenCalledOnce();
    api.list.mockRejectedValueOnce(new Error("synthetic list failure"));
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.uncertain).toBe(true);
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.uncertain).toBe(false);
    api.revoke.mockResolvedValueOnce(new Response(null, { status: 204 }));
    api.list.mockRejectedValueOnce(new Error("synthetic list failure"));
    await act(async () => { await view.result.current.confirm(); });
    expect(api.revoke).toHaveBeenCalledTimes(2);
    expect(view.result.current.confirmation).toBeNull();
    expect(view.result.current.error).toBe("Device unlinked. Couldn’t refresh the list.");
    expect(view.result.current.uncertain).toBe(false);
    expect(view.result.current.devices[0]?.status).toBe("revoked");
    act(() => view.result.current.choose(device.device_id));
    await act(async () => { await view.result.current.confirm(); });
    expect(api.revoke).toHaveBeenCalledTimes(2);
  });

  it("does not accept a pre-unlink list read as post-unlink reconciliation", async () => {
    publishValidatedAuthSessionOwner("device-owner");
    api.list.mockImplementation(async () => listed());
    const view = renderHook(() => useTrustedDevicesModel("device-owner", true));
    await waitFor(() => expect(view.result.current.devices).toHaveLength(1));
    let finishRead!: (response: Response) => void;
    api.list.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    let oldRefresh!: Promise<void>;
    act(() => { oldRefresh = view.result.current.refresh(); });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    act(() => view.result.current.choose(device.device_id));
    api.revoke.mockResolvedValueOnce(new Response(null, { status: 204 }));
    let unlink!: Promise<void>;
    act(() => { unlink = view.result.current.confirm(); });
    await waitFor(() => expect(api.revoke).toHaveBeenCalledOnce());
    api.list.mockResolvedValueOnce(new Response(JSON.stringify({ devices: [{ ...device, status: "revoked" }] }), { status: 200 }));
    await act(async () => { finishRead(listed()); await oldRefresh; await unlink; });
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.devices[0]?.status).toBe("revoked");
    expect(view.result.current.error).toBe("");
  });

  it("does not join a retired visit's pending list when the same owner reopens", async () => {
    publishValidatedAuthSessionOwner("device-owner");
    let oldRead!: (response: Response) => void;
    api.list.mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; }))
      .mockImplementation(async () => listed());
    const view = renderHook(({ enabled }) => useTrustedDevicesModel("device-owner", enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    view.rerender({ enabled: false });
    view.rerender({ enabled: true });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.devices).toHaveLength(1));
    await act(async () => { oldRead(listed()); });
    expect(view.result.current.error).toBe("");
    expect(view.result.current.devices[0]?.device_name).toBe("Test computer");
  });
});

describe("deriveSyncDisplay", () => {
  it("shows an active device's real last-sync time", () => {
    const d = deriveSyncDisplay(
      { status: "active", last_synced_at: NOW - 3_600_000 },
      NOW,
    );
    expect(d.tone).toBe("active");
    expect(d.label).toMatch(/^Trusted · last synced /);
  });

  it("never claims live reachability for a trusted device", () => {
    // status="active" means authorized, not running. The label must not imply
    // the agent is reachable right now -- there is no liveness channel.
    const d = deriveSyncDisplay(
      { status: "active", last_synced_at: NOW - 2 * 86_400_000 },
      NOW,
    );
    expect(d.label).not.toMatch(/^Active\b/);
    expect(d.label).toContain("Trusted");
  });

  it("says a device is active now only on a fresh heartbeat", () => {
    const d = deriveSyncDisplay(
      {
        status: "active",
        last_synced_at: NOW - 2 * 86_400_000,
        last_heartbeat_at: NOW - 30_000,
        heartbeat: { current_model: "gemini-3.6-flash" },
      },
      NOW,
    );
    // A stale sync must not suppress a live heartbeat: this is the exact case
    // that used to read "last synced 2 days ago" while the agent was running.
    expect(d).toEqual({
      label: "Active now · running gemini-3.6-flash",
      tone: "active",
    });
  });

  it("falls back to trust-only once the heartbeat goes stale", () => {
    const d = deriveSyncDisplay(
      {
        status: "active",
        last_synced_at: NOW - 3_600_000,
        last_heartbeat_at: NOW - HEARTBEAT_FRESH_MS - 1000,
      },
      NOW,
    );
    // Never keep claiming reachability from an expired heartbeat.
    expect(d.label).toMatch(/^Trusted · last synced /);
    expect(d.label).not.toContain("Active now");
  });

  it("shows 'not yet synced' for a trusted device that never synced", () => {
    const d = deriveSyncDisplay({ status: "active", last_synced_at: null }, NOW);
    expect(d).toEqual({ label: "Trusted · not yet synced", tone: "neutral" });
  });

  it("reports a sealed device as reported, never asserts sealing as fact", () => {
    const d = deriveSyncDisplay(
      { status: "revoked", sealed_at: NOW - 60_000 },
      NOW,
    );
    expect(d.tone).toBe("muted");
    expect(d.label).toMatch(/^Revoked · device reported sealed /);
    expect(d.label).not.toContain("vault sealed");
  });

  it("awaits seal confirmation inside the bounded window", () => {
    const d = deriveSyncDisplay(
      { status: "revoked", sealed_at: null, revoked_at: NOW - 1000 },
      NOW,
    );
    expect(d).toEqual({
      label: "Revoked · awaiting device seal confirmation",
      tone: "neutral",
    });
  });

  it("degrades to an honest 'seal unconfirmed' past the window", () => {
    const d = deriveSyncDisplay(
      {
        status: "revoked",
        sealed_at: null,
        revoked_at: NOW - SEAL_CONFIRM_WINDOW_MS - 1000,
      },
      NOW,
    );
    expect(d).toEqual({ label: "Revoked · seal unconfirmed", tone: "muted" });
  });

  it("renders an unclassifiable status as unavailable, never a false 'stopped'", () => {
    const d = deriveSyncDisplay({ status: "mystery" }, NOW);
    expect(d).toEqual({ label: "Sync status unavailable", tone: "muted" });
    expect(d.label).not.toMatch(/stopped|revoked/i);
  });

  it("is reload-stable for the same (fields, nowMs)", () => {
    const fields = { status: "active" as const, last_synced_at: NOW - 5000 };
    expect(deriveSyncDisplay(fields, NOW)).toEqual(
      deriveSyncDisplay(fields, NOW),
    );
  });
});

describe("formatRelativeTime", () => {
  it("returns empty for null/undefined so callers can branch", () => {
    expect(formatRelativeTime(null, NOW)).toBe("");
    expect(formatRelativeTime(undefined, NOW)).toBe("");
  });

  it("collapses very recent times to 'just now'", () => {
    expect(formatRelativeTime(NOW - 5000, NOW)).toBe("just now");
  });

  it("formats a past time relative to now", () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toMatch(/ago/);
  });
});
