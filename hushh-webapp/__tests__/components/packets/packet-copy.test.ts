import { describe, expect, it } from "vitest";

import { buyerNotes, buyerPacketStatus, dayRangeLabel, ownerPacketStatus } from "@/components/consent/packets/packet-copy";
import type { DrivePacket } from "@/lib/services/drive-packet-service";

// A synthetic listed packet, as a buyer's list receives it.
const packet: DrivePacket = { packetId: "00000001-3333-4333-8333-333333333333", version: 2, listingRevision: 1,
  title: "Example Bank statements", description: "Monthly statements for one synthetic account.", state: "ready",
  coverageSummary: "January to June 2026", gaps: [], documentCount: 3, verifiedAt: null, freshness: "current",
  assessmentScore: 95, importance: 100, suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: true,
  canRequest: true, canList: false };

describe("buyer packet words", () => {
  it("reads a packet's state in one plain line", () => {
    expect(buyerPacketStatus(packet, null, "Avery")).toEqual({ line: "3 documents · January to June 2026", tone: "ready" });
    expect(buyerPacketStatus({ ...packet, documentCount: 1 }, null, "Avery").line).toBe("1 document · January to June 2026");
    // A summary the server is still writing is left out, not shown as jargon.
    expect(buyerPacketStatus({ ...packet, coverageSummary: "Evidence is being prepared." }, null, "Avery").line).toBe("3 documents");
    expect(buyerPacketStatus({ ...packet, canRequest: false }, null, "Avery")).toEqual({ line: "Not available right now", tone: "paused" });
    expect(buyerPacketStatus(packet, { requestId: "r", existingAccess: false }, "Avery"))
      .toEqual({ line: "Requested · Waiting for Avery", tone: "waiting" });
    // Already having the files wins over anything else.
    expect(buyerPacketStatus({ ...packet, canRequest: false }, { requestId: "r", existingAccess: true }, "Avery"))
      .toEqual({ line: "You have these files", tone: "listed" });
  });

  it("turns the server's partial-Drive note into one plain line, and adds nothing otherwise", () => {
    expect(buyerNotes(packet)).toEqual([]);
    expect(buyerNotes({ ...packet, description: `${packet.description} Covers only its verified documents and stated span. ` +
      "Other Drive files remain unverified; this is not a complete inventory of matching records." }))
      .toEqual(["It may not include every matching file."]);
  });

  it("writes a request's exact dates the short way", () => {
    expect(dayRangeLabel("2026-09-29", "2026-10-01")).toBe("Sep 29 – Oct 1, 2026");
    expect(dayRangeLabel("2026-03-01", "2026-08-31")).toBe("Mar 1 – Aug 31, 2026");
    expect(dayRangeLabel("2025-12-30", "2026-01-02")).toBe("Dec 30, 2025 – Jan 2, 2026");
    expect(dayRangeLabel("2026-09-29", "2026-09-29")).toBe("Sep 29, 2026");
    expect(dayRangeLabel(null, "2026-09-29")).toBeNull();
    expect(dayRangeLabel("not-a-date", "2026-09-29")).toBeNull();
  });
});

describe("owner packet words", () => {
  // The owner's packets as the server sends them: a version that isn't ready is never "current".
  const owned: DrivePacket = { ...packet, listingRevision: 0, listingEnabled: false, canList: true, canRequest: false };
  const CHECKING = "The private agent is checking current evidence.";
  const notCurrent = { ...owned, freshness: "stale" as const, canList: false, gaps: [CHECKING] };

  it("says why a packet can't be listed, and keeps Checking for one that is being checked", () => {
    expect(ownerPacketStatus({ ...notCurrent, state: "incomplete", gaps: ["Documents name different accounts"] }))
      .toMatchObject({ word: "Needs attention", tone: "attention", detail: "It can’t be listed yet." });
    expect(ownerPacketStatus({ ...notCurrent, state: "unable_to_verify" })).toMatchObject({ word: "Couldn’t check", tone: "attention" });
    // The server's stand-in while it checks a packet again, and a ready packet whose files changed.
    expect(ownerPacketStatus({ ...notCurrent, title: "Packet being checked", state: "incomplete" }))
      .toMatchObject({ word: "Checking", tone: "waiting", detail: "Agent One is checking its files." });
    expect(ownerPacketStatus(notCurrent)).toMatchObject({ word: "Checking", detail: "Agent One is checking its files." });
    // Nothing to say why: the server says it is checking.
    expect(ownerPacketStatus({ ...notCurrent, state: "incomplete" }).word).toBe("Checking");
    // A listed packet being checked can't be bought until it is done.
    expect(ownerPacketStatus({ ...notCurrent, listingEnabled: true, listingRevision: 1 }).detail)
      .toBe("Agent One is checking its files. Buyers can’t buy it until then.");
    // Paused by either switch (Prepare packets, or Background Drive access), so it names neither.
    expect(ownerPacketStatus({ ...notCurrent, freshness: "paused" })).toMatchObject({ word: "Paused", detail: "Preparation is paused." });
    expect(ownerPacketStatus({ ...notCurrent, freshness: "paused", listingEnabled: true, listingRevision: 1 }).detail)
      .toBe("Preparation is paused. Connections can see it but can’t buy it.");
    expect(ownerPacketStatus(owned)).toMatchObject({ word: "Ready to list", tone: "ready" });
  });
});
