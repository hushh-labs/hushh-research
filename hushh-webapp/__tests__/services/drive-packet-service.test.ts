import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  apiFetch: api.fetch, getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
} }));
import { DrivePacketService, parseDrivePacket, parseDriveCollectionStatus } from "@/lib/services/drive-packet-service";
import { DriveGroupService, parseDriveGroupPage } from "@/lib/services/drive-group-service";
import { DrivePacketResourceService } from "@/lib/services/drive-packet-resource-service";
import { CacheService } from "@/lib/services/cache-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
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
  it("separates discovery count from frozen sale membership without converting unknown to zero", () => {
    expect(parseDrivePacket({ ...discovery, documentCount: null, saleDocumentCount: null })).toMatchObject({ documentCount: null, saleDocumentCount: null });
    expect(parseDrivePacket({ ...discovery, version: 1, state: "empty", documentCount: 51, saleDocumentCount: 0 })).toMatchObject({ documentCount: 51, saleDocumentCount: 0, canRequest: false });
    expect(() => parseDrivePacket({ ...discovery, version: 1, state: "ready", canRequest: true, documentCount: 51, saleDocumentCount: 0 })).toThrow();
  });
  it("accepts recovered frozen version 2 and sends its exact version at the fixed price", async () => {
    const recovered = { ...discovery, state: "ready", version: 2, saleDocumentCount: 2, canList: true, canRequest: true };
    const parsed = parseDrivePacket(recovered, "owner");
    expect(parsed).toMatchObject({ version: 2, priceCents: 500, saleDocumentCount: 2 });
    expect(parseDrivePacket({ ...recovered, version: Number.MAX_SAFE_INTEGER }).version).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseDrivePacket({ ...discovery, state: "empty", version: 2, documentCount: 51, saleDocumentCount: 0 }).version).toBe(2);
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])
      expect(() => parseDrivePacket({ ...recovered, version })).toThrow();
    expect(() => parseDrivePacket({ ...discovery, version: 2 })).toThrow();
    expect(() => parseDrivePacket({ ...recovered, priceCents: 501 })).toThrow();
    expect(() => parseDrivePacket({ ...discovery, state: "empty", version: 0, documentCount: 0, saleDocumentCount: 0 })).toThrow();
    api.fetch.mockResolvedValueOnce(new Response("{}"));
    await DrivePacketService.listing("owner", parsed, "allow", 500, () => undefined);
    expect(JSON.parse(api.fetch.mock.calls[0][1].body)).toMatchObject({ version: 2, priceCents: 500 });
    api.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ requestId: id, existingAccess: false })));
    await DrivePacketService.request("owner", "firebase", parsed, id, () => undefined);
    expect(JSON.parse(api.fetch.mock.calls[1][1].body)).toEqual({ version: 2, clientRequestId: id });
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
    const tagged = { ...preview, tagging: { status: "running", policyVersion: "test-v1",
      counts: { financial: 0, review: 0, other: 0, pending: 1 } },
      documents: [{ ...preview.documents[0], packetTag: { bucket: "review", reason: "no_evidence" } }] };
    expect(parseDrivePacket({ ...discovery, preview: tagged }, "owner")).toMatchObject({ preview: tagged });
    expect(parseDrivePacket({ ...discovery, preview: tagged })).not.toHaveProperty("preview");
    // A scheduled retry time is optional: a malformed one drops only itself.
    const retrying = { ...tagged.tagging, status: "queued", retryAt: "2026-10-28T06:00:00Z", failureCode: "refresh_in_progress" };
    expect(parseDrivePacket({ ...discovery, preview: { ...tagged, tagging: retrying } }, "owner").preview?.tagging)
      .toEqual({ status: "queued", policyVersion: "test-v1", counts: tagged.tagging.counts, retryAt: "2026-10-28T06:00:00Z" });
    expect(parseDrivePacket({ ...discovery, preview: { ...tagged, tagging: { ...retrying, retryAt: "soon" } } }, "owner").preview?.tagging)
      .toEqual({ status: "queued", policyVersion: "test-v1", counts: tagged.tagging.counts });
    for (const invalid of [null, { status: ["running"] }, { ...tagged.tagging, counts: { financial: -1 } }]) {
      const parsed = parseDrivePacket({ ...discovery, preview: { ...tagged, tagging: invalid,
        documents: [{ ...tagged.documents[0], packetTag: { bucket: ["financial"], reason: "invalid" } }] } }, "owner");
      expect(parsed).not.toHaveProperty("preview.tagging");
      expect(parsed).not.toHaveProperty("preview.documents.0.packetTag");
      expect(parsed).toMatchObject({ preview: { documents: [{ viewUrl: preview.documents[0].viewUrl }] } });
    }
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

describe("@feature_drive_packets @trace_loop public financial summary boundary", () => {
  const summary = { packetId: id, version: 0, category: "financial", title: "Financial documents",
    periodStart: "2026-09-01", periodEnd: "2026-10-31", timezone: "Asia/Kolkata", documentCount: null,
    countBasis: "discovery_matches", complete: false, updatedAt: null, priceCents: 500, currency: "USD",
    availability: "preparing", viewerAction: "connect" };
  it("reads Firebase-only summaries without vault authority and discards all private additions", async () => {
    const { FinancialPacketSummaryService } = await import("@/lib/services/financial-packet-summary-service");
    api.fetch.mockResolvedValue(new Response(JSON.stringify({ packets: [{ ...summary, requestId: id,
      contents: { documents: [{ name: "Private file.pdf", viewUrl: "https://drive.google.com/private" }] }, preview: { matched: 12 } }], nextCursor: null })));
    const result = await FinancialPacketSummaryService.list(id, "firebase-only", () => {});
    expect(result.packets).toEqual([summary]);
    expect(api.fetch).toHaveBeenCalledWith(`/api/one/people/${id}/financial-packets`, expect.objectContaining({ cache: "no-store", headers: { Authorization: "Bearer firebase-only" } }));
    expect(result.packets[0].documentCount).toBeNull();
  });
  it("rejects malformed summary authority, truncated JSON, and a retired viewer after bytes arrive", async () => {
    const { FinancialPacketSummaryService, parseFinancialPacketSummary } = await import("@/lib/services/financial-packet-summary-service");
    for (const change of [{ priceCents: 501 }, { viewerAction: ["request"] }, { documentCount: -1 }, { saleDocumentCount: -1 }, { complete: "true" }, { periodEnd: "2026-09-31" }, { timezone: "invalid" }])
      expect(() => parseFinancialPacketSummary({ ...summary, ...change })).toThrow();
    api.fetch.mockResolvedValue(new Response('{"packets":['));
    await expect(FinancialPacketSummaryService.list(id, "firebase", () => {})).rejects.toThrow();
    let retired = false;
    api.fetch.mockResolvedValue({ ok: true, text: async () => { retired = true; return JSON.stringify({ packets: [summary], nextCursor: null }); } });
    await expect(FinancialPacketSummaryService.list(id, "firebase", () => { if (retired) throw new Error("retired"); })).rejects.toThrow("retired");
  });
  it("binds explicit public publication to its own version/revision and keeps the owner projection out of buyer packets", async () => {
    const { FinancialPacketSummaryService, PUBLIC_PACKET_DISCLOSURE } = await import("@/lib/services/financial-packet-summary-service");
    const expected = { enabled: false, revision: 7, version: 0, disclosure: PUBLIC_PACKET_DISCLOSURE };
    api.fetch.mockResolvedValue(new Response(JSON.stringify({ ...expected, enabled: true, revision: 8 })));
    await FinancialPacketSummaryService.publish("owner-token", id, expected, true, () => {});
    expect(JSON.parse(api.fetch.mock.calls[0][1].body)).toEqual({ enabled: true, version: 0, expectedRevision: 7, disclosure: PUBLIC_PACKET_DISCLOSURE });
    expect(api.fetch.mock.calls[0][1].method).toBe("PUT");
    api.fetch.mockResolvedValue(new Response(JSON.stringify({ ...expected, enabled: false, revision: 9 })));
    await expect(FinancialPacketSummaryService.publish("owner-token", id, { ...expected, version: 1 }, false, () => {})).resolves.toMatchObject({ enabled: false, version: 0 });
    expect(() => parseDrivePacket({ ...packet, publicSummary: expected })).not.toThrow();
  });
});

describe("@feature_drive_packets @trace_loop scalar publication receipts", () => {
  it("uses owner no-store metadata without OAuth and strips private additions", async () => {
    const { FinancialPacketSummaryService, PUBLIC_PACKET_DISCLOSURE } = await import("@/lib/services/financial-packet-summary-service");
    const receipt = { packetId: id, currentVersion: 1, title: "Financial documents", periodStart: "2026-07-01", periodEnd: "2026-08-31", timezone: "UTC",
      publicSummary: { enabled: true, revision: 9, version: 0, disclosure: PUBLIC_PACKET_DISCLOSURE } };
    api.fetch.mockResolvedValue(new Response(JSON.stringify({ packets: [{ ...receipt, contents: { documents: [{ name: "Private.pdf" }] }, userId: "hidden" }], nextCursor: null })));
    expect((await FinancialPacketSummaryService.publications("owner-token", () => {})).packets).toEqual([receipt]);
    expect(api.fetch).toHaveBeenCalledWith("/api/connectors/google_drive/sharing/packet-publications", expect.objectContaining({ method: "GET", cache: "no-store", headers: { Authorization: "Bearer owner-token" } }));
    api.fetch.mockResolvedValue(new Response(JSON.stringify({ packets: [{ ...receipt, publicSummary: { ...receipt.publicSummary, revision: "9" } }], nextCursor: null })));
    await expect(FinancialPacketSummaryService.publications("owner-token", () => {})).rejects.toThrow();
  });
});

// These are protected presentation snapshots, not persisted document copies.

const resourceSession = "synthetic-owner:auth-1:vault-1:packets";
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
describe("packet memory resource isolation and reconciliation", () => {
  beforeEach(() => CacheService.getInstance().clear());
  it("renders a warm return from the canonical memory snapshot and isolates owner and session", async () => {
    const loader = vi.fn(async () => ({ revision: 2, count: 14 }));
    await DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, loader);
    expect(DrivePacketResourceService.peek(resourceSession, "catalog")).toEqual({ revision: 2, count: 14 });
    await DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, loader);
    expect(loader).toHaveBeenCalledOnce();
    expect(DrivePacketResourceService.peek("different-owner:auth-1:vault-1:packets", "catalog")).toBeNull();
    expect(DrivePacketResourceService.peek("synthetic-owner:auth-2:vault-1:packets", "catalog")).toBeNull();
    CacheService.getInstance().invalidateUser("synthetic-owner");
    expect(DrivePacketResourceService.peek(resourceSession, "catalog")).toBeNull();
  });
  it("coalesces a refresh burst into one flight and at most one trailing read", async () => {
    const first = deferred<string>(), last = deferred<string>();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const initial = DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, loader);
    const burst = Array.from({ length: 12 }, () => DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, loader, { force: true }));
    expect(loader).toHaveBeenCalledOnce();
    first.resolve("obsolete"); await Promise.resolve(); await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(2);
    const duringTrailing = DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, loader, { force: true });
    expect(DrivePacketResourceService.peek(resourceSession, "catalog")).toBeNull();
    last.resolve("current");
    expect(await Promise.all([initial, ...burst, duringTrailing])).toEqual(Array(14).fill("current"));
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("accepts a live same-session consumer after the initiating mount retires", async () => {
    let live = true;
    const pending = deferred<string>(), guard = () => { if (!live) throw new Error("retired"); };
    const first = DrivePacketResourceService.load(resourceSession, "catalog", guard, async current => { const value = await pending.promise; current(); return value; });
    const firstOutcome = first.catch(() => "retired");
    live = false;
    const returned = DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, async () => "duplicate");
    pending.resolve("current");
    expect(await returned).toBe("current");
    expect(await firstOutcome).toBe("retired");
  });
  it("keeps the previous snapshot when another mutation supersedes the bounded trailing read", async () => {
    await DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, async () => "safe");
    const first = deferred<string>(), trailing = deferred<string>();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(trailing.promise);
    const operation = DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, loader, { force: true });
    DrivePacketResourceService.invalidate(resourceSession, "catalog");
    first.resolve("older"); await Promise.resolve(); await Promise.resolve();
    DrivePacketResourceService.invalidate(resourceSession, "catalog");
    trailing.resolve("still-older");
    await expect(operation).rejects.toThrow("packet_resource_changed");
    expect(DrivePacketResourceService.peek(resourceSession, "catalog")).toBe("safe");
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("purges packet memory on vault epoch changes and prevents late results restoring it", async () => {
    await DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, async () => "private snapshot");
    const pending = deferred<string>();
    const operation = DrivePacketResourceService.load(resourceSession, "catalog", () => undefined, () => pending.promise, { force: true });
    advanceVaultSessionEpoch();
    expect(DrivePacketResourceService.peek(resourceSession, "catalog")).toBeNull();
    pending.resolve("late private snapshot");
    await expect(operation).rejects.toThrow("packet_resource_retired");
    expect(DrivePacketResourceService.peek(resourceSession, "catalog")).toBeNull();
  });
});

describe("packet deadlines and authoritative mutation snapshots", () => {
  beforeEach(() => CacheService.getInstance().clear());
  it.each(["clear", "owner"])("retires a cold writer on %s purge even before a snapshot exists", async mode => {
    const pending = deferred<string>();
    const operation = DrivePacketResourceService.load(resourceSession, "cold", () => undefined, () => pending.promise);
    if (mode === "clear") CacheService.getInstance().clear();
    else CacheService.getInstance().invalidateUser("synthetic-owner");
    pending.resolve("late");
    await expect(operation).rejects.toThrow("packet_resource_retired");
    expect(DrivePacketResourceService.peek(resourceSession, "cold")).toBeNull();
  });
  it("bounds the full flight and never publishes after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<string>();
      const operation = DrivePacketResourceService.load(resourceSession, "bounded", () => undefined, () => pending.promise);
      const rejected = expect(operation).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(8_001);
      await rejected;
      pending.resolve("late"); await Promise.resolve();
      expect(DrivePacketResourceService.peek(resourceSession, "bounded")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("keeps a parsed mutation receipt visible over older server revisions", async () => {
    const enabled = { enabled: true, revision: 1 }, disabled = { enabled: false, revision: 2 };
    await DrivePacketResourceService.load(resourceSession, "visibility", () => undefined, async () => enabled);
    DrivePacketResourceService.publish(resourceSession, "visibility", () => undefined, disabled);
    expect(DrivePacketResourceService.peek(resourceSession, "visibility")).toEqual(disabled);
    const result = await DrivePacketResourceService.load(resourceSession, "visibility", () => undefined, async () => enabled,
      { reconcile: (previous, incoming) => incoming.revision >= previous.revision ? incoming : previous });
    expect(result).toEqual(disabled);
  });
  it("reads and writes the canonical owner visibility contract with strict revision receipts", async () => {
    const { FinancialPacketSummaryService, PACKET_PROFILE_VISIBILITY_DISCLOSURE } = await import("@/lib/services/financial-packet-summary-service");
    const expected = { enabled: true, revision: 0, disclosure: PACKET_PROFILE_VISIBILITY_DISCLOSURE };
    api.fetch.mockResolvedValueOnce(new Response(JSON.stringify(expected)));
    expect(await FinancialPacketSummaryService.visibility("owner", () => undefined)).toEqual(expected);
    api.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...expected, enabled: false, revision: 1 })));
    await FinancialPacketSummaryService.setVisibility("owner", expected, false, () => undefined);
    expect(api.fetch.mock.calls[1]).toEqual(["/api/connectors/google_drive/sharing/financial-summary-preference", expect.objectContaining({
      method: "PUT", timeoutMs: 8_000, body: JSON.stringify({ enabled: false, expectedRevision: 0, disclosure: PACKET_PROFILE_VISIBILITY_DISCLOSURE }),
    })]);
    api.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...expected, enabled: false })));
    await expect(FinancialPacketSummaryService.setVisibility("owner", expected, false, () => undefined)).rejects.toThrow();
    expect(api.fetch).toHaveBeenCalledTimes(3);
  });
  it("does not retry deterministic HTTP refusals", async () => {
    api.fetch.mockResolvedValue(new Response(JSON.stringify({ detail: { code: "owner_authority_required" } }), { status: 403 }));
    await expect(DrivePacketService.preview("owner", id, () => undefined)).rejects.toMatchObject({ code: "owner_authority_required" });
    expect(api.fetch).toHaveBeenCalledOnce();
  });
});
