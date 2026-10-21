import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadFullBlob: vi.fn() },
}));
vi.mock("@/lib/services/account-service", () => ({
  AccountService: { exportData: vi.fn(), exportBlob: vi.fn() },
}));
vi.mock("@/lib/utils/native-download", () => ({ downloadFileBlob: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));

import { AccountService } from "@/lib/services/account-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { downloadFileBlob } from "@/lib/utils/native-download";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  MemoryExportUnavailableError,
  PkmExportService,
  memoryExportFilename,
} from "@/lib/services/pkm-export-service";

const loadFullBlob = vi.mocked(PersonalKnowledgeModelService.loadFullBlob);
const exportData = vi.mocked(AccountService.exportData);
const exportBlob = vi.mocked(AccountService.exportBlob);
const download = vi.mocked(downloadFileBlob);

const UNLOCKED = {
  userId: "owner-1",
  vaultKey: "vault-key",
  vaultOwnerToken: "vault-owner-token",
};

beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner(UNLOCKED.userId);
  loadFullBlob.mockResolvedValue({
    financial: { holdings: [{ ticker: "AAPL" }] },
    location: { savedPlaces: { home: "somewhere" } },
  });
  exportData.mockResolvedValue({
    success: true,
    data: {
      encrypted_pkm_blobs: [{ ciphertext: "c", iv: "i", tag: "t" }],
      encrypted_vault_keys: [{ wrapped: "k" }],
      consent_audit: [{ scope: "attr.financial.*", action: "GRANTED" }],
    },
  });
  download.mockResolvedValue(true);
  exportBlob.mockResolvedValue(new Blob([JSON.stringify({
    encrypted_pkm_blobs: [{ ciphertext: "raw history" }],
    encrypted_pkm_recovery_segments: [{ ciphertext: "retained revision" }],
  })], { type: "application/json" }));
});

describe("buildMemoryExport", () => {
  it("carries both halves: what you can read and what can restore it", async () => {
    // Either alone is half a promise. Readable-only cannot restore; ciphertext-only
    // cannot be read.
    const result = await PkmExportService.buildMemoryExport(UNLOCKED);

    expect(result.readable).toHaveProperty("financial");
    expect(result.readable).toHaveProperty("location");
    expect(result.restorable).toHaveProperty("encrypted_pkm_blobs");
    expect(result.restorable).toHaveProperty("encrypted_vault_keys");
  });

  it("NEVER includes the record of what you agreed to", async () => {
    // consent_audit is an accountability record, not personal convenience data.
    // The API returns it; this service must drop it. If someone later widens the
    // download, this is the test that should stop them.
    const result = await PkmExportService.buildMemoryExport(UNLOCKED);

    expect(result.restorable).not.toHaveProperty("consent_audit");
    expect(JSON.stringify(result)).not.toContain("GRANTED");
  });

  it("refuses while the vault is locked instead of exporting an unreadable file", async () => {
    // Handing over ciphertext alone would silently answer a different question
    // than the one the person asked.
    await expect(
      PkmExportService.buildMemoryExport({ ...UNLOCKED, vaultKey: "" }),
    ).rejects.toBeInstanceOf(MemoryExportUnavailableError);
    await expect(
      PkmExportService.buildMemoryExport({ ...UNLOCKED, vaultOwnerToken: "" }),
    ).rejects.toBeInstanceOf(MemoryExportUnavailableError);
    expect(loadFullBlob).not.toHaveBeenCalled();
  });

  it("lists every domain that was actually decrypted", async () => {
    const result = await PkmExportService.buildMemoryExport(UNLOCKED);
    expect(result.meta.domains).toEqual(["financial", "location"]);
    expect(result.meta.domain_count).toBe(2);
  });

  it("still delivers the readable half when the encrypted copy cannot be fetched", async () => {
    // The encrypted half is a bonus. Failing the whole export because a backup
    // call failed would deny the person the thing they actually asked for.
    exportData.mockRejectedValueOnce(new Error("backend unavailable"));
    const result = await PkmExportService.buildMemoryExport(UNLOCKED);

    expect(result.readable).toHaveProperty("financial");
    expect(result.restorable).toBeNull();
    expect(result.meta.restorable_error).toBe("The encrypted copy could not be fetched.");
    expect(JSON.stringify(result)).not.toContain("backend unavailable");
  });

  it("says in the file what the file does not contain", async () => {
    // Without this the export reads as a full account backup, which it is not.
    const result = await PkmExportService.buildMemoryExport(UNLOCKED);
    expect(result.meta.excludes.length).toBeGreaterThan(0);
    expect(result.meta.restore_requires).toContain("password");
  });
});

describe("downloadMemoryExport", () => {
  it.each(["owner", "vault"] as const)("does not hand plaintext to a file destination after %s replacement", async (replacement) => {
    let finish!: (value: Record<string, unknown>) => void;
    loadFullBlob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const operation = PkmExportService.downloadMemoryExport(UNLOCKED);
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    if (replacement === "owner") publishValidatedAuthSessionOwner("another-owner");
    else advanceVaultSessionEpoch();
    finish({ preferences: { note: "synthetic private note" } });
    await rejected;
    expect(exportData).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("composes the existing file without parsing/stringifying encrypted history", async () => {
    const stringify = JSON.stringify;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => { throw new Error("encrypted parse forbidden"); });
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      if (value && typeof value === "object" &&
        ("restorable" in value || "encrypted_pkm_recovery_segments" in value)) throw new Error("encrypted stringify forbidden");
      return stringify(value, ...args);
    });
    let result;
    try { result = await PkmExportService.downloadMemoryExport(UNLOCKED); }
    finally { parseSpy.mockRestore(); stringifySpy.mockRestore(); }

    expect(download).toHaveBeenCalledTimes(1);
    const [content, filename] = download.mock.calls[0]!;
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject; reader.readAsText(content);
    });
    const bundle = JSON.parse(text);
    expect(bundle.readable).toHaveProperty("financial");
    expect(bundle.restorable.encrypted_pkm_recovery_segments[0].ciphertext).toBe("retained revision");
    expect(exportData).not.toHaveBeenCalled();
    expect(exportBlob).toHaveBeenCalledWith(UNLOCKED.vaultOwnerToken, expect.objectContaining({ exclude: ["consent_audit"] }));
    expect(filename).toMatch(/^hushh-memory-\d{4}-\d{2}-\d{2}\.json$/);
    expect(result).toMatchObject({ saved: true, domainCount: 2, backupIncluded: true });
  });

  it("preserves readable output and explicitly reports the missing backup on failure", async () => {
    exportBlob.mockRejectedValueOnce(new Error("synthetic incomplete body"));
    const result = await PkmExportService.downloadMemoryExport(UNLOCKED);
    expect(result).toMatchObject({ saved: true, backupIncluded: false, domainCount: 2 });
    const reader = new FileReader();
    const text = new Promise<string>(resolve => { reader.onload = () => resolve(reader.result as string); });
    reader.readAsText(download.mock.calls[0]![0]);
    expect(JSON.parse(await text)).toMatchObject({ restorable: null,
      meta: { restorable_error: "The encrypted copy could not be fetched." }, readable: { financial: expect.any(Object) } });
  });

  it("does not hand off an export when the owner changes during encrypted transfer", async () => {
    exportBlob.mockImplementationOnce(async (_token, options) => {
      publishValidatedAuthSessionOwner("another-owner");
      options?.requireCurrent?.();
      return new Blob();
    });
    await expect(PkmExportService.downloadMemoryExport(UNLOCKED)).rejects.toMatchObject({ name: "AbortError" });
    expect(download).not.toHaveBeenCalled();
  });

  it("reports not-saved when the share sheet is dismissed", async () => {
    // On a phone the Documents folder is not browsable, so a file nobody shared
    // anywhere is not a file the person actually has.
    download.mockResolvedValueOnce(false);
    const result = await PkmExportService.downloadMemoryExport(UNLOCKED);
    expect(result.saved).toBe(false);
  });
});

describe("memoryExportFilename", () => {
  it("names the file by the day it was taken", () => {
    expect(memoryExportFilename("2026-09-10T18:04:11.000Z")).toBe("hushh-memory-2026-09-10.json");
  });
});
