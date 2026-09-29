import { describe, expect, it } from "vitest";

import {
  consentEntryInformationLabel,
  consentInformationLabel,
  countItems,
  formatConsentDuration,
  formatDecideBy,
  formatRequestedAt,
  parseConsentInstant,
} from "@/lib/consent/consent-owner-copy";
import {
  mergeConsentSharePreviews,
  requestedItemPreview,
  summarizeConsentExportPayload,
} from "@/lib/consent/consent-share-preview";

/**
 * The decision sheet's P2 list, measured on UAT 2026-09-28: "Requested:
 * Unavailable", "Preferences" vs "Food Preferences", "1 items", "1 week" vs
 * "7 days", and "Decision due 10/5/2026, 1:51:08 PM". Each is pinned here at
 * the helper every owner surface now shares.
 */

// Sun Sep 28 2026, 1:51 PM local time.
const NOW = new Date(2026, 8, 28, 13, 51).getTime();

describe("owner consent copy", () => {
  it("reads the numeric epoch strings the pending list sends", () => {
    // `new Date("1790000000000")` is Invalid Date: the root of "Unavailable".
    expect(Number.isNaN(new Date("1790000000000").getTime())).toBe(true);
    expect(parseConsentInstant("1790000000000")).toBe(1790000000000);
    expect(parseConsentInstant(1790000000)).toBe(1790000000000);
    expect(parseConsentInstant("2026-09-28T20:51:00.000Z")).toBe(
      Date.parse("2026-09-28T20:51:00.000Z"),
    );
    expect(parseConsentInstant("")).toBeNull();
    expect(parseConsentInstant("not a time")).toBeNull();
    expect(formatRequestedAt(String(NOW), NOW)).toMatch(/^Today, 1:51\sPM$/);
  });

  it("says when to decide in words", () => {
    expect(formatDecideBy(new Date(2026, 9, 5, 13, 51).getTime(), NOW)).toBe("Oct 5");
    expect(formatDecideBy(new Date(2026, 8, 28, 18, 0).getTime(), NOW)).toMatch(
      /^Today, 6:00\sPM$/,
    );
  });

  it("words a duration one way, the way the requester chose it", () => {
    expect(formatConsentDuration(168)).toBe("7 days");
    expect(formatConsentDuration("24")).toBe("1 day");
    expect(formatConsentDuration(48)).toBe("2 days");
    expect(formatConsentDuration(4)).toBe("4 hours");
    expect(formatConsentDuration(1)).toBe("1 hour");
    expect(formatConsentDuration(0.5)).toBe("30 min");
    expect(formatConsentDuration(0)).toBeNull();
  });

  it("counts in the singular when there is one", () => {
    expect(countItems(1)).toBe("1 item");
    expect(countItems(3)).toBe("3 items");
  });

  it("gives a request and the access it becomes the same name", () => {
    const request = consentInformationLabel({
      scope: "attr.food.preferences.*",
      label: "Preferences",
    });
    const access = consentInformationLabel({ scope: "attr.food.preferences.*" });
    expect(request).toBe("Food preferences");
    expect(access).toBe(request);
    expect(consentInformationLabel({ scope: "pkm.read" })).not.toMatch(/PKM|Knowledge/);
  });
});

describe("share preview summary", () => {
  it("counts what would be shared under human labels, never the values", () => {
    const preview = summarizeConsentExportPayload({
      food: {
        preferences: {
          favorite_cuisines: ["Thai", "Sichuan", ""],
          favorite_restaurants: {
            _entities: { a: { name: "Nopa" }, b: { name: "Zuni" }, c: {} },
          },
          spice_level: "hot",
        },
      },
      __export_metadata: { scope: "attr.food.preferences.*" },
    });

    expect(preview.groups).toEqual([
      { label: "Favorite cuisines", count: 2 },
      { label: "Favorite restaurants", count: 2 },
      { label: "Spice level", count: 1 },
    ]);
    expect(preview.total).toBe(5);
    expect(JSON.stringify(preview)).not.toMatch(/Thai|Nopa|hot/);
  });

  it("merges the items of one request into one count", () => {
    const merged = mergeConsentSharePreviews([
      { total: 2, groups: [{ label: "Favorite cuisines", count: 2 }] },
      { total: 1, groups: [{ label: "Allergies", count: 1 }] },
    ]);
    expect(merged).toEqual({
      total: 3,
      groups: [
        { label: "Favorite cuisines", count: 2 },
        { label: "Allergies", count: 1 },
      ],
    });
  });
});

// Regression (localhost run 2026-09-28): the sheet said "2 items · Preferences"
// for a request for "Food preferences"; Active said "Food preferences kind".
describe("the request's own labels", () => {
  it("heads the preview with the requested label and keeps only new names inside it", () => {
    const summary = summarizeConsentExportPayload({
      memory: { food: { preferences: { entities: { a: { summary: "x" }, b: { summary: "y" } } } } },
    }, "Food preferences");
    expect(summary.groups).toEqual([{ label: "Preferences", count: 2 }]);
    expect(requestedItemPreview("Food preferences", summary)).toEqual({
      total: 2, groups: [{ label: "Food preferences", count: 2 }],
    });
    const named = requestedItemPreview("Food preferences", {
      total: 3, groups: [{ label: "Favorite restaurants", count: 3 }],
    });
    expect(named.groups[0]).toEqual({ label: "Food preferences", count: 3, names: ["Favorite restaurants"] });
  });

  it("names a person request by the server's label, other entries by their key", () => {
    expect(consentEntryInformationLabel({ scope: "attr.food.preferences.kind", scope_description: "Food preferences",
      metadata: { request_source: "one_person_profile" } })).toBe("Food preferences");
    expect(consentEntryInformationLabel({ scope: "attr.food.preferences.kind", scope_description: "Preferences" }))
      .toBe(consentInformationLabel({ scope: "attr.food.preferences.kind" }));
  });
});
