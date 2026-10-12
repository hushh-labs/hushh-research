import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), load: vi.fn(), stage: vi.fn(), legacyWrite: vi.fn() }));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/pkm/pkm-natural-language-ingestion")>(), prepareNaturalLanguagePkm: mocks.prepare,
}));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  MARKDOWN_MEMORY_DOMAIN: "one_memory", loadMarkdownMemory: mocks.load, stageMarkdownMemoryFacts: mocks.stage,
  markdownFactsFromCards: (cards: Array<{source_text:string; preparation_requires_review?:boolean}>) =>
    cards.filter(card => !card.preparation_requires_review).map(card => ({ text: card.source_text, section: "Facts" })),
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { savePreparedDomain: mocks.legacyWrite } }));

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
    mocks.stage.mockResolvedValue({ success: true, saved: 1 });
    mocks.prepare.mockResolvedValue({ sourceCoverage: [], previews: [],
      cards: [{ source_text: "Receipt Radar's observed sample includes frequent Supabase receipts." }] });
  });

  it("sends only sample-qualified aggregates to assessment and writes only accepted Soul bullets", async () => {
    await saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1), receipt(2)] });
    const input = mocks.prepare.mock.calls[0]![0];
    expect(input.currentDomains).toEqual(["one_memory"]);
    expect(input.currentManifests).toEqual([]);
    expect(input.message).toContain("Supabase (2 receipts)");
    expect(input.message).toContain("Cloud & Infra (2 receipts)");
    expect(input.message).toContain("USD 248.02");
    expect(input.message).toContain("partial scan");
    for (const raw of ["gmail_live_source", "message-", "INV-", "RAW_PRIVATE_SUBJECT", "RAW_PRIVATE_DETAIL", "124.01", "15:30"]) {
      expect(input.message).not.toContain(raw);
      expect(JSON.stringify(mocks.stage.mock.calls[0]![0])).not.toContain(raw);
    }
    const staged = mocks.stage.mock.calls[0]![0];
    expect(staged.replaceSource).toEqual({ key: expect.stringMatching(/^gmail_receipt_radar:[a-f0-9]{64}$/),
      observedAt: base.now.toISOString() });
    expect(staged.facts).toEqual([{ text: "Receipt Radar's observed sample includes frequent Supabase receipts.", section: "Facts" }]);
    expect(mocks.legacyWrite).not.toHaveBeenCalled();
  });

  it("separates currencies and never turns unpaid/refunded/unknown amounts or a single charge into spending", () => {
    const facts = buildReceiptTrendObservations([
      receipt(1), receipt(2), receipt(3, { status: "overdue", amount: 99999 }),
      receipt(4, { status: "refunded", amount: 77777 }), receipt(5, { currency: "INR", amount: 20 }),
      receipt(6, { currency: "INR", amount: 30 }), receipt(7, { currency: "EUR", amount: 50 }),
      receipt(8, { amount: null, receipt_date: null }),
    ], base.accountKey, false).join("\n");
    expect(facts).toContain("USD 248.02"); expect(facts).toContain("INR 50.00");
    expect(facts).not.toContain("99999"); expect(facts).not.toContain("77777"); expect(facts).not.toContain("EUR 50.00");
    expect(facts).toContain("1 undated"); expect(facts).toContain("not total spending");
  });

  it("does not update memory after incomplete or degraded semantic assessment", async () => {
    mocks.prepare.mockResolvedValueOnce({ cards: [], previews: [], sourceCoverage: [
      { sourceBlockId: "synthetic", disposition: "failed", detectedFactCount: 1, accountedFactCount: 0 },
    ] });
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)] })).rejects.toThrow("existing memory was kept");
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("has no effect without receipts or when no durable aggregate was selected", async () => {
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [] })).rejects.toThrow(/no receipts/i);
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.prepare.mockResolvedValueOnce({ sourceCoverage: [], previews: [], cards: [] });
    expect(await saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)] })).toEqual({ count: 0 });
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("rejects a source/account transition during assessment before local staging", async () => {
    let current = true;
    mocks.prepare.mockImplementationOnce(async () => { current = false; return { sourceCoverage: [], previews: [],
      cards: [{ source_text: "Old account observations." }] }; });
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)], isCurrent: () => current })).rejects.toThrow("session changed");
    expect(mocks.stage).not.toHaveBeenCalled();
  });
});
