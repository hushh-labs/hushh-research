"use client";
import { readReceiptCanonicalIndex } from "@/lib/profile/gmail-receipt-memory-index";
import { buildShoppingReceiptCanonicalIndexPreparedDomain } from "@/lib/profile/gmail-receipt-memory-pkm";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import { receiptAccountBinding, validateReceiptSnapshot, RECEIPT_SNAPSHOT_PREFIX, type ReceiptSnapshot } from "./receipt-snapshot";
import { lightweightReceiptMemory, assertReceiptMemoryBudget, safeReceiptPreference } from "./receipt-lightweight-memory";
import type { ReceiptStoreSession } from "./receipt-store";

/** Move active legacy detail only after encrypted commit + verified read-back.
 * Legacy coverage/account provenance is incomplete. It is never combined with
 * a current account or used as that account's canonical analytical source. */
export async function migrateReceiptMemory(session: ReceiptStoreSession, snapshot: ReceiptSnapshot, generation: number, revision?: number) {
  const beforeEffect = async () => {
    if (!(session.isCurrent?.() ?? true))
      throw new Error("Receipt memory update was reset or its authority changed.");
    const version = await SecureDurableResourceService.version(session.userId,
      revision === undefined ? "mail_receipt_migration.v1" : RECEIPT_SNAPSHOT_PREFIX + snapshot.account_binding);
    if (!(session.isCurrent?.() ?? true) || version.generation !== generation)
      throw new Error("Receipt memory update was reset or its authority changed.");
    if (revision !== undefined && version.revision !== revision)
      throw new Error("Saved receipts changed during assessment. Sync again before updating memory.");
  };
  const result = await PkmWriteCoordinator.savePreparedDomain({ ...session, domain: "shopping",
    mayPublish: session.isCurrent,
    confirmation: { confirmedByUser: true, surface: "web", source: "gmail_receipt_memory_save_button" }, beforeEffect,
    build: async context => {
      await beforeEffect();
      const legacy = readReceiptCanonicalIndex(context.currentDomainData);
      const prior = context.currentDomainData.receipts_memory as Record<string, unknown> | undefined;
      if (!legacy && prior?._canonical_index)
        throw new Error("Legacy receipt memory couldn't be validated. Existing memory was kept.");
      const highlights = (prior?.observed_facts as { recent_highlights?: unknown } | undefined)?.recent_highlights;
      if (highlights !== undefined && (!Array.isArray(highlights) || highlights.length > 100))
        throw new Error("Legacy receipt highlights couldn't be validated. Existing memory was kept.");
      if (legacy || (Array.isArray(highlights) && highlights.length)) {
        const account_binding = await receiptAccountBinding(`legacy_unattributed:${JSON.stringify({ legacy, highlights })}`);
        const rows: ReceiptSnapshot["rows"] = [];
        for (const t of legacy?.transactions ?? []) {
          // Legacy short_detail was free source prose. The authorized migration
          // preserves allowed canonical facts, never that excluded passage.
          // Read-back parity below covers this closed normalized projection.
          const ref = await receiptAccountBinding(t.ref);
          const kind = t.status === "refunded" ? "refund" : t.status === "cancelled" ? "cancellation" : t.status === "delivered" ? "fulfillment" : "purchase";
          const amount = t.amount === null ? null : String(t.amount);
          rows.push({ ref, display_id: `group-${ref}`, primary_event_ref: ref, merchant: t.merchant ?? "Receipt", category: t.category,
            display_kind: t.merchant ? "merchant" : "generic", brand: null, amount, currency: t.currency,
            transaction_date: t.transaction_date, identifiers: t.identifiers.map(i => ({ ...i })), status: t.status,
            recurrence: "unknown", attention_state: "none", attention_reason: null, attention_is_prediction: false,
            attention_date: null, document_kind: null, confidence: null,
            events: [{ ref, locator: null, document_kind: null, status: t.status, kind, date: t.transaction_date, amount, currency: t.currency }],
          });
        }
        for (const [index, value] of (Array.isArray(highlights) ? highlights : []).entries()) {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Legacy receipt highlights couldn't be validated. Existing memory was kept.");
          const h = value as Record<string, unknown>;
          const allowed = { merchant: h.merchant_label, amount: h.amount ?? null, currency: h.currency ?? null, transaction_date: h.purchased_at ?? null };
          const ref = await receiptAccountBinding(`legacy-highlight:${index}:${JSON.stringify(allowed)}`);
          const amount = allowed.amount === null ? null : typeof allowed.amount === "number" && Number.isFinite(allowed.amount) ? String(allowed.amount) : "invalid";
          rows.push({ ref, display_id: `group-${ref}`, primary_event_ref: ref,
            merchant: allowed.merchant as string, category: "Uncategorized", display_kind: "merchant", brand: null,
            amount, currency: allowed.currency as string | null, transaction_date: allowed.transaction_date as string | null,
            identifiers: [], status: null, recurrence: "unknown", attention_state: "none", attention_reason: null,
            attention_is_prediction: false, attention_date: null, document_kind: null, confidence: null,
            events: [{ ref, locator: null, document_kind: null, status: null, kind: "unknown", date: allowed.transaction_date as string | null, amount, currency: allowed.currency as string | null }],
          });
        }
        const freshness = legacy?.generated_at ?? (prior?.provenance as { imported_at?: unknown } | undefined)?.imported_at ?? (prior?.readable_summary as { updated_at?: unknown } | undefined)?.updated_at ?? snapshot.freshness;
        const archive = validateReceiptSnapshot({ schema: "mail_receipt_snapshot.v1", account_binding, freshness,
          coverage: { partial: true, truncated: legacy?.truncated ?? false, source_count: Math.max(legacy?.total_transactions ?? 0, rows.length), window_from: null, window_to: null, source: "legacy_pkm" }, rows });
        const resourceKey = `mail_receipts_legacy.v1:${account_binding}`;
        const priorArchive = await SecureDurableResourceService.read<ReceiptSnapshot>(session.userId, resourceKey, session.vaultKey);
        if (!priorArchive) await SecureDurableResourceService.write({ ...session, resourceKey, value: archive,
          expected: { generation, revision: 0 }, isCurrent: session.isCurrent ?? (() => true) });
        const readback = await SecureDurableResourceService.read<ReceiptSnapshot>(session.userId, resourceKey, session.vaultKey);
        if (!readback || JSON.stringify(validateReceiptSnapshot(readback.value)) !== JSON.stringify(archive))
          throw new Error("Legacy receipt snapshot verification failed. Existing memory was kept.");
      }
      await beforeEffect();
      const lightweight = lightweightReceiptMemory(snapshot);
      const preferences = (prior?.inferred_preferences as { preference_signals?: unknown[] } | undefined)?.preference_signals ?? [];
      for (const signal of preferences.slice(0, 20)) {
        const label = typeof signal === "string" ? signal : (signal as { label?: unknown } | null)?.label;
        if (safeReceiptPreference(label)) lightweight.inferred_preferences.preference_signals.push(label);
      }
      assertReceiptMemoryBudget(lightweight);
      return buildShoppingReceiptCanonicalIndexPreparedDomain({ currentDomainData: context.currentDomainData,
        currentManifest: context.currentManifest, index: { schema: "receipt_canonical_index.v1", generated_at: snapshot.freshness,
          total_transactions: snapshot.rows.length, truncated: snapshot.coverage.truncated, transactions: [] },
        digest: await receiptAccountBinding(JSON.stringify(snapshot)), now: new Date(snapshot.freshness),
        lightweightMemory: lightweight, archiveVerified: true });
    },
  });
  if (!result.success) throw new Error(result.message || "Receipt memory couldn't be updated. Existing memory was kept.");
}
