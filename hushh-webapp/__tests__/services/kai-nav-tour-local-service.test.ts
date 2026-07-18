import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPreferences,
  mockGetLocalItem,
  mockSetLocalItem,
  mockRemoveLocalItem,
} = vi.hoisted(() => ({
  mockPreferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
  mockGetLocalItem: vi.fn(),
  mockSetLocalItem: vi.fn(),
  mockRemoveLocalItem: vi.fn(),
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: mockPreferences,
}));

vi.mock("@/lib/utils/session-storage", () => ({
  getLocalItem: mockGetLocalItem,
  setLocalItem: mockSetLocalItem,
  removeLocalItem: mockRemoveLocalItem,
}));

import { KaiNavTourLocalService } from "@/lib/services/kai-nav-tour-local-service";

describe("KaiNavTourLocalService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockPreferences.get.mockResolvedValue({ value: null });
    mockPreferences.set.mockResolvedValue(undefined);
    mockPreferences.remove.mockResolvedValue(undefined);
  });

  it("returns null when no local state exists", async () => {
    const result = await KaiNavTourLocalService.load("user-123");

    expect(result).toBeNull();
  });

  it("marks a tour as completed", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const result = await KaiNavTourLocalService.markCompleted(
      "user-123",
      now
    );

    expect(result.completed_at).toBe(now.toISOString());
    expect(result.skipped_at).toBeNull();
    expect(result.synced_to_vault_at).toBeNull();

    expect(mockPreferences.set).toHaveBeenCalled();
    expect(mockSetLocalItem).toHaveBeenCalled();
  });

  it("marks a tour as skipped", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");

    const result = await KaiNavTourLocalService.markSkipped(
      "user-123",
      now
    );

    expect(result.completed_at).toBeNull();
    expect(result.skipped_at).toBe(now.toISOString());
    expect(result.synced_to_vault_at).toBeNull();

    expect(mockPreferences.set).toHaveBeenCalled();
    expect(mockSetLocalItem).toHaveBeenCalled();
  });

  it("marks an existing state as synced", async () => {
    const existing = {
      version: 1,
      completed_at: "2026-01-01T00:00:00.000Z",
      skipped_at: null,
      synced_to_vault_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    mockPreferences.get.mockResolvedValue({
      value: JSON.stringify(existing),
    });

    const now = new Date("2026-01-03T00:00:00.000Z");

    const result = await KaiNavTourLocalService.markSynced(
      "user-123",
      now
    );

    expect(result).not.toBeNull();
    expect(result?.synced_to_vault_at).toBe(now.toISOString());

    expect(mockPreferences.set).toHaveBeenCalled();
    expect(mockSetLocalItem).toHaveBeenCalled();
  });

  it("clears persisted state", async () => {
    await KaiNavTourLocalService.clear("user-123");

    expect(mockPreferences.remove).toHaveBeenCalledWith({
      key: "kai_nav_tour_v1:user-123",
    });

    expect(mockRemoveLocalItem).toHaveBeenCalledWith(
      "kai_nav_tour_v1:fallback:user-123"
    );
  });
});
