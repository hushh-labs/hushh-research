import { describe, it, expect, vi, beforeEach } from "vitest";

const apiJson = vi.fn();
vi.mock("@/lib/services/api-client", () => ({
  apiJson: (...args: unknown[]) => apiJson(...args),
  ApiError: class ApiError extends Error {},
}));

import { OneConnectionsService } from "@/lib/one-connections/service";

describe("OneConnectionsService", () => {
  beforeEach(() => apiJson.mockReset());

  it("POSTs to the connections seed endpoint and returns the result", async () => {
    apiJson.mockResolvedValueOnce({
      result: { seeded: 2, existingCount: 0, skippedSelf: 1 },
    });
    const out = await OneConnectionsService.seedTrustedConnections({
      vaultOwnerToken: "tok",
    });
    expect(apiJson).toHaveBeenCalledWith(
      "/api/one/connections/seed-trusted",
      expect.objectContaining({ method: "POST" }),
    );
    expect(out).toEqual({ seeded: 2, existingCount: 0, skippedSelf: 1 });
  });
});
