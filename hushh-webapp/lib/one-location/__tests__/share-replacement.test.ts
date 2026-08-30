import { describe, expect, it } from "vitest";

import {
  resolveShareDurationHours,
  shareReplacementsLosingTime,
} from "@/lib/one-location/share-replacement";
import type { OneLocationGrant } from "@/lib/one-location/types";

/**
 * Reported: "if i share my location with someone previously for 2 hours, and
 * in the next cycle i share with the same person for 15 minutes, the previous
 * share times out into the new duration -- without giving any alert."
 *
 * Sharing again does not extend an existing share: the backend revokes the
 * live grant in the same lane and inserts a fresh one, so a shorter duration
 * takes time away. These are the cases the confirm step's warning has to get
 * right, and -- just as importantly -- the ones it has to stay silent about.
 */

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function hoursFromNow(hours: number): string {
  return new Date(NOW + hours * 3_600_000).toISOString();
}

function grant(overrides: Partial<OneLocationGrant> = {}): OneLocationGrant {
  return {
    id: "grant_ordinary",
    ownerUserId: "owner_1",
    recipientUserId: "user_b",
    recipientKeyId: "key_b",
    status: "active",
    consentScope: "cap.location.live.view",
    capabilityScopes: ["cap.location.live.view"],
    durationMode: "timed",
    durationHours: 2,
    createdAt: hoursFromNow(0),
    expiresAt: hoursFromNow(2),
    shareKind: "share",
    ...overrides,
  };
}

describe("resolveShareDurationHours", () => {
  it("reads the open-ended token as no comparable amount", () => {
    expect(resolveShareDurationHours("until_stopped")).toBeNull();
  });

  it("clamps into the window the backend accepts", () => {
    // `gt=0, le=24` server-side. A value outside it would be posted and
    // rejected, and a warning that compared the unclamped number would quote
    // a duration the share never gets.
    expect(resolveShareDurationHours("0.1")).toBe(0.25);
    expect(resolveShareDurationHours("48")).toBe(24);
    expect(resolveShareDurationHours("2")).toBe(2);
  });

  it("falls back to the floor for a value that is not a number", () => {
    // Matches what the duration wheel already writes back on sight.
    expect(resolveShareDurationHours("nonsense")).toBe(0.25);
  });
});

describe("shareReplacementsLosingTime", () => {
  it("flags the reported case: 2 hours live, re-shared for 15 minutes", () => {
    const rows = shareReplacementsLosingTime({
      recipientUserIds: ["user_b"],
      activeOwnerGrants: [grant()],
      durationValue: "0.25",
      nowMs: NOW,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientUserId).toBe("user_b");
    expect(rows[0]?.untilStopped).toBe(false);
    expect(rows[0]?.grant.id).toBe("grant_ordinary");
  });

  it("stays silent when the new share runs longer", () => {
    // Extending is the ordinary re-share and costs nothing. A warning here
    // would fire on almost every share and stop being read.
    expect(
      shareReplacementsLosingTime({
        recipientUserIds: ["user_b"],
        activeOwnerGrants: [
          grant({ durationHours: 0.25, expiresAt: hoursFromNow(0.25) }),
        ],
        durationValue: "2",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("stays silent when the picker was not really moved", () => {
    // A 1-hour share running for a minute reads as "59 more min", and the
    // ladder still says 1 hour. Re-sharing on that untouched value is not a
    // decision to give a minute back.
    expect(
      shareReplacementsLosingTime({
        recipientUserIds: ["user_b"],
        activeOwnerGrants: [
          grant({ durationHours: 1, expiresAt: hoursFromNow(59 / 60) }),
        ],
        durationValue: "1",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("treats an until-stopped share as the worst case", () => {
    // Nothing about a duration is being shortened here -- an end time is being
    // imposed on a share that had none. It is the biggest loss this screen can
    // cause and the one with no remaining figure to quote.
    const rows = shareReplacementsLosingTime({
      recipientUserIds: ["user_b"],
      activeOwnerGrants: [
        grant({
          durationMode: "until_stopped",
          durationHours: null,
          expiresAt: null,
        }),
      ],
      durationValue: "0.25",
      nowMs: NOW,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.untilStopped).toBe(true);
  });

  it("says nothing when the new share is itself open-ended", () => {
    // Replacing either kind of share with one that runs until you stop it
    // takes no time away from anybody.
    for (const live of [
      grant(),
      grant({ durationMode: "until_stopped", durationHours: null, expiresAt: null }),
    ]) {
      expect(
        shareReplacementsLosingTime({
          recipientUserIds: ["user_b"],
          activeOwnerGrants: [live],
          durationValue: "until_stopped",
          nowMs: NOW,
        }),
      ).toEqual([]);
    }
  });

  it("ignores a Save My Soul share, which a plain share never replaces", () => {
    // Replacement is lane-scoped on the backend (`_share_lane_match_sql`): a
    // `shareKind: "share"` post supersedes only the ordinary lane. Warning
    // about SOS time this tap would not touch is a false alarm on the one
    // screen that must not cry wolf.
    expect(
      shareReplacementsLosingTime({
        recipientUserIds: ["user_b"],
        activeOwnerGrants: [
          grant({
            id: "grant_sos",
            shareKind: "sos",
            durationHours: 8,
            expiresAt: hoursFromNow(8),
          }),
        ],
        durationValue: "0.25",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("compares the ordinary share when a person holds both", () => {
    // The picker row's own `ordinaryGrant ?? primaryGrant` fallback would quote
    // the eight-hour SOS grant here. The number this warning reports has to be
    // the one the tap actually resets.
    const rows = shareReplacementsLosingTime({
      recipientUserIds: ["user_b"],
      activeOwnerGrants: [
        grant({
          id: "grant_sos",
          shareKind: "sos",
          durationHours: 8,
          expiresAt: hoursFromNow(8),
        }),
        grant(),
      ],
      durationValue: "0.25",
      nowMs: NOW,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.grant.id).toBe("grant_ordinary");
  });

  it("names only the people who lose time, in the order they were picked", () => {
    // Sharing with five at once is one tap; only the two with a longer live
    // share are giving anything up, and the other three must not be dragged
    // into a warning that is not about them.
    const rows = shareReplacementsLosingTime({
      recipientUserIds: ["user_a", "user_b", "user_c", "user_d", "user_e"],
      activeOwnerGrants: [
        // Longer than the 30 minutes being picked -- loses time.
        grant({ id: "g_d", recipientUserId: "user_d", expiresAt: hoursFromNow(4) }),
        // Shorter -- gains time, so silent.
        grant({
          id: "g_c",
          recipientUserId: "user_c",
          durationHours: 0.25,
          expiresAt: hoursFromNow(0.25),
        }),
        grant({ id: "g_b", recipientUserId: "user_b", expiresAt: hoursFromNow(2) }),
      ],
      durationValue: "0.5",
      nowMs: NOW,
    });

    expect(rows.map((row) => row.recipientUserId)).toEqual([
      "user_b",
      "user_d",
    ]);
  });

  it("skips a selected person who has no live share at all", () => {
    expect(
      shareReplacementsLosingTime({
        recipientUserIds: ["user_z"],
        activeOwnerGrants: [grant()],
        durationValue: "0.25",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("skips a grant that has already run out", () => {
    // Nothing is being taken from a share that is over, and the state snapshot
    // this reads can be up to a minute stale.
    expect(
      shareReplacementsLosingTime({
        recipientUserIds: ["user_b"],
        activeOwnerGrants: [grant({ expiresAt: hoursFromNow(-1) })],
        durationValue: "0.25",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("skips a timed grant with no readable expiry", () => {
    // There is no honest amount to put in the warning, and an alert that
    // cannot say what is being lost is worse than none. The server stays the
    // authority on that grant.
    expect(
      shareReplacementsLosingTime({
        recipientUserIds: ["user_b"],
        activeOwnerGrants: [grant({ expiresAt: null })],
        durationValue: "0.25",
        nowMs: NOW,
      }),
    ).toEqual([]);
  });
});
