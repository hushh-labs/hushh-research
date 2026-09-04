import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "@/lib/format/relative-time";
import {
  deriveSyncDisplay,
  HEARTBEAT_FRESH_MS,
  SEAL_CONFIRM_WINDOW_MS,
} from "@/lib/trusted-device/sync-display";

const NOW = 1_700_000_000_000;

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
