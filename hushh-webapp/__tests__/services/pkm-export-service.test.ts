import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadFullBlob: vi.fn() },
}));
vi.mock("@/lib/services/account-service", () => ({
  AccountService: { exportData: vi.fn() },
}));
vi.mock("@/lib/utils/native-download", () => ({ downloadTextFile: vi.fn() }));

import { AccountService } from "@/lib/services/account-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { downloadTextFile } from "@/lib/utils/native-download";
import {
  MemoryExportUnavailableError,
  PkmExportService,
  memoryExportFilename,
} from "@/lib/services/pkm-export-service";

const loadFullBlob = vi.mocked(PersonalKnowledgeModelService.loadFullBlob);
const exportData = vi.mocked(AccountService.exportData);
const download = vi.mocked(downloadTextFile);

const UNLOCKED = {
  userId: "owner-1",
  vaultKey: "vault-key",
  vaultOwnerToken: "vault-owner-token",
};

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(result.meta.restorable_error).toContain("backend unavailable");
  });

  it("says in the file what the file does not contain", async () => {
    // Without this the export reads as a full account backup, which it is not.
    const result = await PkmExportService.buildMemoryExport(UNLOCKED);
    expect(result.meta.excludes.length).toBeGreaterThan(0);
    expect(result.meta.restore_requires).toContain("passphrase");
  });
});

describe("downloadMemoryExport", () => {
  it("writes the assembled export and reports what the person got", async () => {
    const result = await PkmExportService.downloadMemoryExport(UNLOCKED);

    expect(download).toHaveBeenCalledTimes(1);
    const [content, filename] = download.mock.calls[0]!;
    expect(JSON.parse(content as string).readable).toHaveProperty("financial");
    expect(filename).toMatch(/^hushh-memory-\d{4}-\d{2}-\d{2}\.json$/);
    expect(result).toMatchObject({ saved: true, domainCount: 2 });
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
