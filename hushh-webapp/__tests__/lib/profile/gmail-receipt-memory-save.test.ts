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
});
