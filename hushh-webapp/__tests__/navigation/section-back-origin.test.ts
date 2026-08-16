import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDestinationOrigins,
  isDestinationRoot,
  readDestinationOrigin,
  readDestinationOriginsForTest,
  recordDestinationEntry,
  resolveDestinationId,
} from "@/lib/navigation/section-back-origin";
import {
  navigateTopShellBack,
  resolveTopShellBackAction,
} from "@/lib/navigation/top-shell-back";

const KAI = "/one/kai";
const KAI_ANALYSIS = "/one/kai/analysis";
const LOCATION = "/one/location";
const LOCATION_PEOPLE = "/one/location?view=people";
const CONNECT = "/one/connect";
const ONE_HOME = "/one";

beforeEach(() => {
  clearDestinationOrigins();
});

/**
 * Inside a destination the declared parent already climbs correctly and needs
 * no memory. What the hierarchy cannot know is which destination the person
 * crossed in from, and that is the only case back got wrong.
 */
describe("destination identity", () => {
  it("treats agent sections and shared bottom-nav surfaces alike", () => {
    expect(resolveDestinationId(LOCATION)).toBeTruthy();
    // Connect is not an agent capability. Scoping this to sections alone is
    // what left "Location -> Add Connections -> back" landing on One home.
    expect(resolveDestinationId(CONNECT)).toBeTruthy();
    expect(resolveDestinationId(LOCATION)).not.toBe(resolveDestinationId(CONNECT));
  });

  it("knows which routes are exit points", () => {
    expect(isDestinationRoot(LOCATION)).toBe(true);
    expect(isDestinationRoot(CONNECT)).toBe(true);
    // Deeper routes still climb their declared parents.
    expect(isDestinationRoot(KAI_ANALYSIS)).toBe(false);
  });
});

describe("recording crossings", () => {
  it("stores nothing for a move inside one destination", () => {
    recordDestinationEntry(KAI);
    recordDestinationEntry(KAI_ANALYSIS);

    expect(readDestinationOriginsForTest()).toEqual([]);
  });

  it("keeps the query of the screen that was left", () => {
    recordDestinationEntry(LOCATION_PEOPLE);
    recordDestinationEntry(CONNECT);

    // Returning to a bare /one/location is the right screen showing the wrong
    // tab, which is what the report described.
    expect(readDestinationOrigin(CONNECT)).toBe(LOCATION_PEOPLE);
  });

  it("does not treat a query-only change as a crossing", () => {
    recordDestinationEntry(LOCATION);
    recordDestinationEntry(LOCATION_PEOPLE);

    expect(readDestinationOriginsForTest()).toEqual([]);
  });

  it("refuses anything that is not an in-app absolute path", () => {
    recordDestinationEntry(LOCATION);
    recordDestinationEntry("https://example.com/one/connect");
    recordDestinationEntry("//evil.example.com");

    expect(readDestinationOriginsForTest()).toEqual([]);
  });

  it("unwinds rather than stacking when a destination is re-entered", () => {
    recordDestinationEntry(ONE_HOME);
    recordDestinationEntry(LOCATION);
    recordDestinationEntry(CONNECT);
    recordDestinationEntry(LOCATION);

    const ids = readDestinationOriginsForTest().map((e) => e.destinationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(readDestinationOrigin(CONNECT)).toBeNull();
  });
});

describe("back leaves a destination by its origin", () => {
  it("returns from Connect to the exact Location screen it was opened from", () => {
    recordDestinationEntry(LOCATION_PEOPLE);
    recordDestinationEntry(CONNECT);

    expect(resolveTopShellBackAction({ pathname: CONNECT })).toEqual({
      href: LOCATION_PEOPLE,
      mode: "push",
      transitionMode: "full",
    });
  });

  it("climbs inside a destination, ignoring the origin", () => {
    recordDestinationEntry(LOCATION);
    recordDestinationEntry(KAI);
    recordDestinationEntry(KAI_ANALYSIS);

    const action = resolveTopShellBackAction({ pathname: KAI_ANALYSIS });
    expect(action?.href).not.toBe(LOCATION);
  });

  it("falls back to the declared parent with no recorded origin", () => {
    // Deep link, cold start, shared invite link. Unchanged behaviour.
    expect(resolveTopShellBackAction({ pathname: "/ria/onboarding" })).toEqual({
      href: ONE_HOME,
      mode: "push",
      transitionMode: "full",
    });
  });

  it("spends the origin so a later visit cannot retrace a stale route", () => {
    recordDestinationEntry(LOCATION_PEOPLE);
    recordDestinationEntry(CONNECT);
    const navigate = vi.fn();

    navigateTopShellBack({ pathname: CONNECT, navigate });
    expect(navigate).toHaveBeenCalledWith({
      href: LOCATION_PEOPLE,
      mode: "push",
      transitionMode: "full",
    });
    expect(readDestinationOrigin(CONNECT)).toBeNull();
  });

  it("closes an open action sheet in place instead of leaving", () => {
    recordDestinationEntry(KAI);
    recordDestinationEntry(LOCATION);
    const navigate = vi.fn();

    navigateTopShellBack({
      pathname: LOCATION,
      searchParams: new URLSearchParams("action=share"),
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith({
      href: `${LOCATION}?view=now`,
      mode: "replace",
      transitionMode: "contextual",
    });
    // The overlay closed; the origin is still owed for when they actually go.
    expect(readDestinationOrigin(LOCATION)).toBe(KAI);
  });

  it("still reports no back where the shell hides it", () => {
    recordDestinationEntry(LOCATION);
    recordDestinationEntry(CONNECT);

    // The iOS edge-back gesture enables itself from this returning an action,
    // so when back exists must not shift.
    expect(
      resolveTopShellBackAction({
        pathname: CONNECT,
        breadcrumb: { backHref: ONE_HOME, hideBack: true, items: [] },
      }),
    ).toBeNull();
  });
});
