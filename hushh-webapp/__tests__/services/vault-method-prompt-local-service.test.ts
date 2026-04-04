import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
}));

import { VaultMethodPromptLocalService } from "@/lib/services/vault-method-prompt-local-service";

describe("VaultMethodPromptLocalService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists RP-aware dismiss state", async () => {
    await VaultMethodPromptLocalService.dismiss(
      "uid-1",
      "generated_default_native_passkey_prf",
      "kai.hushh.ai"
    );

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringContaining("uid-1"),
        value: expect.stringContaining("dismissed_for_rp_id"),
      })
    );
  });

  it("loads legacy state without RP id", async () => {
    getMock.mockResolvedValueOnce({
      value: JSON.stringify({
        dismissed_for_method: "generated_default_native_passkey_prf",
        dismissed_at: "2026-02-25T00:00:00.000Z",
      }),
    });

    const state = await VaultMethodPromptLocalService.load("uid-1");
    expect(state).toEqual(
      expect.objectContaining({
        dismissed_for_method: "generated_default_native_passkey_prf",
      })
    );
  });
});
