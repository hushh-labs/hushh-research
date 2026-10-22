import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  apiFetch: api.fetch, getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
} }));
import { DrivePacketService, parseDrivePacket, parseDriveCollectionStatus } from "@/lib/services/drive-packet-service";
const id = "11111111-1111-4111-8111-111111111111";
const packet = { packetId: id, version: 2, listingRevision: 3, title: "Schwab statements",
  description: "Verified statements", state: "ready", coverageSummary: "September 2026", gaps: [],
  documentCount: 3, verifiedAt: "2026-10-13T10:00:00Z", freshness: "current", assessmentScore: 95,
  importance: 100, suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: false,
  canRequest: false, canList: true };
beforeEach(() => vi.resetAllMocks());
describe("private packet wire contract", () => {
  it("binds Allow to the exact version, revision, disclosure and cent price", async () => {
    api.fetch.mockResolvedValue(Response.json({}));
    await DrivePacketService.listing("owner", parseDrivePacket(packet), "allow", 5678, () => undefined);
    const [url, options] = api.fetch.mock.calls[0];
    expect(url).toBe(`/api/connectors/google_drive/sharing/packets/${id}/listing`);
    expect(JSON.parse(options.body)).toEqual({ version: 2, expectedRevision: 3, decision: "allow", priceCents: 5678,
      disclosure: "drive-packet-listing-connections-v1" });
    expect(options.cache).toBe("no-store");
  });
  it("rejects malformed readiness, stale availability, out-of-range prices and hash versions", () => {
    for (const change of [{ state: "ready", gaps: ["Missing September"] }, { freshness: "stale" },
      { priceCents: 49 }, { suggestedPriceCents: 50001 }, { importance: 501 }, { assessmentScore: 101 },
      { version: "abc123" }, { version: 0 }]) {
      expect(() => parseDrivePacket({ ...packet, ...change })).toThrow();
    }
    expect(parseDrivePacket({ ...packet, state: "incomplete", gaps: ["Missing September"], canList: false }).state).toBe("incomplete");
  });
  it("checks the owner fence after response bytes arrive and before a mutation starts", async () => {
    let current = true;
    const guard = () => { if (!current) throw new Error("session_changed"); };
    api.fetch.mockResolvedValue({ ok: true, text: async () => { current = false; return JSON.stringify({ packets: [packet], nextCursor: null }); } });
    await expect(DrivePacketService.packets("owner", guard)).rejects.toThrow("session_changed");
    api.fetch.mockClear();
    await expect(DrivePacketService.request("owner", "firebase", parseDrivePacket(packet), id, guard)).rejects.toThrow("session_changed");
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it("retains the caller idempotency key and reports existing access without checkout", async () => {
    api.fetch.mockResolvedValue(Response.json({ requestId: id, existingAccess: true }));
    expect(await DrivePacketService.request("buyer", "firebase", parseDrivePacket(packet), id, () => undefined)).toEqual({ requestId: id, existingAccess: true });
    expect(JSON.parse(api.fetch.mock.calls[0][1].body)).toEqual({ version: 2, clientRequestId: id });
    expect(api.fetch.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer firebase", "X-Hushh-Consent": "buyer", "Content-Type": "application/json" });
  });
});


describe("collection indexing stages", () => {
  const status = {
    enabled: true, backgroundEnabled: true, state: "indexing", revision: 1,
    counts: { discovered: 3, extracted: 2, indexed: 1, failed: 1, pending: 1 },
    initialStartedAt: "2026-10-13T04:00:00Z", initialCompletedAt: null,
    lastSyncedAt: "2026-10-13T04:01:00Z", lastIndexedAt: "2026-10-13T04:01:00Z",
    lastExtractedAt: "2026-10-13T04:00:45Z", initialExtractionCompletedAt: null,
    initialExtractionDurationMs: null, lastSemanticIndexingDurationMs: 6000,
    lastDocumentExtractionDurationMs: 4000, initialIndexingDurationMs: null, syncDurationMs: 1200,
  };
  it("preserves extraction and semantic indexing as separate measured stages", () => {
    const result = parseDriveCollectionStatus(status);
    expect(result.counts).toEqual(status.counts);
    expect(result.initialCompletedAt).toBeNull();
    expect(result.lastSemanticIndexingDurationMs).toBe(6000);
    expect(result.lastDocumentExtractionDurationMs).toBe(4000);
  });
  it("rejects double counts and semantically indexed files without extraction", () => {
    for (const counts of [
      { ...status.counts, pending: 2 }, { ...status.counts, extracted: 0 },
      { ...status.counts, extracted: 4 },
    ]) expect(() => parseDriveCollectionStatus({ ...status, counts })).toThrow();
  });
});

describe("what is inside a packet", () => {
  const contents = { period: { start: "2026-01-01", end: "2026-06-30" }, documents: [
    { name: "Example Bank statement Jan 2026.pdf", type: "bank statement", pages: 2, period: { start: "2026-01-01", end: "2026-01-31" } },
    { name: "Example Bank statement Feb 2026.pdf", type: null, pages: null, period: null },
  ] };
  const owned = { ...packet, title: "Example Bank statements", contents };
  it("keeps the owner's own file list and never hands it to a buyer view", async () => {
    expect(parseDrivePacket(owned, "owner").contents).toEqual(contents);
    expect(parseDrivePacket(owned).contents).toBeUndefined();
    expect(parseDrivePacket(packet, "owner").contents).toBeUndefined();
    api.fetch.mockImplementation(async () => Response.json({ packets: [owned], nextCursor: null }));
    expect((await DrivePacketService.packets("owner", () => undefined)).packets[0].contents).toEqual(contents);
    const bought = await DrivePacketService.packets("buyer", () => undefined, id);
    expect(bought.packets[0].contents).toBeUndefined();
    expect(JSON.stringify(bought)).not.toContain("Example Bank statement Jan 2026.pdf");
  });
  it("rejects a malformed file list", () => {
    for (const change of [{ period: { start: "2026-02-01", end: "2026-01-01" } }, { period: { start: "Jan", end: "2026-01-01" } },
      { documents: [{ ...contents.documents[0], name: "" }] }, { documents: [{ ...contents.documents[0], pages: 0 }] },
      { documents: "Example Bank statement Jan 2026.pdf" }, { documents: Array(121).fill(contents.documents[1]) }]) {
      expect(() => parseDrivePacket({ ...owned, contents: { ...contents, ...change } }, "owner")).toThrow();
    }
  });
});
