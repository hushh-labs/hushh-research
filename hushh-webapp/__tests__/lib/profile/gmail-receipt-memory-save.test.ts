import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), load: vi.fn(), stage: vi.fn(), legacyWrite: vi.fn(), version: vi.fn(), write: vi.fn(), migrate: vi.fn() }));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/pkm/pkm-natural-language-ingestion")>(), prepareNaturalLanguagePkm: mocks.prepare,
}));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  MARKDOWN_MEMORY_DOMAIN: "one_memory", loadMarkdownMemory: mocks.load, stageMarkdownMemoryFacts: mocks.stage,
  markdownFactsFromCards: (cards: Array<{source_text:string; preparation_requires_review?:boolean}>) =>
    cards.filter(card => !card.preparation_requires_review).map(card => ({ text: card.source_text, section: "Facts" })),
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { savePreparedDomain: mocks.legacyWrite } }));

vi.mock("@/lib/mail/receipt-store", () => ({ receiptStoreVersion: mocks.version, writeReceiptSnapshot: mocks.write }));
vi.mock("@/lib/mail/receipt-memory-migration", () => ({ migrateReceiptMemory: mocks.migrate }));

import { buildReceiptTrendObservations, saveReceiptCanonicalIndexToMemory } from "@/lib/profile/gmail-receipt-memory-save";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

function receipt(id: number, overrides: Partial<ReceiptListItem> = {}): ReceiptListItem {
  return { id, source_id: `gmail_live_source_${id}`, source_kind: "gmail_live", gmail_message_id: `message-${id}`,
    merchant_name: "Supabase", merchant_domain: "supabase.io", subject: "RAW_PRIVATE_SUBJECT", short_detail: "RAW_PRIVATE_DETAIL",
    event_type: "purchase", amount: 124.01, currency: "USD", status: "paid", document_kind: "invoice",
    category: "Cloud & Infra", category_confidence: 0.95, receipt_date: "2026-10-04T15:30:00Z",
    identifiers: [{ kind: "invoice", value: `INV-${id}` }], ...overrides };
}
const base = { userId: "user-1", vaultKey: "vault-key", vaultOwnerToken: "owner-token", accountKey: "owner@example.com",
  now: new Date("2026-10-09T10:00:00Z") };

describe("Receipt Radar saves only Soul aggregate trends", () => {
  beforeEach(() => {
    vi.clearAllMocks(); publishValidatedAuthSessionOwner("user-1");
    mocks.load.mockResolvedValue({ markdown: "# Soul.md" });
    mocks.stage.mockImplementation(async params => ({ success: true, saved: params.facts.length }));
    mocks.version.mockResolvedValue({ generation: 0, revision: 0 });
    mocks.write.mockImplementation(async () => { mocks.version.mockResolvedValue({ generation: 0, revision: 1 }); return { generation: 0, revision: 1 }; });
    mocks.migrate.mockResolvedValue(undefined);
    mocks.prepare.mockImplementation(async params => ({ sourceCoverage: [], previews: [], cards: [{ source_text: params.message.split("\n\n")[0] }] }));
  });

  it("sends only sample-qualified aggregates to assessment and writes only accepted Soul bullets", async () => {
    await saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1), receipt(2)] });
    const input = mocks.prepare.mock.calls[0]![0];
    expect(input.currentDomains).toEqual(["one_memory"]);
    expect(input.currentManifests).toEqual([]);
    expect(input.message).toContain("Supabase (2 receipts)");
    expect(input.message).toContain("Cloud & Infra (2 receipts)");
    expect(input.message).not.toContain("USD");
    expect(input.message).toContain("partial scan");
    for (const raw of ["gmail_live_source", "message-", "INV-", "RAW_PRIVATE_SUBJECT", "RAW_PRIVATE_DETAIL", "124.01", "15:30"]) {
      expect(input.message).not.toContain(raw);
      expect(JSON.stringify(mocks.stage.mock.calls[0]![0])).not.toContain(raw);
    }
    const staged = mocks.stage.mock.calls[0]![0];
    expect(staged.replaceSource).toEqual({ key: expect.stringMatching(/^gmail_receipt_radar:[a-f0-9]{64}$/),
      observedAt: base.now.toISOString() });
    expect(staged.facts).toEqual([{ text: input.message.split("\n\n")[0], section: "Facts" }]);
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(mocks.migrate.mock.invocationCallOrder[0]);
    expect(mocks.migrate).toHaveBeenCalled();
    expect(mocks.legacyWrite).not.toHaveBeenCalled();
  });

  it("separates currencies and never turns unpaid/refunded/unknown amounts or a single charge into spending", () => {
    const facts = buildReceiptTrendObservations([
      receipt(1), receipt(2), receipt(3, { status: "overdue", amount: 99999 }),
      receipt(4, { status: "refunded", amount: 77777 }), receipt(5, { currency: "INR", amount: 20 }),
      receipt(6, { currency: "INR", amount: 30 }), receipt(7, { currency: "EUR", amount: 50 }),
      receipt(8, { amount: null, receipt_date: null }),
    ], base.accountKey, false).join("\n");
    expect(facts).not.toMatch(/USD|INR|EUR|50\.00/);
    expect(facts).not.toContain("99999"); expect(facts).not.toContain("77777"); expect(facts).not.toContain("EUR 50.00");
    expect(facts).toContain("1 undated"); expect(facts).toContain("not all purchases");
  });

  it("does not update memory after incomplete or degraded semantic assessment", async () => {
    mocks.prepare.mockResolvedValueOnce({ cards: [], previews: [], sourceCoverage: [
      { sourceBlockId: "synthetic", disposition: "failed", detectedFactCount: 1, accountedFactCount: 0 },
    ] });
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)] })).rejects.toThrow("existing memory was kept");
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("replaces old receipt memory after a completed empty scan without inventing an aggregate", async () => {
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [], partialScan: false })).resolves.toEqual({ count: 0 });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ facts: [] }));
  });

  it("removes old owned facts when no durable aggregate was selected", async () => {
    mocks.prepare.mockResolvedValueOnce({ sourceCoverage: [], previews: [], cards: [] });
    expect(await saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)] })).toEqual({ count: 0 });
    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ facts: [] }));
  });

  it("rejects a source/account transition during assessment before local staging", async () => {
    let current = true;
    mocks.prepare.mockImplementationOnce(async () => { current = false; return { sourceCoverage: [], previews: [],
      cards: [{ source_text: "Old account observations." }] }; });
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)], isCurrent: () => current })).rejects.toThrow("session changed");
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("never lets a retry adopt a newer Reset generation", async () => {
    mocks.version.mockResolvedValue({ generation: 1, revision: 0 });
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)], ownerGeneration: 0 })).rejects.toThrow("reset");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });
});
