import { describe, expect, it } from "vitest";

import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";

function grant(id: string, shareKind: string | null, createdAt: string) {
  return { id, shareKind, createdAt };
}

function sortSmsFirst<T extends { shareKind: string | null }>(grants: T[]): T[] {
  return [...grants].sort(
    (a, b) => Number(isSmsTriggeredGrant(b)) - Number(isSmsTriggeredGrant(a)),
  );
}

describe("isSmsTriggeredGrant", () => {
  it("is true for an sos share", () => {
    expect(isSmsTriggeredGrant({ shareKind: "sos" })).toBe(true);
  });

  it("is false for a routine share", () => {
    expect(isSmsTriggeredGrant({ shareKind: "share" })).toBe(false);
  });

  it("is false for an unrecognized or missing kind", () => {
    expect(isSmsTriggeredGrant({ shareKind: null })).toBe(false);
    expect(isSmsTriggeredGrant({ shareKind: "drive_to" })).toBe(false);
  });
});

describe("shared-with-me SMS-first sort", () => {
  it("moves an sos grant ahead of an older routine grant", () => {
    const routine = grant("routine", "share", "2026-05-20T08:00:00.000Z");
    const sos = grant("sos", "sos", "2026-05-20T07:00:00.000Z");

    expect(sortSmsFirst([routine, sos]).map((g) => g.id)).toEqual([
      "sos",
      "routine",
    ]);
  });

  it("keeps the existing relative order within each group (stable sort)", () => {
    const routineA = grant("routine-a", "share", "2026-05-20T09:00:00.000Z");
    const routineB = grant("routine-b", "check_in", "2026-05-20T08:00:00.000Z");
    const sosA = grant("sos-a", "sos", "2026-05-20T07:00:00.000Z");
    const sosB = grant("sos-b", "sos", "2026-05-20T06:00:00.000Z");

    expect(
      sortSmsFirst([routineA, routineB, sosA, sosB]).map((g) => g.id),
    ).toEqual(["sos-a", "sos-b", "routine-a", "routine-b"]);
  });
});
