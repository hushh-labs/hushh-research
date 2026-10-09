/**
 * The owner-confirmed save of the receipt canonical index into encrypted PKM.
 *
 * This is the existing governed flow, not a new write path: the same
 * `gmail_receipt_memory_save_button` writer the reserved-branch registry names
 * for `shopping.receipts_memory`, the same `PkmWriteCoordinator`, and the same
 * prepared-domain validation. Its caller is the finished sync the owner started
 * (the product default, which an owner setting can turn off); this module never
 * decides to save on its own.
 */

import {
  buildReceiptCanonicalIndex,
  receiptIndexDigest,
  type ReceiptCanonicalIndex,
} from "@/lib/profile/gmail-receipt-memory-index";
import {
  buildShoppingReceiptCanonicalIndexPreparedDomain,
  RECEIPT_MEMORY_SAVE_WRITER,
} from "@/lib/profile/gmail-receipt-memory-pkm";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

export { RECEIPT_MEMORY_SAVE_WRITER };

export type ReceiptMemorySaveOutcome = {
  /** Canonical transactions in the saved memory. */
  count: number;
};

async function writeReceiptIndex(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  index: ReceiptCanonicalIndex;
  now: Date;
}): Promise<void> {
  const digest = await receiptIndexDigest(params.index);

  // Always written, even when the content is unchanged: the owner's sync is the
  // confirmation that the memory is current, and `generated_at` is how
  // the reader judges that.
  const result = await PkmWriteCoordinator.savePreparedDomain({
    userId: params.userId,
    domain: "shopping",
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: RECEIPT_MEMORY_SAVE_WRITER,
    },
    build: async (context) => {
      const prepared = buildShoppingReceiptCanonicalIndexPreparedDomain({
        currentDomainData: context.currentDomainData,
        currentManifest: context.currentManifest,
        index: params.index,
        digest,
        now: params.now,
      });
      const validation = await PersonalKnowledgeModelService.validatePreparedDomainStore({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        domain: "shopping",
        domainData: prepared.domainData,
        summary: prepared.summary,
        manifest: prepared.manifest,
        structureDecision: prepared.structureDecision,
        baseFullBlob: context.baseFullBlob,
        expectedDataVersion:
          context.currentEncryptedDomain?.dataVersion ?? context.expectedDataVersion,
        upgradeContext: context.upgradeContext,
      });
      if (!validation.success) throw new Error("Failed to validate receipt memory.");
      return prepared;
    },
  });
  if (!result.success) throw new Error("Failed to save receipt memory.");
}

export async function saveReceiptCanonicalIndexToMemory(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  receipts: readonly ReceiptListItem[];
  accountKey: string | null | undefined;
  now?: Date;
}): Promise<ReceiptMemorySaveOutcome> {
  const now = params.now ?? new Date();
  // The very call Mail > Receipts renders from, so memory never disagrees with the page.
  const rows = buildRecentReceiptRows(params.receipts, params.accountKey);
  if (rows.length === 0) {
    throw new Error("There are no receipts to save yet.");
  }
  const index = await buildReceiptCanonicalIndex({
    rows,
    accountKey: String(params.accountKey ?? "").trim(),
    now,
  });
  await writeReceiptIndex({ ...params, index, now });
  return { count: index.total_transactions };
}

/**
 * Resets the saved receipts: the same governed writer saves an empty index,
 * which the page and Chat with One both read as "nothing saved". It runs only
 * after the owner confirms a reset (or disconnects Mail).
 */
export async function resetReceiptCanonicalIndexInMemory(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const index = await buildReceiptCanonicalIndex({ rows: [], accountKey: "", now });
  await writeReceiptIndex({ ...params, index, now });
}
