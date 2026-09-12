"use client";

/**
 * Download everything One remembers about you.
 *
 * Two halves in one file, because either alone is half a promise:
 *
 *   readable    every domain decrypted, so a person can actually read what the
 *               agent knows about them without our app.
 *   restorable  the encrypted blobs and vault-key wrappers, so the same file can
 *               put it back.
 *
 * A readable-only export is a document you cannot restore from. A ciphertext-only
 * export is a backup you cannot read. The whole point of asking for your own
 * memory is to have both.
 *
 * This must run in the browser. The backend stores ciphertext and holds no key:
 * `personal_knowledge_model_service.py` has no decrypt path at all, and
 * `/api/account/export` says so in its own docstring ("No plaintext PKM
 * content"). So the readable half can only be assembled here, with the vault
 * unlocked, and the export is unavailable while it is locked.
 *
 * What this deliberately does NOT include:
 *
 *   consent_audit and the other audit trails. Those record what a person was
 *   shown and what they agreed to. They exist for accountability, not for
 *   convenience, and a personal download is not the right door for them.
 *
 *   The roughly 176 non-memory tables an account reset would clear -- other
 *   products built on the same account (Kai, RIA, the developer platform),
 *   connector caches that rebuild themselves on reconnect, and pod
 *   infrastructure bindings. This file is memory, and `meta.excludes` says so
 *   plainly so nobody mistakes it for a full account backup.
 */

import { AccountService } from "@/lib/services/account-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { downloadTextFile } from "@/lib/utils/native-download";

export const MEMORY_EXPORT_VERSION = 1;

/** Keys that must never reach a personal download, whatever the API returns. */
const EXCLUDED_RESTORABLE_KEYS = ["consent_audit"] as const;

export type MemoryExportMeta = {
  export_version: number;
  exported_at: string;
  user_id: string;
  domains: string[];
  domain_count: number;
  /** Present only when the encrypted half could not be fetched. */
  restorable_error?: string;
  restore_requires: string;
  excludes: string[];
};

export type MemoryExport = {
  meta: MemoryExportMeta;
  readable: Record<string, unknown>;
  restorable: Record<string, unknown> | null;
};

export class MemoryExportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryExportUnavailableError";
  }
}

function stripExcluded(
  data: Record<string, unknown> | undefined | null,
): Record<string, unknown> | null {
  if (!data) return null;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if ((EXCLUDED_RESTORABLE_KEYS as readonly string[]).includes(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/** A stable, human-obvious filename: one export per person per day reads clearly. */
export function memoryExportFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10) || "export";
  return `hushh-memory-${day}.json`;
}

export const PkmExportService = {
  /**
   * Assemble the export. Requires an unlocked vault: without the key there is
   * nothing readable to assemble, and returning the ciphertext alone would be a
   * file that silently answers a different question than the one asked.
   */
  async buildMemoryExport(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<MemoryExport> {
    if (!params.userId) {
      throw new MemoryExportUnavailableError("Sign in first.");
    }
    if (!params.vaultKey || !params.vaultOwnerToken) {
      throw new MemoryExportUnavailableError(
        "Unlock your vault first. Without the key nothing here can be read.",
      );
    }

    const readable = await PersonalKnowledgeModelService.loadFullBlob({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    });

    // The encrypted half is a bonus, not the point. If it cannot be fetched the
    // person still gets everything they can read, and meta says what is missing
    // rather than the file quietly being less than it claims.
    let restorable: Record<string, unknown> | null = null;
    let restorableError: string | undefined;
    try {
      const result = await AccountService.exportData(params.vaultOwnerToken);
      restorable = stripExcluded(result?.data);
    } catch (error) {
      restorableError =
        error instanceof Error ? error.message : "The encrypted copy could not be fetched.";
    }

    const exportedAt = new Date().toISOString();
    const domains = Object.keys(readable).filter((key) => !key.startsWith("__"));

    return {
      meta: {
        export_version: MEMORY_EXPORT_VERSION,
        exported_at: exportedAt,
        user_id: params.userId,
        domains,
        domain_count: domains.length,
        ...(restorableError ? { restorable_error: restorableError } : {}),
        restore_requires:
          "The encrypted copy can only be opened with your vault passphrase. Nobody else can read it, including us.",
        excludes: [
          "Records of what you were shown and agreed to, which are kept for accountability.",
          "Anything outside your memory: connected accounts, saved cards, places, and activity from other parts of the app.",
        ],
      },
      readable,
      restorable,
    };
  },

  /**
   * Build the export and hand it to the person as a file.
   *
   * On a phone this goes through the share sheet, and `downloadTextFile` only
   * reports success once that sheet accepts -- the app's Documents folder is not
   * browsable, so a write that nobody shared anywhere is not a file the person
   * actually has.
   */
  async downloadMemoryExport(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<{ saved: boolean; filename: string; domainCount: number }> {
    const memoryExport = await this.buildMemoryExport(params);
    const filename = memoryExportFilename(memoryExport.meta.exported_at);
    const saved = await downloadTextFile(JSON.stringify(memoryExport, null, 2), filename);
    return { saved, filename, domainCount: memoryExport.meta.domain_count };
  },
};
