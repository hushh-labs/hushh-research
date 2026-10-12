/** Receipt Radar contributes aggregate observations to Soul, never transactions. */
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import { RECEIPT_MEMORY_SAVE_WRITER } from "@/lib/profile/gmail-receipt-memory-pkm";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { isUnresolvedSourceBlock, prepareNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
import { loadMarkdownMemory, MARKDOWN_MEMORY_DOMAIN, markdownFactsFromCards, stageMarkdownMemoryFacts } from "@/lib/pkm/markdown-memory";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

export { RECEIPT_MEMORY_SAVE_WRITER };
export type ReceiptMemorySaveOutcome = { count: number };

/** Mathematical projection only. Memory agents still select durable statements. */
export function buildReceiptTrendObservations(receipts: readonly ReceiptListItem[], accountKey: string | null | undefined, partialScan = true): string[] {
  const rows = buildRecentReceiptRows(receipts, accountKey);
  if (!rows.length) return [];
  const merchants = new Map<string, number>();
  const categories = new Map<string, number>();
  const totals = new Map<string, { count: number; amount: number }>();
  const months: string[] = [];
  for (const row of rows) {
    // A merchant is only a bounded, Markdown-inert label, never email content.
    const merchant = row.merchantName.replace(/[\r\n\t*_\x60~[\]<>\\|]/g, " ").replace(/\s+/g, " ").trim();
    if (row.displayKind === "merchant" && merchant.length <= 80 && !/https?:|www\.|@/i.test(merchant))
      merchants.set(merchant, (merchants.get(merchant) ?? 0) + 1);
    if (row.category && row.category !== "Other" && row.category !== "Uncategorized")
      categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
    const currency = row.currency?.toUpperCase();
    // An invoice/refund/trial is not proof of paid spend.
    if ((row.status === "paid" || row.status === "delivered") && currency && /^[A-Z]{3}$/.test(currency) &&
      typeof row.amount === "number" && Number.isFinite(row.amount) && row.amount >= 0) {
      const total = totals.get(currency) ?? { count: 0, amount: 0 };
      totals.set(currency, { count: total.count + 1, amount: total.amount + row.amount });
    }
    if (row.receiptDate && Number.isFinite(Date.parse(row.receiptDate))) months.push(new Date(row.receiptDate).toISOString().slice(0, 7));
  }
  months.sort();
  const period = months.length ? `dated ${months[0]} through ${months.at(-1)}` : "with no verified date range";
  const basis = `Receipt Radar's observed sample (${rows.length} receipts, ${period}; ${rows.length - months.length} undated; ${partialScan ? "partial scan" : "completed scan, not all purchases"})`;
  const ranked = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  return [
    `${basis}: the most represented merchants are ${ranked(merchants).map(([label, count]) => `${label} (${count} receipts)`).join(", ") || "not verified"}.`,
    ...(categories.size ? [`${basis}: the most represented categories are ${ranked(categories).map(([label, count]) => `${label} (${count} receipts)`).join(", ")}.`] : []),
    ...[...totals].filter(([, total]) => total.count > 1 && Number.isFinite(total.amount)).sort(([a], [b]) => a.localeCompare(b)).slice(0, 4).map(([currency, total]) =>
      `${basis}: recorded paid/delivered amounts total ${currency} ${total.amount.toFixed(2)} across ${total.count} receipts with known amounts; this is not total spending.`),
  ];
}

/** Compatibility entrypoint; its old name no longer authorizes an index write. */
export async function saveReceiptCanonicalIndexToMemory(params: {
  userId: string; vaultKey: string; vaultOwnerToken: string;
  receipts: readonly ReceiptListItem[]; accountKey: string | null | undefined;
  now?: Date; partialScan?: boolean; isCurrent?: () => boolean;
}): Promise<ReceiptMemorySaveOutcome> {
  const guard = createAgentPkmCaptureGuard({ userId: params.userId,
    signal: new AbortController().signal, isEnabled: params.isCurrent ?? (() => true) });
  await guard.assertCurrent();
  const observations = buildReceiptTrendObservations(params.receipts, params.accountKey, params.partialScan);
  if (!observations.length) throw new Error("There are no receipts to save yet.");
  const observedAt = (params.now ?? new Date()).toISOString();
  const key = `gmail_receipt_radar:${await sha256Hex(String(params.accountKey ?? ""))}`;
  const session = { userId: params.userId, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken };
  await loadMarkdownMemory(session);
  await guard.assertCurrent();
  // Exact-source selection over a few factual aggregate sentences, not raw
  // receipts or a second router. No host-inferred preferences or cadence.
  const prepared = await prepareNaturalLanguagePkm({
    userId: params.userId, vaultOwnerToken: params.vaultOwnerToken,
    message: observations.join("\n\n"), currentDomains: [MARKDOWN_MEMORY_DOMAIN], currentManifests: [],
    source: RECEIPT_MEMORY_SAVE_WRITER, allowEmpty: true,
    beforeEffect: guard.assertCurrent, isEffectCurrent: guard.isCurrent,
  });
  await guard.assertCurrent();
  if (prepared.sourceCoverage.some(isUnresolvedSourceBlock) || prepared.previews.some(preview => preview.used_fallback || preview.error))
    throw new Error("Receipt trends could not be assessed. Your existing memory was kept.");
  const facts = markdownFactsFromCards(prepared.cards);
  if (!facts.length) return { count: 0 };
  const result = await stageMarkdownMemoryFacts({ ...session, facts, replaceSource: { key, observedAt },
    beforeEffect: guard.assertCurrent,
    confirmation: { confirmedByUser: true, surface: "web", source: RECEIPT_MEMORY_SAVE_WRITER },
  });
  if (!result.success) throw new Error("Receipt trends could not be added to Soul.md.");
  return { count: result.saved };
}
