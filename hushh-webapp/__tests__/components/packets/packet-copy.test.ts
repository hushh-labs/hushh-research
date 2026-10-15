import { describe, expect, it } from "vitest";

import { buyerNotes, buyerPacketStatus, dayRangeLabel } from "@/components/consent/packets/packet-copy";
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
