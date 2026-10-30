import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
const coordinator = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { savePreparedDomain: coordinator } }));
import { migrateReceiptMemory } from "@/lib/mail/receipt-memory-migration";
import { captureReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { assertReceiptMemoryBudget, receiptMemoryForChat, safeReceiptPreference, safeAffinityLabel } from "@/lib/mail/receipt-lightweight-memory";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
const session = { userId: "owner", vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner", isCurrent: () => true };
const legacy = { schema: "receipt_canonical_index.v1", generated_at: "2026-10-01T00:00:00Z", total_transactions: 1, truncated: false,
  transactions: [{ ref: `txn_${"a".repeat(24)}`, merchant: "Amazon", amount: 12.1, currency: "USD", category: "Shopping", status: "paid", transaction_date: "2026-10-01", identifiers: [{ kind: "order", value: "ORDER-1" }], detail: "OLD_SOURCE_PASSAGE" }] };
const current = () => ({ wishlists: { items: ["headphones"] }, receipts_memory: { _canonical_index: structuredClone(legacy),
  readable_summary: { text: "OLD_PRIVATE_DETAIL USD 12.10", updated_at: "2026-10-01T00:00:00Z" }, observed_facts: { recent_highlights: [{ merchant_label: "Amazon", amount: 12.1, currency: "USD", purchased_at: "2026-10-01", reason_code: "high_value", body: "RAW_BODY" }] },
  inferred_preferences: { preference_signals: ["Prefers reusable packaging", "Paid €54.60 on 12/08/2026", "PNR ABC123"] } } });
async function snapshot() { return captureReceiptSnapshot([{ id: 1, source_id: "raw-provider", gmail_message_id: "raw-provider", subject: "RAW_SUBJECT", merchant_name: "Amazon", merchant_domain: "amazon.com", category: "Shopping", category_confidence: 1, amount: 1, amount_decimal: "1.00", currency: "USD", status: "paid", event_type: "purchase", transaction_date: "2026-10-02", identifiers: [{ kind: "order", value: "ORDER-2" }] } satisfies ReceiptListItem], "account", { partial: false, truncated: false, source_count: 1, window_from: null, window_to: null, source: "gmail_live" }); }
beforeEach(() => { vi.restoreAllMocks(); coordinator.mockReset(); Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true }); Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }); });
describe("authorized receipt memory migration", () => {
  it("verifies the encrypted permitted legacy projection before removing the old index, preserving shopping and safe preferences", async () => {
    let cloud: Record<string, unknown> = current();
    coordinator.mockImplementation(async params => {
      const prepared = await params.build({ currentDomainData: cloud, currentManifest: null });
      const keys = await Durable.list("owner", "mail_receipts_legacy.v1:");
      expect(keys).toHaveLength(1);
      const archive = await Durable.read<any>("owner", keys[0]!, session.vaultKey);
      expect(archive!.value.rows[0]).toMatchObject({ merchant: "Amazon", amount: "12.1", currency: "USD", transaction_date: "2026-10-01", identifiers: legacy.transactions[0]!.identifiers });
      expect(JSON.stringify(archive)).not.toMatch(/OLD_SOURCE_PASSAGE|RAW_|subject|body/);
      cloud = prepared.domainData;
      return { success: true };
    });
    await migrateReceiptMemory(session, await snapshot(), 0);
    expect(cloud.wishlists).toEqual({ items: ["headphones"] });
    const memory = cloud.receipts_memory as any;
    expect(memory.inferred_preferences.preference_signals).toEqual(["Prefers reusable packaging"]);
    expect(memory.observed_facts.merchant_affinity).toEqual([{ merchant_label: "Amazon", purchase_count: 1 }]);
    expect(JSON.stringify(memory)).not.toMatch(/_canonical_index|ORDER-|transaction_date|amount|RAW_|OLD_|54.60|PNR/);
    expect(new TextEncoder().encode(JSON.stringify(memory)).length).toBeLessThanOrEqual(16384);
  });
  it("does not replace memory when encrypted read-back fails or the origin was reset", async () => {
    let cloud: Record<string, unknown> = current(); const original = structuredClone(cloud);
    coordinator.mockImplementation(async params => { const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true }; });
    const read = vi.spyOn(Durable, "read"); read.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("synthetic read failure"));
    await expect(migrateReceiptMemory(session, await snapshot(), 0)).rejects.toThrow();
    expect(cloud).toEqual(original);
    read.mockRestore(); await Durable.purgeUser("owner");
    await expect(migrateReceiptMemory(session, await snapshot(), 0)).rejects.toThrow(/reset/);
    expect(cloud).toEqual(original);
  });
  it("never traverses legacy detail in a routine Chat projection and measures a UTF-8 budget", () => {
    const packet = receiptMemoryForChat(current().receipts_memory);
    expect(JSON.stringify(packet)).not.toMatch(/OLD_|RAW_|12.10|ORDER-|canonical_index|recent_highlights/);
    expect(safeReceiptPreference("Paid €54.60 on 12/08/2026")).toBe(false);
    expect(safeReceiptPreference("PNR ABC123")).toBe(false);
    expect(safeAffinityLabel("Amazon order ABC123")).toBe(false);
    expect(safeAffinityLabel("Amazon October 4 2026")).toBe(false);
    expect(safeAffinityLabel("7 Eleven")).toBe(true);
    expect(receiptMemoryForChat({ observed_facts: { merchant_affinity: ["Amazon order ABC123", "Amazon October 4 2026"].map(merchant_label => ({ merchant_label, purchase_count: 1 })) } })).toMatchObject({ merchant_affinity: [] });
    expect(() => assertReceiptMemoryBudget("界".repeat(5460))).not.toThrow();
    expect(() => assertReceiptMemoryBudget("界".repeat(5462))).toThrow(/16 KiB/);
  });

  it("rechecks owner authority after awaited storage reads and passes the final publication guard", async () => {
    let ownerCurrent = true;
    const guardedSession = { ...session, isCurrent: () => ownerCurrent };
    const canonical = await snapshot();
    vi.spyOn(Durable, "version").mockImplementation(async () => {
      ownerCurrent = false;
      return { generation: 0, revision: 1 };
    });
    coordinator.mockImplementation(async params => {
      expect(params.mayPublish).toBe(guardedSession.isCurrent);
      await params.beforeEffect();
      throw new Error("A switched owner must not reach publication.");
    });
    await expect(migrateReceiptMemory(guardedSession, canonical, 0, 1)).rejects.toThrow(/authority changed/);
  });

  it("refuses a reused snapshot revision after Reset changes its generation", async () => {
    const canonical = await snapshot();
    vi.spyOn(Durable, "version").mockResolvedValue({ generation: 1, revision: 1 });
    coordinator.mockImplementation(async params => {
      await params.beforeEffect();
      throw new Error("A reset generation must not reach publication.");
    });
    await expect(migrateReceiptMemory(session, canonical, 0, 1)).rejects.toThrow(/reset/);
    expect(Durable.version).toHaveBeenCalledOnce();
    expect(Durable.version).toHaveBeenCalledWith("owner", `mail_receipts.v2:${canonical.account_binding}`);
  });

  it("archives permitted index-free legacy highlights before replacing their memory branch", async () => {
    const cloud: Record<string, unknown> = current(); delete (cloud.receipts_memory as Record<string, unknown>)._canonical_index;
    coordinator.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: cloud });
      const keys = await Durable.list("owner", "mail_receipts_legacy.v1:");
      const archive = await Durable.read<any>("owner", keys[0]!, session.vaultKey);
      expect(archive!.value.rows).toEqual([expect.objectContaining({ merchant: "Amazon", amount: "12.1", currency: "USD", transaction_date: "2026-10-01", status: null, identifiers: [] })]);
      expect(JSON.stringify(archive)).not.toMatch(/RAW_|body|high_value/);
      expect(plan.domainData.receipts_memory).not.toHaveProperty("observed_facts.recent_highlights");
      return { success: true };
    });
    await migrateReceiptMemory(session, await snapshot(), 0);
  });
});
