import { describe, expect, it, vi } from "vitest";

import { groupActiveConsentEntries, groupPendingConsentRequests } from "@/lib/consent/owner-consent-request";
import { collapseConsentBundleRows } from "@/lib/feed/feed-consent-grouping";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { ownerConsentRequestActionable } from "@/lib/feed/use-feed-actionables";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * One request is one Feed item.
 *
 * Measured on UAT 2026-09-28: a three-item ask from Kushal rendered in the
 * owner's Feed as "Someone requested Preferences." -- no name, no reason, a
 * label that disagreed with the access it became, and one row per item. The
 * contract (C5) is one item per request, reading "<Name> wants your <labels> ·
 * <reason>", with Allow and Don't allow inline.
 *
 * Negative control (run by hand, 2026-09-28): making
 * `groupPendingConsentRequests` key every entry by its own request id instead
 * of its bundle fails "folds per-item rows" and "one row per request" below.
 */

const ISSUED_AT = "1790000000000"; // the wire's numeric string, epoch ms

function pending(
  scope: string,
  index: number,
  overrides: Partial<ConsentCenterEntry> = {},
): ConsentCenterEntry {
  return {
    id: `req-${index}`,
    request_id: `req-${index}`,
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    scope,
    scope_description: "Preferences",
    counterpart_type: "person",
    counterpart_id: "user-kushal",
    counterpart_label: "Kushal Trivedi",
    reason: "Picking a place for our dinner together",
    issued_at: ISSUED_AT,
    approval_timeout_at: 1790604800000,
    metadata: { bundle_id: "bundle-dinner", expiry_hours: 168 },
    ...overrides,
  };
}

const THREE_ITEMS = [
  pending("attr.food.preferences.*", 1),
  pending("attr.food.dietary_restrictions.*", 2),
  pending("attr.travel.preferences.*", 3),
];

describe("owner consent request grouping", () => {
  it("folds per-item rows that share a bundle into one request", () => {
    const requests = groupPendingConsentRequests(THREE_ITEMS);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.key).toBe("bundle:bundle-dinner");
    expect(request!.members.map((member) => member.request_id)).toEqual([
      "req-1",
      "req-2",
      "req-3",
    ]);
    // Named from each item's key, never the shared stored "Preferences".
    expect(request!.labels).toEqual([
      "Food preferences",
      "Food dietary restrictions",
      "Travel preferences",
    ]);
    expect(request!.headline).toBe("Kushal wants your Food preferences and 2 more");
    expect(request!.requestedAt).toBe(1790000000000);
    expect(request!.durationHours).toBe(168);
    expect(request!.complete).toBe(true);
  });

  it("keeps separate asks separate", () => {
    const requests = groupPendingConsentRequests([
      pending("attr.food.preferences.*", 1, { metadata: {} }),
      pending("attr.travel.preferences.*", 2, { metadata: {} }),
    ]);
    expect(requests.map((request) => request.key)).toEqual([
      "request:req-1",
      "request:req-2",
    ]);
  });

  it("decides nothing inline while a server bundle is still arriving", () => {
    const [request] = groupPendingConsentRequests([
      {
        ...pending("", 0),
        id: "bundle:bundle-dinner",
        scope: null,
        request_id: null,
        bundle_id: "bundle-dinner",
        bundle_complete: false,
        bundle_items: [
          { request_id: "req-1", label: "Food preferences", status: "pending", entry: null },
        ],
      },
    ]);
    const row = ownerConsentRequestActionable(request!, {
      allow: vi.fn(),
      deny: vi.fn(),
      openDetails: vi.fn(),
      onDecided: vi.fn(),
      sortAt: 0,
    });
    expect(request!.complete).toBe(false);
    expect(row.actions.map((action) => action.key)).toEqual(["details"]);
  });

  it("leaves requests with their own ceremony out of the inline queue", () => {
    const requests = groupPendingConsentRequests([
      pending("attr.location.live", 1, {
        metadata: { request_source: "one_location_access_request" },
      }),
      pending("attr.food.preferences.*", 2, {
        metadata: { request_source: "one_email_kyc_v1" },
      }),
    ]);
    expect(requests).toEqual([]);
  });
});

describe("the Feed row for one request", () => {
  it("reads as one sentence with the reason, and offers Details, Don't allow and Allow", async () => {
    const [request] = groupPendingConsentRequests([THREE_ITEMS[0]!]);
    const allow = vi.fn(async () => true);
    const deny = vi.fn(async () => false);
    const onDecided = vi.fn();
    const openDetails = vi.fn();
    const row = ownerConsentRequestActionable(request!, {
      allow,
      deny,
      openDetails,
      onDecided,
      sortAt: 1,
    });

    expect(row.title).toBe("Kushal wants your Food preferences");
    expect(row.description).toBe("Picking a place for our dinner together");
    expect(row.title).not.toMatch(/Someone|requested|Preferences\./);
    expect(row.displayTimestamp).toBe(1790000000000);
    expect(row.actions.map((action) => [action.key, action.label])).toEqual([
      ["details", "Details"],
      ["deny", "Don't allow"],
      ["allow", "Allow"],
    ]);
    // Don't allow is one tap: its Undo toast (not an armed second tap) is
    // what keeps a stray tap from declining.
    expect(row.actions.find((action) => action.key === "deny")?.confirm).toBeFalsy();

    await row.actions.find((action) => action.key === "allow")!.run();
    expect(allow).toHaveBeenCalledWith(request);
    expect(onDecided).toHaveBeenCalledWith("bundle:bundle-dinner");

    // A decision that did not happen (the unlock was cancelled) leaves the
    // row where it is.
    onDecided.mockClear();
    await row.actions.find((action) => action.key === "deny")!.run();
    expect(deny).toHaveBeenCalledWith(request);
    expect(onDecided).not.toHaveBeenCalled();

    row.actions.find((action) => action.key === "details")!.run();
    expect(openDetails).toHaveBeenCalledTimes(1);
  });
});

describe("consent history rows", () => {
  function historyRow(id: string, scope: string, read = false): FeedItem {
    return {
      id,
      source_domain: "consent",
      event_type: "consent_requested",
      actor_label: null,
      metadata: {
        scope,
        scope_description: "Preferences",
        bundle_id: "bundle-dinner",
        requester_label: "Kushal Trivedi",
        reason: "Picking a place for our dinner together",
      },
      read,
      created_at: "2026-09-28T20:51:00.000Z",
    };
  }

  it("shows one row per request, named and with its reason", () => {
    const rows = collapseConsentBundleRows([
      historyRow("30", "attr.food.preferences.*"),
      historyRow("29", "attr.food.dietary_restrictions.*", true),
      historyRow("28", "attr.travel.preferences.*", true),
      {
        ...historyRow("27", "attr.food.preferences.*"),
        event_type: "consent_revoked",
        metadata: { scope: "attr.food.preferences.*" },
      },
    ]);

    expect(rows.map((row) => row.id)).toEqual(["30", "27"]);
    expect(rows[0]!.read).toBe(false);
    const requested = presentFeedItem(rows[0]!);
    expect(requested.label).toBe("Kushal Trivedi");
    expect(requested.description).toBe(
      "Asked for your Food preferences and 2 more · picking a place for our dinner together",
    );
    expect(requested.description).not.toContain("Someone");
    // Same words as the Needs you row and the Active row.
    expect(presentFeedItem(rows[1]!).description).toBe(
      "You stopped sharing your Food preferences",
    );
  });

  // Localhost run 2026-09-28 (screenshot 25): "Someone asked for your Food
  // preferences" although the row carried the requester as its actor.
  it("names the requester from the row's actor when the metadata has no name", () => {
    const named = presentFeedItem({ ...historyRow("41", "attr.food.preferences.*"),
      actor_label: "Kushal Trivedi", metadata: { scope: "attr.food.preferences.*" } });
    expect(named.label).toBe("Kushal Trivedi");
    expect(named.description).toBe("Asked for your Food preferences");
  });

  it("negative control: says Someone only when the row carries no name at all", () => {
    const anonymous = presentFeedItem({ ...historyRow("42", "attr.food.preferences.*"),
      actor_label: null, metadata: { scope: "attr.food.preferences.*" } });
    expect(anonymous.label).toBe("Information request");
    expect(anonymous.description).toBe("Someone asked for your Food preferences");
  });

  it("leaves a row that stands alone untouched, so the memoised row keeps its identity", () => {
    const alone = historyRow("40", "attr.food.preferences.*");
    const [row] = collapseConsentBundleRows([alone]);
    expect(row).toBe(alone);
  });
});

describe("Active: one row per request", () => {
  const grant = (id: string, scope: string, label: string, overrides: Partial<ConsentCenterEntry> = {}): ConsentCenterEntry => ({
    id, request_id: `req-${id}`, kind: "active_grant", status: "active", action: "CONSENT_GRANTED",
    scope, scope_description: label, counterpart_type: "person", counterpart_id: "user-kushal",
    counterpart_label: "Kushal Trivedi", issued_at: "2026-09-28T23:20:00.000Z",
    metadata: { request_source: "one_person_profile" }, ...overrides,
  });

  it("groups on bundle_id and names the row with the server's bundle_label", () => {
    const rows = groupActiveConsentEntries([
      grant("a", "attr.food.preferences.kind", "Food preferences", { bundle_id: "b1", bundle_label: "Food preferences and Dietary constraints" }),
      grant("b", "attr.health.dietary.observations", "Dietary constraints", { bundle_id: "b1", bundle_label: "Food preferences and Dietary constraints" }),
      grant("c", "attr.travel.*", "Travel", { counterpart_id: "user-sam", bundle_id: "b2" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "request", bundleId: "b1", label: "Food preferences and Dietary constraints" });
    expect(rows[0]!.kind === "request" && rows[0]!.members.map((member) => member.id)).toEqual(["a", "b"]);
    expect(rows[1]).toMatchObject({ kind: "single" });
  });

  it("without a bundle id, groups one person's grants written together, and says how many more", () => {
    const rows = groupActiveConsentEntries([
      grant("a", "attr.food.*", "Food preferences", { metadata: {} }),
      grant("b", "attr.health.*", "Dietary constraints", { metadata: {}, issued_at: "2026-09-28T23:20:40.000Z" }),
      // A day later: another request.
      grant("c", "attr.travel.*", "Travel", { metadata: {}, issued_at: "2026-09-29T23:20:00.000Z" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["request", "single"]);
    // Key-derived without the server's person-request label: the older wording, counted.
    expect(rows[0]).toMatchObject({ label: "Food data and 1 more" });
  });

  it("negative control: other people's grants and non-person access never merge", () => {
    const rows = groupActiveConsentEntries([
      grant("a", "attr.food.*", "Food", { metadata: {} }),
      grant("b", "attr.food.*", "Food", { metadata: {}, counterpart_id: "user-sam" }),
      grant("c", "attr.food.*", "Food", { metadata: {}, counterpart_type: "developer" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["single", "single", "single"]);
  });
});
