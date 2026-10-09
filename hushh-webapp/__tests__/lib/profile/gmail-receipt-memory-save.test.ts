import { beforeEach, describe, expect, it, vi } from "vitest";

const savePreparedDomain = vi.fn();
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { savePreparedDomain: (...args: unknown[]) => savePreparedDomain(...args) },
}));

const validatePreparedDomainStore = vi.fn();
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    validatePreparedDomainStore: (...args: unknown[]) => validatePreparedDomainStore(...args),
  },
}));

import {
  RECEIPT_MEMORY_SAVE_WRITER,
  resetReceiptCanonicalIndexInMemory,
  saveReceiptCanonicalIndexToMemory,
} from "@/lib/profile/gmail-receipt-memory-save";
import { RECEIPT_INDEX_BRANCH } from "@/lib/profile/gmail-receipt-memory-index";
import { reservedEntryFor } from "@/lib/pkm/reserved-branches";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

function receipt(id: number): ReceiptListItem {
  return {
    id,
    source_id: `gmail_live_source_${id}`,
    source_kind: "gmail_live",
    gmail_message_id: `message-${id}`,
    merchant_name: "Supabase",
    merchant_domain: "supabase.io",
    subject: "Invoice",
    event_type: "purchase",
    amount: 124.01,
    currency: "USD",
    status: "overdue",
    document_kind: "invoice",
    receipt_date: "2026-10-04T15:30:00Z",
    identifiers: [{ kind: "invoice", value: `INV-${id}` }],
  };
}

const base = {
  userId: "user-1",
  vaultKey: "vault-key",
  vaultOwnerToken: "owner-token",
  accountKey: "owner@example.com",
  now: new Date("2026-10-09T10:00:00Z"),
};

describe("saving the receipt canonical index to private memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validatePreparedDomainStore.mockResolvedValue({ success: true });
    savePreparedDomain.mockImplementation(async (params: { build: (c: unknown) => unknown }) => {
      await params.build({
        currentDomainData: { wishlists: { items: ["a"] } },
        currentManifest: null,
        baseFullBlob: {},
        currentEncryptedDomain: null,
        expectedDataVersion: 3,
        upgradeContext: undefined,
      });
      return { success: true };
    });
  });

  it("uses only the owner-confirmed writer the reserved registry names for this branch", async () => {
    await saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1), receipt(2)] });

    expect(savePreparedDomain).toHaveBeenCalledOnce();
    const params = savePreparedDomain.mock.calls[0]![0];
    expect(params.domain).toBe("shopping");
    expect(params.confirmation).toEqual({
      confirmedByUser: true,
      surface: "web",
      source: "gmail_receipt_memory_save_button",
    });
    // The registry, not this test, is the authority: the writer must be catalogued for the branch.
    expect(RECEIPT_MEMORY_SAVE_WRITER).toBe("gmail_receipt_memory_save_button");
    const entry = reservedEntryFor("shopping", "receipts_memory");
    expect(entry?.writerIds.has(RECEIPT_MEMORY_SAVE_WRITER)).toBe(true);
    // Only that writer: an agent-pipeline label would be refused for this branch.
    expect(entry?.writerIds.has("agent_chat_memory")).toBe(false);
  });

  it("validates the prepared domain, preserving siblings and adding the index", async () => {
    const outcome = await saveReceiptCanonicalIndexToMemory({
      ...base,
      receipts: [receipt(1), receipt(2)],
    });
    expect(outcome.count).toBe(2);
    const validated = validatePreparedDomainStore.mock.calls[0]![0];
    expect(validated.domain).toBe("shopping");
    expect(validated.domainData.wishlists).toEqual({ items: ["a"] });
    expect(validated.domainData.receipts_memory[RECEIPT_INDEX_BRANCH].transactions).toHaveLength(2);
    expect(validated.expectedDataVersion).toBe(3);
  });

  it("has nothing to save without receipts and never calls the writer", async () => {
    await expect(saveReceiptCanonicalIndexToMemory({ ...base, receipts: [] })).rejects.toThrow(
      /no receipts to save/i,
    );
    expect(savePreparedDomain).not.toHaveBeenCalled();
  });

  it("fails loudly when validation or the write is refused, never reporting a save", async () => {
    validatePreparedDomainStore.mockResolvedValueOnce({ success: false });
    await expect(
      saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)] }),
    ).rejects.toThrow(/validate receipt memory/i);
    savePreparedDomain.mockResolvedValueOnce({ success: false });
    await expect(
      saveReceiptCanonicalIndexToMemory({ ...base, receipts: [receipt(1)] }),
    ).rejects.toThrow(/save receipt memory/i);
  });

  it("resets through the very same governed writer by saving an empty index, with its summary rewritten", async () => {
    let written: Record<string, unknown> | null = null;
    savePreparedDomain.mockImplementation(async (params: { build: (c: unknown) => Promise<{ domainData: Record<string, unknown> }> }) => {
      const prepared = await params.build({
        currentDomainData: {
          receipts_memory: {
            readable_summary: {
              text: "Saved 3 receipts from your Mail.",
              highlights: [],
              updated_at: "2026-10-01T00:00:00Z",
              source_label: "Gmail receipts",
              generated_by: "receipt_canonical_index",
            },
            [RECEIPT_INDEX_BRANCH]: { schema: "receipt_canonical_index.v1" },
          },
        },
        currentManifest: null,
        baseFullBlob: {},
        currentEncryptedDomain: null,
        expectedDataVersion: 3,
        upgradeContext: undefined,
      });
      written = prepared.domainData;
      return { success: true };
    });

    await resetReceiptCanonicalIndexInMemory({
      userId: base.userId,
      vaultKey: base.vaultKey,
      vaultOwnerToken: base.vaultOwnerToken,
      now: base.now,
    });

    expect(savePreparedDomain).toHaveBeenCalledOnce();
    expect(savePreparedDomain.mock.calls[0]![0].confirmation.source).toBe(RECEIPT_MEMORY_SAVE_WRITER);
    const memory = (written as unknown as { receipts_memory: Record<string, unknown> }).receipts_memory;
    const index = memory[RECEIPT_INDEX_BRANCH] as { total_transactions: number; transactions: unknown[] };
    expect(index.total_transactions).toBe(0);
    expect(index.transactions).toEqual([]);
    // The stale "Saved 3 receipts" text is ours, so it is rewritten, not kept.
    expect((memory.readable_summary as { text: string }).text).toBe("No receipts are saved.");
  });

  it("does not report a reset that the writer refused", async () => {
    savePreparedDomain.mockResolvedValue({ success: false });
    await expect(
      resetReceiptCanonicalIndexInMemory({
        userId: base.userId,
        vaultKey: base.vaultKey,
        vaultOwnerToken: base.vaultOwnerToken,
      }),
    ).rejects.toThrow("Failed to save receipt memory.");
  });
});
