// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "runtime-owner" } }),
}));

const { getVaultOwnerToken } = vi.hoisted(() => ({
  getVaultOwnerToken: vi.fn(() => "runtime-token"),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    getVaultOwnerToken,
    vaultOwnerToken: "runtime-token",
  }),
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    revokeGrant: vi.fn(),
    revokePublicInvite: vi.fn(),
    stopBackgroundShare: vi.fn(),
  },
}));

import { LocationRevocationRuntime } from "@/components/one-location/location-revocation-runtime";
import {
  pendingLocationRevocationGrantIds,
  revokeLocationGrantOrQueue,
} from "@/lib/one-location/location-revocation-queue";
import { OneLocationService } from "@/lib/one-location/service";

describe("LocationRevocationRuntime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getVaultOwnerToken.mockReturnValue("runtime-token");
    window.localStorage.clear();
    vi.mocked(OneLocationService.stopBackgroundShare).mockResolvedValue(
      {} as never,
    );
  });

  it("retries a queued revoke outside the Location page after vault unlock", async () => {
    vi.mocked(OneLocationService.revokeGrant).mockRejectedValueOnce(
      new Error("offline"),
    );
    await expect(
      revokeLocationGrantOrQueue({
        userId: "runtime-owner",
        vaultOwnerToken: "runtime-token",
        grantId: "runtime-grant",
      }),
    ).resolves.toBe(false);
    expect(pendingLocationRevocationGrantIds("runtime-owner")).toEqual(
      new Set(["runtime-grant"]),
    );

    vi.mocked(OneLocationService.revokeGrant).mockResolvedValue({} as never);
    render(<LocationRevocationRuntime />);

    await waitFor(() => {
      expect(pendingLocationRevocationGrantIds("runtime-owner").size).toBe(0);
    });
    expect(OneLocationService.revokeGrant).toHaveBeenLastCalledWith({
      vaultOwnerToken: "runtime-token",
      grantId: "runtime-grant",
    });
  });

  it("rechecks the queue when a new revoke arrives during an in-flight retry", async () => {
    vi.mocked(OneLocationService.revokeGrant).mockRejectedValueOnce(
      new Error("offline"),
    );
    await revokeLocationGrantOrQueue({
      userId: "runtime-owner",
      vaultOwnerToken: "runtime-token",
      grantId: "grant-a",
    });

    let finishGrantA: (() => void) | undefined;
    vi.mocked(OneLocationService.revokeGrant).mockImplementation(
      ({ grantId }) => {
        if (grantId === "grant-a") {
          return new Promise((resolve) => {
            finishGrantA = () => resolve({} as never);
          });
        }
        return Promise.reject(new Error("grant-b temporarily offline"));
      },
    );
    render(<LocationRevocationRuntime />);
    await waitFor(() => expect(finishGrantA).toBeTypeOf("function"));

    await expect(
      revokeLocationGrantOrQueue({
        userId: "runtime-owner",
        vaultOwnerToken: "runtime-token",
        grantId: "grant-b",
      }),
    ).resolves.toBe(false);
    vi.mocked(OneLocationService.revokeGrant).mockResolvedValue({} as never);
    finishGrantA?.();

    await waitFor(() => {
      expect(pendingLocationRevocationGrantIds("runtime-owner").size).toBe(0);
    });
    expect(OneLocationService.revokeGrant).toHaveBeenCalledWith({
      vaultOwnerToken: "runtime-token",
      grantId: "grant-b",
    });
  });
});
