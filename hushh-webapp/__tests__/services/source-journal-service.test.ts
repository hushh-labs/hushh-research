import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiJson: vi.fn() }));

vi.mock("@/lib/services/api-client", () => ({ apiJson: mocks.apiJson }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }) },
}));

import { SourceJournalService } from "@/lib/services/source-journal-service";

/** The backend's real reset() replies; the pytest contract proves it emits them. */
type ResetVector = { after: number; response: Record<string, unknown> };
const resetVectors = JSON.parse(readFileSync(path.resolve(
  __dirname, "../../../consent-protocol/tests/fixtures/live_memory_journal_reset_vectors.json",
), "utf8")) as Record<"source_in_range_gap" | "connector_in_range_gap" | "retention_reset", ResetVector>;
const ALL_SOURCE_KINDS = [
  "profile", "consent", "connection", "document_earning", "payout_activity",
  "document_request_payment",
];

const event = {
  sequence: "1",
  eventId: "event-1",
  sourceId: "google_drive",
  operation: "changed",
  schemaVersion: 1,
  occurredAt: "2026-10-14T00:00:00+00:00",
};

describe("SourceJournalService", () => {
  beforeEach(() => mocks.apiJson.mockReset());

  it("accepts a committed hint and returns the captured head for post-scan checkpointing", async () => {
    mocks.apiJson.mockResolvedValue({
      events: [event], nextCursor: "1", headCursor: "3", earliestCursor: "0",
      resetRequired: false, hasMore: true,
    });
    await expect(SourceJournalService.connectorHead("owner-token", "0"))
      .resolves.toEqual({
        headCursor: "3", changed: true, resetRequired: false,
        pendingCount: 3, firstOccurredAt: "2026-10-14T00:00:00.000Z",
      });
    expect(mocks.apiJson).toHaveBeenCalledWith(
      "/api/one/source-journal/connectors?after=0&limit=1",
      { method: "GET", headers: { Authorization: "Bearer owner-token" }, cache: "no-store" },
    );
  });

  it("treats a retention gap as a full authoritative reread", async () => {
    mocks.apiJson.mockResolvedValue({
      events: [], nextCursor: "0", headCursor: "2049", earliestCursor: "1",
      resetRequired: true, hasMore: false,
    });
    await expect(SourceJournalService.connectorHead("owner-token", "0"))
      .resolves.toEqual({
        headCursor: "2049", changed: true, resetRequired: true,
        pendingCount: null, firstOccurredAt: null,
      });
  });

  it("accepts the backend's real reset vectors on both journals, in range or not", async () => {
    const accepted = async (name: keyof typeof resetVectors) => {
      const vector = resetVectors[name];
      mocks.apiJson.mockResolvedValue(vector.response);
      const head = vector.response.headCursor;
      await expect(SourceJournalService.sourceChanges("owner-token", String(vector.after)))
        .resolves.toEqual({
          headCursor: head, changedKinds: ALL_SOURCE_KINDS,
          resetRequired: true, hints: {}, exact: false,
        });
      await expect(SourceJournalService.connectorHead("owner-token", String(vector.after)))
        .resolves.toEqual({
          headCursor: head, changed: true, resetRequired: true,
          pendingCount: null, firstOccurredAt: null,
        });
    };
    // Cursor 4 sits inside the retained range (earliest 0, head 6): the
    // backend found sequence 5 missing. Old clients rejected this reply.
    await accepted("source_in_range_gap");
    await accepted("connector_in_range_gap");
    await accepted("retention_reset");

    // The structural checks still hold: a reset never carries events, more
    // pages, or a moved cursor.
    const gap = resetVectors.source_in_range_gap;
    for (const broken of [
      { ...gap.response, nextCursor: "5" },
      { ...gap.response, events: [{ ...event, sourceKind: "consent", sequence: "5" }] },
      { ...gap.response, hasMore: true },
    ]) {
      mocks.apiJson.mockResolvedValue(broken);
      await expect(SourceJournalService.sourceChanges("owner-token", String(gap.after)))
        .rejects.toThrow("reset is invalid");
      await expect(SourceJournalService.connectorHead("owner-token", String(gap.after)))
        .rejects.toThrow("reset is invalid");
    }
  });

  it("rejects a missing page row instead of advancing over it", async () => {
    mocks.apiJson.mockResolvedValue({
      events: [], nextCursor: "0", headCursor: "1", earliestCursor: "0",
      resetRequired: false, hasMore: false,
    });
    await expect(SourceJournalService.connectorHead("owner-token", "0"))
      .rejects.toThrow("incomplete");
  });

  it("rejects a wrong sequence and an overwide cursor", async () => {
    mocks.apiJson.mockResolvedValue({
      events: [{ ...event, sequence: "2" }], nextCursor: "2", headCursor: "2",
      earliestCursor: "0", resetRequired: false, hasMore: false,
    });
    await expect(SourceJournalService.connectorHead("owner-token", "0"))
      .rejects.toThrow("event is invalid");
    await expect(SourceJournalService.connectorHead("owner-token", "9223372036854775808"))
      .rejects.toThrow("cursor is invalid");
    expect(mocks.apiJson).toHaveBeenCalledTimes(1);
  });

  it("replays every source hint to one captured head without treating metadata as a fact", async () => {
    const events = Array.from({ length: 100 }, (_, index) => ({
      sequence: String(index + 1), eventId: `event-${index + 1}`,
      sourceKind: index === 0 ? "consent" : "profile",
      operation: "changed", schemaVersion: 1, occurredAt: event.occurredAt,
    }));
    mocks.apiJson
      .mockResolvedValueOnce({
        events, nextCursor: "100", headCursor: "101", earliestCursor: "0",
        resetRequired: false, hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [{ ...events[0], sequence: "101", sourceKind: "document_request_payment" }],
        nextCursor: "101", headCursor: "102", earliestCursor: "0",
        resetRequired: false, hasMore: true,
      });
    const at = "2026-10-14T00:00:00.000Z";
    await expect(SourceJournalService.sourceChanges("owner-token", "0"))
      .resolves.toEqual({
        headCursor: "101", changedKinds: ["profile", "consent", "document_request_payment"],
        resetRequired: false,
        hints: {
          profile: { count: 99, firstOccurredAt: at, lastOccurredAt: at },
          consent: { count: 1, firstOccurredAt: at, lastOccurredAt: at },
          document_request_payment: { count: 1, firstOccurredAt: at, lastOccurredAt: at },
        },
        exact: true,
      });
    expect(mocks.apiJson.mock.calls[1]?.[0]).toBe(
      "/api/one/source-journal/events?after=100&limit=1",
    );
  });

  it("counts committed hints per source with their commit times and no identifiers", async () => {
    const t = (second: number) => `2026-10-14T00:00:0${second}+00:00`;
    const iso = (second: number) => `2026-10-14T00:00:0${second}.000Z`;
    mocks.apiJson.mockResolvedValueOnce({
      events: [
        { sequence: "5", eventId: "event-5", sourceKind: "consent", operation: "changed", schemaVersion: 1, occurredAt: t(1) },
        { sequence: "6", eventId: "event-6", sourceKind: "profile", operation: "changed", schemaVersion: 1, occurredAt: t(2) },
        { sequence: "7", eventId: "event-7", sourceKind: "consent", operation: "deleted", schemaVersion: 1, occurredAt: t(3) },
        { sequence: "8", eventId: "event-8", sourceKind: "consent", operation: "changed", schemaVersion: 1, occurredAt: t(4) },
      ],
      nextCursor: "8", headCursor: "8", earliestCursor: "0", resetRequired: false, hasMore: false,
    });
    const changes = await SourceJournalService.sourceChanges("owner-token", "4");
    expect(changes).toMatchObject({ headCursor: "8", exact: true });
    expect(changes.hints).toEqual({
      consent: { count: 3, firstOccurredAt: iso(1), lastOccurredAt: iso(4) },
      profile: { count: 1, firstOccurredAt: iso(2), lastOccurredAt: iso(2) },
    });

    // The connector journal reads one hint: the backlog and its oldest commit.
    mocks.apiJson.mockResolvedValueOnce({
      events: [{ ...event, sequence: "5", eventId: "event-5", occurredAt: t(9) }],
      nextCursor: "5", headCursor: "7", earliestCursor: "0", resetRequired: false, hasMore: true,
    });
    const connector = await SourceJournalService.connectorHead("owner-token", "4");
    expect(connector).toEqual({
      headCursor: "7", changed: true, resetRequired: false,
      pendingCount: 3, firstOccurredAt: iso(9),
    });
    // Hints schedule reads only; event and source identifiers never leave.
    for (const result of [changes, connector]) {
      expect(JSON.stringify(result)).not.toContain("event-");
      expect(JSON.stringify(result)).not.toContain("google_drive");
    }
  });

  it("forces a full source reread after journal retention reset", async () => {
    mocks.apiJson.mockResolvedValue({
      events: [], nextCursor: "0", headCursor: "3000", earliestCursor: "952",
      resetRequired: true, hasMore: false,
    });
    const changes = await SourceJournalService.sourceChanges("owner-token", "0");
    expect(changes.resetRequired).toBe(true);
    expect(changes.headCursor).toBe("3000");
    expect(changes.changedKinds).toEqual([
      "profile", "consent", "connection", "document_earning", "payout_activity",
      "document_request_payment",
    ]);
  });

  it("rejects gaps and unknown source kinds without advancing replay", async () => {
    mocks.apiJson.mockResolvedValueOnce({
      events: [{ ...event, sourceKind: "consent", sequence: "2" }],
      nextCursor: "2", headCursor: "2", earliestCursor: "0",
      resetRequired: false, hasMore: false,
    }).mockResolvedValueOnce({
      events: [{ ...event, sourceKind: "credentials" }],
      nextCursor: "1", headCursor: "1", earliestCursor: "0",
      resetRequired: false, hasMore: false,
    });
    await expect(SourceJournalService.sourceChanges("owner-token", "0"))
      .rejects.toThrow();
    await expect(SourceJournalService.sourceChanges("owner-token", "0"))
      .rejects.toThrow("event is invalid");
  });
});
