import { describe, expect, it } from "vitest";

import {
  isPublishableAge,
  publishPointFrom,
  shouldWarnOnPublishFailure,
} from "@/lib/one-location/live-publish-decision";

const SNAPSHOT = {
  latitude: 19.076,
  longitude: 72.877,
  accuracyM: 14,
  capturedAt: new Date().toISOString(),
  sourcePlatform: "ios" as const,
};

function denial(): Error {
  const error = new Error("Location permission is blocked for this site.");
  error.name = "LocationPermissionDeniedError";
  return error;
}

function timeout(): Error {
  const error = new Error("Could not get your location.");
  error.name = "LocationTimeoutError";
  (error as Error & { code?: number }).code = 3;
  return error;
}

describe("the live publisher's failure gate", () => {
  it("stays silent while a fix is in hand and nothing was refused", () => {
    // The reported bug, stated as a decision: a heartbeat that failed while a
    // movement watch was delivering fixes warned once every twenty seconds
    // about a location the app already had.
    expect(
      shouldWarnOnPublishFailure({ error: timeout(), snapshot: SNAPSHOT }),
    ).toBe(false);
  });

  it("speaks up when the platform actually refused", () => {
    expect(
      shouldWarnOnPublishFailure({ error: denial(), snapshot: SNAPSHOT }),
    ).toBe(true);
  });

  it("speaks up for a native refusal, which names neither denied nor blocked", () => {
    expect(
      shouldWarnOnPublishFailure({
        error: new Error("Location permission was not granted."),
        snapshot: SNAPSHOT,
      }),
    ).toBe(true);
  });

  it("speaks up when there is no position at all", () => {
    expect(
      shouldWarnOnPublishFailure({ error: timeout(), snapshot: null }),
    ).toBe(true);
  });

  it("keeps speaking up once a denial has been observed, whatever the error says", () => {
    // A denial proven by attempting stays true on every tick after it; the
    // error on a later tick may well be an ordinary timeout.
    expect(
      shouldWarnOnPublishFailure({
        error: timeout(),
        snapshot: SNAPSHOT,
        observedDenial: true,
      }),
    ).toBe(true);
  });
});

describe("what the live publisher may send", () => {
  it("publishes a fix measured this session", () => {
    const point = publishPointFrom({
      snapshot: SNAPSHOT,
      snapshotOrigin: "fresh",
    });

    expect(point?.latitude).toBe(19.076);
    expect(point?.capturedAt).toBe(SNAPSHOT.capturedAt);
  });

  it("refuses to publish a remembered position as a live one", () => {
    // The recipient's screen says "live". A restored coordinate under that
    // label shows someone standing still somewhere they already left, so
    // skipping the tick is the honest failure — their own staleness threshold
    // is what tells them the dot is old.
    expect(
      publishPointFrom({ snapshot: SNAPSHOT, snapshotOrigin: "restored" }),
    ).toBeNull();
  });

  it("refuses to publish when there is nothing to publish", () => {
    expect(
      publishPointFrom({ snapshot: null, snapshotOrigin: null }),
    ).toBeNull();
  });

  it("carries the platform that produced the fix, not a guess", () => {
    // sourcePlatform is sealed into the envelope and rendered to the
    // recipient. Defaulting it relabels every iPhone share as web.
    expect(
      publishPointFrom({ snapshot: SNAPSHOT, snapshotOrigin: "fresh" })
        ?.sourcePlatform,
    ).toBe("ios");
  });
});

describe("how old a fix this tick may reuse", () => {
  it("accepts a fix from within the heartbeat window", () => {
    const capturedAt = new Date(Date.now() - 5_000).toISOString();
    expect(isPublishableAge(capturedAt, 20_000)).toBe(true);
  });

  it("rejects a fix older than the heartbeat window", () => {
    const capturedAt = new Date(Date.now() - 25_000).toISOString();
    expect(isPublishableAge(capturedAt, 20_000)).toBe(false);
  });

  it("rejects a timestamp from the future as a clock change, not a fresh fix", () => {
    const capturedAt = new Date(Date.now() + 60_000).toISOString();
    expect(isPublishableAge(capturedAt, 20_000)).toBe(false);
  });

  it("rejects a timestamp it cannot read", () => {
    expect(isPublishableAge("not-a-date", 20_000)).toBe(false);
    expect(isPublishableAge(null, 20_000)).toBe(false);
  });
});
