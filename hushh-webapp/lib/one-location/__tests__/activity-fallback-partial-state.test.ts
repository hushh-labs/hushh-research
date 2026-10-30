import { describe, expect, it } from "vitest";

import { buildOneLocationActivityFallback } from "@/lib/one-location/activity";
import type { OneLocationState } from "@/lib/one-location/types";

/**
 * A missing section costs that section's rows, never the screen.
 *
 * The fallback guarded against a null state and then assumed a non-null one
 * carried all six of its arrays. A snapshot missing any single list — a partial
 * cache entry, a cached shape written by an older build, a section the backend
 * degraded to nothing — threw "Cannot read properties of undefined (reading
 * 'map')" out of a useMemo, which the global error boundary turned into a blank
 * Location page.
 */

const RANGE = "30d" as const;

// Deliberately NOT the full OneLocationState: the point is what happens when
// the object on hand is short of a field the type promises.
function partial(state: Record<string, unknown>): OneLocationState {
  return state as unknown as OneLocationState;
}

describe("buildOneLocationActivityFallback with an incomplete snapshot", () => {
  it("survives the exact shape that crashed the page (no recipients)", () => {
    expect(() =>
      buildOneLocationActivityFallback(
        partial({ ownerGrants: [], requests: [] }),
        "user_a",
        RANGE,
      ),
    ).not.toThrow();
  });

  it("survives an object with none of the lists at all", () => {
    const result = buildOneLocationActivityFallback(
      partial({}),
      "user_a",
      RANGE,
    );
    expect(result.range).toBe(RANGE);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("survives each list being missing on its own", () => {
    const lists = [
      "recipients",
      "ownerGrants",
      "receivedGrants",
      "requests",
      "publicInvites",
      "publicInviteSubmissions",
    ];
    for (const omitted of lists) {
      const snapshot: Record<string, unknown> = {};
      for (const key of lists) if (key !== omitted) snapshot[key] = [];
      expect(
        () => buildOneLocationActivityFallback(partial(snapshot), "user_a", RANGE),
        `omitting ${omitted} should not throw`,
      ).not.toThrow();
    }
  });

  it("still returns the empty shape for a null state", () => {
    const result = buildOneLocationActivityFallback(null, "user_a", RANGE);
    expect(result.range).toBe(RANGE);
    expect(result.events).toEqual([]);
  });

  it("reports zero counts rather than inventing them when lists are absent", () => {
    const result = buildOneLocationActivityFallback(
      partial({}),
      "user_a",
      RANGE,
    );
    expect(result.summary.activeShareCount).toBe(0);
    expect(result.summary.requestsReceivedCount).toBe(0);
    expect(result.summary.requestsSentCount).toBe(0);
  });
});
