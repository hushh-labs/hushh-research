import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "@/lib/format/relative-time";
import {
  deriveSyncDisplay,
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
    expect(d.label).toMatch(/^Active · last synced /);
  });

  it("shows 'not yet synced' for an active device that never synced", () => {
    const d = deriveSyncDisplay({ status: "active", last_synced_at: null }, NOW);
    expect(d).toEqual({ label: "Active · not yet synced", tone: "neutral" });
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
