import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiJson: vi.fn() }));

vi.mock("@/lib/services/api-client", () => ({ apiJson: mocks.apiJson }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }) },
}));

import { SourceJournalService } from "@/lib/services/source-journal-service";

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
      .resolves.toEqual({ headCursor: "3", changed: true });
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
      .resolves.toEqual({ headCursor: "2049", changed: true });
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
});
