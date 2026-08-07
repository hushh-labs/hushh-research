import { beforeEach, describe, expect, it, vi } from "vitest";

const { addSavedLocationMock, loadSavedLocationsMock, storeRuntimeSecretMock } =
  vi.hoisted(() => ({
    addSavedLocationMock: vi.fn(),
    loadSavedLocationsMock: vi.fn(),
    storeRuntimeSecretMock: vi.fn(),
  }));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "credential",
  GEMINI_RUNTIME_TRANSPORT_REF: "transport",
  GEMINI_VERTEX_LOCATION_REF: "location",
  GEMINI_VERTEX_PROJECT_REF: "project",
  RUNTIME_CREDENTIAL_MODE_REF: "mode",
  PersonalKnowledgeModelService: {
    storeRuntimeSecret: (...args: unknown[]) => storeRuntimeSecretMock(...args),
  },
}));

vi.mock("@/lib/one-location/saved-locations", () => ({
  addSavedLocation: (...args: unknown[]) => addSavedLocationMock(...args),
  loadSavedLocations: (...args: unknown[]) => loadSavedLocationsMock(...args),
  defaultLabelForCategory: (category: "home" | "work" | "other") =>
    category === "home" ? "Home" : category === "work" ? "Work" : "Other",
  DuplicateSavedLocationError: class DuplicateSavedLocationError extends Error {
    readonly existingCategory: "home" | "work" | "other";

    constructor(existingLocation: { category: "home" | "work" | "other" }) {
      super("This place is already saved.");
      this.name = "DuplicateSavedLocationError";
      this.existingCategory = existingLocation.category;
    }
  },
}));

import { DuplicateSavedLocationError } from "@/lib/one-location/saved-locations";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";

describe("PreVaultSensitiveDraftService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PreVaultSensitiveDraftService.clearForUser("user-1");
    storeRuntimeSecretMock.mockResolvedValue({ success: true });
    addSavedLocationMock.mockResolvedValue([]);
    loadSavedLocationsMock.mockResolvedValue([]);
  });

  it("holds a Gemini credential only in memory until every encrypted write succeeds", async () => {
    PreVaultSensitiveDraftService.stageGeminiRuntime("user-1", {
      transport: "developer_api",
      credential: "memory-only-gemini-key",
      vertexProject: null,
      vertexLocation: null,
    });

    await PreVaultSensitiveDraftService.finalizeForVault({
      userId: "user-1",
      vaultKey: "memory-only-vault-key",
      vaultOwnerToken: "memory-only-owner-token",
    });

    expect(storeRuntimeSecretMock).toHaveBeenCalledTimes(3);
    expect(PreVaultSensitiveDraftService.hasGeminiRuntime("user-1")).toBe(
      false,
    );
  });

  it("retains a staged credential for a retry when encrypted persistence fails", async () => {
    PreVaultSensitiveDraftService.stageGeminiRuntime("user-1", {
      transport: "developer_api",
      credential: "memory-only-gemini-key",
      vertexProject: null,
      vertexLocation: null,
    });
    storeRuntimeSecretMock.mockResolvedValueOnce({ success: false });

    await expect(
      PreVaultSensitiveDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      }),
    ).rejects.toThrow("PKM_WRITE_FAILED");

    expect(PreVaultSensitiveDraftService.hasGeminiRuntime("user-1")).toBe(true);
  });

  it("holds a selected finance action only in process memory until it is consumed", () => {
    const file = new File(["symbol,quantity\nHUSHH,1"], "portfolio.csv", {
      type: "text/csv",
    });
    PreVaultSensitiveDraftService.stageFinanceIntent("user-1", {
      kind: "statement",
      file,
    });

    expect(PreVaultSensitiveDraftService.hasFinanceIntent("user-1")).toBe(true);
    expect(
      PreVaultSensitiveDraftService.consumeFinanceIntent("user-1"),
    ).toEqual({
      kind: "statement",
      file,
    });
    expect(PreVaultSensitiveDraftService.hasFinanceIntent("user-1")).toBe(
      false,
    );
  });

  it("clears a pending finance action with all other pre-vault drafts", () => {
    PreVaultSensitiveDraftService.stageFinanceIntent("user-1", {
      kind: "plaid",
      environment: "sandbox",
    });

    PreVaultSensitiveDraftService.clearForUser("user-1");

    expect(PreVaultSensitiveDraftService.hasFinanceIntent("user-1")).toBe(
      false,
    );
  });

  it("keeps a saved-location draft only in memory until the vault is ready", async () => {
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "home",
      label: "",
      latitude: 28.6139,
      longitude: 77.209,
      address: "Flat 4B, Kartavya Path, New Delhi 110001, India",
    });

    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(true);
    expect(addSavedLocationMock).not.toHaveBeenCalled();

    await PreVaultSensitiveDraftService.finalizeForVault({
      userId: "user-1",
      vaultKey: "memory-only-vault-key",
      vaultOwnerToken: "memory-only-owner-token",
    });

    expect(addSavedLocationMock).toHaveBeenCalledWith({
      context: {
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      },
      input: {
        category: "home",
        label: "",
        latitude: 28.6139,
        longitude: 77.209,
        address: "Flat 4B, Kartavya Path, New Delhi 110001, India",
      },
    });
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(
      false,
    );
  });

  it("retains a saved-location draft when encrypted persistence fails", async () => {
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "work",
      label: "",
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Hushh Office, Bengaluru 560001, India",
    });
    addSavedLocationMock.mockRejectedValueOnce(new Error("PKM_WRITE_FAILED"));

    await expect(
      PreVaultSensitiveDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      }),
    ).rejects.toThrow("PKM_WRITE_FAILED");

    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(true);
  });

  it("treats a same-category duplicate as an idempotent finalization retry", async () => {
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "home",
      label: "",
      latitude: 28.6139,
      longitude: 77.209,
      address: "New Delhi 110001, India",
    });
    addSavedLocationMock.mockRejectedValueOnce(
      new DuplicateSavedLocationError({ category: "home" } as never),
    );
    loadSavedLocationsMock.mockResolvedValueOnce([
      {
        id: "home",
        category: "home",
        label: "Home",
        latitude: 28.6139,
        longitude: 77.209,
        address: "New Delhi 110001, India",
        savedAt: "2026-08-04T00:00:00.000Z",
      },
    ]);

    await expect(
      PreVaultSensitiveDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      }),
    ).resolves.toBeUndefined();
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(
      false,
    );
  });

  it("keeps a cross-category duplicate for explicit owner resolution", async () => {
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "work",
      label: "",
      latitude: 28.6139,
      longitude: 77.209,
      address: "New Delhi 110001, India",
    });
    addSavedLocationMock.mockRejectedValueOnce(
      new DuplicateSavedLocationError({ category: "home" } as never),
    );

    await expect(
      PreVaultSensitiveDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      }),
    ).rejects.toBeInstanceOf(DuplicateSavedLocationError);
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(true);
  });

  it("does not mistake a nearby same-category place for an exact retry", async () => {
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "home",
      label: "",
      latitude: 28.6139,
      longitude: 77.209,
      address: "Flat 4B, New Delhi 110001, India",
    });
    addSavedLocationMock.mockRejectedValueOnce(
      new DuplicateSavedLocationError({ category: "home" } as never),
    );
    loadSavedLocationsMock.mockResolvedValueOnce([
      {
        id: "home",
        category: "home",
        label: "Home",
        latitude: 28.61391,
        longitude: 77.20901,
        address: "Flat 3A, New Delhi 110001, India",
        savedAt: "2026-08-04T00:00:00.000Z",
      },
    ]);

    await expect(
      PreVaultSensitiveDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      }),
    ).rejects.toBeInstanceOf(DuplicateSavedLocationError);
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(true);
  });

  it("does not persist a captured location after the user clears the session", async () => {
    let releaseGeminiWrite: ((value: { success: boolean }) => void) | undefined;
    storeRuntimeSecretMock.mockImplementationOnce(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          releaseGeminiWrite = resolve;
        }),
    );
    PreVaultSensitiveDraftService.stageGeminiRuntime("user-1", {
      transport: "developer_api",
      credential: "memory-only-gemini-key",
      vertexProject: null,
      vertexLocation: null,
    });
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "home",
      label: "",
      latitude: 28.6139,
      longitude: 77.209,
      address: "New Delhi 110001, India",
    });

    const finalization = PreVaultSensitiveDraftService.finalizeForVault({
      userId: "user-1",
      vaultKey: "memory-only-vault-key",
      vaultOwnerToken: "memory-only-owner-token",
    });
    await vi.waitFor(() => expect(storeRuntimeSecretMock).toHaveBeenCalled());

    PreVaultSensitiveDraftService.clearForUser("user-1");
    releaseGeminiWrite?.({ success: true });
    await finalization;

    expect(addSavedLocationMock).not.toHaveBeenCalled();
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(
      false,
    );
  });

  it("replays a new same-user draft with fresh authority after cancellation", async () => {
    let releaseOldWrite: ((value: { success: boolean }) => void) | undefined;
    storeRuntimeSecretMock.mockImplementationOnce(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          releaseOldWrite = resolve;
        }),
    );
    PreVaultSensitiveDraftService.stageGeminiRuntime("user-1", {
      transport: "developer_api",
      credential: "old-session-key",
      vertexProject: null,
      vertexLocation: null,
    });

    const oldFinalization = PreVaultSensitiveDraftService.finalizeForVault({
      userId: "user-1",
      vaultKey: "old-vault-key",
      vaultOwnerToken: "old-owner-token",
    });
    await vi.waitFor(() => expect(storeRuntimeSecretMock).toHaveBeenCalled());

    PreVaultSensitiveDraftService.clearForUser("user-1");
    PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
      category: "work",
      label: "",
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Hushh Office, Bengaluru 560001, India",
    });
    const newFinalization = PreVaultSensitiveDraftService.finalizeForVault({
      userId: "user-1",
      vaultKey: "new-vault-key",
      vaultOwnerToken: "new-owner-token",
    });

    expect(addSavedLocationMock).not.toHaveBeenCalled();
    releaseOldWrite?.({ success: true });
    await Promise.all([oldFinalization, newFinalization]);

    expect(addSavedLocationMock).toHaveBeenCalledTimes(1);
    expect(addSavedLocationMock).toHaveBeenCalledWith({
      context: {
        userId: "user-1",
        vaultKey: "new-vault-key",
        vaultOwnerToken: "new-owner-token",
      },
      input: {
        category: "work",
        label: "",
        latitude: 12.9716,
        longitude: 77.5946,
        address: "Hushh Office, Bengaluru 560001, India",
      },
    });
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(
      false,
    );
  });

  it("rejects invalid coordinates before staging sensitive information", () => {
    expect(() =>
      PreVaultSensitiveDraftService.stageSavedLocation("user-1", {
        category: "other",
        label: "Gym",
        latitude: 91,
        longitude: 77.209,
        address: "Invalid",
      }),
    ).toThrow("Choose a valid location before continuing.");
    expect(PreVaultSensitiveDraftService.hasSavedLocation("user-1")).toBe(
      false,
    );
  });
});
