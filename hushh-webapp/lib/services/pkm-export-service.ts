"use client";

import { projectWalletConsent } from "@/lib/wallet/card-consent-projection";
import { Capacitor } from "@capacitor/core";

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
import { downloadFileBlob } from "@/lib/utils/native-download";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

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

type MemoryExportOptions = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  isEffectCurrent?: () => boolean;
};

function memoryExportGuard(params: MemoryExportOptions): () => void {
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = snapshotVaultSessionEpoch();
  return () => {
    if (!owner || owner.userId !== params.userId || !isValidatedAuthSessionOwnerCurrent(owner) ||
      !isVaultSessionEpochCurrent(epoch) || params.isEffectCurrent?.() === false)
      throw new DOMException("The export request expired.", "AbortError");
  };
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

async function buildMemoryExportParts<T>(params: MemoryExportOptions,
  loadRestorable: (requireCurrent: () => void) => Promise<T>,
): Promise<{ meta: MemoryExportMeta; readable: Record<string, unknown>; restorable: T | null }> {
    if (!params.userId) {
      throw new MemoryExportUnavailableError("Sign in first.");
    }
    if (!params.vaultKey || !params.vaultOwnerToken) {
      throw new MemoryExportUnavailableError(
        "Unlock your vault first. Without the key nothing here can be read.",
      );
    }

    const requireCurrent = memoryExportGuard(params);
    requireCurrent();
    const readable = { ...await PersonalKnowledgeModelService.loadFullBlob({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }) };
    requireCurrent();
    for (const domain of Object.keys(readable)) if (domain.trim().toLowerCase() === "wallet") readable[domain] = projectWalletConsent(readable[domain]);

    // The encrypted half is a bonus, not the point. If it cannot be fetched the
    // person still gets everything they can read, and meta says what is missing
    // rather than the file quietly being less than it claims.
    let restorable: T | null = null;
    let restorableError: string | undefined;
    try {
      restorable = await loadRestorable(requireCurrent);
    } catch {
      restorableError = "The encrypted copy could not be fetched.";
    }
    requireCurrent();

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
          "The encrypted copy can only be opened with your vault password. Nobody else can read it, including us.",
        excludes: [
          "Private card artwork, security codes and sharing receipts are omitted from the readable copy.",
          "Records of what you were shown and agreed to, which are kept for accountability.",
          "Anything outside your memory: connected accounts, saved cards, places, and activity from other parts of the app.",
        ],
      },
      readable,
      restorable,
    };
}

export const PkmExportService = {
  /** Compatibility object API for existing small/native callers. */
  async buildMemoryExport(params: MemoryExportOptions): Promise<MemoryExport> {
    return buildMemoryExportParts(params, async () => {
      const result = await AccountService.exportData(params.vaultOwnerToken);
      return stripExcluded(result.data);
    });
  },

  /**
   * Build the export and hand it to the person as a file.
   *
   * On a phone this goes through the share sheet, and the guarded file handoff only
   * reports success once that sheet accepts -- the app's Documents folder is not
   * browsable, so a write that nobody shared anywhere is not a file the person
   * actually has.
   */
  async downloadMemoryExport(params: MemoryExportOptions): Promise<{ saved: boolean; filename: string; domainCount: number; backupIncluded: boolean }> {
    const requireCurrent = memoryExportGuard(params);
    requireCurrent();
    // Native keeps its existing guarded Cache/share-sheet contract. Its buffered
    // bridge and base64 writer are not a bounded large-file transport.
    const native = Capacitor.isNativePlatform();
    const memoryExport = native ? await this.buildMemoryExport(params) :
      await buildMemoryExportParts(params, requireCurrent => AccountService.exportBlob(params.vaultOwnerToken, {
        exclude: EXCLUDED_RESTORABLE_KEYS, requireCurrent,
      }));
    requireCurrent();
    const filename = memoryExportFilename(memoryExport.meta.exported_at);
    const blob = native ? new Blob([JSON.stringify(memoryExport, null, 2)], { type: "application/json" }) :
      new Blob(['{"meta":', JSON.stringify(memoryExport.meta), ',"readable":', JSON.stringify(memoryExport.readable),
        ',"restorable":', (memoryExport.restorable as Blob | null) ?? "null", "}"], { type: "application/json" });
    requireCurrent();
    const saved = await downloadFileBlob(blob, filename, () => {
      try { requireCurrent(); return true; } catch { return false; }
    });
    return { saved, filename, domainCount: memoryExport.meta.domain_count, backupIncluded: memoryExport.restorable !== null };
  },
};
