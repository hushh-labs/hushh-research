import { beforeEach, describe, expect, it } from "vitest";

import {
  clearLiveShareEntries,
  liveShareEntriesEqual,
  loadLiveShareEntries,
  pruneLiveShareEntries,
  reconcileLiveShareEntries,
  resolveStoppableGrantId,
  saveLiveShareEntries,
  summarizeLiveShareEntries,
  type LiveShareSessionEntry,
} from "@/lib/one-location/live-share-session";
import type { OneLocationGrant } from "@/lib/one-location/types";

const NOW = Date.parse("2026-08-16T10:00:00.000Z");

function grant(overrides: Partial<OneLocationGrant> = {}): OneLocationGrant {
  return {
    id: "grant_1",
    ownerUserId: "user_a",
    recipientUserId: "user_b",
    recipientKeyId: "key_b",
    status: "active",
    consentScope: "cap.location.live.view",
    capabilityScopes: ["cap.location.live.view"],
    durationHours: 1,
    createdAt: "2026-08-16T09:30:00.000Z",
    expiresAt: "2026-08-16T10:30:00.000Z",
    ...overrides,
  };
}

describe("live share session record", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("survives the round trip so a returning visit paints before the network", () => {
    const entries: LiveShareSessionEntry[] = [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ];
    saveLiveShareEntries("user_a", entries);

    expect(loadLiveShareEntries("user_a", NOW)).toEqual(entries);
  });

  it("keys the record per owner so another account's share is never yours", () => {
    saveLiveShareEntries("user_a", [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);

    expect(loadLiveShareEntries("user_b", NOW)).toEqual([]);
  });

  it("never persists anything beyond ids and timestamps", () => {
    saveLiveShareEntries("user_a", [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);

    const raw = window.localStorage.getItem("one_location_live_share_v1:user_a");
    expect(raw).toBeTruthy();
    // Deliberately still an EXACT key set, not a subset check. The point of
    // this assertion is what is ABSENT: no names, no phone numbers, no
    // coordinates, no capability token. `recipientUserId` joins the list
    // because a headcount needs the head -- one person holding two grants is
    // one person -- and it is an opaque id the device already holds, which is
    // the same standard `grantId` meets.
    expect(Object.keys(JSON.parse(raw ?? "[]")[0]).sort()).toEqual([
      "expiresAt",
      "grantId",
      "recipientUserId",
      "shareKind",
      "startedAt",
    ]);
  });

  it("drops a share that already ended instead of claiming you are still visible", () => {
    saveLiveShareEntries("user_a", [
      {
        grantId: "expired",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T08:00:00.000Z",
        expiresAt: "2026-08-16T09:00:00.000Z",
      },
      {
        grantId: "running",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);

    expect(loadLiveShareEntries("user_a", NOW).map((e) => e.grantId)).toEqual([
      "running",
    ]);
  });

  it("stops trusting an open-ended record after a day", () => {
    const stale: LiveShareSessionEntry[] = [
      {
        grantId: "open",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-14T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    const fresh: LiveShareSessionEntry[] = [
      {
        grantId: "open",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T08:00:00.000Z",
        expiresAt: null,
      },
    ];

    expect(pruneLiveShareEntries(stale, NOW)).toEqual([]);
    expect(pruneLiveShareEntries(fresh, NOW)).toEqual(fresh);
  });

  it("survives a corrupt or half-written record", () => {
    window.localStorage.setItem(
      "one_location_live_share_v1:user_a",
      '[{"grantId":"ok","startedAt":"2026-08-16T09:30:00.000Z","expiresAt":"2026-08-16T10:30:00.000Z"},{"grantId":"","startedAt":"nope"},"garbage"]',
    );

    expect(loadLiveShareEntries("user_a", NOW).map((e) => e.grantId)).toEqual([
      "ok",
    ]);

    window.localStorage.setItem("one_location_live_share_v1:user_a", "{{{");
    expect(loadLiveShareEntries("user_a", NOW)).toEqual([]);
  });

  it("clears the record when the last share stops", () => {
    saveLiveShareEntries("user_a", [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);
    saveLiveShareEntries("user_a", []);
    expect(window.localStorage.getItem("one_location_live_share_v1:user_a")).toBeNull();

    saveLiveShareEntries("user_a", [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);
    clearLiveShareEntries("user_a");
    expect(window.localStorage.getItem("one_location_live_share_v1:user_a")).toBeNull();
  });
});

describe("reconciling against the server", () => {
  it("remembers when a share started across refreshes", () => {
    const previous: LiveShareSessionEntry[] = [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ];

    // A later payload without `createdAt` must not restart the progress bar.
    const next = reconcileLiveShareEntries(
      previous,
      [grant({ createdAt: null })],
      NOW,
    );

    expect(next).toEqual(previous);
  });

  it("adopts the grant's own start when the device has no memory of it", () => {
    const next = reconcileLiveShareEntries([], [grant()], NOW);
    expect(next[0]?.startedAt).toBe("2026-08-16T09:30:00.000Z");
  });

  it("never keeps a share the backend no longer reports as active", () => {
    const previous: LiveShareSessionEntry[] = [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ];

    expect(reconcileLiveShareEntries(previous, [], NOW)).toEqual([]);
    expect(
      reconcileLiveShareEntries(previous, [grant({ status: "revoked" })], NOW),
    ).toEqual([]);
  });

  it("skips a timed grant whose expiry is missing or already past", () => {
    expect(
      reconcileLiveShareEntries([], [grant({ expiresAt: null })], NOW),
    ).toEqual([]);
    expect(
      reconcileLiveShareEntries(
        [],
        [grant({ expiresAt: "2026-08-16T09:00:00.000Z" })],
        NOW,
      ),
    ).toEqual([]);
  });

  it("carries an until-you-stop share with no expiry", () => {
    const next = reconcileLiveShareEntries(
      [],
      [grant({ durationMode: "until_stopped", expiresAt: null })],
      NOW,
    );
    expect(next).toEqual([
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: null,
      },
    ]);
  });

  it("orders by soonest expiry, with open-ended shares last", () => {
    const next = reconcileLiveShareEntries(
      [],
      [
        grant({ id: "late", expiresAt: "2026-08-16T12:00:00.000Z" }),
        grant({ id: "open", durationMode: "until_stopped", expiresAt: null }),
        grant({ id: "soon", expiresAt: "2026-08-16T10:10:00.000Z" }),
      ],
      NOW,
    );

    expect(next.map((entry) => entry.grantId)).toEqual(["soon", "late", "open"]);
  });
});

describe("summarising the live window", () => {
  it("reports nothing when nothing is live", () => {
    expect(summarizeLiveShareEntries([])).toBeNull();
  });

  it("ends at the LAST expiry, because an earlier one does not hide you", () => {
    const summary = summarizeLiveShareEntries([
      {
        grantId: "soon",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:45:00.000Z",
        expiresAt: "2026-08-16T10:10:00.000Z",
      },
      {
        grantId: "late",
        // A DIFFERENT person, so the count is genuinely two. The
        // same-person case is the test below.
        recipientUserId: "user_c",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T12:00:00.000Z",
      },
    ]);

    expect(summary).toEqual({
      count: 2,
      startedAt: "2026-08-16T09:30:00.000Z",
      endsAt: "2026-08-16T12:00:00.000Z",
    });
  });

  it("counts one person twice-shared-with once, but keeps their LATER expiry", () => {
    // The two halves of this file's rule, in one case. Count is per PERSON:
    // an ordinary share and an SOS share to the same friend is one friend, and
    // "2 people" would be a plain lie about who can see you. Time is per
    // EXPOSURE: `endsAt` means "when you stop being visible to everyone", so
    // it folds over EVERY entry. Deduping before that fold would render this
    // as "ends at 10:10" while the owner stays visible until 18:00 --
    // under-claiming your own exposure, the one direction a privacy status
    // must never round.
    const summary = summarizeLiveShareEntries([
      {
        grantId: "ordinary",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:45:00.000Z",
        expiresAt: "2026-08-16T10:10:00.000Z",
      },
      {
        grantId: "sos",
        recipientUserId: "user_b",
        shareKind: "sos",
        startedAt: "2026-08-16T10:00:00.000Z",
        expiresAt: "2026-08-16T18:00:00.000Z",
      },
    ]);

    expect(summary).toEqual({
      count: 1,
      startedAt: "2026-08-16T09:45:00.000Z",
      endsAt: "2026-08-16T18:00:00.000Z",
    });
  });

  it("still counts two different people as two", () => {
    const summary = summarizeLiveShareEntries([
      {
        grantId: "to_b",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:45:00.000Z",
        expiresAt: "2026-08-16T10:10:00.000Z",
      },
      {
        grantId: "to_c",
        recipientUserId: "user_c",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T12:00:00.000Z",
      },
    ]);

    expect(summary?.count).toBe(2);
  });

  it("has no end at all when any share runs until you stop it", () => {
    const summary = summarizeLiveShareEntries([
      {
        grantId: "timed",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
      {
        grantId: "open",
        recipientUserId: "user_c",
        shareKind: "share",
        startedAt: "2026-08-16T09:40:00.000Z",
        expiresAt: null,
      },
    ]);

    expect(summary?.endsAt).toBeNull();
    expect(summary?.count).toBe(2);
  });
});

describe("liveShareEntriesEqual", () => {
  it("only reports equal when every field of every entry matches", () => {
    const a: LiveShareSessionEntry[] = [
      {
        grantId: "grant_1",
        recipientUserId: "user_b",
        shareKind: "share",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ];

    expect(liveShareEntriesEqual(a, [{ ...a[0]! }])).toBe(true);
    expect(liveShareEntriesEqual(a, [])).toBe(false);
    expect(
      liveShareEntriesEqual(a, [
        { ...a[0]!, expiresAt: "2026-08-16T11:30:00.000Z" },
      ]),
    ).toBe(false);
  });
});

describe("resolveStoppableGrantId", () => {
  function entry(
    overrides: Partial<LiveShareSessionEntry>,
  ): LiveShareSessionEntry {
    return {
      grantId: "grant_1",
      recipientUserId: "user_b",
      shareKind: "share",
      startedAt: "2026-08-16T09:30:00.000Z",
      expiresAt: "2026-08-16T10:30:00.000Z",
      ...overrides,
    };
  }

  it("offers Stop for one person's single share", () => {
    expect(resolveStoppableGrantId([entry({ grantId: "only" })])).toBe("only");
  });

  it("offers Manage when one person holds BOTH share lanes", () => {
    // One person can hold an ordinary share and Save My Soul at once. The hero
    // card cannot honestly bind one Stop tap to either lane, so it offers
    // Manage and the lane list carries one Stop per grant.
    expect(
      resolveStoppableGrantId([
        entry({ grantId: "sos", shareKind: "sos", expiresAt: null }),
        entry({ grantId: "ordinary" }),
      ]),
    ).toBeNull();
  });

  it("resolves to the SOS share when it is the only thing running", () => {
    expect(
      resolveStoppableGrantId([entry({ grantId: "sos", shareKind: "sos" })]),
    ).toBe("sos");
  });

  it("offers no single Stop for two different people", () => {
    expect(
      resolveStoppableGrantId([
        entry({ grantId: "to_b", recipientUserId: "user_b" }),
        entry({ grantId: "to_c", recipientUserId: "user_c" }),
      ]),
    ).toBeNull();
  });

  it("offers nothing when nothing is live", () => {
    expect(resolveStoppableGrantId([])).toBeNull();
  });
});
