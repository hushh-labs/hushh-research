/** Receipt Radar contributes aggregate observations to Soul, never transactions. */
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import { RECEIPT_MEMORY_SAVE_WRITER } from "@/lib/profile/gmail-receipt-memory-pkm";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { isUnresolvedSourceBlock, prepareNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
import { loadMarkdownMemory, MARKDOWN_MEMORY_DOMAIN, markdownFactsFromCards, stageMarkdownMemoryFacts } from "@/lib/pkm/markdown-memory";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { captureReceiptSnapshot, RECEIPT_SNAPSHOT_PREFIX } from "@/lib/mail/receipt-snapshot";
import { receiptStoreVersion, writeReceiptSnapshot, loadReceiptSnapshot } from "@/lib/mail/receipt-store";
import { migrateReceiptMemory } from "@/lib/mail/receipt-memory-migration";
import { assertLightweightReceiptFacts, safeAffinityLabel } from "@/lib/mail/receipt-lightweight-memory";

export { RECEIPT_MEMORY_SAVE_WRITER };
export type ReceiptMemorySaveOutcome = { count: number };

/** Mathematical projection only. Memory agents still select durable statements. */
export function buildReceiptTrendObservations(receipts: readonly ReceiptListItem[], accountKey: string | null | undefined, partialScan = true): string[] {
  const rows = buildRecentReceiptRows(receipts, accountKey);
  if (!rows.length) return [];
  const merchants = new Map<string, number>();
  const categories = new Map<string, number>();
  const months: string[] = [];
  for (const row of rows) {
    // A merchant is only a bounded, Markdown-inert label, never email content.
    const merchant = row.merchantName.replace(/[\r\n\t*_\x60~[\]<>\\|]/g, " ").replace(/\s+/g, " ").trim();
    if (row.displayKind === "merchant" && merchant.length <= 80 && safeAffinityLabel(merchant))
      merchants.set(merchant, (merchants.get(merchant) ?? 0) + 1);
    if (row.category && row.category !== "Other" && row.category !== "Uncategorized")
      categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
    if (row.receiptDate && Number.isFinite(Date.parse(row.receiptDate))) months.push(new Date(row.receiptDate).toISOString().slice(0, 7));
  }
  months.sort();
  const period = months.length ? `dated ${months[0]} through ${months.at(-1)}` : "with no verified date range";
  const basis = `Receipt Radar's observed sample (${rows.length} receipts, ${period}; ${rows.length - months.length} undated; ${partialScan ? "partial scan" : "completed scan, not all purchases"})`;
  const ranked = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  return [
    `${basis}: the most represented merchants are ${ranked(merchants).map(([label, count]) => `${label} (${count} receipts)`).join(", ") || "not verified"}.`,
    ...(categories.size ? [`${basis}: the most represented categories are ${ranked(categories).map(([label, count]) => `${label} (${count} receipts)`).join(", ")}.`] : []),
  ];
}

/** Compatibility entrypoint; its old name no longer authorizes an index write. */
export async function saveReceiptCanonicalIndexToMemory(params: {
  userId: string; vaultKey: string; vaultOwnerToken: string;
  receipts: readonly ReceiptListItem[]; accountKey: string | null | undefined;
  now?: Date; partialScan?: boolean; isCurrent?: () => boolean; ownerGeneration?: number; snapshotRevision?: number;
}): Promise<ReceiptMemorySaveOutcome> {
  const guard = createAgentPkmCaptureGuard({ userId: params.userId,
    signal: new AbortController().signal, isEnabled: params.isCurrent ?? (() => true) });
  await guard.assertCurrent();
  if (!params.accountKey) throw new Error("A Mail account is required to save receipt memory.");
  const session = { userId: params.userId, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken, isCurrent: guard.isCurrent };
  const expected = await receiptStoreVersion(params.userId, params.accountKey);
  if (params.ownerGeneration !== undefined && expected.generation !== params.ownerGeneration)
    throw new Error("Receipt sync was reset. Sync again before updating memory.");
  if (params.snapshotRevision !== undefined && expected.revision !== params.snapshotRevision)
    throw new Error("Saved receipts changed. Sync again before updating memory.");
  const persisted = params.snapshotRevision !== undefined && params.snapshotRevision > 0
    ? await loadReceiptSnapshot(session, params.accountKey) : null;
  if (params.snapshotRevision !== undefined && params.snapshotRevision > 0 && (!persisted || persisted.revision !== params.snapshotRevision))
    throw new Error("Saved receipt verification failed. Existing memory was kept.");
  const snapshot = persisted?.value ?? await captureReceiptSnapshot(params.receipts, params.accountKey, {
    partial: params.partialScan ?? true, truncated: params.partialScan ?? true, source_count: params.receipts.length,
    window_from: null, window_to: null, source: "gmail_live",
  }, params.now);
  const verified = persisted ?? await writeReceiptSnapshot(session, snapshot, expected);
  await guard.assertCurrent();
  const observations = buildReceiptTrendObservations(params.receipts, params.accountKey, params.partialScan);
  const observedAt = (params.now ?? new Date()).toISOString();
  const key = `gmail_receipt_radar:${await sha256Hex(String(params.accountKey ?? ""))}`;
  await loadMarkdownMemory(session);
  await guard.assertCurrent();
  // Exact-source selection over a few factual aggregate sentences, not raw
  // receipts or a second router. No host-inferred preferences or cadence.
  const prepared = observations.length ? await prepareNaturalLanguagePkm({
    userId: params.userId, vaultOwnerToken: params.vaultOwnerToken,
    message: observations.join("\n\n"), currentDomains: [MARKDOWN_MEMORY_DOMAIN], currentManifests: [],
    source: RECEIPT_MEMORY_SAVE_WRITER, allowEmpty: true,
    beforeEffect: guard.assertCurrent, isEffectCurrent: guard.isCurrent,
  }) : { cards: [], previews: [], sourceCoverage: [] };
  await guard.assertCurrent();
  if (prepared.sourceCoverage.some(isUnresolvedSourceBlock) || prepared.previews.some(preview => preview.used_fallback || preview.error))
    throw new Error("Receipt trends could not be assessed. Your existing memory was kept.");
  const facts = prepared.cards.flatMap(card => {
    if (!markdownFactsFromCards([card]).length) return [];
    const selected = card.source_text?.trim();
    const observation = selected && observations.find(text => text.includes(selected));
    if (!observation) throw new Error("Receipt trends must select approved aggregate observations. Existing memory was kept.");
    // Assessment selects evidence; it cannot rewrite aggregates into exact
    // charges or invent products/preferences in receipt-owned Soul memory.
    return [{ text: observation, section: "Facts" as const }];
  }).filter((fact, index, all) => all.findIndex(other => other.text === fact.text) === index);
  assertLightweightReceiptFacts(facts);
  const assertSnapshotCurrent = async () => {
    await guard.assertCurrent();
    const current = await receiptStoreVersion(params.userId, params.accountKey!);
    if (current.generation !== verified.generation || current.revision !== verified.revision)
      throw new Error("Saved receipts changed during assessment. Sync again before updating memory.");
  };
  await assertSnapshotCurrent();
  await migrateReceiptMemory(session, snapshot, verified.generation, verified.revision);
  await guard.assertCurrent();
  const result = await stageMarkdownMemoryFacts({ ...session, facts, replaceSource: { key, observedAt },
    receiptGeneration: verified.generation,
    receiptSnapshotFence: { resourceKey: RECEIPT_SNAPSHOT_PREFIX + snapshot.account_binding, revision: verified.revision },
    beforeEffect: assertSnapshotCurrent,
    confirmation: { confirmedByUser: true, surface: "web", source: RECEIPT_MEMORY_SAVE_WRITER },
  });
  if (!result.success) throw new Error("Receipt trends could not be added to memory.md.");
  return { count: result.saved };
}
