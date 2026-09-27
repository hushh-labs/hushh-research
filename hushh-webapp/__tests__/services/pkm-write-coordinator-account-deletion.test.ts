import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: vi.fn(() => {
      // The erasure transaction holds this account's rows; the proxy gives up.
      throw new Error("Failed to store domain data: 500");
    }),
    getDomainManifest: vi.fn(),
  },
}));

import {
  clearAccountDeletionActive,
  markAccountDeletionActive,
} from "@/lib/auth/account-deletion-activity";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

function save(userId: string) {
  return PkmWriteCoordinator.saveMergedDomain({
    userId,
    domain: "kyc_connector",
    vaultKey: "vault-key",
    vaultOwnerToken: "vault-owner-token",
    confirmation: { kind: "user_confirmed" } as never,
    build: () => ({}) as never,
  });
}

describe("PkmWriteCoordinator during account deletion", () => {
  afterEach(() => {
    clearAccountDeletionActive("uid-deleting");
    vi.restoreAllMocks();
  });

  it("reports a write interrupted by this account's deletion as a warning, not a crash", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    markAccountDeletionActive("uid-deleting");

    const result = await save("uid-deleting");

    expect(result.saveState).toBe("blocked_pending_unlock");
    expect(result.success).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[PkmWriteCoordinator] PKM write stopped by account deletion.",
    );
  });

  it("still reports genuine write failures for every other account as errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    markAccountDeletionActive("uid-deleting");

    const result = await save("uid-other");

    expect(result.saveState).toBe("failed");
    expect(error).toHaveBeenCalledWith("[PkmWriteCoordinator] PKM write failed.");
  });
});
