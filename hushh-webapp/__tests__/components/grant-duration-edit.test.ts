import { describe, expect, it } from "vitest";

import {
  GRANT_EDIT_DURATION_FALLBACK,
  defaultEditDurationHours,
  grantDurationEditIntent,
  grantRemainingHours,
} from "@/lib/one-location/grant-duration-edit";

const NOW = Date.parse("2026-05-20T08:00:00.000Z");

function grant(fields: { expiresAt?: string | null; durationHours?: number | null }) {
  return {
    expiresAt: fields.expiresAt ?? null,
    durationHours: fields.durationHours ?? null,
  };
}

/** `nowMs` plus this many minutes, as an ISO expiry. */
function inMinutes(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

describe("grantRemainingHours", () => {
  it("reads what is left from the expiry", () => {
    expect(grantRemainingHours(grant({ expiresAt: inMinutes(30) }), NOW)).toBeCloseTo(
      0.5,
      6,
    );
  });

  it("clamps an already-passed expiry to zero rather than going negative", () => {
    expect(grantRemainingHours(grant({ expiresAt: inMinutes(-10) }), NOW)).toBe(0);
  });

  it("falls back to the granted length when no expiry was sent", () => {
    expect(grantRemainingHours(grant({ durationHours: 4 }), NOW)).toBe(4);
  });

  it("has no answer for a grant carrying neither", () => {
    expect(grantRemainingHours(grant({}), NOW)).toBeNull();
    expect(grantRemainingHours(null, NOW)).toBeNull();
  });
});

describe("defaultEditDurationHours", () => {
  // The reported bug: the editor opened on "1 hour" over a row that said
  // "30 more min", so the field was never the share's current duration.
  it("opens on the option nearest what is actually left", () => {
    expect(defaultEditDurationHours(grant({ expiresAt: inMinutes(30) }), NOW)).toBe(
      "0.5",
    );
    expect(defaultEditDurationHours(grant({ expiresAt: inMinutes(59) }), NOW)).toBe(
      "1",
    );
    expect(defaultEditDurationHours(grant({ expiresAt: inMinutes(200) }), NOW)).toBe(
      "4",
    );
    expect(defaultEditDurationHours(grant({ expiresAt: inMinutes(1200) }), NOW)).toBe(
      "24",
    );
  });

  it("never proposes more than the longest option, however far off the expiry is", () => {
    expect(
      defaultEditDurationHours(grant({ expiresAt: "2099-05-20T08:00:00.000Z" }), NOW),
    ).toBe("24");
  });

  it("falls back when the grant says nothing usable about its length", () => {
    expect(defaultEditDurationHours(grant({}), NOW)).toBe(
      GRANT_EDIT_DURATION_FALLBACK,
    );
    expect(defaultEditDurationHours(grant({ expiresAt: "not a date" }), NOW)).toBe(
      GRANT_EDIT_DURATION_FALLBACK,
    );
  });
});

describe("grantDurationEditIntent", () => {
  it("shortens when the new duration ends the share sooner", () => {
    expect(
      grantDurationEditIntent({
        grant: grant({ expiresAt: inMinutes(60) }),
        durationHours: 0.5,
        nowMs: NOW,
      }),
    ).toBe("shorten");
  });

  it("asks the owner when the new duration would run past the current expiry", () => {
    expect(
      grantDurationEditIntent({
        grant: grant({ expiresAt: inMinutes(12) }),
        durationHours: 1,
        nowMs: NOW,
      }),
    ).toBe("request");
  });

  // A one-hour share a minute old reads "59 more min" and the picker opens on
  // "1 hour". Save on that untouched field is not a request for one more
  // minute of somebody's location.
  it("treats a picker still showing what is left as no change at all", () => {
    expect(
      grantDurationEditIntent({
        grant: grant({ expiresAt: inMinutes(59) }),
        durationHours: 1,
        nowMs: NOW,
      }),
    ).toBe("unchanged");
    expect(
      grantDurationEditIntent({
        grant: grant({ expiresAt: inMinutes(24 * 60 - 10) }),
        durationHours: 24,
        nowMs: NOW,
      }),
    ).toBe("unchanged");
  });

  it("still calls a real shortening a shortening, just inside the tolerance band", () => {
    // 45 minutes left, asked for 30: a quarter of an hour is a change.
    expect(
      grantDurationEditIntent({
        grant: grant({ expiresAt: inMinutes(45) }),
        durationHours: 0.5,
        nowMs: NOW,
      }),
    ).toBe("shorten");
  });

  it("shortens when there is no expiry to compare against", () => {
    // A never-expiring share can only be cut short by naming a duration, and
    // the backend's shorten endpoint agrees -- it skips its own check.
    expect(
      grantDurationEditIntent({
        grant: grant({ durationHours: null }),
        durationHours: 1,
        nowMs: NOW,
      }),
    ).toBe("shorten");
  });

  it("leaves an unreadable duration to the backend rather than guessing", () => {
    expect(
      grantDurationEditIntent({
        grant: grant({ expiresAt: inMinutes(60) }),
        durationHours: Number.NaN,
        nowMs: NOW,
      }),
    ).toBe("shorten");
  });
});
