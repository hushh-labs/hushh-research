import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  apiFetch: api.fetch, getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
} }));
import { DrivePacketService, parseDrivePacket, parseDriveCollectionStatus } from "@/lib/services/drive-packet-service";
import { DriveGroupService, parseDriveGroupPage } from "@/lib/services/drive-group-service";
const id = "11111111-1111-4111-8111-111111111111";
const packet = { packetId: id, version: 2, listingRevision: 3, title: "Schwab statements",
  description: "Verified statements", state: "ready", coverageSummary: "September 2026", gaps: [],
  documentCount: 3, verifiedAt: "2026-10-13T10:00:00Z", freshness: "current", assessmentScore: 95,
  importance: 100, suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: false,
  canRequest: false, canList: true };
beforeEach(() => vi.resetAllMocks());

describe("@feature_drive_packets @trace_loop query packet wire contract", () => {
  const discovery = { kind: "provider_discovery", packetId: id, category: "bank", version: 0, listingRevision: 0,
    periodStart: "2026-09-01", periodEnd: "2026-10-31", timezone: "Asia/Kolkata", state: "building",
    title: "Account statements", description: "Files from a Drive search", coverageSummary: "September–October 2026",
    documentCount: 2, freshness: "current", priceCents: 500, listingEnabled: false, canRequest: false, canList: false,
    requestId: null, purchaseState: "none" };
  it("accepts an open period without fabricated content assessment and prevents premature purchase", () => {
    const parsed = parseDrivePacket(discovery);
    expect(parsed).toMatchObject({ kind: "provider_discovery", version: 0, state: "building", canRequest: false });
    expect(parsed).not.toHaveProperty("assessmentScore");
    expect(parseDrivePacket({ ...discovery, state: "empty", version: 1, documentCount: 0 }).state).toBe("empty");
    for (const change of [{ canRequest: true }, { canList: true }, { listingEnabled: true }, { version: 1 }, { priceCents: 499 },
      { category: ["bank"] }, { state: ["building"] }, { periodEnd: "2026-09-31" }, { timezone: "invalid" }]) {
      expect(() => parseDrivePacket({ ...discovery, ...change })).toThrow();
    }
  });
  it("preserves durable purchase identity and limits original file links to the owner", () => {
    const document = { name: "Example statement.pdf", type: null, pages: null, period: null, viewUrl: "https://drive.google.com/file/d/example/view" };
    const closed = { ...discovery, state: "ready", version: 1, canRequest: true, canList: true,
      requestId: id, purchaseState: "delivered", contents: { period: null, documents: [document] } };
    expect(parseDrivePacket(closed, "owner").contents?.documents[0].viewUrl).toBe(document.viewUrl);
    expect(parseDrivePacket(closed)).toMatchObject({ requestId: id, purchaseState: "delivered" });
    expect(parseDrivePacket(closed).contents).toBeUndefined();
    for (const change of [{ requestId: null }, { purchaseState: "none" }, { purchaseState: ["delivered"] },
      { contents: { period: null, documents: [{ ...document, viewUrl: "https://drive.google.com.evil.test/file" }] } }]) {
      expect(() => parseDrivePacket({ ...closed, ...change }, "owner")).toThrow();
    }
  });
  it("rejects a changed price before an approved period listing reaches transport", async () => {
    const frozen = parseDrivePacket({ ...discovery, state: "ready", version: 1, canList: true });
    await expect(DrivePacketService.listing("owner", frozen, "allow", 600, () => undefined)).rejects.toThrow();
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it("keeps preview progress and originals owner-only without changing sale readiness", async () => {
    const preview = { status: "partial", revision: 0, matched: 1, complete: false, stale: false,
      updatedAt: "2026-10-24T10:00:00Z", errorCode: null, nextCursor: null, limited: false,
      documents: [{ name: "Example recording.mp4", type: "video/mp4", pages: null, period: null,
        shareable: false, viewUrl: "https://drive.google.com/file/d/recording/view" }] };
    const owner = parseDrivePacket({ ...discovery, preview }, "owner");
    expect(owner).toMatchObject({ preview, version: 0, canList: false, canRequest: false });
    expect(parseDrivePacket({ ...discovery, preview })).not.toHaveProperty("preview");
    expect(() => parseDrivePacket({ ...discovery, preview: { ...preview, status: ["completed"], matched: null, complete: false } }, "owner")).toThrow();
    expect(() => parseDrivePacket({ ...discovery, preview: { ...preview, documents: [
      { ...preview.documents[0], viewUrl: "https://drive.google.com.evil.test/private" },
    ] } }, "owner")).toThrow();
    api.fetch.mockImplementation(async () => new Response(JSON.stringify(preview)));
    await DrivePacketService.preparePreview("owner", id, () => undefined);
    expect(api.fetch).toHaveBeenCalledWith(`/api/connectors/google_drive/sharing/packets/${id}/preview`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ refresh: false }) }));
    await DrivePacketService.preview("owner", id, () => undefined);
    expect(api.fetch.mock.calls[1][1].method).toBe("GET");
  });
});

describe("@feature_drive_packets @trace_loop owner data packet file pages", () => {
  const file = { ref: "a".repeat(64), title: "Synthetic file", viewUrl: "https://drive.google.com/file/d/synthetic-file/view", day: "2026-10-22" };
  it("rejects unsafe provider links and nonadvancing pages", () => {
    expect(parseDriveGroupPage({ items: [file], nextCursor: null, total: 1 }, 0).items[0].title).toBe(file.title);
    for (const viewUrl of ["javascript:alert(1)", "https://drive.google.com.evil.test/file/d/synthetic-file/view", "https://evil.test/"]) {
      expect(() => parseDriveGroupPage({ items: [{ ...file, viewUrl }], nextCursor: null, total: 1 }, 0)).toThrow();
    }
    expect(() => parseDriveGroupPage({ items: [file], nextCursor: 0, total: 2 }, 0)).toThrow();
  });
  it("uses no-store and drops response bytes after owner retirement", async () => {
    let current = true;
    const guard = () => { if (!current) throw new Error("session_changed"); };
    api.fetch.mockResolvedValue({ ok: true, text: async () => { current = false; return JSON.stringify({ items: [file], nextCursor: null, total: 1 }); } });
    await expect(DriveGroupService.files("owner", "kept", 0, guard)).rejects.toThrow("session_changed");
    expect(api.fetch.mock.calls[0][1].cache).toBe("no-store");
    api.fetch.mockClear();
    await expect(DriveGroupService.setProcessing("owner", true, guard)).rejects.toThrow("session_changed");
    expect(api.fetch).not.toHaveBeenCalled();
  });
});
describe("@feature_drive_packets @trace_loop private packet wire contract", () => {
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


describe("@feature_drive_packets @trace_loop collection indexing stages", () => {
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

describe("@feature_drive_packets @trace_loop what is inside a packet", () => {
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
