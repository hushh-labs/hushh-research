import { describe, expect, it } from "vitest";

import {
  RECENT_SECTION_LIMIT,
  flattenRecipientSections,
  lastInteractionByUserId,
  sectionRecipients,
} from "@/lib/one-location/recipient-sections";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";

function person(userId: string, displayName: string) {
  return { userId, displayName } as OneLocationRecipient;
}

const label = (recipient: OneLocationRecipient) =>
  recipient.displayName ?? recipient.userId;

function request(
  ownerUserId: string,
  requestedAt: string | null,
  resolvedAt: string | null = null,
) {
  return { ownerUserId, requestedAt, resolvedAt } as OneLocationAccessRequest;
}

function grant(
  fields: Partial<OneLocationGrant> & { createdAt: string | null },
) {
  return fields as OneLocationGrant;
}

describe("lastInteractionByUserId", () => {
  it("reads recency from all three things this screen already knows", () => {
    const byUserId = lastInteractionByUserId({
      requestedByMe: [request("asked", "2026-08-01T00:00:00Z")],
      receivedGrants: [
        grant({ ownerUserId: "gave-me", createdAt: "2026-08-02T00:00:00Z" }),
      ],
      ownerGrants: [
        grant({ recipientUserId: "i-gave", createdAt: "2026-08-03T00:00:00Z" }),
      ],
    });

    expect(byUserId.get("asked")).toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(byUserId.get("gave-me")).toBe(Date.parse("2026-08-02T00:00:00Z"));
    expect(byUserId.get("i-gave")).toBe(Date.parse("2026-08-03T00:00:00Z"));
  });

  it("keeps the NEWEST touch when one person appears more than once", () => {
    // Somebody you asked in June and who shared with you in August is a person
    // you dealt with in August. Taking the first one found would bury them.
    const byUserId = lastInteractionByUserId({
      requestedByMe: [request("u1", "2026-06-01T00:00:00Z")],
      receivedGrants: [
        grant({ ownerUserId: "u1", createdAt: "2026-08-01T00:00:00Z" }),
      ],
      ownerGrants: [],
    });

    expect(byUserId.get("u1")).toBe(Date.parse("2026-08-01T00:00:00Z"));
  });

  it("falls back to when a request was answered if it never recorded a send", () => {
    const byUserId = lastInteractionByUserId({
      requestedByMe: [request("u1", null, "2026-08-05T00:00:00Z")],
      receivedGrants: [],
      ownerGrants: [],
    });

    expect(byUserId.get("u1")).toBe(Date.parse("2026-08-05T00:00:00Z"));
  });

  it("ignores a timestamp it cannot read rather than sorting on NaN", () => {
    const byUserId = lastInteractionByUserId({
      requestedByMe: [request("u1", "not-a-date")],
      receivedGrants: [],
      ownerGrants: [],
    });

    expect(byUserId.has("u1")).toBe(false);
  });
});

describe("sectionRecipients", () => {
  const roster = [
    person("u1", "Zoya Khan"),
    person("u2", "Aarav Mehta"),
    person("u3", "Divya Rajendran"),
  ];

  it("returns one unlabelled run while a query is active", () => {
    // A search result is ordered by how well each person matches. An alphabet
    // laid over that would describe an arrangement the list does not have, so
    // the caller's order passes straight through and nothing is titled.
    const sections = sectionRecipients({
      recipients: roster,
      lastInteraction: new Map([["u3", 10]]),
      label,
      querying: true,
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeUndefined();
    expect(sections[0].recipients.map((r) => r.userId)).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
  });

  it("puts people you have dealt with first, newest first, and the rest A-Z", () => {
    const sections = sectionRecipients({
      recipients: roster,
      lastInteraction: new Map([
        ["u1", 100],
        ["u3", 200],
      ]),
      label,
      querying: false,
    });

    expect(sections.map((s) => s.title)).toEqual(["Recent", "All"]);
    expect(sections[0].recipients.map((r) => r.displayName)).toEqual([
      "Divya Rajendran",
      "Zoya Khan",
    ]);
    expect(sections[1].recipients.map((r) => r.displayName)).toEqual([
      "Aarav Mehta",
    ]);
  });

  it("never lists the same person twice", () => {
    // In a list you READ a duplicate is a convenience. In a list you SELECT
    // from it is two rows that must agree about one selection, and the moment
    // they disagree the screen is lying about what is chosen.
    const sections = sectionRecipients({
      recipients: roster,
      lastInteraction: new Map([["u3", 1]]),
      label,
      querying: false,
    });

    const ids = sections.flatMap((s) => s.recipients.map((r) => r.userId));
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids).toHaveLength(roster.length);
  });

  it("caps Recent, so the alphabet never loses more than a handful", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      person(`u${i}`, `Person ${i}`),
    );
    const interactions = new Map(many.map((p, i) => [p.userId, i]));

    const sections = sectionRecipients({
      recipients: many,
      lastInteraction: interactions,
      label,
      querying: false,
    });

    expect(sections[0].recipients).toHaveLength(RECENT_SECTION_LIMIT);
    expect(sections[1].recipients).toHaveLength(12 - RECENT_SECTION_LIMIT);
  });

  it("leaves a roster nobody has been dealt with unlabelled", () => {
    // One run with nothing above it is just the roster. A lone "All" heading
    // names a distinction that is not being drawn.
    const sections = sectionRecipients({
      recipients: roster,
      lastInteraction: new Map(),
      label,
      querying: false,
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeUndefined();
    expect(sections[0].recipients.map((r) => r.displayName)).toEqual([
      "Aarav Mehta",
      "Divya Rajendran",
      "Zoya Khan",
    ]);
  });

  it("sorts an accented name where a person looks for it", () => {
    const sections = sectionRecipients({
      recipients: [person("u1", "Zoya"), person("u2", "Émile")],
      lastInteraction: new Map(),
      label,
      querying: false,
    });

    expect(sections[0].recipients.map((r) => r.displayName)).toEqual([
      "Émile",
      "Zoya",
    ]);
  });

  it("returns nothing for an empty roster", () => {
    expect(
      sectionRecipients({
        recipients: [],
        lastInteraction: new Map(),
        label,
        querying: false,
      }),
    ).toEqual([]);
  });
});

describe("flattenRecipientSections", () => {
  it("interleaves headers and people into one windowable list", () => {
    // One flat array, so the virtualizer measures headers and rows through the
    // same window instead of a scroller per section.
    const rows = flattenRecipientSections([
      { key: "recent", title: "Recent", recipients: [person("u1", "A")] },
      { key: "all", title: "All", recipients: [person("u2", "B")] },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "header",
      "recipient",
      "header",
      "recipient",
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      "header:recent",
      "u1",
      "header:all",
      "u2",
    ]);
  });

  it("emits no header for an untitled run", () => {
    const rows = flattenRecipientSections([
      { key: "results", recipients: [person("u1", "A")] },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("recipient");
  });
});
