import { beforeEach, describe, expect, it } from "vitest";

import {
  clearLiveShareEntries,
  liveShareEntriesEqual,
  loadLiveShareEntries,
  pruneLiveShareEntries,
  reconcileLiveShareEntries,
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
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);

    const raw = window.localStorage.getItem("one_location_live_share_v1:user_a");
    expect(raw).toBeTruthy();
    expect(Object.keys(JSON.parse(raw ?? "[]")[0]).sort()).toEqual([
      "expiresAt",
      "grantId",
      "startedAt",
    ]);
  });

  it("drops a share that already ended instead of claiming you are still visible", () => {
    saveLiveShareEntries("user_a", [
      {
        grantId: "expired",
        startedAt: "2026-08-16T08:00:00.000Z",
        expiresAt: "2026-08-16T09:00:00.000Z",
      },
      {
        grantId: "running",
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
        startedAt: "2026-08-14T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    const fresh: LiveShareSessionEntry[] = [
      { grantId: "open", startedAt: "2026-08-16T08:00:00.000Z", expiresAt: null },
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
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
    ]);
    saveLiveShareEntries("user_a", []);
    expect(window.localStorage.getItem("one_location_live_share_v1:user_a")).toBeNull();

    saveLiveShareEntries("user_a", [
      {
        grantId: "grant_1",
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
        startedAt: "2026-08-16T09:45:00.000Z",
        expiresAt: "2026-08-16T10:10:00.000Z",
      },
      {
        grantId: "late",
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

  it("has no end at all when any share runs until you stop it", () => {
    const summary = summarizeLiveShareEntries([
      {
        grantId: "timed",
        startedAt: "2026-08-16T09:30:00.000Z",
        expiresAt: "2026-08-16T10:30:00.000Z",
      },
      {
        grantId: "open",
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
