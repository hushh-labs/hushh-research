import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Native (Capacitor) ↔ web parity for the PKM "no data for this user yet" case.
 *
 * A fresh user with no PKM data makes the backend raise a 404
 * ("No … data found for user"). The iOS/Android plugins reject such responses
 * with a message that STARTS with `HTTP Error 404: …`. The web branches already
 * treat a 404 as an empty state (metadata -> emptyMetadata, data/domain -> null);
 * these tests lock in that the NATIVE branches now do the same instead of
 * surfacing a raw error banner ("HTTP Error 404: …") on the Personal Data screen.
 *
 * Critically, ONLY a 404 is treated as empty — auth/server/network errors must
 * keep propagating so real failures stay visible.
 */

const getMetadataMock = vi.fn();
const getEncryptedDataMock = vi.fn();
const getDomainDataMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhPersonalKnowledgeModel: {
    getMetadata: (...args: unknown[]) => getMetadataMock(...args),
    getEncryptedData: (...args: unknown[]) => getEncryptedDataMock(...args),
    getDomainData: (...args: unknown[]) => getDomainDataMock(...args),
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

vi.mock("@/lib/firebase/config", () => ({
  auth: {
    currentUser: null,
  },
}));

import { CacheService } from "@/lib/services/cache-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

const VAULT_TOKEN = "vault-owner-token";
const NO_DATA_404 = 'HTTP Error 404: {"detail":"No data found for user"}';

describe("PKM native no-data (404) → empty parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
  });

  describe("getMetadata", () => {
    it("returns empty metadata (not a thrown error) on a native no-data 404", async () => {
      getMetadataMock.mockRejectedValue(new Error(NO_DATA_404));

      const meta = await PersonalKnowledgeModelService.getMetadata(
        "user-1",
        true,
        VAULT_TOKEN,
      );

      expect(meta.userId).toBe("user-1");
      expect(meta.domains).toEqual([]);
      expect(meta.totalAttributes).toBe(0);
      expect(meta.lastUpdated).toBeNull();
    });

    it("treats the metadata-specific 404 detail string as empty too", async () => {
      getMetadataMock.mockRejectedValue(
        new Error('HTTP Error 404: {"detail":"No PKM data found for user"}'),
      );

      const meta = await PersonalKnowledgeModelService.getMetadata(
        "user-2",
        true,
        VAULT_TOKEN,
      );

      expect(meta.domains).toEqual([]);
    });

    it("re-throws a native 500 (server errors stay visible)", async () => {
      getMetadataMock.mockRejectedValue(new Error("HTTP Error 500: internal"));

      await expect(
        PersonalKnowledgeModelService.getMetadata("user-3", true, VAULT_TOKEN),
      ).rejects.toThrow(/HTTP Error 500/);
    });

    it("re-throws a native 401 (auth errors stay visible)", async () => {
      getMetadataMock.mockRejectedValue(new Error("HTTP Error 401: unauthorized"));

      await expect(
        PersonalKnowledgeModelService.getMetadata("user-4", true, VAULT_TOKEN),
      ).rejects.toThrow(/HTTP Error 401/);
    });

    it("re-throws a message that merely contains '404' but is not the plugin prefix (anchor guard)", async () => {
      getMetadataMock.mockRejectedValue(
        new Error("Something failed, server said 404 somewhere"),
      );

      await expect(
        PersonalKnowledgeModelService.getMetadata("user-5", true, VAULT_TOKEN),
      ).rejects.toThrow(/404 somewhere/);
    });
  });

  describe("getEncryptedData", () => {
    it("returns null on a native no-data 404", async () => {
      getEncryptedDataMock.mockRejectedValue(new Error(NO_DATA_404));

      const blob = await PersonalKnowledgeModelService.getEncryptedData(
        "user-1",
        VAULT_TOKEN,
      );

      expect(blob).toBeNull();
    });

    it("re-throws a native 500", async () => {
      getEncryptedDataMock.mockRejectedValue(new Error("HTTP Error 500: boom"));

      await expect(
        PersonalKnowledgeModelService.getEncryptedData("user-2", VAULT_TOKEN),
      ).rejects.toThrow(/HTTP Error 500/);
    });
  });

  describe("getDomainData", () => {
    it("returns null on a native no-data 404", async () => {
      getDomainDataMock.mockRejectedValue(new Error(NO_DATA_404));

      const blob = await PersonalKnowledgeModelService.getDomainData(
        "user-1",
        "finance",
        VAULT_TOKEN,
      );

      expect(blob).toBeNull();
    });

    it("re-throws a native network error (offline stays visible)", async () => {
      getDomainDataMock.mockRejectedValue(new Error("Network error: timed out"));

      await expect(
        PersonalKnowledgeModelService.getDomainData(
          "user-2",
          "finance",
          VAULT_TOKEN,
        ),
      ).rejects.toThrow(/Network error/);
    });
  });
});
